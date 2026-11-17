// The money engine (_ledger) with "Old dues" mixed in, checked against an independent day-by-day calculation
// on hundreds of random situations. (ledger.test.mjs, from version 1, is unchanged and still checks monthly bills.)
// Rules for old dues: they start to count on their own date; with the interest switch off they never earn interest;
// money always goes to the earliest due date first, interest before the bill itself.
import { freshDb } from './db.mjs';
import assert from 'node:assert/strict';

const c = await freshDb('rb_ledger2');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', e.message.split('\n')[0]); } };
const near = (a, b, tol = 0.015, msg = '') => assert.ok(Math.abs(Number(a) - Number(b)) <= tol, `${msg} expected ${b}, got ${a}`);

let rn = 0, tick = 0;
async function mkTenancy() {
  const room = (await c.query('insert into rooms(room_no) values ($1) returning id', ['T' + (++rn)])).rows[0].id;
  return (await c.query(`insert into tenancies(room_id, full_name, rent, start_date) values ($1,'Test',1000,'2020-01-01') returning id`, [room])).rows[0].id;
}
// Each bill gets a later "created" time than the one before, like bills entered one after another.
const stamp = () => new Date(Date.UTC(2026, 0, 1) + (++tick) * 1000).toISOString();
const addBill = async (tid, month, due, total, waived = false) => (await c.query(
  `insert into bills(tenancy_id, month, rent, persons, water_rate, water, elec_rate, due_date, interest_waived, created_at) values ($1,$2,$3,0,0,0,0,$4,$5,$6) returning id`, [tid, month, total, due, waived, stamp()])).rows[0].id;
const addDues = async (tid, since, total, waived = false) => (await c.query(
  `insert into bills(tenancy_id, month, kind, rent, persons, water_rate, water, elec_rate, due_date, interest_waived, created_at) values ($1,'1900-01-01','previous',$2,0,0,0,0,$3,$4,$5) returning id`, [tid, total, since, waived, stamp()])).rows[0].id;
const addPay = (tid, date, amt) => c.query(`insert into payments(tenancy_id, amount, paid_on, method, status) values ($1,$2,$3,'cash','approved')`, [tid, amt, date]);
const ledger = async (tid, asof) => (await c.query('select _ledger($1,$2::date) as l', [tid, asof])).rows[0].l;
const setting = (k, v) => c.query(`update app_settings set ${k} = $1 where id = 1`, [v]);

// ---------- independent day-by-day calculation ----------
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const r2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
function oracle({ bills, payments, asof, rate = 24, grace = 0 }) {
  const daily = rate / 100 / 365;
  // a monthly bill counts from the 1st of its month; old dues count from their own date
  const B = bills.map((b, i) => ({ ...b, seq: i, start: b.kind === 'previous' ? b.due : b.month, late: addDays(b.due, grace), on: false, prin: 0, intr: 0, paid: 0 }))
    .sort((a, b) => a.late.localeCompare(b.late) || a.month.localeCompare(b.month) || a.seq - b.seq);
  const P = payments.filter(p => p.date <= asof).sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
  const starts = [...B.map(b => b.start), ...P.map(p => p.date)].sort();
  const lots = [];
  if (starts.length) for (let d = starts[0]; d <= asof; d = addDays(d, 1)) {
    for (const b of B) if (b.on && !b.waived && b.prin > 0 && d > b.late) b.intr += b.prin * daily;
    for (const b of B) if (!b.on && b.start === d) { b.on = true; b.prin = Math.max(b.total, 0); if (b.total < 0) lots.push(-b.total); }
    for (const p of P) if (p.date === d) lots.push(p.amount);
    for (let k = 0; k < lots.length; k++) {
      let rem = lots[k];
      for (const b of B) {
        if (rem <= 0) break; if (!b.on) continue;
        const ti = Math.min(rem, r2(b.intr)), tp = Math.min(rem - ti, b.prin);
        b.intr -= ti; b.prin -= tp; b.paid += ti + tp; rem -= ti + tp;
      }
      lots[k] = rem;
    }
  }
  return { bills: B, credit: lots.reduce((s, x) => s + Math.max(x, 0), 0) };
}

