// Checks the money engine (_ledger) against hand-worked examples and against an
// independent day-by-day calculation on hundreds of random situations.
import { freshDb } from './db.mjs';
import assert from 'node:assert/strict';

const c = await freshDb();
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', e.message.split('\n')[0]); } };
const near = (a, b, tol = 0.015, msg = '') => assert.ok(Math.abs(Number(a) - Number(b)) <= tol, `${msg} expected ${b}, got ${a}`);

let rn = 0;
async function mkTenancy() {
  const room = (await c.query('insert into rooms(room_no) values ($1) returning id', ['T' + (++rn)])).rows[0].id;
  return (await c.query(`insert into tenancies(room_id, full_name, rent, start_date) values ($1,'Test',1000,'2020-01-01') returning id`, [room])).rows[0].id;
}
const addBill = (tid, month, due, total, waived = false) => c.query(
  `insert into bills(tenancy_id, month, rent, persons, water_rate, water, elec_rate, due_date, interest_waived) values ($1,$2,$3,0,0,0,0,$4,$5)`, [tid, month, total, due, waived]);
const addPay = (tid, date, amt, status = 'approved') => c.query(
  `insert into payments(tenancy_id, amount, paid_on, method, status) values ($1,$2,$3,'cash',$4)`, [tid, amt, date, status]);
const ledger = async (tid, asof) => (await c.query('select _ledger($1,$2::date) as l', [tid, asof])).rows[0].l;
const setting = (k, v) => c.query(`update app_settings set ${k} = $1 where id = 1`, [v]);

// ---------- independent day-by-day oracle ----------
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const r2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
function oracle({ bills, payments, asof, rate = 24, grace = 0 }) {
  const daily = rate / 100 / 365;
  const B = bills.map(b => ({ ...b, due: addDays(b.due, grace), on: false, prin: 0, intr: 0 }))
    .sort((a, b) => a.due.localeCompare(b.due) || a.month.localeCompare(b.month));
  const P = payments.filter(p => p.date <= asof).sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
  const starts = [...B.map(b => b.month), ...P.map(p => p.date)].sort();
  if (!starts.length) return B;
  const lots = [];
  for (let d = starts[0]; d <= asof; d = addDays(d, 1)) {
    for (const b of B) if (b.on && !b.waived && b.prin > 0 && d > b.due) b.intr += b.prin * daily;
    for (const b of B) if (!b.on && b.month === d) { b.on = true; b.prin = Math.max(b.total, 0); if (b.total < 0) lots.push(-b.total); }
    for (const p of P) if (p.date === d) lots.push(p.amount);
    for (let k = 0; k < lots.length; k++) {
      let rem = lots[k];
      for (const b of B) {
        if (rem <= 0) break; if (!b.on) continue;
        const ti = Math.min(rem, r2(b.intr)), tp = Math.min(rem - ti, b.prin);
        b.intr -= ti; b.prin -= tp; rem -= ti + tp;
      }
      lots[k] = rem;
    }
  }
  return B;
}

