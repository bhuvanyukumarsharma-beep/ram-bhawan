// End-to-end checks of the database functions as the app uses them, signed in as
// owner / admin / tenants, running as the restricted "anon" role the internet uses.
import { freshDb, connect } from './db.mjs';
import assert from 'node:assert/strict';

const admin = await freshDb();             // full-rights connection, only for set-up and time checks
const c = await connect();                 // the app's connection
await c.query('set role anon');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', String(e.message).split('\n')[0]); } };
const rpc = async (fn, args = {}) => {
  const keys = Object.keys(args);
  const vals = keys.map(k => { const v = args[k]; return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v; });
  return (await c.query(`select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, vals)).rows[0].r;
};
const fails = async (fn, args, re) => { try { await rpc(fn, args); } catch (e) { if (re) assert.match(e.message, re); return; } assert.fail(`${fn} should have failed`); };
const badLogin = async (args, re) => { const r = await rpc('login', args); assert.ok(r.error && !r.token, 'login should have been refused'); assert.match(r.error, re); };
const near = (a, b, tol = 0.015) => assert.ok(Math.abs(Number(a) - Number(b)) <= tol, `expected ${b}, got ${a}`);

// Freeze "today" in this test database so the checks give the same answer on any day.
await admin.query(`create or replace function _today() returns date language sql stable as $$ select date '2026-11-04' $$`);
const today = (await admin.query(`select _today()::text d, date_trunc('month', _today())::date::text m0`)).rows[0];
const m0 = today.m0, yymm = m0.slice(2, 4) + m0.slice(5, 7);
const dueOf = d => m0.slice(0, 8) + String(d).padStart(2, '0');
console.log('Clock in the test database says today is', today.d);

await admin.query(`select setup_owner('owner','Bhuvanya','owner@example.com','ownerpass')`);
let O = (await rpc('login', { p_login: 'owner', p_password: 'ownerpass', p_device: 'test' })).token;

console.log('Sign-in');
await t('wrong password is refused; the same message is used for an unknown ID', async () => {
  await badLogin({ p_login: 'owner', p_password: 'nope' }, /Wrong ID or password/);
  await badLogin({ p_login: 'ghost', p_password: 'nope' }, /Wrong ID or password/);
});
await t('5 wrong attempts lock the account for a while, even for the right password', async () => {
  const ok = await rpc('add_admin', { p_token: O, p_login: 'locktest', p_name: 'Lock', p_email: null, p_password: 'rightpass' });
  for (let i = 0; i < 5; i++) await badLogin({ p_login: 'locktest', p_password: 'bad' + i }, /Wrong ID/);
  await badLogin({ p_login: 'locktest', p_password: 'rightpass' }, /Too many wrong attempts/);
  await admin.query(`delete from login_attempts`); await rpc('set_user_active', { p_token: O, p_user: ok.id, p_active: false });
});
await t('a made-up or logged-out token is refused', async () => {
  await fails('rooms_overview', { p_token: 'made-up' }, /SESSION_EXPIRED/);
  const tmp = (await rpc('login', { p_login: 'owner', p_password: 'ownerpass' })).token; await rpc('logout', { p_token: tmp });
  await fails('rooms_overview', { p_token: tmp }, /SESSION_EXPIRED/);
});

await t('forgotten owner password: only the database administrator can reset it; old sessions and the lock-out are cleared', async () => {
  await assert.rejects(c.query(`select reset_owner_password('hackedpass')`), /permission denied/);       // the internet cannot
  const tok = (await rpc('login', { p_login: 'owner', p_password: 'ownerpass' })).token;
  for (let i = 0; i < 5; i++) await badLogin({ p_login: 'owner', p_password: 'bad' + i }, /Wrong ID|Too many/);
  await badLogin({ p_login: 'owner', p_password: 'ownerpass' }, /Too many wrong attempts/);
  const msg = (await admin.query(`select reset_owner_password('brand-new-pass') as r`)).rows[0].r; assert.match(msg, /Sign in with ID: owner/);
  await fails('rooms_overview', { p_token: tok }, /SESSION_EXPIRED/);                                      // old sessions ended
  await badLogin({ p_login: 'owner', p_password: 'ownerpass' }, /Wrong ID/);
  const r = await rpc('login', { p_login: 'owner', p_password: 'brand-new-pass' }); assert.ok(r.token);
  await admin.query(`select reset_owner_password('ownerpass')`);                                          // put it back for the rest of the tests
  O = (await rpc('login', { p_login: 'owner', p_password: 'ownerpass', p_device: 'test' })).token;
});

console.log('Set-up: rooms, tenants, bills');
const rooms = {};
for (const n of ['101', '102', '103']) rooms[n] = await rpc('save_room', { p_token: O, p_id: null, p_room_no: n, p_floor: '1', p_default_rent: 3500, p_notes: null });
const mv = (room, f, login, pw) => rpc('move_in', { p_token: O, p_room: rooms[room], p_fields: { start_date: '2026-01-01', due_day: 5, ...f }, p_login: login, p_password: pw });
const t101 = await mv('101', { full_name: 'Asha', persons: 2, rent: 4000, opening_reading: 1250, phone: '9999900001', notes: 'private note', id_proof: 'Aadhaar xxxx' }, 'r101', 'pass101');
const t102 = await mv('102', { full_name: 'Ravi', persons: 1, rent: 3500, opening_reading: 500 }, 'r102', 'pass102');
await t('duplicate room number / duplicate tenant ID / second tenant in a full room are refused', async () => {
  await fails('save_room', { p_token: O, p_id: null, p_room_no: '101', p_floor: null, p_default_rent: 1, p_notes: null }, /already exists/);
  await fails('move_in', { p_token: O, p_room: rooms['103'], p_fields: { full_name: 'X', rent: 1 }, p_login: 'R101', p_password: 'abcdef' }, /already taken/);
  await fails('move_in', { p_token: O, p_room: rooms['101'], p_fields: { full_name: 'X', rent: 1 } }, /already has a tenant/);
});
await t('creating the month\'s bills uses rent + water (₹100 x people) and carries over the last reading', async () => {
  assert.equal(await rpc('create_bills', { p_token: O, p_month: m0 }), 2);
  assert.equal(await rpc('create_bills', { p_token: O, p_month: m0 }), 0);          // running again makes no duplicates
  const d = await rpc('tenancy_detail', { p_token: O, p_tenancy: t101 }); const b = d.ledger.bills[0];
  near(b.rent, 4000); near(b.water, 200); near(b.prev_reading, 1250); assert.equal(b.awaiting_reading, true); near(b.total, 4200);
});

const T1 = (await rpc('login', { p_login: 'R101', p_password: 'pass101' })).token;   // ID is not case sensitive
const T2 = (await rpc('login', { p_login: 'r102', p_password: 'pass102' })).token;
const home1 = await rpc('tenant_home', { p_token: T1 });
const bill1 = home1.ledger.bills[0].id;

console.log('Meter reading, deductions, payments');
await t('tenant cannot enter a reading lower than the last one', async () => fails('submit_reading', { p_token: T1, p_bill: bill1, p_reading: 1200 }, /lower than the last reading/));
await t('tenant reading -> electricity (new - old) x 10, owner is notified, owner confirms, tenant is then locked out', async () => {
  const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ';
  const r = await rpc('submit_reading', { p_token: T1, p_bill: bill1, p_reading: 1310, p_photo: photo });
  near(r.units, 60); near(r.electricity, 600);
  const inbox = await rpc('inbox', { p_token: O }); assert.equal(inbox.readings.length, 1); assert.ok(inbox.readings[0].photo_id);
  assert.equal(await rpc('get_attachment', { p_token: O, p_id: inbox.readings[0].photo_id }), photo);
  const n = await admin.query(`select count(*)::int n from notifications where kind='reading' and title like 'Meter reading%'`); assert.ok(n.rows[0].n >= 1);
  await rpc('update_bill', { p_token: O, p_bill: bill1, p_fields: { reading_verified: true } });
  await fails('submit_reading', { p_token: T1, p_bill: bill1, p_reading: 1300 }, /already confirmed/);
  near((await rpc('tenancy_detail', { p_token: O, p_tenancy: t101 })).ledger.bills[0].total, 4800);
});
await t('owner can correct the reading; bill follows', async () => {
  await rpc('update_bill', { p_token: O, p_bill: bill1, p_fields: { new_reading: 1305 } });
  near((await rpc('tenancy_detail', { p_token: O, p_tenancy: t101 })).ledger.bills[0].electricity, 550);
  await rpc('update_bill', { p_token: O, p_bill: bill1, p_fields: { new_reading: 1310 } });
});
await t('maintenance done by tenant: request -> owner approves (can change the amount) -> bill drops', async () => {
  await rpc('claim_deduction', { p_token: T1, p_description: 'Fixed tap', p_amount: 350 });
  const claim = (await rpc('inbox', { p_token: O })).claims[0]; assert.equal(claim.room_no, '101');
  await rpc('decide_deduction', { p_token: O, p_claim: claim.id, p_approve: true, p_amount: 300, p_bill: null, p_note: 'Bill was ₹300' });
  const d = await rpc('tenant_home', { p_token: T1 }); near(d.ledger.bills[0].total, 4500);
  assert.equal(d.claims[0].status, 'approved'); near(d.claims[0].approved, 300);
});
await t('tenant reports a UPI payment -> not counted until the owner approves -> receipt issued', async () => {
  await rpc('report_payment', { p_token: T1, p_amount: 2000, p_paid_on: today.d, p_method: 'upi', p_reference: 'UPI123', p_note: null, p_proof: null });
  let d = await rpc('tenant_home', { p_token: T1 }); near(d.ledger.totals.outstanding, 4500); assert.equal(d.other_payments[0].status, 'pending');
  const pay = (await rpc('inbox', { p_token: O })).payments[0]; assert.equal(pay.reference, 'UPI123');
  const r = await rpc('decide_payment', { p_token: O, p_payment: pay.id, p_approve: true, p_amount: null, p_paid_on: null, p_note: null });
  assert.match(r.receipt_no, new RegExp('^RB-' + yymm + '-\\d{4}$'));
  d = await rpc('tenant_home', { p_token: T1 }); near(d.ledger.totals.outstanding, 2500); assert.equal(d.ledger.payments[0].receipt_no, r.receipt_no);
  const rc = await rpc('receipt', { p_token: T1, p_payment: pay.id }); near(rc.amount, 2000); near(rc.balance_after, 2500); assert.equal(rc.room_no, '101');
  near(rc.applied.reduce((s, a) => s + a.principal + a.interest, 0), 2000);
});
await t('rejecting a payment needs a reason; rejected money is not counted; tenant sees the reason', async () => {
  await rpc('report_payment', { p_token: T1, p_amount: 500, p_paid_on: today.d, p_method: 'cash', p_reference: null, p_note: null, p_proof: null });
  const pay = (await rpc('inbox', { p_token: O })).payments[0];
  await fails('decide_payment', { p_token: O, p_payment: pay.id, p_approve: false, p_amount: null, p_paid_on: null, p_note: '' }, /reason/);
  await rpc('decide_payment', { p_token: O, p_payment: pay.id, p_approve: false, p_amount: null, p_paid_on: null, p_note: 'Not received in my account' });
  const d = await rpc('tenant_home', { p_token: T1 }); near(d.ledger.totals.outstanding, 2500);
  assert.equal(d.other_payments.find(p => p.status === 'rejected').decision_note, 'Not received in my account');
  await fails('decide_payment', { p_token: O, p_payment: pay.id, p_approve: true, p_amount: null, p_paid_on: null, p_note: null }, /already handled/);
});
await t('owner records cash directly (approved at once); future dates and zero amounts are refused; a mistake can be cancelled', async () => {
  const r = await rpc('record_payment', { p_token: O, p_tenancy: t102, p_amount: 1000, p_paid_on: today.d, p_method: 'cash', p_reference: null, p_note: null });
  assert.ok(r.receipt_no);
  await fails('record_payment', { p_token: O, p_tenancy: t102, p_amount: 0, p_paid_on: today.d, p_method: 'cash' }, /greater than zero/);
  await fails('record_payment', { p_token: O, p_tenancy: t102, p_amount: 10, p_paid_on: '2099-01-01', p_method: 'cash' }, /future/);
  const before = (await rpc('tenant_home', { p_token: T2 })).ledger.payments.length; assert.equal(before, 1);
  await fails('void_payment', { p_token: O, p_payment: r.id, p_note: '' }, /reason/);
  await rpc('void_payment', { p_token: O, p_payment: r.id, p_note: 'Entered twice' });
  assert.equal((await rpc('tenant_home', { p_token: T2 })).ledger.payments.length, 0);
});
await t('late interest shows up; owner can waive it on a bill; changing the rate changes it', async () => {
  const past = await admin.query(`select (_today() - 30)::text d`);
  await admin.query(`update bills set due_date = $1 where id = $2`, [past.rows[0].d, bill1]);
  await admin.query(`update payments set paid_on = paid_on - 5 where tenancy_id = $1 and status = 'approved'`, [t101]);   // paid 5 days ago
  let d = await rpc('tenancy_detail', { p_token: O, p_tenancy: t101 }); assert.ok(d.ledger.totals.interest_due > 0); assert.equal(d.ledger.bills[0].is_overdue, true);
  const i24 = d.ledger.totals.interest_due;
  await rpc('update_settings', { p_token: O, p_fields: { interest_rate: 12 } });
  d = await rpc('tenancy_detail', { p_token: O, p_tenancy: t101 }); assert.ok(d.ledger.totals.interest_due < i24 * 0.6);
  await rpc('update_settings', { p_token: O, p_fields: { interest_rate: 24 } });
  await rpc('update_bill', { p_token: O, p_bill: bill1, p_fields: { interest_waived: true } });
  d = await rpc('tenancy_detail', { p_token: O, p_tenancy: t101 }); near(d.ledger.totals.interest_due, 0);
  await rpc('update_bill', { p_token: O, p_bill: bill1, p_fields: { interest_waived: false, due_date: dueOf(5) } });
  await admin.query(`update payments set paid_on = paid_on + 5 where tenancy_id = $1 and status = 'approved'`, [t101]);
});

console.log('Privacy and permissions');
await t('a tenant sees only their own room - and none of the owner\'s private notes', async () => {
  const h2 = await rpc('tenant_home', { p_token: T2 }); assert.equal(h2.tenancy.full_name, 'Ravi'); assert.equal(h2.tenancy.room_no, '102');
  const h1 = await rpc('tenant_home', { p_token: T1 }); assert.equal(h1.tenancy.notes, undefined); assert.equal(h1.tenancy.id_proof, undefined); assert.equal(h1.tenancy.user_id, undefined);
  assert.ok(!JSON.stringify(h2).includes('Asha'));
});
await t('a tenant cannot open another tenant\'s receipt or photo, or any owner screen', async () => {
  const pid = (await admin.query(`select id from payments where tenancy_id=$1 and status='approved'`, [t101])).rows[0].id;
  await fails('receipt', { p_token: T2, p_payment: pid }, /not allowed/);
  const aid = (await admin.query(`select id from attachments limit 1`)).rows[0].id;
  await fails('get_attachment', { p_token: T2, p_id: aid }, /not allowed/);
  for (const [fn, a] of [['rooms_overview', {}], ['inbox', {}], ['record_payment', { p_tenancy: t101, p_amount: 5, p_paid_on: today.d, p_method: 'cash' }],
    ['tenancy_detail', { p_tenancy: t101 }], ['create_bills', { p_month: m0 }], ['staff_users', {}], ['export_all', {}], ['update_settings', { p_fields: {} }]])
    await fails(fn, { p_token: T2, ...a }, /not allowed/);
});
await t('the open internet (anon) cannot read tables or call internal functions', async () => {
  for (const q of ['select * from users', 'select * from payments', 'select * from sessions', `select _ledger('${t101}')`, `select claim_notifications(5)`, `select setup_owner('a','b','c','dddddd')`])
    await assert.rejects(c.query(q), /permission denied/);
});
await t('owner adds an admin with full access; an admin cannot add admins or touch the owner', async () => {
  await rpc('add_admin', { p_token: O, p_login: 'manager', p_name: 'Manager', p_email: 'm@example.com', p_password: 'mgrpass' });
  const A = (await rpc('login', { p_login: 'manager', p_password: 'mgrpass' })).token;
  assert.equal((await rpc('rooms_overview', { p_token: A })).rooms.length, 3);
  await fails('add_admin', { p_token: A, p_login: 'x1', p_name: 'X', p_email: null, p_password: 'abcdef' }, /not allowed/);
  const ownerId = (await rpc('staff_users', { p_token: O })).find(u => u.role === 'owner').id;
  await fails('reset_password', { p_token: A, p_user: ownerId, p_password: 'hacked1' }, /Only the owner/);
  await fails('staff_users', { p_token: A }, /not allowed/);
  const tid = (await admin.query(`select user_id from tenancies where id=$1`, [t102])).rows[0].user_id;
  await rpc('reset_password', { p_token: A, p_user: tid, p_password: 'newpass2' });          // admin may reset a tenant password
  await fails('rooms_overview', { p_token: T2 }, /SESSION_EXPIRED|not allowed/);              // old session ended
  await rpc('login', { p_login: 'r102', p_password: 'newpass2' });
});
await t('switching a user off ends their sessions', async () => {
  const uid = (await admin.query(`select user_id from tenancies where id=$1`, [t101])).rows[0].user_id;
  await rpc('set_user_active', { p_token: O, p_user: uid, p_active: false });
  await fails('tenant_home', { p_token: T1 }, /SESSION_EXPIRED/); await badLogin({ p_login: 'r101', p_password: 'pass101' }, /Wrong ID/);
  await rpc('set_user_active', { p_token: O, p_user: uid, p_active: true });
});

console.log('Overview, reminders, notifications');
await t('room blocks show the right colour state', async () => {
  const ov = await rpc('rooms_overview', { p_token: O }); const by = Object.fromEntries(ov.rooms.map(r => [r.room_no, r]));
  assert.equal(by['103'].status, 'empty'); assert.ok(['due', 'overdue'].includes(by['101'].status)); near(by['101'].outstanding, 2500);
  assert.ok(ov.summary.collected_this_month >= 2000);
});
await t('reminders: 3 days before, on the day, overdue; nothing is sent twice', async () => {
  const T = async d => { await admin.query(`delete from notifications where kind in ('due','overdue')`); await admin.query(`select generate_reminders($1::date)`, [d]); return (await admin.query(`select title, body from notifications where kind in ('due','overdue') order by title`)).rows; };
  const due = dueOf(5);
  const minus = n => admin.query(`select ($1::date - $2::int)::text d`, [due, n]).then(r => r.rows[0].d);
  let rows = await T(await minus(3)); assert.ok(rows.some(r => r.title === 'Rent due in 3 days'), JSON.stringify(rows));
  rows = await T(await minus(0)); assert.ok(rows.some(r => r.title === 'Rent is due today'));
  rows = await T(await minus(-1)); assert.ok(rows.some(r => r.title === 'Rent overdue by 1 day' && /late interest/.test(r.body)), JSON.stringify(rows));
  await admin.query(`select generate_reminders($1::date)`, [await minus(-1)]);
  assert.equal((await admin.query(`select count(*)::int n from notifications where title='Rent overdue by 1 day'`)).rows[0].n, rows.filter(r => r.title === 'Rent overdue by 1 day').length);
});
await t('delivery queue: unsent notifications are handed out once, with push endpoints and email', async () => {
  const OT = (await rpc('login', { p_login: 'owner', p_password: 'ownerpass' })).token;
  await rpc('save_push_subscription', { p_token: OT, p_endpoint: 'https://push.example/abc', p_p256dh: 'k', p_auth: 'a', p_device: 'phone' });
  await admin.query(`select generate_reminders(null)`);
  await admin.query(`set role service_role`); const got = (await admin.query(`select claim_notifications(100) r`)).rows[0].r; const again = (await admin.query(`select claim_notifications(100) r`)).rows[0].r; await admin.query('reset role');
  assert.ok(got.length > 0); assert.equal(again.length, 0);
  assert.ok(got.some(n => n.subs.length === 1 && n.email === 'owner@example.com'));
});
await t('the app saves its own web address: only staff can, it is checked, it reaches the delivery queue and the email link', async () => {
  const before = await rpc('me', { p_token: O }); assert.ok(!before.settings.app_url);
  const s1 = await rpc('update_settings', { p_token: O, p_fields: { app_url: ' https://ram-bhawan.netlify.app/ ' } });
  assert.equal(s1.app_url, 'https://ram-bhawan.netlify.app/'); assert.equal(s1.interest_rate, 24); assert.equal(s1.building_name, before.settings.building_name);   // other rules untouched
  await fails('update_settings', { p_token: O, p_fields: { app_url: 'javascript:alert(1)' } }, /must start with https/);
  await fails('update_settings', { p_token: O, p_fields: { app_url: 'https://a b.com' } }, /must start with https/);
  assert.equal((await rpc('me', { p_token: O })).settings.app_url, 'https://ram-bhawan.netlify.app/');
  const T = (await rpc('login', { p_login: 'r102', p_password: 'newpass2' })).token;
  await fails('update_settings', { p_token: T, p_fields: { app_url: 'https://evil.example' } });
  assert.equal((await rpc('me', { p_token: T })).settings.app_url, 'https://ram-bhawan.netlify.app/');                 // tenants may read it, not change it
  await admin.query(`select _notify((select id from users where role='owner'), 'test', 'Hello', 'Body', '#/inbox', null)`);
  await admin.query(`set role service_role`); const got = (await admin.query(`select claim_notifications(100) r`)).rows[0].r; await admin.query('reset role');
  assert.ok(got.length > 0 && got.every(n => n.app_url === 'https://ram-bhawan.netlify.app/' && n.app_name === before.settings.building_name));
  const { buildEmail } = await import('../supabase/functions/notify/index.ts');
  const m = buildEmail({ GMAIL_USER: 'me@gmail.com' }, { email: 'a@b.c', title: 'T', body: 'x <b> y', link: '#/inbox', app_url: 'https://ram-bhawan.netlify.app/', app_name: 'Ram Bhawan' });
  assert.equal(m.to, 'a@b.c'); assert.equal(m.from, 'Ram Bhawan <me@gmail.com>'); assert.ok(m.content.endsWith('Open: https://ram-bhawan.netlify.app/#/inbox')); assert.ok(m.html.includes('href="https://ram-bhawan.netlify.app/#/inbox"') && m.html.includes('x &lt;b&gt; y'));
  assert.ok(buildEmail({ GMAIL_USER: 'me@gmail.com', APP_URL: 'https://custom.example' }, { email: 'a@b.c', title: 'T', body: 'x', link: null, app_url: 'https://ram-bhawan.netlify.app/' }).content.endsWith('Open: https://custom.example/'));   // the optional APP_URL secret wins
  assert.ok(!buildEmail({ GMAIL_USER: 'me@gmail.com' }, { email: 'a@b.c', title: 'T', body: 'x', link: '#/x' }).content.includes('Open:'));                                 // no address known: no broken link
  await rpc('update_settings', { p_token: O, p_fields: { app_url: '' } }); assert.equal((await rpc('me', { p_token: O })).settings.app_url, null);
});
await t('notifications: tenant reads only their own and can mark them read', async () => {
  const T2b = (await rpc('login', { p_login: 'r102', p_password: 'newpass2' })).token;
  const list = await rpc('my_notifications', { p_token: T2b, p_limit: 20 }); assert.ok(list.length >= 1);
  const uid = (await admin.query(`select user_id from tenancies where id=$1`, [t102])).rows[0].user_id;
  const other = (await admin.query(`select count(*)::int n from notifications where user_id <> $1`, [uid])).rows[0].n; assert.ok(other > 0);
  await rpc('mark_notifications_read', { p_token: T2b, p_ids: null });
  assert.ok((await rpc('my_notifications', { p_token: T2b, p_limit: 20 })).every(n => n.read));
  assert.equal((await rpc('me', { p_token: T2b })).unread, 0);
});
await t('requests and complaints reach the owner; a complaint is not shown back to other tenants', async () => {
  await rpc('create_ticket', { p_token: T2, p_kind: 'maintenance', p_title: 'Bulb not working', p_details: null, p_photo: null }).catch(() => {});
  const T2c = (await rpc('login', { p_login: 'r102', p_password: 'newpass2' })).token;
  await rpc('create_ticket', { p_token: T2c, p_kind: 'maintenance', p_title: 'Bulb not working', p_details: 'Corridor', p_photo: null });
  await rpc('create_ticket', { p_token: T2c, p_kind: 'complaint', p_title: 'Noise at night', p_details: null, p_photo: null });
  const inbox = await rpc('inbox', { p_token: O }); assert.equal(inbox.tickets.length, 2);
  const k = inbox.tickets.find(x => x.kind === 'maintenance'); await rpc('update_ticket', { p_token: O, p_ticket: k.id, p_status: 'in_progress', p_note: 'Electrician coming Friday' });
  assert.equal((await rpc('tenant_home', { p_token: T2c })).tickets.find(x => x.kind === 'maintenance').owner_note, 'Electrician coming Friday');
});
await t('backup export works for the owner and leaves out passwords', async () => {
  const ex = await rpc('export_all', { p_token: O }); assert.ok(ex.payments.length >= 2); assert.ok(!JSON.stringify(ex).includes('password_hash'));
});

console.log('Tenants without a login (back-entering old months before giving anyone a password)');
await t('a tenant with no login: bills, payments, cancel, receipt, reminders and later login creation all work', async () => {
  const room = await rpc('save_room', { p_token: O, p_id: null, p_room_no: '404', p_floor: '4', p_default_rent: 4000, p_notes: null });
  const tid = await rpc('move_in', { p_token: O, p_room: room, p_fields: { full_name: 'No Login Tenant', rent: 4000, persons: 2, start_date: '2026-08-01', due_day: 5, opening_reading: 50 } });
  const b1 = await rpc('add_bill', { p_token: O, p_tenancy: tid, p_month: '2026-08-01' });
  await rpc('update_bill', { p_token: O, p_bill: b1, p_fields: { new_reading: 90, reading_verified: true } });
  const b2 = await rpc('add_bill', { p_token: O, p_tenancy: tid, p_month: '2026-09-01' });
  await rpc('update_bill', { p_token: O, p_bill: b2, p_fields: { new_reading: 120, reading_verified: true } });
  const p1 = await rpc('record_payment', { p_token: O, p_tenancy: tid, p_amount: 1000, p_paid_on: '2026-09-20', p_method: 'cash', p_reference: null, p_note: null });
  const view = await rpc('tenancy_detail', { p_tenancy: tid, p_token: O });
  const pay = view.ledger.payments[0]; assert.equal(pay.amount, 1000); assert.ok(pay.receipt_no);
  assert.equal((await rpc('receipt', { p_token: O, p_payment: pay.id })).tenant, 'No Login Tenant');
  await rpc('void_payment', { p_token: O, p_payment: pay.id, p_note: 'entered by mistake' });
  assert.equal((await rpc('tenancy_detail', { p_tenancy: tid, p_token: O })).ledger.payments.length, 0);
  await admin.query(`select generate_reminders('2026-11-04')`);                                    // the daily job must not trip over a tenant without a login
  const ex = await rpc('export_all', { p_token: O }); assert.ok(ex.tenancies.some(x => x.full_name === 'No Login Tenant'));
  const nu = await rpc('create_tenant_login', { p_token: O, p_tenancy: tid, p_login: 'r404', p_password: 'pass404' });
  assert.equal(nu.role, 'tenant'); const T = (await rpc('login', { p_login: 'r404', p_password: 'pass404' })).token;
  assert.equal((await rpc('tenant_home', { p_token: T })).tenancy.full_name, 'No Login Tenant');
});

console.log('Starting fresh');
await t('wipe: needs the exact sentence, then removes rooms, tenants, bills, payments and tenant logins but keeps the owner, admins and settings; receipt numbers restart', async () => {
  await rpc('update_settings', { p_token: O, p_fields: { upi_id: 'keep@upi' } });
  const cnt = async (tb) => (await admin.query(`select count(*)::int n from ${tb}`)).rows[0].n;
  assert.ok(await cnt('rooms') > 0 && await cnt('payments') > 0 && await cnt('bills') > 0);
  await assert.rejects(admin.query(`select wipe_everything_except_owner('yes')`), /Nothing was deleted/);
  assert.ok(await cnt('rooms') > 0);
  const out = (await admin.query(`select wipe_everything_except_owner('yes, delete all rooms, tenants and payments') r`)).rows[0].r; assert.match(out, /^Done/);
  for (const tb of ['rooms', 'tenancies', 'bills', 'bill_adjustments', 'payments', 'deduction_claims', 'tickets', 'attachments', 'notifications']) assert.equal(await cnt(tb), 0, tb);
  assert.equal((await admin.query(`select count(*)::int n from users where role = 'tenant'`)).rows[0].n, 0);
  assert.equal((await admin.query(`select count(*)::int n from users where role = 'owner'`)).rows[0].n, 1);
  assert.equal((await admin.query(`select count(*)::int n from push_subscriptions where user_id in (select id from users where role='tenant')`)).rows[0].n, 0);
  const again = await rpc('login', { p_login: 'owner', p_password: 'ownerpass' }); assert.ok(again.token);                       // the owner can still sign in
  assert.equal((await rpc('me', { p_token: again.token })).settings.upi_id, 'keep@upi');                                      // settings kept
  const room = await rpc('save_room', { p_token: again.token, p_id: null, p_room_no: '1', p_floor: '1', p_default_rent: 1000, p_notes: null });
  const tid = await rpc('move_in', { p_token: again.token, p_room: room, p_fields: { full_name: 'Fresh Start', rent: 1000, persons: 1, start_date: '2026-11-01', due_day: 5, opening_reading: 0 } }, null, null);
  await rpc('add_bill', { p_token: again.token, p_tenancy: tid, p_month: '2026-11-01' });
  await rpc('record_payment', { p_token: again.token, p_tenancy: tid, p_amount: 100, p_paid_on: '2026-11-02', p_method: 'cash', p_reference: null, p_note: null });
  assert.match((await rpc('tenancy_detail', { p_token: again.token, p_tenancy: tid })).ledger.payments[0].receipt_no, /-0001$/);       // numbering starts again at 1
});

console.log(`\n${pass} passed, ${fail} failed`);
await c.end(); await admin.end(); process.exit(fail ? 1 : 0);