console.log('Old dues: hand-worked examples');
await t('old dues 4000 owed since 1 Sep, looked at on 4 Nov (64 days): interest 168.33', async () => {
  const id = await mkTenancy(); await addDues(id, '2026-09-01', 4000);
  const l = await ledger(id, '2026-11-04'); near(l.bills[0].interest_left, 168.33); near(l.totals.outstanding, 4168.33); assert.equal(l.bills[0].kind, 'previous'); assert.equal(l.bills[0].days_late, 64);
});
await t('old dues do not exist before their date: not owed, not overdue, and a payment made earlier waits as credit', async () => {
  const id = await mkTenancy(); await addDues(id, '2026-09-01', 4000); await addPay(id, '2026-08-10', 1500);
  let l = await ledger(id, '2026-08-31'); assert.equal(l.bills[0].status, 'upcoming'); near(l.totals.outstanding, 0); near(l.totals.credit, 1500); near(l.totals.billed, 0); assert.equal(l.totals.overdue_bills, 0);
  l = await ledger(id, '2026-09-01'); near(l.totals.credit, 0); near(l.totals.outstanding, 2500); assert.equal(l.bills[0].status, 'partial'); near(l.totals.interest_due, 0);
  l = await ledger(id, '2026-09-11'); near(l.totals.interest_due, 2500 * 0.24 / 365 * 10);
});
await t('old dues with the interest switch off never earn interest', async () => {
  const id = await mkTenancy(); await addDues(id, '2026-11-04', 2500, true);
  near((await ledger(id, '2028-01-01')).totals.outstanding, 2500); near((await ledger(id, '2028-01-01')).totals.interest_due, 0);
});
await t('grace days apply to old dues like to any bill', async () => {
  await setting('grace_days', 3); const id = await mkTenancy(); await addDues(id, '2026-09-01', 3650);
  near((await ledger(id, '2026-09-04')).totals.interest_due, 0); near((await ledger(id, '2026-09-05')).totals.interest_due, 2.4);
  await setting('grace_days', 0);
});
await t('earliest due date first: dated old dues, then the earlier month, then old dues entered today, then this month', async () => {
  const id = await mkTenancy();
  const oct = await addBill(id, '2026-10-01', '2026-10-05', 4200, true), nov = await addBill(id, '2026-11-01', '2026-11-05', 4200);
  const dated = await addDues(id, '2026-09-01', 1000, true), undated = await addDues(id, '2026-11-04', 600, true);
  await addPay(id, '2026-11-04', 6000);
  const l = await ledger(id, '2026-11-04');
  assert.deepEqual(l.bills.map(b => b.id), [dated, oct, undated, nov]);
  assert.deepEqual(l.payments[0].applied.map(a => [a.bill_id, Number(a.principal), a.kind]), [[dated, 1000, 'previous'], [oct, 4200, 'regular'], [undated, 600, 'previous'], [nov, 200, 'regular']]);
});
await t('two old dues with the very same date: the one entered first is paid first, every time', async () => {
  const id = await mkTenancy(); const first = await addDues(id, '2026-08-01', 1000, true), second = await addDues(id, '2026-08-01', 2000, true); await addPay(id, '2026-08-02', 1500);
  for (let i = 0; i < 10; i++) { const l = await ledger(id, '2026-08-03'); assert.deepEqual(l.bills.map(b => [b.id, b.status]), [[first, 'paid'], [second, 'partial']]); }
});

