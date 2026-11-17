// Version 2 features, checked through the database functions exactly as the website calls them
// (signed in as owner / master / tenant, running as the restricted "anon" role the internet uses).
// Sections: foundations, old dues, delete a bill, documents, correcting payments, building bill, reminders, Lodging.
import { freshDb, connect } from './db.mjs';
import assert from 'node:assert/strict';
import { oldDuesInterest, cleanPhone } from '../app/src/lib/dues.ts';

const admin = await freshDb('rb_v2');      // full-rights connection, only for set-up and looking inside
const c = await connect('rb_v2');          // the app's connection
await c.query('set role anon');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', String(e.message).split('\n').slice(0, 2).join(' | ')); } };
const rpc = async (fn, args = {}) => {
  const keys = Object.keys(args);
  const vals = keys.map(k => { const v = args[k]; return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v; });
  return (await c.query(`select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, vals)).rows[0].r;
};
const fails = async (fn, args, re) => { try { await rpc(fn, args); } catch (e) { if (re) assert.match(e.message, re); return; } assert.fail(`${fn} should have failed`); };
const near = (a, b, tol = 0.015) => assert.ok(Math.abs(Number(a) - Number(b)) <= tol, `expected ${b}, got ${a}`);
const sql = async (q, p = []) => (await admin.query(q, p)).rows;
const one = async (q, p = []) => (await sql(q, p))[0];
const ledger = async (tid, asof = null) => (await one('select _ledger($1, $2::date) l', [tid, asof])).l;
// Lodging lines written since a marker, newest last.
const logMark = async () => Number((await one('select coalesce(max(id), 0) m from audit_log')).m);
const logSince = async (mark) => sql('select * from audit_log where id > $1 order by id', [mark]);

// Freeze "today" so the checks give the same answer on any day.
await admin.query(`create or replace function _today() returns date language sql stable as $$ select date '2026-11-04' $$`);
const TODAY = '2026-11-04', M0 = '2026-11-01', OLD = '1900-01-01';

await admin.query(`select setup_owner('owner','Bhuvanya','owner@example.com','ownerpass')`);
const O = (await rpc('login', { p_login: 'owner', p_password: 'ownerpass', p_device: 'test' })).token;
await rpc('add_admin', { p_token: O, p_login: 'rakesh', p_name: 'Rakesh', p_email: null, p_password: 'rakesh1' });
const A = (await rpc('login', { p_login: 'rakesh', p_password: 'rakesh1' })).token;
// The daily job makes the month's bills on "bill day". Keep that day out of the way (the 28th), so that running the
// reminders for some date in these checks does not quietly add bills to every tenant.
await rpc('update_settings', { p_token: O, p_fields: { bill_day: 28 } });

// A new room with a new tenant each time, so the sections do not disturb each other.
let roomNo = 200;
const newRoom = async (rent = 4000) => { const no = String(++roomNo); return { no, id: await rpc('save_room', { p_token: O, p_id: null, p_room_no: no, p_floor: '2', p_default_rent: rent, p_notes: null }) }; };
async function newTenant(name, fields = {}, login = null) {
  const room = await newRoom();
  const tid = await rpc('move_in', { p_token: O, p_room: room.id, p_fields: { full_name: name, rent: 4000, persons: 2, start_date: '2026-06-01', due_day: 5, opening_reading: 100, ...fields }, p_login: login, p_password: login ? 'pass-' + login : null });
  const token = login ? (await rpc('login', { p_login: login, p_password: 'pass-' + login })).token : null;
  return { tid, room, token, name };
}
const addBill = async (tid, month, reading = null) => {
  const id = await rpc('add_bill', { p_token: O, p_tenancy: tid, p_month: month });
  if (reading != null) await rpc('update_bill', { p_token: O, p_bill: id, p_fields: { new_reading: reading, reading_verified: true } });
  return id;
};
const pay = (tid, amount, on, method = 'cash', by = O) => rpc('record_payment', { p_token: by, p_tenancy: tid, p_amount: amount, p_paid_on: on, p_method: method, p_reference: null, p_note: null });
const oldDues = (tid, amount, note, since, by = O) => rpc('add_old_dues', { p_token: by, p_tenancy: tid, p_amount: amount, p_note: note, p_since: since });
const detail = (tid) => rpc('tenancy_detail', { p_token: O, p_tenancy: tid });
const overview = async () => { const ov = await rpc('rooms_overview', { p_token: O }); return { ...ov, by: Object.fromEntries(ov.rooms.map(r => [r.room_no, r])) }; };

// ============================================================ C0 foundations
console.log('Foundations');
await t('the version marker is 2, for the sign-in page and for signed-in people', async () => {
  assert.equal((await rpc('public_info')).schema_version, 2);
  assert.equal((await rpc('me', { p_token: O })).settings.schema_version, 2);
});
await t('every bill and every "applied" line carries its kind; a monthly bill is "regular"', async () => {
  const x = await newTenant('Kind Check'); await addBill(x.tid, '2026-10-01', 150); await pay(x.tid, 500, '2026-10-02');
  const d = await detail(x.tid);
  assert.equal(d.ledger.bills[0].kind, 'regular'); assert.equal(d.ledger.payments[0].applied[0].kind, 'regular');
  assert.equal(d.ledger.payments[0].edited_at, null); assert.equal(d.ledger.payments[0].edit_note, null);
});
await t('a deduction or charge line says who made it and when - for masters; a tenant never sees the name', async () => {
  const x = await newTenant('By Check', {}, 'bycheck'); const b = await addBill(x.tid, '2026-10-01', 150);
  await rpc('add_adjustment', { p_token: A, p_bill: b, p_label: 'Broken window', p_amount: 250 });
  const adj = (await detail(x.tid)).ledger.bills[0].adjustments[0];
  assert.equal(adj.by, 'Rakesh'); assert.ok(adj.at); assert.equal(adj.label, 'Broken window');
  const home = await rpc('tenant_home', { p_token: x.token }); const mine = home.ledger.bills[0].adjustments[0];
  assert.equal(mine.label, 'Broken window'); near(mine.amount, 250); assert.ok(mine.at); assert.equal('by' in mine, false);
  assert.ok(!JSON.stringify(home).includes('Rakesh'), 'the master name leaked to the tenant');
  near(home.ledger.totals.outstanding, (await detail(x.tid)).ledger.totals.outstanding);
});

// ============================================================ C1 old dues
console.log('Old dues');
const settings = (await rpc('me', { p_token: O })).settings;
await t('old dues WITH a date: shown as "Old dues", normal late interest from that date; the preview on the form equals the ledger', async () => {
  const x = await newTenant('Suresh Kumar'); const mark = await logMark();
  const id = await oldDues(x.tid, 4000, 'Aug to Oct rent', '2026-09-01');
  const d = await detail(x.tid); const b = d.ledger.bills[0];
  assert.equal(b.id, id); assert.equal(b.kind, 'previous'); assert.equal(b.month, OLD); assert.equal(b.note, 'Aug to Oct rent'); assert.equal(b.due_date, '2026-09-01');
  near(b.total, 4000); near(b.rent, 4000); near(b.water, 0); near(b.electricity, 0); assert.equal(b.awaiting_reading, false); assert.equal(b.interest_waived, false);
  near(b.interest_left, 4000 * 0.24 / 365 * 64); assert.equal(b.is_overdue, true);
  near(b.interest_left, oldDuesInterest(4000, '2026-09-01', TODAY, Number(settings.interest_rate), settings.grace_days), 0.001);
  const line = (await logSince(mark))[0];
  assert.equal(line.action, 'dues.added'); assert.equal(line.group_name, 'bills'); assert.equal(line.actor_name, 'Bhuvanya');
  assert.equal(line.summary, 'Added old dues ₹4,000 (Aug to Oct rent) for Suresh Kumar, Room ' + x.room.no + ', owed since 1 Sep 2026');
  assert.equal(line.room_no, x.room.no); assert.equal(line.tenant_name, 'Suresh Kumar'); assert.equal(line.tenancy_id, x.tid);
});
await t('the interest preview equals the ledger for other amounts, dates, rates and grace days', async () => {
  const x = await newTenant('Preview Check');
  for (const [amt, since, rate, grace] of [[1234.5, '2026-01-15', 24, 0], [98765, '2025-03-31', 18, 5], [10, '2026-11-03', 24, 0], [5000, '2026-11-04', 24, 0], [7000, '2026-10-30', 36, 10], [333.33, '2024-02-29', 12.5, 3]]) {
    await rpc('update_settings', { p_token: O, p_fields: { interest_rate: rate, grace_days: grace } });
    const id = await oldDues(x.tid, amt, null, since);
    const b = (await ledger(x.tid)).bills.find(z => z.id === id);
    near(oldDuesInterest(amt, since, TODAY, rate, grace), b.interest_left, 0.0051);
    await rpc('delete_bill', { p_token: O, p_bill: id });
  }
  await rpc('update_settings', { p_token: O, p_fields: { interest_rate: 24, grace_days: 0 } });
});
await t('old dues WITHOUT a date: due the day they are entered, never any interest, however long they stay unpaid', async () => {
  const x = await newTenant('No Date'); const mark = await logMark();
  await oldDues(x.tid, 2500, '', null);
  const b = (await detail(x.tid)).ledger.bills[0];
  assert.equal(b.kind, 'previous'); assert.equal(b.due_date, TODAY); assert.equal(b.interest_waived, true); assert.equal(b.note, null); near(b.outstanding, 2500);
  const later = await ledger(x.tid, '2027-06-01'); near(later.totals.interest_due, 0); near(later.totals.outstanding, 2500);
  assert.equal((await logSince(mark))[0].summary, 'Added old dues ₹2,500 for No Date, Room ' + x.room.no + ', no date (no late interest)');
});
await t('several old dues for one tenant are allowed, even with the same date; totals add up', async () => {
  const x = await newTenant('Many Dues');
  await oldDues(x.tid, 1000, 'July', '2026-08-01'); await oldDues(x.tid, 2000, 'August', '2026-08-01'); await oldDues(x.tid, 300, 'Fan repair', null);
  const l = await ledger(x.tid); assert.equal(l.bills.length, 3); assert.ok(l.bills.every(b => b.kind === 'previous' && b.month === OLD));
  near(l.totals.principal_due, 3300); assert.deepEqual(l.bills.map(b => b.note), ['July', 'August', 'Fan repair']);
  for (let i = 0; i < 5; i++) assert.deepEqual((await ledger(x.tid)).bills.map(b => b.note), ['July', 'August', 'Fan repair']);   // same order every time
});
await t('wrong entries are refused in plain words: zero, too large, a future date, a date before 2000, a very long note, an unknown tenant', async () => {
  const x = await newTenant('Validation');
  await fails('add_old_dues', { p_token: O, p_tenancy: x.tid, p_amount: 0, p_note: null, p_since: null }, /more than zero/);
  await fails('add_old_dues', { p_token: O, p_tenancy: x.tid, p_amount: -5, p_note: null, p_since: null }, /more than zero/);
  await fails('add_old_dues', { p_token: O, p_tenancy: x.tid, p_amount: null, p_note: null, p_since: null }, /more than zero/);
  await fails('add_old_dues', { p_token: O, p_tenancy: x.tid, p_amount: 10000001, p_note: null, p_since: null }, /too large/);
  await fails('add_old_dues', { p_token: O, p_tenancy: x.tid, p_amount: 100, p_note: null, p_since: '2026-11-05' }, /future/);
  await fails('add_old_dues', { p_token: O, p_tenancy: x.tid, p_amount: 100, p_note: null, p_since: '1999-12-31' }, /2000/);
  await fails('add_old_dues', { p_token: O, p_tenancy: x.tid, p_amount: 100, p_note: 'x'.repeat(201), p_since: null }, /too long/);
  await fails('add_old_dues', { p_token: O, p_tenancy: '00000000-0000-0000-0000-000000000000', p_amount: 100, p_note: null, p_since: null }, /Tenant not found/);
  await oldDues(x.tid, 10000000, 'x'.repeat(200), '2000-01-01');                       // the limits themselves are allowed
  assert.equal((await ledger(x.tid)).bills.length, 1);
});
await t('only masters can add old dues; a tenant cannot, not even for their own room', async () => {
  const x = await newTenant('Tenant Try', {}, 'tenanttry');
  await fails('add_old_dues', { p_token: x.token, p_tenancy: x.tid, p_amount: 100, p_note: null, p_since: null }, /not allowed/);
  await oldDues(x.tid, 700, 'by the other master', null, A);
  assert.equal((await ledger(x.tid)).bills.length, 1);
});
await t('move-in with old dues: the tenant and all the rows are saved together, each with its Lodging line', async () => {
  const room = await newRoom(); const mark = await logMark();
  const tid = await rpc('move_in', { p_token: O, p_room: room.id, p_fields: { full_name: 'Years Here', rent: 4000, persons: 1, start_date: '2019-04-01',
    old_dues: [{ amount: 4000, note: 'September', since: '2026-09-05' }, { amount: 4000, note: 'October', since: '2026-10-05' }, { amount: 1500, note: 'Balance of deposit', since: null }] } });
  const l = await ledger(tid); assert.equal(l.bills.length, 3); near(l.totals.principal_due, 9500);
  assert.deepEqual(l.bills.map(b => [b.note, b.due_date, b.interest_waived]), [['September', '2026-09-05', false], ['October', '2026-10-05', false], ['Balance of deposit', TODAY, true]]);
  const lines = await logSince(mark);
  assert.deepEqual(lines.map(x => x.action), ['tenant.moved_in', 'dues.added', 'dues.added', 'dues.added']);
  assert.ok(lines.every(x => x.tenancy_id === tid && x.room_no === room.no));
});
await t('move-in is all-or-nothing: one bad old-dues row (or more than 12 rows) and no tenant is created', async () => {
  const room = await newRoom(); const mark = await logMark();
  const base = { full_name: 'Half Saved', rent: 4000 };
  await fails('move_in', { p_token: O, p_room: room.id, p_fields: { ...base, old_dues: [{ amount: 100, note: 'fine', since: null }, { amount: 100, note: 'future', since: '2030-01-01' }] } }, /future/);
  await fails('move_in', { p_token: O, p_room: room.id, p_fields: { ...base, old_dues: [{ amount: 0, note: 'zero', since: null }] } }, /more than zero/);
  await fails('move_in', { p_token: O, p_room: room.id, p_fields: { ...base, old_dues: Array.from({ length: 13 }, () => ({ amount: 1, note: null, since: null })) } }, /12/);
  await fails('move_in', { p_token: O, p_room: room.id, p_fields: { ...base, old_dues: 'lots' } }, /old dues/i);
  assert.equal((await overview()).by[room.no].status, 'empty');
  assert.equal((await one(`select count(*)::int n from tenancies where room_id = $1`, [room.id])).n, 0);
  assert.equal((await logSince(mark)).length, 0);
  const tid = await rpc('move_in', { p_token: O, p_room: room.id, p_fields: { ...base, old_dues: Array.from({ length: 12 }, (_, i) => ({ amount: 100 + i, note: 'row ' + i, since: null })) } });
  assert.equal((await ledger(tid)).bills.length, 12);
});
await t('money goes to the earliest due date first: dated old dues before the month\'s bill; undated old dues after bills that were due earlier', async () => {
  const x = await newTenant('Order Check');
  await addBill(x.tid, '2026-10-01', 100);                       // due 5 Oct: 4000 + 200
  await addBill(x.tid, M0, 100);                                 // due 5 Nov
  const dated = await oldDues(x.tid, 1000, 'dated', '2026-09-01'); const undated = await oldDues(x.tid, 600, 'undated', null);
  await rpc('update_bill', { p_token: O, p_bill: dated, p_fields: { interest_waived: true } });      // keep the sums round
  await rpc('update_bill', { p_token: O, p_bill: (await ledger(x.tid)).bills.find(b => b.month === '2026-10-01').id, p_fields: { interest_waived: true } });
  await pay(x.tid, 6000, TODAY);
  const l = await ledger(x.tid); const ap = l.payments[0].applied;
  assert.deepEqual(ap.map(a => [a.kind, a.month, Number(a.principal)]), [['previous', OLD, 1000], ['regular', '2026-10-01', 4200], ['previous', OLD, 600], ['regular', M0, 200]]);
  assert.deepEqual(l.bills.map(b => b.status), ['paid', 'paid', 'paid', 'partial']); assert.equal(ap[2].bill_id, undated);
});
await t('a payment dated BEFORE the old dues began waits as advance credit and is used on the day they start', async () => {
  const x = await newTenant('Early Payer');
  await oldDues(x.tid, 3000, 'September', '2026-09-10');
  const p = await pay(x.tid, 1000, '2026-08-15');
  const early = await ledger(x.tid, '2026-08-20');
  assert.equal(early.bills[0].status, 'upcoming'); near(early.totals.outstanding, 0); near(early.totals.credit, 1000); near(early.totals.billed, 0);
  assert.deepEqual(early.payments[0].applied, []);
  const dayBefore = await ledger(x.tid, '2026-09-09'); near(dayBefore.totals.credit, 1000); near(dayBefore.totals.outstanding, 0);
  const start = await ledger(x.tid, '2026-09-10'); near(start.totals.credit, 0); near(start.totals.outstanding, 2000); assert.equal(start.payments[0].applied[0].kind, 'previous');
  const rc = await rpc('receipt', { p_token: O, p_payment: p.id });                     // the receipt is "as on the day paid": the old dues did not exist yet
  assert.deepEqual(rc.applied, []); near(rc.credit_left, 1000); near(rc.balance_after, 0); near(rc.credit_after, 1000);
  const now = await ledger(x.tid); near(now.totals.principal_due, 2000); assert.ok(now.totals.interest_due > 0);
});
await t('old dues can be edited like a bill, but only amount, note, date and the interest switch; the rest stays as it is', async () => {
  const x = await newTenant('Edit Dues'); const id = await oldDues(x.tid, 4000, 'typed wrong', null); const mark = await logMark();
  await rpc('update_bill', { p_token: O, p_bill: id, p_fields: { rent: 4500, note: 'Aug rent', due_date: '2026-08-05', interest_waived: false, persons: 3, new_reading: 500, water_rate: 100, prev_reading: 5, elec_rate: 9 } });
  const b = (await ledger(x.tid)).bills[0];
  near(b.total, 4500); assert.equal(b.note, 'Aug rent'); assert.equal(b.due_date, '2026-08-05'); assert.equal(b.interest_waived, false); assert.ok(b.interest_left > 0);
  assert.equal(b.persons, 0); assert.equal(b.new_reading, null); near(b.water, 0); near(b.electricity, 0); assert.equal(b.reading_verified, false); assert.equal(b.kind, 'previous'); assert.equal(b.month, OLD);
  await fails('update_bill', { p_token: O, p_bill: id, p_fields: { rent: 0 } }, /more than zero/);
  await fails('update_bill', { p_token: O, p_bill: id, p_fields: { due_date: '2031-01-01' } }, /future/);
  const line = (await logSince(mark))[0]; assert.equal(line.action, 'bill.edited'); assert.match(line.summary, /^Changed old dues of Edit Dues, Room \d+: amount ₹4,000 to ₹4,500/);
  assert.match(line.summary, /date 4 Nov 2026 to 5 Aug 2026/); assert.match(line.summary, /late interest off to on/);
  near(line.details.before.rent, 4000); near(line.details.after.rent, 4500);
});
await t('reminders: old dues get no "due in N days" and no meter-reading alerts; overdue alerts say "Old dues ... still unpaid", with interest only when it is charged', async () => {
  const x = await newTenant('Remind Dated', {}, 'reminddated'); const y = await newTenant('Remind Plain', {}, 'remindplain');
  await oldDues(x.tid, 4000, 'Sept', '2026-09-01'); await oldDues(y.tid, 2500, null, null);          // y: due 4 Nov, no interest
  const uid = async (z) => (await one('select user_id from tenancies where id = $1', [z.tid])).user_id;
  const run = async (day) => { await admin.query(`delete from notifications`); await admin.query(`select generate_reminders($1::date)`, [day]); return sql(`select n.user_id, n.kind, n.title, n.body from notifications n order by n.title`); };
  const mine = (rows, id) => rows.filter(r => r.user_id === id);
  for (const day of ['2026-08-29', '2026-08-31', '2026-09-01', '2026-11-01', '2026-11-02', '2026-11-04'])           // before and on the due days: nothing for old dues
    assert.deepEqual(mine(await run(day), await uid(x)).concat(mine(await run(day), await uid(y))).filter(r => r.kind !== 'overdue'), [], day);
  let rows = await run('2026-09-02');                                                                    // 1 day late (dated)
  let n = mine(rows, await uid(x)); assert.equal(n.length, 1); assert.equal(n[0].kind, 'overdue'); assert.equal(n[0].title, 'Old dues are still unpaid');
  assert.match(n[0].body, /^Old dues of ₹4,000 are still unpaid, plus late interest ₹3 = ₹4,003\./);
  rows = await run('2026-11-05');                                                                        // 1 day late (undated): no word about interest
  n = mine(rows, await uid(y)); assert.equal(n.length, 1); assert.equal(n[0].body, 'Old dues of ₹2,500 are still unpaid. Please pay as soon as you can.');
  for (const [day, want] of [['2026-11-07', 1], ['2026-11-11', 1], ['2026-11-18', 1], ['2026-11-25', 1], ['2026-11-06', 0], ['2026-11-12', 0]])
    assert.equal(mine(await run(day), await uid(y)).length, want, day);                                  // days 3, 7, then weekly
  rows = await run('2026-11-05'); const again = await sql(`select generate_reminders('2026-11-05'::date)`); assert.ok(again);
  assert.equal((await sql(`select 1 from notifications where user_id = $1`, [await uid(y)])).length, 1);  // never sent twice
  await admin.query(`delete from notifications`);
});
await t('a tenant cannot send a meter reading for old dues', async () => {
  const x = await newTenant('Reading Try', {}, 'readingtry'); const id = await oldDues(x.tid, 900, null, null);
  await fails('submit_reading', { p_token: x.token, p_bill: id, p_reading: 500 }, /monthly bill/);
  assert.equal((await ledger(x.tid)).bills[0].new_reading, null);
});
await t('approving a deduction: goes to the latest MONTHLY bill by default; with only old dues it says "create the bill first"; old dues can still be picked by hand', async () => {
  const x = await newTenant('Claim Check', {}, 'claimcheck'); const dues = await oldDues(x.tid, 5000, 'old', null);
  await rpc('claim_deduction', { p_token: x.token, p_description: 'Fixed tap', p_amount: 300 });
  let claim = (await rpc('inbox', { p_token: O })).claims.find(k => k.tenancy_id === x.tid);
  assert.deepEqual(claim.bills.map(b => b.kind), ['previous']);
  await fails('decide_deduction', { p_token: O, p_claim: claim.id, p_approve: true, p_amount: null, p_bill: null, p_note: null }, /Create the bill first/);
  const oct = await addBill(x.tid, '2026-10-01', 150); const nov = await addBill(x.tid, M0);
  claim = (await rpc('inbox', { p_token: O })).claims.find(k => k.tenancy_id === x.tid);
  assert.deepEqual(claim.bills.map(b => [b.kind, b.month]), [['regular', M0], ['regular', '2026-10-01'], ['previous', OLD]]);
  await rpc('decide_deduction', { p_token: O, p_claim: claim.id, p_approve: true, p_amount: null, p_bill: null, p_note: null });
  let l = await ledger(x.tid); assert.equal(l.bills.find(b => b.id === nov).adjustments.length, 1); assert.equal(l.bills.find(b => b.id === dues).adjustments.length, 0); assert.ok(oct);
  await rpc('claim_deduction', { p_token: x.token, p_description: 'Painted door', p_amount: 200 });
  claim = (await rpc('inbox', { p_token: O })).claims.find(k => k.tenancy_id === x.tid);
  await rpc('decide_deduction', { p_token: O, p_claim: claim.id, p_approve: true, p_amount: null, p_bill: dues, p_note: null });
  l = await ledger(x.tid); near(l.bills.find(b => b.id === dues).total, 4800);
});
await t('Rooms page: "No bill yet" means no MONTHLY bill; unpaid old dues still colour the room and count in "To collect"', async () => {
  const x = await newTenant('Only Dues'); const y = await newTenant('Paid Dues'); const before = await overview();
  await oldDues(x.tid, 1200, null, '2026-10-01'); const id = await oldDues(y.tid, 800, null, null); await pay(y.tid, 800, TODAY);
  const ov = await overview();
  assert.equal(ov.by[x.room.no].status, 'overdue'); near(ov.by[x.room.no].outstanding, (await ledger(x.tid)).totals.outstanding); assert.equal(ov.by[x.room.no].awaiting_reading, false);
  assert.equal(ov.by[y.room.no].status, 'nobill'); assert.ok(id);
  near(ov.summary.outstanding - before.summary.outstanding, (await ledger(x.tid)).totals.outstanding);
  await addBill(y.tid, M0, 150); await pay(y.tid, 4700, TODAY);                         // 4000 + 200 water + 50 units x 10
  assert.equal((await overview()).by[y.room.no].status, 'paid');
});
await t('monthly bills are untouched by old dues: the month can still be billed, the last reading carries over, the old billing list ignores old dues', async () => {
  const x = await newTenant('Mixed', { opening_reading: 300 }); await oldDues(x.tid, 999, null, '2026-07-01');
  const oct = await addBill(x.tid, '2026-10-01', 360); const nov = await addBill(x.tid, M0);
  const l = await ledger(x.tid); near(l.bills.find(b => b.id === nov).prev_reading, 360); near(l.bills.find(b => b.id === oct).electricity, 600);
  await fails('add_bill', { p_token: O, p_tenancy: x.tid, p_month: M0 }, /already exists/);
  await fails('add_bill', { p_token: O, p_tenancy: x.tid, p_month: OLD }, /Choose a month/);
  const bm = await rpc('billing_month', { p_token: O, p_month: M0 }); assert.equal(bm.rows.find(r => r.tenancy_id === x.tid).bill.id, nov);
  const bmOld = await rpc('billing_month', { p_token: O, p_month: '2026-07-01' }); assert.equal(bmOld.rows.find(r => r.tenancy_id === x.tid).bill, null);
  assert.equal(await rpc('create_bills', { p_token: O, p_month: M0 }) >= 0, true);
  assert.equal((await ledger(x.tid)).bills.filter(b => b.month === M0).length, 1);
});
await t('the tenant sees their old dues as "Old dues" (kind previous) with the note, in their own app', async () => {
  const x = await newTenant('Tenant View', {}, 'tenantview'); await oldDues(x.tid, 4000, 'Aug to Oct rent', '2026-09-01');
  const home = await rpc('tenant_home', { p_token: x.token }); const b = home.ledger.bills[0];
  assert.equal(b.kind, 'previous'); assert.equal(b.note, 'Aug to Oct rent'); near(home.ledger.totals.outstanding, (await ledger(x.tid)).totals.outstanding);
});
await t('nothing the database writes ever says "1900": alerts, Lodging lines, messages', async () => {
  const x = await newTenant('Label Check', {}, 'labelcheck'); const id = await oldDues(x.tid, 4000, 'x', '2026-09-01');
  await pay(x.tid, 500, TODAY); await rpc('add_adjustment', { p_token: O, p_bill: id, p_label: 'Late fee', p_amount: 50 });
  await rpc('update_bill', { p_token: O, p_bill: id, p_fields: { rent: 4100 } });
  for (const d of ['2026-09-02', '2026-09-04', '2026-09-08', '2026-11-04']) await admin.query(`select generate_reminders($1::date)`, [d]);
  const texts = (await sql(`select title || ' ' || coalesce(body, '') as x from notifications union all select summary from audit_log`)).map(r => r.x);
  assert.ok(texts.length > 20); assert.deepEqual(texts.filter(x => /1900|January 19/.test(x)), []);
  await admin.query(`delete from notifications`);
});


// ============================================================ C2 delete a bill
console.log('Delete a bill');
const building = (month = M0, asof = null) => rpc('building_bill', { p_token: O, p_month: month, p_as_of: asof });
await t('a deleted bill is gone from every screen at once: room page, tenant page, tenant app, Rooms boxes, building bill', async () => {
  const x = await newTenant('Delete Me', {}, 'deleteme'); await addBill(x.tid, '2026-10-01', 150); const nov = await addBill(x.tid, M0, 180);   // Nov = 4000 + 200 + 300
  const seen = async (id) => [
    (await rpc('room_detail', { p_token: O, p_room: x.room.id })).current.ledger.bills.some(b => b.id === id),
    (await detail(x.tid)).ledger.bills.some(b => b.id === id),
    (await rpc('tenant_home', { p_token: x.token })).ledger.bills.some(b => b.id === id),
    (await building()).rows.find(r => r.tenancy_id === x.tid).bill_id === id];
  assert.deepEqual(await seen(nov), [true, true, true, true]);
  const before = await overview();
  await rpc('delete_bill', { p_token: A, p_bill: nov });                                 // any master may delete
  assert.deepEqual(await seen(nov), [false, false, false, false]);
  const after = await overview();
  near(before.by[x.room.no].outstanding - after.by[x.room.no].outstanding, 4500); near(before.summary.outstanding - after.summary.outstanding, 4500);
  const row = (await building()).rows.find(r => r.tenancy_id === x.tid); assert.equal(row.no_bill, true); near(row.this_month, 0); near(row.to_pay, after.by[x.room.no].outstanding);
  await fails('delete_bill', { p_token: O, p_bill: nov }, /Bill not found/);
});
await t('payments are never deleted: money paid against the deleted bill moves to the other bills, the rest becomes advance credit', async () => {
  const x = await newTenant('Re Apply'); const oct = await addBill(x.tid, '2026-10-01', 150); const nov = await addBill(x.tid, M0, 180);
  await rpc('update_bill', { p_token: O, p_bill: oct, p_fields: { interest_waived: true } });
  await pay(x.tid, 6000, TODAY);                                                         // Oct 4700 in full, 1300 on Nov
  let l = await ledger(x.tid); near(l.bills.find(b => b.id === nov).outstanding, 3200); near(l.totals.credit, 0);
  const mark = await logMark();
  await rpc('delete_bill', { p_token: O, p_bill: oct });
  l = await ledger(x.tid); assert.equal(l.payments.length, 1); near(l.payments[0].amount, 6000);
  assert.equal(l.bills.length, 1); assert.equal(l.bills[0].status, 'paid'); near(l.totals.outstanding, 0); near(l.totals.credit, 1500);
  const line = (await logSince(mark))[0]; assert.equal(line.action, 'bill.deleted');
  assert.equal(line.summary, 'Deleted the October 2026 bill of Re Apply, Room ' + x.room.no + ', total ₹4,700. ₹4,700 already paid against it stays with the tenant and is used for other bills. The meter reading 150 was removed.');
  near(line.details.bill.total, 4700); near(line.details.paid_against_it, 4700);
  await rpc('delete_bill', { p_token: O, p_bill: nov });
  l = await ledger(x.tid); assert.equal(l.bills.length, 0); assert.equal(l.payments.length, 1); near(l.totals.credit, 6000); near(l.totals.outstanding, 0);
});
await t('an approved deduction on the deleted bill is taken back: the request is marked "removed because the bill was deleted"', async () => {
  const x = await newTenant('Claim Gone', {}, 'claimgone'); const nov = await addBill(x.tid, M0, 180);          // 4000 + 200 + 80 units x 10 = 5000
  await rpc('claim_deduction', { p_token: x.token, p_description: 'Fixed tap', p_amount: 350 });
  const claim = (await rpc('inbox', { p_token: O })).claims.find(k => k.tenancy_id === x.tid);
  await rpc('decide_deduction', { p_token: O, p_claim: claim.id, p_approve: true, p_amount: 300, p_bill: null, p_note: 'Bill was 300' });
  await rpc('add_adjustment', { p_token: O, p_bill: nov, p_label: 'Broken window', p_amount: 250 });
  const mark = await logMark(); const alerts = (await one('select count(*)::int n from notifications')).n;
  await rpc('delete_bill', { p_token: O, p_bill: nov });
  const mine = (await rpc('tenant_home', { p_token: x.token })).claims[0];
  assert.equal(mine.status, 'rejected'); assert.equal(mine.approved, null); assert.equal(mine.decision_note, 'Bill was 300 (removed because the bill was deleted)');
  assert.equal((await one('select count(*)::int n from bill_adjustments a join bills b on b.id = a.bill_id where b.tenancy_id = $1', [x.tid])).n, 0);
  const line = (await logSince(mark))[0];
  assert.match(line.summary, /^Deleted the November 2026 bill of Claim Gone, Room \d+, total ₹4,950\. The meter reading 180 was removed\. Approved deductions of ₹300 were removed\.$/);
  assert.equal((await one('select count(*)::int n from notifications')).n, alerts);     // deleting a bill sends no alert to the tenant
});
await t('a deleted month comes back only when bills are made again; old dues can be deleted too; a tenant cannot delete anything', async () => {
  const x = await newTenant('Come Back', { opening_reading: 100 }, 'comeback'); await addBill(x.tid, '2026-10-01', 150); const nov = await addBill(x.tid, M0, 180);
  await fails('delete_bill', { p_token: x.token, p_bill: nov }, /not allowed/);
  await rpc('delete_bill', { p_token: O, p_bill: nov });
  await admin.query(`select generate_reminders('2026-11-05'::date)`);                    // the daily run on an ordinary day does not bring it back
  assert.equal((await ledger(x.tid)).bills.filter(b => b.month === M0).length, 0);
  assert.ok(await rpc('create_bills', { p_token: O, p_month: M0 }) >= 1);                 // "Create bills for all rooms" does
  const again = (await ledger(x.tid)).bills.find(b => b.month === M0);
  assert.ok(again && again.id !== nov); assert.equal(again.awaiting_reading, true); near(again.prev_reading, 150);
  const dues = await oldDues(x.tid, 900, 'Sept balance', null); const mark = await logMark();
  await rpc('delete_bill', { p_token: O, p_bill: dues });
  assert.equal((await ledger(x.tid)).bills.some(b => b.kind === 'previous'), false);
  assert.equal((await logSince(mark))[0].summary, 'Deleted old dues (Sept balance) of Come Back, Room ' + x.room.no + ', total ₹900.');
  await admin.query(`delete from notifications`);
});

// ============================================================ C3 documents
console.log('Documents');
const JPG = 'data:image/jpeg;base64,/9j/4AAQ' + 'A'.repeat(4000), PDF = 'data:application/pdf;base64,JVBERi0x' + 'B'.repeat(6000);
const addDoc = (tid, title, data, by = O) => rpc('add_tenant_document', { p_token: by, p_tenancy: tid, p_title: title, p_data: data });
const docs = (tid, by = O) => rpc('tenant_documents_list', { p_token: by, p_tenancy: tid });
const docTenant = await newTenant('Doc Tenant', {}, 'doctenant');
await t('a master adds a photo and a PDF; the list shows title, type, size and who added it - never the file itself; the file opens on request', async () => {
  const mark = await logMark();
  const a = await addDoc(docTenant.tid, ' Aadhaar front ', JPG); const b = await addDoc(docTenant.tid, 'Agreement', PDF, A);
  const list = await docs(docTenant.tid);
  assert.deepEqual(list.documents.map(d => [d.title, d.mime, d.added_by]), [['Aadhaar front', 'image/jpeg', 'Bhuvanya'], ['Agreement', 'application/pdf', 'Rakesh']]);
  assert.equal(list.documents[0].size_kb, Math.ceil(JPG.length / 1024)); assert.equal(list.total_kb, Math.ceil(JPG.length / 1024) + Math.ceil(PDF.length / 1024)); assert.ok(list.all_documents_kb >= list.total_kb);
  assert.ok(!JSON.stringify(list).includes('AAAAAAAA') && !JSON.stringify(list).includes('BBBBBBBB'));
  assert.equal(await rpc('get_attachment', { p_token: O, p_id: a.attachment_id }), JPG); assert.equal(await rpc('get_attachment', { p_token: A, p_id: b.attachment_id }), PDF);
  assert.equal((await detail(docTenant.tid)).tenancy.documents, 2);
  const lines = await logSince(mark);
  assert.deepEqual(lines.map(l => [l.action, l.summary]), [
    ['document.added', 'Added a document "Aadhaar front" (photo, 4 KB) for Doc Tenant, Room ' + docTenant.room.no],
    ['document.added', 'Added a document "Agreement" (PDF, 6 KB) for Doc Tenant, Room ' + docTenant.room.no]]);
  assert.ok(!JSON.stringify(lines).includes('AAAAAAAA'));
});
await t('only photos (JPEG, PNG, WebP) and PDFs, within the size limits; a title is needed; at most 10 per tenant', async () => {
  const x = await newTenant('Doc Limits');
  for (const bad of ['hello', 'data:image/gif;base64,R0lGOD', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', 'data:application/pdf,plain', 'data:image/jpegX;base64,AAAA'])
    await fails('add_tenant_document', { p_token: O, p_tenancy: x.tid, p_title: 'x', p_data: bad }, /Only photos/);
  await fails('add_tenant_document', { p_token: O, p_tenancy: x.tid, p_title: 'x', p_data: '' }, /Choose a photo or a PDF/);
  const png = (n) => 'data:image/png;base64,'.padEnd(n, 'A'), pdf = (n) => 'data:application/pdf;base64,'.padEnd(n, 'A');
  await fails('add_tenant_document', { p_token: O, p_tenancy: x.tid, p_title: 'big photo', p_data: png(850001) }, /photo is too large/);
  await fails('add_tenant_document', { p_token: O, p_tenancy: x.tid, p_title: 'big pdf', p_data: pdf(1600001) }, /PDF is too large/);
  await addDoc(x.tid, 'photo at the limit', png(850000)); await addDoc(x.tid, 'pdf at the limit', pdf(1600000)); await addDoc(x.tid, 'webp', 'data:image/webp;base64,UklGR');
  await fails('add_tenant_document', { p_token: O, p_tenancy: x.tid, p_title: '   ', p_data: JPG }, /title/);
  await fails('add_tenant_document', { p_token: O, p_tenancy: x.tid, p_title: 'x'.repeat(81), p_data: JPG }, /too long/);
  await fails('add_tenant_document', { p_token: O, p_tenancy: '00000000-0000-0000-0000-000000000000', p_title: 'x', p_data: JPG }, /Tenant not found/);
  for (let i = 4; i <= 10; i++) await addDoc(x.tid, 'Other ' + i, JPG);
  assert.equal((await docs(x.tid)).documents.length, 10);
  await fails('add_tenant_document', { p_token: O, p_tenancy: x.tid, p_title: 'eleventh', p_data: JPG }, /already has 10 documents/);
});
await t('documents are for masters only: a tenant can neither list, open, add nor delete them - not even their own', async () => {
  const list = await docs(docTenant.tid); const T = docTenant.token;
  await fails('tenant_documents_list', { p_token: T, p_tenancy: docTenant.tid }, /not allowed/);
  await fails('get_attachment', { p_token: T, p_id: list.documents[0].attachment_id }, /not allowed/);
  await fails('add_tenant_document', { p_token: T, p_tenancy: docTenant.tid, p_title: 'x', p_data: JPG }, /not allowed/);
  await fails('delete_tenant_document', { p_token: T, p_doc: list.documents[0].id }, /not allowed/);
  await fails('storage_info', { p_token: T }, /not allowed/);
  const home = JSON.stringify(await rpc('tenant_home', { p_token: T }));
  assert.ok(!home.includes(list.documents[0].attachment_id) && !home.includes('"documents"') && !home.includes('Aadhaar'));
  await admin.query(`update attachments set uploaded_by = (select user_id from tenancies where id = $1) where id = $2`, [docTenant.tid, list.documents[0].attachment_id]);
  await fails('get_attachment', { p_token: T, p_id: list.documents[0].attachment_id }, /not allowed/);      // even if the file were somehow marked as theirs
});
await t('deleting a document removes the file too and is noted in Lodging', async () => {
  const before = await docs(docTenant.tid); const d = before.documents[1]; const mark = await logMark();
  await rpc('delete_tenant_document', { p_token: O, p_doc: d.id });
  assert.deepEqual((await docs(docTenant.tid)).documents.map(z => z.title), ['Aadhaar front']);
  assert.equal((await one('select count(*)::int n from attachments where id = $1', [d.attachment_id])).n, 0);
  assert.equal((await logSince(mark))[0].summary, 'Deleted the document "Agreement" of Doc Tenant, Room ' + docTenant.room.no);
  await fails('delete_tenant_document', { p_token: O, p_doc: d.id }, /not found/);
  await fails('get_attachment', { p_token: O, p_id: d.attachment_id }, /not found/);
});
await t('space meter: database size, the 500 MB limit, and how much of it is documents', async () => {
  const s1 = await rpc('storage_info', { p_token: A });
  assert.ok(s1.database_bytes > 1000000); assert.equal(s1.limit_bytes, 524288000);
  assert.equal(Number(s1.documents_bytes), Number((await one(`select sum(length(a.data)) n from attachments a where a.id in (select attachment_id from tenant_documents)`)).n));
  await addDoc(docTenant.tid, 'Photo', JPG);
  const s2 = await rpc('storage_info', { p_token: O }); assert.equal(s2.documents_bytes - s1.documents_bytes, JPG.length); assert.equal(s2.documents, s1.documents + 1);
});
await t('the backup lists the documents (title, size) but holds no files', async () => {
  const ex = await rpc('export_all', { p_token: O });
  assert.ok(ex.tenant_documents.some(d => d.title === 'Aadhaar front' && d.size_kb > 0)); assert.ok(ex.audit_log.length > 50);
  const text = JSON.stringify(ex); assert.ok(!text.includes('AAAAAAAAAAAAAAAA') && !text.includes('password_hash'));
});

// ============================================================ C5 correcting payments, the Payments view
console.log('Correcting a payment; the Payments view');
const payTenant = await newTenant('Corr Check', {}, 'corrcheck');
await addBill(payTenant.tid, '2026-10-01', 150); await addBill(payTenant.tid, M0, 180);
let corr;
await t('a confirmed payment can be corrected with a reason: the ledger follows, the receipt number stays, Lodging keeps old and new values', async () => {
  corr = await pay(payTenant.tid, 3000, '2026-11-02'); const before = await ledger(payTenant.tid); const mark = await logMark();
  await rpc('edit_payment', { p_token: A, p_payment: corr.id, p_fields: { amount: 3500, paid_on: '2026-11-03' }, p_reason: ' typed wrong ' });
  const l = await ledger(payTenant.tid); const p = l.payments[0];
  near(p.amount, 3500); assert.equal(p.paid_on, '2026-11-03'); assert.equal(p.receipt_no, corr.receipt_no); assert.ok(p.edited_at); assert.equal(p.edit_note, 'typed wrong');
  assert.ok(before.totals.outstanding - l.totals.outstanding > 490 && before.totals.outstanding - l.totals.outstanding < 500.01);   // 500 more paid, a day later
  const line = (await logSince(mark))[0];
  assert.equal(line.action, 'payment.corrected'); assert.equal(line.group_name, 'payments'); assert.equal(line.actor_name, 'Rakesh');
  assert.equal(line.summary, `Corrected receipt ${corr.receipt_no} of Corr Check (Room ${payTenant.room.no}): amount ₹3,000 to ₹3,500, date 2 Nov 2026 to 3 Nov 2026. Reason: typed wrong`);
  near(line.details.before.amount, 3000); near(line.details.after.amount, 3500); assert.equal(line.details.before.paid_on, '2026-11-02'); assert.equal(line.details.after.paid_on, '2026-11-03');
});
await t('the tenant is alerted about the correction and sees it on the payment and the receipt - without the master\'s name', async () => {
  const uid = (await one('select user_id from tenancies where id = $1', [payTenant.tid])).user_id;
  const n = await one(`select * from notifications where user_id = $1 and title = 'Payment corrected'`, [uid]);
  assert.equal(n.kind, 'payment'); assert.equal(n.link, '#/payments'); assert.equal(n.body, `Receipt ${corr.receipt_no} was corrected: amount ₹3,000 to ₹3,500, date 2 Nov 2026 to 3 Nov 2026. Reason: typed wrong`);
  const home = await rpc('tenant_home', { p_token: payTenant.token }); assert.equal(home.ledger.payments[0].edit_note, 'typed wrong'); assert.ok(home.ledger.payments[0].edited_at);
  const rc = await rpc('receipt', { p_token: payTenant.token, p_payment: corr.id });
  assert.equal(rc.receipt_no, corr.receipt_no); near(rc.amount, 3500); assert.equal(rc.paid_on, '2026-11-03'); assert.equal(rc.edit_note, 'typed wrong'); assert.ok(rc.edited_at);
  assert.ok(!JSON.stringify(home).includes('Rakesh') && !JSON.stringify(rc).includes('Rakesh') && !JSON.stringify(n).includes('Rakesh'));
  const staffRc = await rpc('receipt', { p_token: O, p_payment: corr.id }); assert.equal(staffRc.edit_note, 'typed wrong');
});
await t('rules for a correction: reason needed, something must change, same checks as a new payment, confirmed payments only, masters only', async () => {
  const E = (fields, reason = 'r') => ({ p_token: O, p_payment: corr.id, p_fields: fields, p_reason: reason });
  await fails('edit_payment', E({ amount: 3600 }, '  '), /reason/);
  await fails('edit_payment', E({}), /Nothing was changed/);
  await fails('edit_payment', E({ amount: 3500, paid_on: '2026-11-03', method: 'cash' }), /Nothing was changed/);
  await fails('edit_payment', E({ amount: 0 }), /greater than zero/);
  await fails('edit_payment', E({ paid_on: '2026-11-05' }), /future/);
  await fails('edit_payment', E({ method: 'cheque' }), /how it was paid/);
  await fails('edit_payment', { ...E({ amount: 1 }), p_payment: '00000000-0000-0000-0000-000000000000' }, /not found/);
  await fails('edit_payment', { ...E({ amount: 1 }), p_token: payTenant.token }, /not allowed/);
  await rpc('report_payment', { p_token: payTenant.token, p_amount: 700, p_paid_on: TODAY, p_method: 'upi', p_reference: 'W1', p_note: null, p_proof: null });
  const waiting = (await rpc('inbox', { p_token: O })).payments.find(p => p.tenancy_id === payTenant.tid);
  await fails('edit_payment', { ...E({ amount: 800 }), p_payment: waiting.id }, /Only a confirmed payment/);
  const gone = await pay(payTenant.tid, 100, TODAY); await rpc('void_payment', { p_token: O, p_payment: gone.id, p_note: 'test' });
  await fails('edit_payment', { ...E({ amount: 800 }), p_payment: gone.id }, /Only a confirmed payment/);
  near((await ledger(payTenant.tid)).payments[0].amount, 3500);                          // nothing above changed anything
  const mark = await logMark();
  await rpc('edit_payment', E({ method: 'upi', reference: 'UPI77', note: 'paid to my son' }, 'was UPI, not cash'));
  assert.match((await logSince(mark))[0].summary, /: paid by cash to UPI, reference none to UPI77, note changed\. Reason: was UPI, not cash$/);
  const p = (await ledger(payTenant.tid)).payments[0]; assert.equal(p.method, 'upi'); assert.equal(p.reference, 'UPI77'); assert.equal(p.edit_note, 'was UPI, not cash'); assert.equal(p.receipt_no, corr.receipt_no);
});
await t('Payments view: every payment dated in the month in every state; only confirmed ones are totalled; the total equals the "Collected this month" box', async () => {
  const waitingId = (await rpc('inbox', { p_token: O })).payments.find(p => p.tenancy_id === payTenant.tid).id;
  await rpc('report_payment', { p_token: payTenant.token, p_amount: 650, p_paid_on: TODAY, p_method: 'cash', p_reference: null, p_note: null, p_proof: null });
  const second = (await rpc('inbox', { p_token: O })).payments.find(p => p.tenancy_id === payTenant.tid && Number(p.amount) === 650);
  await rpc('decide_payment', { p_token: A, p_payment: second.id, p_approve: false, p_amount: null, p_paid_on: null, p_note: 'Not received' });
  const pm = await rpc('payments_month', { p_token: O, p_month: '2026-11-17' });      // any day of the month
  assert.equal(pm.month, M0);
  const mine = pm.rows.filter(r => r.tenancy_id === payTenant.tid);
  assert.deepEqual(mine.map(r => r.status).sort(), ['approved', 'pending', 'rejected', 'void']);
  const ok = mine.find(r => r.status === 'approved'); assert.equal(ok.room_no, payTenant.room.no); assert.equal(ok.tenant, 'Corr Check'); assert.equal(ok.receipt_no, corr.receipt_no);
  assert.equal(ok.decided_by, 'Bhuvanya'); assert.equal(ok.edited_by, 'Bhuvanya'); assert.equal(ok.edit_note, 'was UPI, not cash'); assert.equal(ok.method, 'upi'); assert.equal(ok.reference, 'UPI77');
  assert.equal(mine.find(r => r.status === 'rejected').decision_note, 'Not received'); assert.equal(mine.find(r => r.status === 'rejected').decided_by, 'Rakesh');
  assert.equal(mine.find(r => r.status === 'pending').id, waitingId); assert.equal(mine.find(r => r.status === 'void').receipt_no.slice(0, 3), 'RB-');
  near(pm.approved_total, pm.rows.filter(r => r.status === 'approved').reduce((s, r) => s + Number(r.amount), 0));
  near(pm.approved_total, (await overview()).summary.collected_this_month);
  assert.equal(pm.approved_count, pm.rows.filter(r => r.status === 'approved').length);
  await fails('payments_month', { p_token: payTenant.token, p_month: M0 }, /not allowed/);
});
await t('a payment belongs to the month of its date: correcting the date moves it to that month, and both totals follow', async () => {
  const x = await newTenant('Month Mover'); const p = await pay(x.tid, 1234, '2026-11-01');
  const nov1 = await rpc('payments_month', { p_token: O, p_month: M0 }), oct1 = await rpc('payments_month', { p_token: O, p_month: '2026-10-01' });
  assert.ok(nov1.rows.some(r => r.id === p.id) && !oct1.rows.some(r => r.id === p.id));
  await rpc('edit_payment', { p_token: O, p_payment: p.id, p_fields: { paid_on: '2026-10-31' }, p_reason: 'paid a day earlier' });
  const nov2 = await rpc('payments_month', { p_token: O, p_month: M0 }), oct2 = await rpc('payments_month', { p_token: O, p_month: '2026-10-01' });
  assert.ok(!nov2.rows.some(r => r.id === p.id) && oct2.rows.some(r => r.id === p.id));
  near(nov1.approved_total - nov2.approved_total, 1234); near(oct2.approved_total - oct1.approved_total, 1234);
  near(nov2.approved_total, (await overview()).summary.collected_this_month);
  assert.equal(oct2.rows.find(r => r.id === p.id).receipt_no, p.receipt_no);              // the number is never changed
});

// ============================================================ C6 the building bill
console.log('The building bill');
await t('one line per tenant living there now, a "Vacant" line per empty room, in room order; a moved-out tenant is not listed', async () => {
  const empty = await newRoom(); const gone = await newTenant('Moved Away'); await addBill(gone.tid, M0, 120); await rpc('move_out', { p_token: O, p_tenancy: gone.tid, p_end_date: TODAY });
  const bb = await building(); const ov = await overview();
  assert.deepEqual(bb.rows.map(r => r.room_no), ov.rooms.map(r => r.room_no));
  assert.deepEqual(bb.rows.find(r => r.room_no === empty.no), { room_id: empty.id, room_no: empty.no, vacant: true });
  assert.equal(bb.rows.find(r => r.room_no === gone.room.no).vacant, true); assert.ok(!bb.rows.some(r => r.tenancy_id === gone.tid));
  assert.equal(bb.summary.vacant, ov.summary.empty_rooms); assert.equal(bb.summary.rooms, bb.rows.length); assert.equal(bb.summary.tenants + bb.summary.vacant, bb.rows.length);
  assert.equal(bb.month, M0); assert.equal(bb.as_of, TODAY);
});
await t('every figure on every line comes from the ledger, and  this month + interest - paid + other dues = to pay', async () => {
  const bb = await building(); let lines = 0, withOther = 0, withInterest = 0, withPaid = 0;
  for (const r of bb.rows.filter(x => !x.vacant)) {
    const l = await ledger(r.tenancy_id); const b = l.bills.find(x => x.kind === 'regular' && x.month === M0); lines++;
    near(r.to_pay, l.totals.outstanding); near(r.credit, l.totals.credit); assert.equal(r.overdue, l.totals.overdue_bills > 0); assert.equal(r.unpaid, l.totals.outstanding > 0);
    near(Number(r.this_month) + Number(r.interest) - Number(r.paid) + Number(r.other_dues), r.to_pay);
    if (!b) { assert.equal(r.no_bill, true); near(r.this_month, 0); near(r.paid, 0); near(r.other_dues, l.totals.outstanding); continue; }
    assert.equal(r.no_bill, false); assert.equal(r.bill_id, b.id); near(r.rent, b.rent); near(r.water, b.water); near(r.electricity, b.electricity);
    near(r.other, b.adjustments.reduce((s, a) => s + Number(a.amount), 0)); near(r.this_month, b.total); near(r.interest, b.interest_charged);
    near(r.paid, Number(b.principal_paid) + Number(b.interest_paid)); near(r.other_dues, l.totals.outstanding - b.outstanding); near(r.bill_interest_left, b.interest_left); assert.equal(r.awaiting_reading, b.awaiting_reading); assert.equal(r.status, b.status);
    if (r.other_dues > 0) withOther++; if (r.interest > 0 || l.totals.interest_due > 0) withInterest++; if (r.paid > 0) withPaid++;
  }
  assert.ok(lines > 20 && withOther > 3 && withInterest > 3 && withPaid > 2, `not enough variety: ${lines} ${withOther} ${withInterest} ${withPaid}`);
});
await t('the totals line is the sum of each column; the summary counts rooms billed, vacant, readings missing', async () => {
  const bb = await building(); const rows = bb.rows.filter(r => !r.vacant);
  for (const k of ['rent', 'water', 'electricity', 'other', 'this_month', 'interest', 'paid', 'other_dues', 'to_pay', 'credit']) near(bb.totals[k], rows.reduce((s, r) => s + Number(r[k]), 0), 0.02);
  near(bb.totals.this_month + bb.totals.interest - bb.totals.paid + bb.totals.other_dues, bb.totals.to_pay, 0.02);
  assert.equal(bb.summary.billed, rows.filter(r => !r.no_bill).length); assert.equal(bb.summary.no_bill, rows.filter(r => r.no_bill).length);
  assert.equal(bb.summary.readings_missing, rows.filter(r => r.awaiting_reading).length); assert.ok(bb.summary.readings_missing > 0 && bb.summary.no_bill > 0);
  near(bb.summary.to_collect, bb.totals.to_pay);
});
await t('the building bill agrees with the Rooms boxes: "Unpaid" adds up to "To collect", "Overdue" lists exactly the rooms in "Rooms overdue"', async () => {
  const late = await newTenant('Late Earlier'); await addBill(late.tid, '2026-10-01', 150);                 // October unpaid, no November bill yet
  const duesOnly = await newTenant('Late Dues Only'); await oldDues(duesOnly.tid, 1200, null, '2026-10-01');    // late only on old dues, no bill yet
  const bb = await building(); const ov = await overview();
  near(bb.rows.filter(r => r.unpaid).reduce((s, r) => s + Number(r.to_pay), 0), ov.summary.outstanding, 0.02); near(bb.summary.to_collect, ov.summary.outstanding, 0.02);
  assert.deepEqual(bb.rows.filter(r => r.overdue).map(r => r.room_no), ov.rooms.filter(r => r.status === 'overdue').map(r => r.room_no));
  assert.equal(bb.summary.overdue_rooms, ov.summary.overdue_rooms);
  const r1 = bb.rows.find(r => r.tenancy_id === late.tid); assert.equal(r1.no_bill, true); assert.equal(r1.overdue, true); assert.ok(r1.other_dues > 4700); near(r1.other_dues, r1.to_pay);
  const onlyDues = bb.rows.find(r => r.tenancy_id === duesOnly.tid); assert.equal(onlyDues.overdue, true); assert.equal(onlyDues.no_bill, true); assert.ok(onlyDues.to_pay > 1200);   // late only on old dues
  const mixed = bb.rows.find(r => r.tenant === 'Mixed'); assert.equal(mixed.no_bill, false); assert.equal(mixed.overdue, true); assert.ok(mixed.other_dues > 999);              // this month not late, earlier dues are
});
await t('advance credit shows when nothing is due; a bill still waiting for its meter reading is flagged', async () => {
  const x = await newTenant('In Advance'); await addBill(x.tid, M0, 120); await pay(x.tid, 6000, TODAY);       // bill 4400, 1600 extra
  const y = await newTenant('No Reading'); await addBill(y.tid, M0);
  const bb = await building(); const rx = bb.rows.find(r => r.tenancy_id === x.tid), ry = bb.rows.find(r => r.tenancy_id === y.tid);
  near(rx.to_pay, 0); near(rx.credit, 1600); assert.equal(rx.status, 'paid'); assert.equal(rx.unpaid, false); near(rx.paid, 4400);
  assert.equal(ry.awaiting_reading, true); assert.equal(rx.awaiting_reading, false); near(ry.electricity, 0);
});
await t('the "as on" date: never before the 1st of the month shown (it is raised); a later date shows more interest; an earlier month can be looked at as it was', async () => {
  const x = await newTenant('As On'); await addBill(x.tid, '2026-10-01', 150); await addBill(x.tid, M0, 180); await pay(x.tid, 1000, '2026-10-20');
  const raised = await building(M0, '2026-10-15'); assert.equal(raised.as_of, M0);
  const now = await building(); const later = await building(M0, '2026-11-20'); assert.equal(later.as_of, '2026-11-20');
  const pick = (bb) => bb.rows.find(r => r.tenancy_id === x.tid);
  assert.ok(pick(later).to_pay > pick(now).to_pay); near(pick(later).to_pay, (await ledger(x.tid, '2026-11-20')).totals.outstanding);
  near(pick(raised).to_pay, (await ledger(x.tid, M0)).totals.outstanding);
  const oct = await building('2026-10-01', '2026-10-10'); assert.equal(oct.month, '2026-10-01'); assert.equal(oct.as_of, '2026-10-10');
  near(pick(oct).paid, 0); near(pick(oct).this_month, 4700); near(pick(oct).to_pay, (await ledger(x.tid, '2026-10-10')).totals.outstanding);
  const octNow = await building('2026-10-01'); assert.equal(octNow.as_of, TODAY); near(pick(octNow).paid, 1000);
  const may = await building('2026-05-01'); assert.ok(!may.rows.some(r => r.tenancy_id === x.tid));       // had not moved in yet (1 June)
  const dec = await building('2026-12-01'); assert.equal(dec.as_of, '2026-12-01'); assert.equal(pick(dec).no_bill, true);
});
await t('the building bill is for masters only', async () => fails('building_bill', { p_token: payTenant.token, p_month: M0 }, /not allowed/));

// ============================================================ C7 share and remind
console.log('Share and remind');
await t('phone numbers for WhatsApp and SMS links: digits only, a leading 0 dropped, 91 added to a 10-digit number', async () => {
  assert.equal(cleanPhone('98765 00001'), '919876500001'); assert.equal(cleanPhone('09876500001'), '919876500001'); assert.equal(cleanPhone('+91 98765-00001'), '919876500001');
  assert.equal(cleanPhone('0091 9876500001'), '919876500001'); assert.equal(cleanPhone('919876500001'), '919876500001'); assert.equal(cleanPhone('+44 7700 900123'), '447700900123');
  assert.equal(cleanPhone('12345'), ''); assert.equal(cleanPhone(''), ''); assert.equal(cleanPhone(null), ''); assert.equal(cleanPhone('call me'), '');
});
await t('"Send app alert + email": one alert with the amount and the late interest, noted in Lodging; a second one within 30 minutes is refused', async () => {
  const x = await newTenant('Remind App', {}, 'remindapp'); await addBill(x.tid, '2026-10-01', 150);
  const uid = (await one('select user_id from tenancies where id = $1', [x.tid])).user_id; const mark = await logMark();
  const l = await ledger(x.tid); const inr = async (n) => (await one('select _inr($1::numeric) x', [n])).x;
  const r = await rpc('send_reminder', { p_token: O, p_tenancy: x.tid, p_channel: 'app' }); near(r.to_pay, l.totals.outstanding);
  const n = await sql(`select * from notifications where user_id = $1 and kind = 'reminder'`, [uid]); assert.equal(n.length, 1);
  assert.equal(n[0].title, 'Payment reminder'); assert.equal(n[0].link, '#/home'); assert.equal(n[0].sent_at, null);
  assert.equal(n[0].body, `A reminder from Ram Bhawan: ${await inr(l.totals.outstanding)} is to be paid (including late interest ${await inr(l.totals.interest_due)}). Please pay as soon as you can.`);
  const line = (await logSince(mark))[0]; assert.equal(line.action, 'reminder.app'); assert.equal(line.group_name, 'tenants');
  assert.equal(line.summary, `Sent an app alert and email to Remind App, Room ${x.room.no}: ${await inr(l.totals.outstanding)} to pay`);
  await fails('send_reminder', { p_token: A, p_tenancy: x.tid, p_channel: 'app' }, /already sent.*wait \d+ more minute/);
  await fails('send_reminder', { p_token: O, p_tenancy: x.tid }, /already sent/);                                       // 'app' is the default
  await admin.query(`update notifications set created_at = now() - interval '31 minutes' where user_id = $1 and kind = 'reminder'`, [uid]);
  await rpc('send_reminder', { p_token: A, p_tenancy: x.tid, p_channel: 'app' });
  assert.equal((await sql(`select 1 from notifications where user_id = $1 and kind = 'reminder'`, [uid])).length, 2);
  assert.equal((await detail(x.tid)).tenancy.last_reminder.channel, 'app');
});
await t('a tenant without a login cannot get an app alert; WhatsApp, text, share and copy only note in Lodging that the message was opened', async () => {
  const x = await newTenant('Remind Phone', { phone: '98765 00001' }); await addBill(x.tid, M0, 120);
  await fails('send_reminder', { p_token: O, p_tenancy: x.tid, p_channel: 'app' }, /no login/);
  assert.equal((await detail(x.tid)).tenancy.last_reminder, null);
  const mark = await logMark(); const alerts = (await one('select count(*)::int n from notifications')).n;
  for (const ch of ['whatsapp', 'sms', 'share', 'copy']) await rpc('send_reminder', { p_token: O, p_tenancy: x.tid, p_channel: ch });
  assert.equal((await one('select count(*)::int n from notifications')).n, alerts);                                       // nothing is sent by the app itself
  const who = `Remind Phone, Room ${x.room.no} (₹4,400 to pay)`;
  assert.deepEqual((await logSince(mark)).map(l => [l.action, l.summary]), [['reminder.whatsapp', 'Opened WhatsApp to remind ' + who], ['reminder.sms', 'Opened a text message to remind ' + who],
    ['reminder.share', 'Opened the share menu to remind ' + who], ['reminder.copy', 'Copied a reminder message for ' + who]]);
  assert.equal((await detail(x.tid)).tenancy.last_reminder.channel, 'copy');
  const row = (await building()).rows.find(r => r.tenancy_id === x.tid); assert.equal(row.last_reminder.channel, 'copy'); assert.ok(row.last_reminder.at); assert.equal(row.phone, '98765 00001');
  await fails('send_reminder', { p_token: O, p_tenancy: x.tid, p_channel: 'pigeon' }, /Unknown way/);
  await fails('send_reminder', { p_token: O, p_tenancy: '00000000-0000-0000-0000-000000000000', p_channel: 'copy' }, /Tenant not found/);
});
await t('no app alert when nothing is due; tenants cannot send reminders', async () => {
  const x = await newTenant('Remind Paid', {}, 'remindpaid');
  await fails('send_reminder', { p_token: O, p_tenancy: x.tid, p_channel: 'app' }, /Nothing is due/);
  await fails('send_reminder', { p_token: x.token, p_tenancy: x.tid, p_channel: 'whatsapp' }, /not allowed/);
  assert.ok(!('last_reminder' in (await rpc('tenant_home', { p_token: x.token })).tenancy));
});

// ============================================================ C8 Lodging
console.log('Lodging');
const lodging = (args = {}, by = O) => rpc('lodging_list', { p_token: by, ...args });
// Runs one action and returns the Lodging lines it wrote.
const lines = async (fn) => { const mark = await logMark(); await fn(); return logSince(mark); };
const sole = async (fn) => { const l = await lines(fn); assert.equal(l.length, 1, 'expected exactly one Lodging line, got ' + l.length + ': ' + l.map(x => x.action).join(', ')); return l[0]; };
const is = (line, action, group, summary, actor = 'Bhuvanya') => {
  assert.equal(line.action, action); assert.equal(line.group_name, group); assert.equal(line.actor_name, actor);
  if (summary instanceof RegExp) assert.match(line.summary, summary); else assert.equal(line.summary, summary);
};
let LT, LR, logBillOct, logBillNov;
await t('rooms and tenants: add / change a room, move in (with login), change details - each writes one clear line; no change, no line', async () => {
  let l = await sole(async () => { LR = await newRoom(); }); is(l, 'room.added', 'tenants', `Added Room ${LR.no} (floor 2), usual rent ₹4,000`); assert.equal(l.room_no, LR.no);
  l = await sole(() => rpc('save_room', { p_token: O, p_id: LR.id, p_room_no: LR.no, p_floor: '2', p_default_rent: 4200, p_notes: 'corner room' }));
  is(l, 'room.edited', 'tenants', `Changed Room ${LR.no}: usual rent ₹4,000 to ₹4,200; notes changed`); near(l.details.before.default_rent, 4000); near(l.details.after.default_rent, 4200);
  assert.equal((await lines(() => rpc('save_room', { p_token: O, p_id: LR.id, p_room_no: LR.no, p_floor: '2', p_default_rent: 4200, p_notes: 'corner room' }))).length, 0);
  const got = await lines(async () => { LT = await rpc('move_in', { p_token: A, p_room: LR.id, p_fields: { full_name: 'Log Tenant', rent: 4000, persons: 2, start_date: '2026-06-01', due_day: 5, opening_reading: 100, deposit: 8000 }, p_login: 'logtenant', p_password: 'secret-pass-1' }); });
  assert.equal(got.length, 2);
  is(got[0], 'tenant.moved_in', 'tenants', `Moved in Log Tenant, Room ${LR.no}: rent ₹4,000, 2 people, from 1 Jun 2026, deposit ₹8,000`, 'Rakesh'); assert.equal(got[0].tenancy_id, LT); assert.equal(got[0].tenant_name, 'Log Tenant');
  is(got[1], 'tenant.login_created', 'tenants', `Made a login for Log Tenant, Room ${LR.no} (login logtenant)`, 'Rakesh');
  l = await sole(() => rpc('save_tenancy', { p_token: O, p_id: LT, p_fields: { rent: 4500, phone: '9000000001', id_proof: 'Aadhaar 1234' } }));
  is(l, 'tenant.edited', 'tenants', `Changed details of Log Tenant, Room ${LR.no}: monthly rent ₹4,000 to ₹4,500; phone none to 9000000001; ID proof note changed`);
  near(l.details.before.rent, 4000); near(l.details.after.rent, 4500); assert.equal(l.details.after.id_proof, 'Aadhaar 1234');
  assert.equal((await lines(() => rpc('save_tenancy', { p_token: O, p_id: LT, p_fields: { rent: 4500, phone: '9000000001' } }))).length, 0);
});
const LTok = (await rpc('login', { p_login: 'logtenant', p_password: 'secret-pass-1' })).token;
await t('bills: one bill, all rooms at once (ONE line with the count), changing a bill, readings sent and checked', async () => {
  let l = await sole(async () => { logBillOct = await rpc('add_bill', { p_token: O, p_tenancy: LT, p_month: '2026-10-01' }); });
  is(l, 'bill.created', 'bills', `Made the October 2026 bill for Log Tenant, Room ${LR.no}: rent ₹4,500 + water ₹200, meter reading still to come`);
  l = await sole(() => rpc('update_bill', { p_token: O, p_bill: logBillOct, p_fields: { new_reading: 150 } }));
  is(l, 'bill.edited', 'bills', `Changed the October 2026 bill of Log Tenant, Room ${LR.no}: meter reading none to 150`); assert.equal(l.details.before.new_reading, null); near(l.details.after.new_reading, 150);
  l = await sole(() => rpc('create_bills', { p_token: A, p_month: M0 }));
  is(l, 'bill.bulk_created', 'bills', /^Made \d+ bills? for November 2026 \(all rooms\)$/, 'Rakesh'); assert.ok(l.details.count >= 1); assert.equal(l.tenancy_id, null);
  assert.equal((await lines(() => rpc('create_bills', { p_token: A, p_month: M0 }))).length, 0);              // nothing made, nothing written
  logBillNov = (await ledger(LT)).bills.find(b => b.month === M0).id;
  l = await sole(() => rpc('submit_reading', { p_token: LTok, p_bill: logBillNov, p_reading: 180, p_photo: JPG }));
  is(l, 'reading.sent', 'bills', 'Sent the meter reading 180 for November 2026 (last 150: 30 units, ₹300), with a photo', 'Log Tenant'); assert.equal(l.actor_role, 'tenant'); assert.equal(l.room_no, LR.no);
  l = await sole(() => rpc('update_bill', { p_token: O, p_bill: logBillNov, p_fields: { reading_verified: true } }));
  is(l, 'reading.checked', 'bills', `Checked the meter reading 180 for the November 2026 bill of Log Tenant, Room ${LR.no} (30 units, ₹300)`);
  assert.equal((await lines(() => rpc('update_bill', { p_token: O, p_bill: logBillNov, p_fields: { reading_verified: true } }))).length, 0);
  l = await sole(() => rpc('update_bill', { p_token: O, p_bill: logBillNov, p_fields: { rent: 4600, persons: 3, due_date: '2026-11-10', interest_waived: true, note: 'agreed' } }));
  is(l, 'bill.edited', 'bills', `Changed the November 2026 bill of Log Tenant, Room ${LR.no}: rent ₹4,500 to ₹4,600; people 2 to 3; due date 5 Nov 2026 to 10 Nov 2026; late interest on to off; note changed`);
  await rpc('update_bill', { p_token: O, p_bill: logBillNov, p_fields: { rent: 4500, persons: 2, due_date: '2026-11-05', interest_waived: false, note: '' } });
});
await t('payments: reported, approved (with the confirmed amount), not confirmed (with the reason), recorded, cancelled', async () => {
  let l = await sole(() => rpc('report_payment', { p_token: LTok, p_amount: 2000, p_paid_on: TODAY, p_method: 'upi', p_reference: 'U1', p_note: null, p_proof: null }));
  is(l, 'payment.requested', 'payments', 'Reported a payment of ₹2,000 by UPI (ref U1), paid on 4 Nov 2026. Waiting to be confirmed.', 'Log Tenant');
  const p1 = (await rpc('inbox', { p_token: O })).payments.find(p => p.tenancy_id === LT);
  l = await sole(() => rpc('decide_payment', { p_token: O, p_payment: p1.id, p_approve: true, p_amount: 1900, p_paid_on: null, p_note: null }));
  is(l, 'payment.approved', 'payments', new RegExp(`^Approved ₹1,900 UPI from Log Tenant \\(Room ${LR.no}\\), receipt RB-2611-\\d{4} \\(reported ₹2,000, confirmed ₹1,900\\)$`));
  near(l.details.reported.amount, 2000); near(l.details.confirmed.amount, 1900);
  await rpc('report_payment', { p_token: LTok, p_amount: 500, p_paid_on: TODAY, p_method: 'cash', p_reference: null, p_note: null, p_proof: null });
  const p2 = (await rpc('inbox', { p_token: O })).payments.find(p => p.tenancy_id === LT);
  l = await sole(() => rpc('decide_payment', { p_token: A, p_payment: p2.id, p_approve: true, p_amount: null, p_paid_on: null, p_note: null }));
  is(l, 'payment.approved', 'payments', new RegExp(`^Approved ₹500 cash from Log Tenant \\(Room ${LR.no}\\), receipt RB-2611-\\d{4}$`), 'Rakesh');
  await rpc('report_payment', { p_token: LTok, p_amount: 700, p_paid_on: TODAY, p_method: 'bank', p_reference: null, p_note: null, p_proof: null });
  const p3 = (await rpc('inbox', { p_token: O })).payments.find(p => p.tenancy_id === LT);
  l = await sole(() => rpc('decide_payment', { p_token: O, p_payment: p3.id, p_approve: false, p_amount: null, p_paid_on: null, p_note: 'Not received' }));
  is(l, 'payment.rejected', 'payments', `Did not confirm ₹700 bank transfer reported by Log Tenant (Room ${LR.no}). Reason: Not received`);
  let rec; l = await sole(async () => { rec = await pay(LT, 1000, '2026-11-03'); });
  is(l, 'payment.recorded', 'payments', `Recorded ₹1,000 cash from Log Tenant (Room ${LR.no}), paid on 3 Nov 2026, receipt ${rec.receipt_no}`);
  l = await sole(() => rpc('void_payment', { p_token: O, p_payment: rec.id, p_note: 'Entered twice' }));
  is(l, 'payment.voided', 'payments', `Cancelled receipt ${rec.receipt_no}: ₹1,000 cash from Log Tenant (Room ${LR.no}), paid on 3 Nov 2026. Reason: Entered twice`);
});
await t('deductions, extra charges and requests: asked, approved, refused, added, removed, updated', async () => {
  let l = await sole(() => rpc('claim_deduction', { p_token: LTok, p_description: 'Fixed tap', p_amount: 350 }));
  is(l, 'claim.requested', 'bills', 'Asked for a deduction of ₹350 for maintenance: Fixed tap', 'Log Tenant');
  const c1 = (await rpc('inbox', { p_token: O })).claims.find(k => k.tenancy_id === LT);
  l = await sole(() => rpc('decide_deduction', { p_token: O, p_claim: c1.id, p_approve: true, p_amount: 300, p_bill: null, p_note: null }));
  is(l, 'claim.approved', 'bills', `Approved a deduction of ₹300 for Log Tenant, Room ${LR.no} (Fixed tap), taken off the November 2026 bill (asked ₹350, approved ₹300)`);
  await rpc('claim_deduction', { p_token: LTok, p_description: 'Painted door', p_amount: 900 });
  const c2 = (await rpc('inbox', { p_token: O })).claims.find(k => k.tenancy_id === LT);
  l = await sole(() => rpc('decide_deduction', { p_token: O, p_claim: c2.id, p_approve: false, p_amount: null, p_bill: null, p_note: 'Not agreed' }));
  is(l, 'claim.rejected', 'bills', `Did not approve the deduction of ₹900 asked by Log Tenant, Room ${LR.no} (Painted door). Reason: Not agreed`);
  l = await sole(() => rpc('add_adjustment', { p_token: O, p_bill: logBillOct, p_label: 'Broken window', p_amount: 250 }));
  is(l, 'adjustment.added', 'bills', `Added a charge of ₹250 (Broken window) to the October 2026 bill of Log Tenant, Room ${LR.no}`);
  l = await sole(() => rpc('add_adjustment', { p_token: A, p_bill: logBillOct, p_label: 'Goodwill', p_amount: -100 }));
  is(l, 'adjustment.added', 'bills', `Subtracted ₹100 (Goodwill) from the October 2026 bill of Log Tenant, Room ${LR.no}`, 'Rakesh');
  const adj = (await ledger(LT)).bills.find(b => b.id === logBillOct).adjustments.find(a => a.label === 'Broken window');
  l = await sole(() => rpc('delete_adjustment', { p_token: O, p_id: adj.id }));
  is(l, 'adjustment.removed', 'bills', `Removed the charge of ₹250 (Broken window) from the October 2026 bill of Log Tenant, Room ${LR.no}`);
  assert.equal((await lines(() => rpc('delete_adjustment', { p_token: O, p_id: adj.id }))).length, 0);
  l = await sole(() => rpc('create_ticket', { p_token: LTok, p_kind: 'maintenance', p_title: 'Fan is noisy', p_details: 'Bedroom', p_photo: null }));
  is(l, 'ticket.created', 'tenants', 'New maintenance request: Fan is noisy', 'Log Tenant');
  const k = (await rpc('inbox', { p_token: O })).tickets.find(x => x.tenancy_id === LT);
  l = await sole(() => rpc('update_ticket', { p_token: O, p_ticket: k.id, p_status: 'in_progress', p_note: 'Electrician on Friday' }));
  is(l, 'ticket.updated', 'tenants', `Request "Fan is noisy" from Log Tenant, Room ${LR.no}: status open to in progress. Note: Electrician on Friday`);
});
await t('logins, settings, team, backup: each change is written with old and new values - and never a password', async () => {
  const uid = (await one('select user_id from tenancies where id = $1', [LT])).user_id;
  let l = await sole(() => rpc('reset_password', { p_token: O, p_user: uid, p_password: 'brand-new-secret' }));
  is(l, 'tenant.password_reset', 'tenants', `Set a new password for Log Tenant, Room ${LR.no} (login logtenant)`);
  l = await sole(() => rpc('set_user_active', { p_token: O, p_user: uid, p_active: false })); is(l, 'tenant.login_switched_off', 'tenants', `Switched off the login of Log Tenant, Room ${LR.no} (logtenant)`);
  assert.equal((await lines(() => rpc('set_user_active', { p_token: O, p_user: uid, p_active: false }))).length, 0);
  l = await sole(() => rpc('set_user_active', { p_token: O, p_user: uid, p_active: true })); is(l, 'tenant.login_switched_on', 'tenants', `Switched on the login of Log Tenant, Room ${LR.no} (logtenant)`);
  l = await sole(() => rpc('update_settings', { p_token: O, p_fields: { interest_rate: 18, grace_days: 2, upi_id: 'rambhawan@upi' } }));
  is(l, 'settings.changed', 'settings', 'Changed settings: late interest 24% to 18%; grace days 0 to 2; UPI ID none to rambhawan@upi'); near(l.details.before.interest_rate, 24); near(l.details.after.interest_rate, 18);
  assert.equal((await lines(() => rpc('update_settings', { p_token: O, p_fields: { interest_rate: 18 } }))).length, 0);
  await rpc('update_settings', { p_token: O, p_fields: { interest_rate: 24, grace_days: 0 } });
  let sunil; l = await sole(async () => { sunil = await rpc('add_admin', { p_token: O, p_login: 'sunil', p_name: 'Sunil', p_email: null, p_password: 'sunil-secret' }); });
  is(l, 'team.added', 'settings', 'Gave master access to Sunil (login sunil)');
  l = await sole(() => rpc('reset_password', { p_token: O, p_user: sunil.id, p_password: 'sunil-secret-2' })); is(l, 'team.password_reset', 'settings', 'Set a new password for Sunil (login sunil)');
  l = await sole(() => rpc('set_user_active', { p_token: O, p_user: sunil.id, p_active: false })); is(l, 'team.switched_off', 'settings', 'Switched off master access of Sunil (login sunil)');
  l = await sole(() => rpc('set_user_active', { p_token: O, p_user: sunil.id, p_active: true })); is(l, 'team.switched_on', 'settings', 'Switched on master access of Sunil (login sunil)');
  l = await sole(() => rpc('export_all', { p_token: O })); is(l, 'backup.downloaded', 'settings', 'Downloaded a backup of all data');
  const all = JSON.stringify(await sql('select * from audit_log'));
  for (const secret of ['secret-pass-1', 'brand-new-secret', 'sunil-secret', 'ownerpass', 'rakesh1', 'pass-', 'password_hash', '$2a$']) assert.ok(!all.includes(secret), 'a password is in Lodging: ' + secret);
});
await t('moving out is written with what is still owed; the daily run writes ONE line as "Automatic", and only when it made bills', async () => {
  const owes = (await ledger(LT)).totals.outstanding; const inr = (await one('select _inr($1::numeric) x', [owes])).x;
  let l = await sole(() => rpc('move_out', { p_token: O, p_tenancy: LT, p_end_date: TODAY }));
  is(l, 'tenant.moved_out', 'tenants', `Moved out Log Tenant from Room ${LR.no} on 4 Nov 2026, still owes ${inr}`);
  const x = await newTenant('Daily Run');
  l = await sole(() => admin.query(`select generate_reminders('2026-11-28'::date)`));                         // the 28th is "bill day" in these tests
  assert.equal(l.action, 'bill.auto_created'); assert.equal(l.actor_id, null); assert.equal(l.actor_name, null); assert.match(l.summary, /^Made \d+ bills? for November 2026 \(daily run\)$/);
  assert.equal((await ledger(x.tid)).bills.filter(b => b.month === M0).length, 1);
  assert.equal((await lines(() => admin.query(`select generate_reminders('2026-11-28'::date)`))).length, 0);
  assert.equal((await lodging({ p_limit: 1, p_group: 'bills' })).rows[0].actor, 'Automatic');
  await admin.query(`delete from notifications`);
});
await t('NOT written: signing in, looking at screens, a tenant changing their own profile or password, automatic reminder alerts, opening a document', async () => {
  const x = await newTenant('Quiet', {}, 'quiet'); await addBill(x.tid, '2026-10-01', 150); const d = await addDoc(x.tid, 'Photo', JPG);
  const got = await lines(async () => {
    const tok = (await rpc('login', { p_login: 'quiet', p_password: 'pass-quiet' })).token; await rpc('login', { p_login: 'quiet', p_password: 'wrong' });
    await rpc('update_profile', { p_token: tok, p_name: 'Quiet', p_email: 'q@example.com', p_phone: '9000000002' });
    await rpc('change_password', { p_token: tok, p_old: 'pass-quiet', p_new: 'pass-quiet-2' });
    await rpc('tenant_home', { p_token: tok }); await rpc('my_notifications', { p_token: tok }); await rpc('mark_notifications_read', { p_token: tok, p_ids: null }); await rpc('send_test_notification', { p_token: tok });
    await rpc('rooms_overview', { p_token: O }); await detail(x.tid); await building(); await rpc('payments_month', { p_token: O, p_month: M0 }); await rpc('inbox', { p_token: O });
    await lodging(); await docs(x.tid); await rpc('get_attachment', { p_token: O, p_id: d.attachment_id }); await rpc('storage_info', { p_token: O }); await rpc('staff_users', { p_token: O });
    await rpc('me', { p_token: O }); await rpc('public_info'); await rpc('receipt', { p_token: O, p_payment: corr.id }); await rpc('billing_month', { p_token: O, p_month: M0 });
    await admin.query(`select generate_reminders('2026-11-06'::date)`); await rpc('logout', { p_token: tok });
  });
  assert.deepEqual(got.map(l => l.action), []);
  await admin.query(`delete from notifications`);
});
await t('the Lodging list: newest first, "Show older" pages without gaps or repeats, group chips, one tenant (History), search, one room', async () => {
  const total = Number((await one('select count(*) n from audit_log')).n); assert.ok(total > 150);
  const p1 = await lodging({ p_limit: 5 }); assert.equal(p1.rows.length, 5); assert.equal(p1.more, true);
  assert.deepEqual(p1.rows.map(r => r.id), [...p1.rows.map(r => r.id)].sort((a, b) => b - a));
  assert.deepEqual(Object.keys(p1.rows[0]).sort(), ['action', 'actor', 'actor_role', 'at', 'details', 'group', 'id', 'room_no', 'summary', 'tenancy_id', 'tenant']);
  const seen = []; let before = null, more = true, pages = 0;
  while (more) { const p = await lodging({ p_limit: 40, p_before: before }); seen.push(...p.rows.map(r => r.id)); more = p.more; before = p.rows.at(-1)?.id ?? null; pages++; assert.ok(pages < 50); }
  assert.equal(seen.length, total); assert.equal(new Set(seen).size, total);
  assert.equal((await lodging()).rows.length, 50); assert.equal((await lodging({ p_limit: 5000 })).rows.length, Math.min(total, 200)); assert.equal((await lodging({ p_limit: 0 })).rows.length, 1);
  for (const g of ['payments', 'bills', 'tenants', 'settings']) { const p = await lodging({ p_limit: 200, p_group: g }); assert.ok(p.rows.length > 3 && p.rows.every(r => r.group === g), g); }
  const hist = await lodging({ p_limit: 200, p_tenancy: LT }); assert.ok(hist.rows.length >= 25 && hist.rows.every(r => r.tenancy_id === LT && r.room_no === LR.no)); assert.equal(hist.more, false);
  assert.equal(hist.rows.at(-1).action, 'tenant.moved_in'); assert.equal(hist.rows[0].action, 'tenant.moved_out');
  const histPay = await lodging({ p_tenancy: LT, p_group: 'payments' }); assert.equal(histPay.rows.length, 8); assert.ok(histPay.rows.some(r => r.actor === 'Log Tenant' && r.actor_role === 'tenant'));
  const found = await lodging({ p_q: 'fan is NOISY' }); assert.equal(found.rows.length, 2); assert.ok(found.rows.every(r => /Fan is noisy/.test(r.summary)));
  assert.ok((await lodging({ p_limit: 200, p_q: 'Rakesh' })).rows.every(r => r.actor === 'Rakesh' || /Rakesh/.test(r.summary)));
  const byRoom = await lodging({ p_limit: 200, p_q: 'room:' + LR.no }); assert.ok(byRoom.rows.length >= hist.rows.length + 2 && byRoom.rows.every(r => r.room_no === LR.no));
  const both = await lodging({ p_limit: 200, p_q: 'room:' + LR.no + String.fromCharCode(10) + 'fan is noisy' }); assert.equal(both.rows.length, 2); assert.ok(both.rows.every(r => r.room_no === LR.no && /Fan is noisy/.test(r.summary)));
  assert.equal((await lodging({ p_q: 'room:no-such-room' + String.fromCharCode(10) + 'fan is noisy' })).rows.length, 0);
  const pct = await lodging({ p_limit: 200, p_q: '%' }); assert.ok(pct.rows.length >= 1 && pct.rows.length < 10 && pct.rows.every(r => r.summary.includes('%')));       // % is a plain character, not "anything"
  assert.equal((await lodging({ p_q: 'no such words anywhere' })).rows.length, 0); assert.equal((await lodging({ p_q: 'no such words anywhere' })).more, false);
});
await t('Lodging is for masters: every master sees it; a tenant gets nothing, and their own app never carries a master\'s name', async () => {
  assert.equal((await lodging({ p_limit: 3 }, A)).rows.length, 3);
  await fails('lodging_list', { p_token: payTenant.token }, /not allowed/);
  await fails('lodging_list', { p_token: payTenant.token, p_tenancy: payTenant.tid }, /not allowed/);
  await fails('lodging_list', { p_token: 'made-up' }, /SESSION_EXPIRED/);
  await assert.rejects(c.query('select * from audit_log'), /permission denied/); await assert.rejects(c.query(`select _log(null, 'x.y', 'z')`), /permission denied/);
  for (const tok of [payTenant.token, docTenant.token]) { const home = JSON.stringify(await rpc('tenant_home', { p_token: tok })); assert.ok(!/Rakesh|Bhuvanya|Sunil/.test(home)); }
});
await t('none of the new master-only actions can be called by a tenant', async () => {
  const T = payTenant.token, tid = payTenant.tid, bill = (await ledger(tid)).bills[0].id;
  for (const [fn, a] of [['add_old_dues', { p_tenancy: tid, p_amount: 1, p_note: null, p_since: null }], ['building_bill', { p_month: M0 }], ['payments_month', { p_month: M0 }],
    ['edit_payment', { p_payment: corr.id, p_fields: { amount: 1 }, p_reason: 'x' }], ['tenant_documents_list', { p_tenancy: tid }], ['add_tenant_document', { p_tenancy: tid, p_title: 'x', p_data: JPG }],
    ['delete_tenant_document', { p_doc: tid }], ['send_reminder', { p_tenancy: tid, p_channel: 'copy' }], ['storage_info', {}], ['lodging_list', {}],
    ['delete_bill', { p_bill: bill }], ['update_bill', { p_bill: bill, p_fields: { rent: 1 } }], ['add_adjustment', { p_bill: bill, p_label: 'x', p_amount: -5 }], ['void_payment', { p_payment: corr.id, p_note: 'x' }]])
    await fails(fn, { p_token: T, ...a }, /not allowed/);
});
await t('a Lodging line can never be changed or deleted, not even by the database owner; deleting a person keeps their lines', async () => {
  const id = (await one('select max(id) m from audit_log')).m;
  await assert.rejects(admin.query(`update audit_log set summary = 'something else' where id = $1`, [id]), /cannot be changed/);
  await assert.rejects(admin.query(`update audit_log set at = now(), details = '{}' where id = $1`, [id]), /cannot be changed/);
  await assert.rejects(admin.query(`delete from audit_log where id = $1`, [id]), /cannot be deleted/);
  await assert.rejects(admin.query(`delete from audit_log`), /cannot be deleted/);
  const S = (await rpc('login', { p_login: 'sunil', p_password: 'sunil-secret-2' })).token; const r = await newRoom();
  const line = await sole(() => rpc('save_room', { p_token: S, p_id: r.id, p_room_no: r.no, p_floor: '9', p_default_rent: 4000, p_notes: null })); assert.equal(line.actor_name, 'Sunil'); assert.ok(line.actor_id);
  const n = Number((await one('select count(*) n from audit_log')).n);
  await admin.query(`delete from users where login_id = 'sunil'`);
  const kept = await one('select * from audit_log where id = $1', [line.id]);
  assert.equal(kept.actor_id, null); assert.equal(kept.actor_name, 'Sunil'); assert.equal(kept.summary, line.summary); assert.equal(String(kept.at), String(line.at));
  assert.equal(Number((await one('select count(*) n from audit_log')).n), n);
  assert.equal((await lodging({ p_limit: 1, p_q: 'Changed Room ' + r.no })).rows[0].actor, 'Sunil');
});

// ============================================================ starting fresh (must stay last)
console.log('Starting fresh');
await t('wipe: also clears documents and Lodging, then writes the single line "All test data was deleted"', async () => {
  const cnt = async (tb) => Number((await one(`select count(*) n from ${tb}`)).n);
  assert.ok(await cnt('tenant_documents') > 5 && await cnt('audit_log') > 150 && await cnt('attachments') > 5);
  await admin.query(`select wipe_everything_except_owner('yes, delete all rooms, tenants and payments')`);
  for (const tb of ['tenant_documents', 'attachments', 'bills', 'payments', 'tenancies', 'rooms']) assert.equal(await cnt(tb), 0, tb);
  const left = await sql('select * from audit_log'); assert.equal(left.length, 1);
  assert.equal(left[0].summary, 'All test data was deleted'); assert.equal(left[0].action, 'data.wiped'); assert.equal(left[0].actor_name, null); assert.equal(left[0].group_name, 'settings');
  await assert.rejects(admin.query(`delete from audit_log`), /cannot be deleted/);            // the lock is back on after the wipe
  const again = (await rpc('login', { p_login: 'owner', p_password: 'ownerpass' })).token;
  assert.deepEqual((await rpc('lodging_list', { p_token: again })).rows.map(r => [r.actor, r.summary]), [['Automatic', 'All test data was deleted']]);
  assert.equal((await rpc('me', { p_token: again })).settings.schema_version, 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
await c.end(); await admin.end(); process.exit(fail ? 1 : 0);