console.log('Hand-worked examples');
await t('bill 4500 due 5 Nov, 10 days late -> interest 29.59', async () => {
  const id = await mkTenancy(); await addBill(id, '2026-11-01', '2026-11-05', 4500);
  const l = await ledger(id, '2026-11-15');
  near(l.bills[0].interest_left, 29.59); near(l.totals.outstanding, 4529.59);
  assert.equal(l.bills[0].days_late, 10); assert.equal(l.bills[0].status, 'unpaid'); assert.equal(l.totals.overdue_bills, 1);
});
await t('no interest on the due date itself, or before', async () => {
  const id = await mkTenancy(); await addBill(id, '2026-11-01', '2026-11-05', 4500);
  near((await ledger(id, '2026-11-05')).totals.interest_due, 0); near((await ledger(id, '2026-11-03')).totals.interest_due, 0);
  near((await ledger(id, '2026-11-06')).totals.interest_due, 2.96);
});
await t('paid in full on the due date: nothing owed, status paid', async () => {
  const id = await mkTenancy(); await addBill(id, '2026-11-01', '2026-11-05', 4500); await addPay(id, '2026-11-05', 4500);
  const l = await ledger(id, '2026-12-31');
  near(l.totals.outstanding, 0); assert.equal(l.bills[0].status, 'paid'); assert.equal(l.totals.overdue_bills, 0);
});
await t('part payment: interest first, then rent; interest keeps running on what is left', async () => {
  const id = await mkTenancy(); await addBill(id, '2026-11-01', '2026-11-05', 4500); await addPay(id, '2026-11-20', 2000);
  const l = await ledger(id, '2026-11-30'); const b = l.bills[0];
  near(b.interest_paid, 44.38); near(b.principal_paid, 1955.62); near(b.principal_left, 2544.38);
  near(b.interest_left, 2544.38 * 0.24 / 365 * 10, 0.02); assert.equal(b.status, 'partial');
  assert.equal(l.payments[0].applied[0].interest, 44.38);
});
await t('two months unpaid: oldest bill is cleared first', async () => {
  const id = await mkTenancy();
  await addBill(id, '2026-09-01', '2026-09-05', 4000); await addBill(id, '2026-10-01', '2026-10-05', 4000); await addPay(id, '2026-10-10', 4300);
  const l = await ledger(id, '2026-10-10'); const sep = l.bills.find(b => b.month.startsWith('2026-09')), oct = l.bills.find(b => b.month.startsWith('2026-10'));
  near(sep.outstanding, 0); assert.equal(sep.status, 'paid'); assert.ok(oct.principal_left > 3600 && oct.principal_left < 4000);
});
await t('advance payment before the bill exists is kept as credit, then used', async () => {
  const id = await mkTenancy(); await addPay(id, '2026-10-28', 3000);
  let l = await ledger(id, '2026-10-30'); near(l.totals.credit, 3000);
  await addBill(id, '2026-11-01', '2026-11-05', 4500);
  l = await ledger(id, '2026-11-02'); near(l.totals.credit, 0); near(l.totals.outstanding, 1500);
});
await t('maintenance deduction lowers the bill; waived interest charges nothing', async () => {
  const id = await mkTenancy(); await addBill(id, '2026-11-01', '2026-11-05', 4500, true);
  const bid = (await c.query('select id from bills where tenancy_id=$1', [id])).rows[0].id;
  await c.query(`insert into bill_adjustments(bill_id,label,amount) values ($1,'fix',-300)`, [bid]);
  const l = await ledger(id, '2026-12-05'); near(l.bills[0].total, 4200); near(l.totals.interest_due, 0);
});
await t('payments still waiting for approval, rejected or cancelled are ignored', async () => {
  const id = await mkTenancy(); await addBill(id, '2026-11-01', '2026-11-05', 4500);
  await addPay(id, '2026-11-04', 4500, 'pending'); await addPay(id, '2026-11-04', 4500, 'rejected'); await addPay(id, '2026-11-04', 4500, 'void');
  near((await ledger(id, '2026-11-04')).totals.outstanding, 4500);
});
await t('grace days delay interest', async () => {
  await setting('grace_days', 3); const id = await mkTenancy(); await addBill(id, '2026-11-01', '2026-11-05', 4500);
  near((await ledger(id, '2026-11-08')).totals.interest_due, 0); near((await ledger(id, '2026-11-09')).totals.interest_due, 2.96);
  await setting('grace_days', 0);
});
await t('a bill with no electricity reading yet is flagged', async () => {
  const id = await mkTenancy(); await addBill(id, '2026-11-01', '2026-11-05', 4500);
  await c.query(`update bills set new_reading = null where tenancy_id=$1`, [id]);
  assert.equal((await ledger(id, '2026-11-02')).bills[0].awaiting_reading, true);
});
await t('empty tenant (no bills, no payments) is fine', async () => {
  const id = await mkTenancy(); const l = await ledger(id, '2026-11-02'); near(l.totals.outstanding, 0); assert.deepEqual(l.bills, []);
});

console.log('Random comparison with the independent calculation');
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
let mismatches = 0, runs = 0, nontrivial = 0, withPay = 0;
for (let s = 0; s < 300; s++) {
  const grace = rnd() < 0.3 ? ri(1, 5) : 0, rate = rnd() < 0.2 ? 18 : 24;
  await setting('grace_days', grace); await setting('interest_rate', rate);
  const id = await mkTenancy(); const nb = ri(1, 5), y = 2026, m0 = ri(1, 6);
  const bills = [];
  for (let i = 0; i < nb; i++) {
    const mm = m0 + i, month = `${y}-${String(mm).padStart(2, '0')}-01`, due = `${y}-${String(mm).padStart(2, '0')}-${String(ri(1, 28)).padStart(2, '0')}`;
    const total = rnd() < 0.08 ? -ri(100, 900) : ri(1500, 9000), waived = rnd() < 0.1;
    bills.push({ month, due, total, waived }); await addBill(id, month, due, total, waived);
  }
  const payments = []; const lastDue = bills[bills.length - 1].due; const asof = addDays(lastDue, ri(-12, 150));
  for (let i = 0; i < ri(0, 7); i++) {
    const date = addDays(bills[0].month, ri(-15, 150)); const amount = ri(100, 9000);
    payments.push({ date, amount, seq: i }); await addPay(id, date, amount);
  }
  const l = await ledger(id, asof); const o = oracle({ bills, payments, asof, rate, grace });
  runs++; if (o.some(b => b.intr > 1 || b.prin > 0)) nontrivial++; if (payments.length && o.some(b => b.intr > 1)) withPay++;
  try {
    for (const b of o) {
      const sb = l.bills.find(x => x.month === b.month); if (!b.on) { assert.equal(sb.status, 'upcoming'); continue; }
      near(sb.principal_left, b.prin, 0.02, `principal ${b.month}`); near(sb.interest_left, r2(b.intr), 0.03, `interest ${b.month}`);
    }
  } catch (e) { mismatches++; if (mismatches <= 3) console.log('  mismatch in run', s, e.message); }
}
await setting('grace_days', 0); await setting('interest_rate', 24);
console.log(`  (${nontrivial} of ${runs} had money owed, ${withPay} had payments AND late interest)`);
await t(`${runs} random situations agree with the independent calculation`, async () => assert.equal(mismatches, 0, mismatches + ' mismatches'));

console.log(`\n${pass} passed, ${fail} failed`);
await c.end(); process.exit(fail ? 1 : 0);