console.log('Old dues mixed with monthly bills: random comparison with the independent calculation');
let seed = 24680; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const p2 = (n) => String(n).padStart(2, '0');
let mismatches = 0, runs = 0, withDues = 0, early = 0, shared = 0, withInterest = 0;
for (let s = 0; s < 400; s++) {
  const grace = rnd() < 0.3 ? ri(1, 5) : 0, rate = rnd() < 0.2 ? 18 : 24;
  await setting('grace_days', grace); await setting('interest_rate', rate);
  const id = await mkTenancy(); const bills = []; const m0 = ri(3, 7);
  const nd = ri(0, 3), nb = ri(0, 4);
  let lastSince = null;
  for (let i = 0; i < nd; i++) {                     // old dues: any date in a wide range, some sharing a date, some without interest
    const since = lastSince && rnd() < 0.25 ? lastSince : addDays('2026-01-01', ri(0, 330)); if (since === lastSince) shared++; lastSince = since;
    const total = ri(200, 20000), waived = rnd() < 0.35;
    bills.push({ kind: 'previous', month: '1900-01-01', due: since, total, waived, id: await addDues(id, since, total, waived) });
  }
  for (let i = 0; i < nb; i++) {
    const month = `2026-${p2(m0 + i)}-01`, due = `2026-${p2(m0 + i)}-${p2(ri(1, 28))}`; const total = rnd() < 0.06 ? -ri(100, 900) : ri(1500, 9000), waived = rnd() < 0.1;
    bills.push({ kind: 'regular', month, due, total, waived, id: await addBill(id, month, due, total, waived) });
  }
  const payments = [];
  for (let i = 0; i < ri(0, 8); i++) { const date = addDays('2026-01-01', ri(-20, 400)); const amount = ri(100, 12000); payments.push({ date, amount, seq: i }); await addPay(id, date, amount); }
  const asof = addDays('2026-01-01', ri(0, 480));
  const l = await ledger(id, asof); const o = oracle({ bills, payments, asof, rate, grace });
  runs++; if (nd) withDues++; if (o.bills.some(b => b.intr > 1)) withInterest++;
  if (bills.some(b => b.kind === 'previous' && payments.some(p => p.date < b.due))) early++;
  try {
    assert.deepEqual(l.bills.map(b => b.id), o.bills.map(b => b.id), 'order of bills');
    for (const b of o.bills) {
      const sb = l.bills.find(x => x.id === b.id); assert.equal(sb.kind, b.kind);
      if (!b.on) { assert.equal(sb.status, 'upcoming'); near(sb.outstanding, 0); continue; }
      near(sb.principal_left, b.prin, 0.02, `principal ${b.kind} ${b.due}`); near(sb.interest_left, r2(b.intr), 0.03, `interest ${b.kind} ${b.due}`);
      near(Number(sb.principal_paid) + Number(sb.interest_paid), b.paid, 0.03, `paid ${b.kind} ${b.due}`);
    }
    near(l.totals.credit, o.credit, 0.03, 'credit');
    near(l.totals.outstanding, o.bills.reduce((x, b) => x + b.prin + r2(b.intr), 0), 0.05, 'outstanding');
    // every payment is fully accounted for: what was applied + what is left as credit = the amount
    for (const p of l.payments) near(p.applied.reduce((x, a) => x + Number(a.principal) + Number(a.interest), 0) + Number(p.credit_left), p.amount, 0.011, 'payment split');
  } catch (e) { mismatches++; if (mismatches <= 3) console.log('  mismatch in run', s, e.message); }
}
await setting('grace_days', 0); await setting('interest_rate', 24);
console.log(`  (${withDues} of ${runs} had old dues, ${shared} shared a date, ${early} had a payment dated before the old dues began, ${withInterest} had late interest)`);
await t(`${runs} random situations with old dues agree with the independent calculation`, async () => { assert.equal(mismatches, 0, mismatches + ' mismatches'); assert.ok(withDues > 200 && early > 100 && shared > 20 && withInterest > 150); });

console.log(`\n${pass} passed, ${fail} failed`);
await c.end(); process.exit(fail ? 1 : 0);
