// The one-time update of a live version 1 database (supabase/database-update.sql) must be safe:
//  * it starts from exactly the database version 1 shipped (tests/fixtures/setup.v1.sql),
//  * every row the owner entered survives and every tenant's money position is IDENTICAL afterwards,
//  * running it a second time changes nothing,
//  * the result is the same database a brand-new setup.sql makes (tables, columns, rules, functions, rights).
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { freshDb, connect, readSql } from './db.mjs';

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', String(e.message).split('\n').slice(0, 3).join(' | ')); } };

const V1 = './fixtures/setup.v1.sql';
const UPDATE = readSql('../supabase/database-update.sql');
const FREEZE = `create or replace function _today() returns date language sql stable as $$ select date '2026-11-04' $$`;

console.log('The files');
await t('the frozen version 1 database is the one that was shipped (checksum)', async () => {
  const sha = crypto.createHash('sha256').update(readSql(V1).replace(/\r/g, '')).digest('hex');
  assert.equal(sha, 'ed3a94ca4e3e95c019342ed06bd1aa0c361340bc752f2f6abd677c6dc49e5575');
});
await t('the update text: plain-English header, no begin/commit, nothing that cannot run in one transaction, ends by reloading the web service', async () => {
  assert.match(UPDATE.slice(0, 600), /ONCE/); assert.match(UPDATE.slice(0, 800), /safe to run again/i);
  const code = UPDATE.replace(/--[^\n]*/g, '');
  assert.ok(!/^\s*(begin|commit|rollback|start transaction)\s*;/im.test(code), 'has its own begin/commit');
  assert.ok(!/\b(concurrently|vacuum|create database|drop database|alter system|reindex)\b/i.test(code), 'has a statement that cannot run in a transaction');
  assert.ok(!/create table (?!if not exists)/i.test(code), 'a table is created without "if not exists"');
  assert.match(UPDATE.trim(), /notify pgrst, 'reload schema';$/);
  assert.equal(UPDATE.slice(UPDATE.lastIndexOf('-- ---------------- lock-down')).replace(/notify pgrst[^\n]*|--[^\n]*/g, '').trim(),
    readSql('../supabase/setup.sql').slice(readSql('../supabase/setup.sql').lastIndexOf('-- ---------------- lock-down')).replace(/--[^\n]*/g, '').trim(), 'both files must end with the same lock-down');
});

// ---------------------------------------------------------------- a realistic version 1 database
const admin = await freshDb('rb_upgrade', V1);
const c = await connect('rb_upgrade');
await c.query('set role anon');
await admin.query(FREEZE);
const rpc = async (fn, args = {}) => {
  const keys = Object.keys(args);
  const vals = keys.map(k => { const v = args[k]; return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v; });
  return (await c.query(`select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, vals)).rows[0].r;
};
await admin.query(`select setup_owner('owner','Bhuvanya','owner@example.com','ownerpass')`);
const O = (await rpc('login', { p_login: 'owner', p_password: 'ownerpass', p_device: 'test' })).token;
await rpc('add_admin', { p_token: O, p_login: 'rakesh', p_name: 'Rakesh', p_email: null, p_password: 'rakesh1' });
const A = (await rpc('login', { p_login: 'rakesh', p_password: 'rakesh1' })).token;
await rpc('update_settings', { p_token: O, p_fields: { upi_id: 'rambhawan@upi', grace_days: 2, building_name: 'Ram Bhawan Test' } });

const room = {};
for (const n of ['101', '102', '103', '104', '105', '106']) room[n] = await rpc('save_room', { p_token: O, p_id: null, p_room_no: n, p_floor: n[0], p_default_rent: 3500, p_notes: null });
const mv = (r, f, login, pw) => rpc('move_in', { p_token: O, p_room: room[r], p_fields: { due_day: 5, ...f }, p_login: login ?? null, p_password: pw ?? null });
const bill = async (tid, month, reading) => {
  const id = await rpc('add_bill', { p_token: O, p_tenancy: tid, p_month: month });
  if (reading != null) await rpc('update_bill', { p_token: O, p_bill: id, p_fields: { new_reading: reading, reading_verified: true } });
  return id;
};
const pay = (tid, amount, on, method = 'cash', by = O) => rpc('record_payment', { p_token: by, p_tenancy: tid, p_amount: amount, p_paid_on: on, p_method: method, p_reference: method === 'upi' ? 'UPI' + amount : null, p_note: null });
const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ';

// A: years-long tenant, pays late and in parts -> late interest already paid and still growing
const tA = await mv('101', { full_name: 'Suresh Kumar', persons: 2, rent: 4000, start_date: '2026-06-01', opening_reading: 1000, phone: '9876500001', id_proof: 'Aadhaar 1234', notes: 'pays late' }, 'r101', 'pass101');
await bill(tA, '2026-07-01', 1040); await bill(tA, '2026-08-01', 1100); await bill(tA, '2026-09-01', 1150); await bill(tA, '2026-10-01', 1215); await bill(tA, '2026-11-01');
await pay(tA, 3000, '2026-07-10'); await pay(tA, 5000, '2026-08-20', 'upi'); await pay(tA, 4000, '2026-10-01', 'bank', A);
// B: no login, has paid nothing for months
const tB = await mv('102', { full_name: 'Meena Devi', persons: 1, rent: 3500, start_date: '2026-08-01', opening_reading: 200 });
await bill(tB, '2026-08-01', 230); await bill(tB, '2026-09-01'); await bill(tB, '2026-10-01'); await bill(tB, '2026-11-01');
// C: paid far in advance (credit), an approved deduction, a repair request
const tC = await mv('103', { full_name: 'Farid Khan', persons: 3, rent: 5000, start_date: '2026-10-01', opening_reading: 0, email: 'farid@example.com' }, 'r103', 'pass103');
await bill(tC, '2026-10-01', 40); await bill(tC, '2026-11-01');
await pay(tC, 12000, '2026-10-03', 'upi');
const TC = (await rpc('login', { p_login: 'r103', p_password: 'pass103' })).token;
await rpc('claim_deduction', { p_token: TC, p_description: 'Fixed the tap', p_amount: 350, p_proof: photo });
await rpc('decide_deduction', { p_token: O, p_claim: (await rpc('inbox', { p_token: O })).claims[0].id, p_approve: true, p_amount: 300, p_bill: null, p_note: 'Bill was 300' });
await rpc('create_ticket', { p_token: TC, p_kind: 'maintenance', p_title: 'Fan is noisy', p_details: 'Bedroom', p_photo: photo });
await rpc('update_ticket', { p_token: A, p_ticket: (await rpc('inbox', { p_token: O })).tickets[0].id, p_status: 'in_progress', p_note: 'Electrician on Friday' });
// D: moved out, still owes money
const tD = await mv('104', { full_name: 'Old Tenant', persons: 1, rent: 3000, start_date: '2026-05-01', opening_reading: 10 });
await bill(tD, '2026-06-01', 30); await bill(tD, '2026-07-01', 55);
await pay(tD, 2000, '2026-06-20');
await rpc('move_out', { p_token: O, p_tenancy: tD, p_end_date: '2026-08-15' });
// E: one of everything else: waiting / refused / cancelled payments, waiting and refused claims, a reading sent by the tenant,
//    interest switched off on one bill, an extra charge, a complaint
const tE = await mv('105', { full_name: 'Lata Joshi', persons: 2, rent: 4500, start_date: '2026-09-01', opening_reading: 700, phone: '09876500005' }, 'r105', 'pass105');
const eSep = await bill(tE, '2026-09-01', 742); const eOct = await bill(tE, '2026-10-01', 790); const eNov = await bill(tE, '2026-11-01');
const TE = (await rpc('login', { p_login: 'r105', p_password: 'pass105' })).token;
await pay(tE, 2500, '2026-09-28');
const mistake = await pay(tE, 800, '2026-10-12'); await rpc('void_payment', { p_token: O, p_payment: mistake.id, p_note: 'Entered twice' });
await rpc('report_payment', { p_token: TE, p_amount: 700, p_paid_on: '2026-10-20', p_method: 'upi', p_reference: 'X1', p_note: null, p_proof: photo });
await rpc('decide_payment', { p_token: O, p_payment: (await rpc('inbox', { p_token: O })).payments[0].id, p_approve: false, p_amount: null, p_paid_on: null, p_note: 'Not received' });
await rpc('report_payment', { p_token: TE, p_amount: 1500, p_paid_on: '2026-11-02', p_method: 'upi', p_reference: 'X2', p_note: 'part', p_proof: null });
await rpc('report_payment', { p_token: TE, p_amount: 2000, p_paid_on: '2026-10-30', p_method: 'cash', p_reference: null, p_note: null, p_proof: null });
await rpc('decide_payment', { p_token: A, p_payment: (await rpc('inbox', { p_token: O })).payments.find(p => Number(p.amount) === 2000).id, p_approve: true, p_amount: 1900, p_paid_on: null, p_note: 'Counted 1900' });
await rpc('claim_deduction', { p_token: TE, p_description: 'Painted the door', p_amount: 900, p_proof: null });
await rpc('decide_deduction', { p_token: O, p_claim: (await rpc('inbox', { p_token: O })).claims[0].id, p_approve: false, p_amount: null, p_bill: null, p_note: 'Not agreed before' });
await rpc('claim_deduction', { p_token: TE, p_description: 'New door lock', p_amount: 450, p_proof: photo });
await rpc('submit_reading', { p_token: TE, p_bill: eNov, p_reading: 835, p_photo: photo });
await rpc('update_bill', { p_token: O, p_bill: eSep, p_fields: { interest_waived: true, note: 'First month, no interest' } });
await rpc('add_adjustment', { p_token: O, p_bill: eOct, p_label: 'Broken window', p_amount: 250 });
await rpc('create_ticket', { p_token: TE, p_kind: 'complaint', p_title: 'Noise at night', p_details: null, p_photo: null });
await admin.query(`select generate_reminders()`);                      // the morning job has run: alerts exist

const TABLES = ['app_settings', 'users', 'sessions', 'login_attempts', 'rooms', 'tenancies', 'attachments', 'bills', 'bill_adjustments', 'payments',
  'deduction_claims', 'tickets', 'notifications', 'push_subscriptions'];
const AS_OF = [null, '2026-07-06', '2026-09-15', '2026-10-31', '2027-02-01'];
const tenancies = [tA, tB, tC, tD, tE];
const receipts = (await admin.query(`select id from payments where status = 'approved' order by created_at, id`)).rows.map(r => r.id);
async function picture() {
  const p = { ledgers: {}, rows: {}, api: {} };
  for (const tid of tenancies) for (const d of AS_OF) p.ledgers[tid + '@' + d] = (await admin.query('select _ledger($1, $2::date) l', [tid, d])).rows[0].l;
  for (const tb of TABLES) p.rows[tb] = (await admin.query(`select to_jsonb(x) j from ${tb} x order by to_jsonb(x)::text`)).rows.map(r => r.j);
  p.api.rooms_overview = await rpc('rooms_overview', { p_token: O });
  p.api.inbox = await rpc('inbox', { p_token: O });
  p.api.billing_month = await rpc('billing_month', { p_token: O, p_month: '2026-11-01' });
  p.api.billing_oct = await rpc('billing_month', { p_token: A, p_month: '2026-10-01' });
  for (const tid of tenancies) p.api['tenancy_detail ' + tid] = await rpc('tenancy_detail', { p_token: O, p_tenancy: tid });
  for (const n of Object.keys(room)) p.api['room_detail ' + n] = await rpc('room_detail', { p_token: O, p_room: room[n] });
  p.api.home_C = await rpc('tenant_home', { p_token: TC }); p.api.home_E = await rpc('tenant_home', { p_token: TE });
  for (const id of receipts) p.api['receipt ' + id] = await rpc('receipt', { p_token: O, p_payment: id });
  return p;
}
// Everything in "before" must still be there, unchanged, in "after". "after" may have extra fields (version 2 adds some).
function kept(before, after, where = '') {
  if (Array.isArray(before)) {
    assert.ok(Array.isArray(after) && after.length === before.length, `${where}: list length changed (${before.length} -> ${after?.length})`);
    before.forEach((x, i) => kept(x, after[i], `${where}[${i}]`));
  } else if (before !== null && typeof before === 'object') {
    assert.ok(after !== null && typeof after === 'object', `${where}: became ${JSON.stringify(after)}`);
    for (const k of Object.keys(before)) kept(before[k], after[k], `${where}.${k}`);
  } else assert.deepEqual(after, before, `${where}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
}
const rowKey = (r) => r.id ?? r.token_hash ?? r.login_id;
function rowsKept(before, after, tb) {
  assert.equal(after.length, before.length, `${tb}: number of rows changed`);
  const byKey = new Map(after.map(r => [rowKey(r), r]));
  for (const r of before) { const a = byKey.get(rowKey(r)); assert.ok(a, `${tb}: a row disappeared`); for (const k of Object.keys(r)) assert.deepEqual(a[k], r[k], `${tb}.${k} changed`); }
}

const before = await picture();
console.log('Before the update (version 1 data)');
await t('the test data is realistic: interest, part payments, credit, a moved-out tenant, waiting items', async () => {
  const L = (tid) => before.ledgers[tid + '@null'].totals;
  assert.ok(L(tA).interest_charged > 0 && L(tA).outstanding > 0, 'A has interest'); assert.ok(L(tB).overdue_bills >= 3, 'B is months behind');
  assert.ok(L(tC).credit > 0, 'C has advance credit'); assert.ok(L(tD).outstanding > 0, 'D left owing');
  assert.equal(before.api.inbox.payments.length, 1); assert.equal(before.api.inbox.claims.length, 1); assert.equal(before.api.inbox.readings.length, 1); assert.equal(before.api.inbox.tickets.length, 2);
  assert.equal(before.rows.bills.length, 16); assert.equal(before.rows.payments.length, 10); assert.ok(before.rows.notifications.length > 5); assert.ok(before.rows.attachments.length >= 4);
});
await t('a broken update changes nothing at all (it runs as one unit)', async () => {
  const x = await freshDb('rb_upgrade_fail', V1);
  await assert.rejects(x.query(UPDATE + '\nselect 1/0;'), /division by zero/);
  assert.equal((await x.query(`select count(*)::int n from information_schema.columns where table_name = 'bills' and column_name = 'kind'`)).rows[0].n, 0);
  assert.equal((await x.query(`select count(*)::int n from information_schema.tables where table_name in ('audit_log','tenant_documents')`)).rows[0].n, 0);
  await x.end();
});

// ---------------------------------------------------------------- the update
console.log('The update');
let after;
await t('the update runs on the version 1 database without an error', async () => { await admin.query(UPDATE); await admin.query(FREEZE); after = await picture(); });
await t('every tenant\'s ledger is IDENTICAL after the update, today and on four other dates', async () => {
  for (const k of Object.keys(before.ledgers)) kept(before.ledgers[k], after.ledgers[k], 'ledger ' + k);
});
await t('every row of every table survived, with every old value unchanged', async () => {
  for (const tb of TABLES) rowsKept(before.rows[tb], after.rows[tb], tb);
});
await t('new columns got their quiet defaults; the two new tables are empty', async () => {
  assert.ok(after.rows.bills.every(b => b.kind === 'regular'));
  assert.ok(after.rows.payments.every(p => p.edited_at === null && p.edited_by === null && p.edit_note === null));
  assert.equal(after.rows.app_settings[0].schema_version, 2);
  assert.equal((await admin.query(`select count(*)::int n from audit_log`)).rows[0].n, 0);
  assert.equal((await admin.query(`select count(*)::int n from tenant_documents`)).rows[0].n, 0);
});
await t('what the OLD website asks for still comes back the same (rooms, room pages, billing month, inbox, tenant home, receipts)', async () => {
  for (const k of Object.keys(before.api)) kept(before.api[k], after.api[k], k);
});
await t('the version marker says 2 (the new website reads it before anything else)', async () => {
  assert.equal((await rpc('public_info')).schema_version, 2); assert.equal((await rpc('me', { p_token: O })).settings.schema_version, 2);
});
async function schema(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  return {
    tables: await q(`select c.relname, c.relrowsecurity as rls from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1`),
    columns: await q(`select c.relname as tbl, row_number() over (partition by c.oid order by a.attnum)::int as pos, a.attname as col, format_type(a.atttypid, a.atttypmod) as type,
        a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as dflt, a.attidentity as identity
      from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1, 2`),
    constraints: await q(`select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`),
    indexes: await q(`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2`),
    triggers: await q(`select tgrelid::regclass::text as tbl, tgname, pg_get_triggerdef(oid) as def from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace) order by 1, 2`),
    sequences: await q(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'S' order by 1`),
    functions: await q(`select p.oid::regprocedure::text as sig, pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as result, p.prosecdef as definer, p.provolatile as vol,
        l.lanname as lang, p.proconfig::text as config, md5(p.prosrc) as body from pg_proc p join pg_language l on l.oid = p.prolang where p.pronamespace = 'public'::regnamespace order by 1`),
    function_rights: await q(`select p.oid::regprocedure::text as sig, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth,
        has_function_privilege('service_role', p.oid, 'execute') as service from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`),
    table_rights: await q(`select c.relname, r.rolname, case when c.relkind = 'S' then has_sequence_privilege(r.rolname, c.oid, 'usage,select,update')
        else has_table_privilege(r.rolname, c.oid, 'select,insert,update,delete,truncate,references,trigger') end as any_right
      from pg_class c cross join (select unnest(array['anon','authenticated']) as rolname) r where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','S') order by 1, 2`),
  };
}
const sameSchema = (a, b, what) => { for (const k of Object.keys(a)) assert.deepEqual(a[k], b[k], `${what}: ${k} differ`); };

console.log('Safe to run again; same as a brand-new database');
const once = await schema(admin);
await t('running the update a second time gives no error and changes nothing (data, ledgers, tables, functions, rights)', async () => {
  await admin.query(UPDATE); await admin.query(FREEZE);
  const again = await picture();
  assert.deepEqual(again.ledgers, after.ledgers, 'ledgers'); assert.deepEqual(again.rows, after.rows, 'rows'); assert.deepEqual(again.api, after.api, 'what the website gets');
  sameSchema(once, await schema(admin), 'second run');
  assert.equal((await admin.query(`select count(*)::int n from audit_log`)).rows[0].n, 0);
});
const fresh = await freshDb('rb_upgrade_fresh');
await fresh.query(FREEZE);
const want = await schema(fresh);
for (const part of Object.keys(want)) {
  await t(`updated database = brand-new database: ${part.replace('_', ' ')}`, async () => assert.deepEqual(once[part], want[part]));
}
await t('no function name exists twice with different arguments (an old copy would stay open to the internet)', async () => {
  for (const db of [admin, fresh]) assert.deepEqual((await db.query(`select proname, count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace group by 1 having count(*) > 1`)).rows, []);
});
await t('the new tables are locked like the old ones: row level security on, nothing for the internet roles', async () => {
  for (const tb of ['audit_log', 'tenant_documents']) {
    assert.deepEqual(once.tables.find(x => x.relname === tb), { relname: tb, rls: true });
    await assert.rejects(c.query(`select * from ${tb}`), /permission denied/);
  }
  assert.ok(once.table_rights.every(r => r.any_right === false));
});

await t('the old website keeps working on the updated database: new month of bills, a payment, the old billing list', async () => {
  assert.equal(await rpc('create_bills', { p_token: O, p_month: '2026-12-01' }), 4);
  const r = await rpc('record_payment', { p_token: O, p_tenancy: tB, p_amount: 1000, p_paid_on: '2026-11-03', p_method: 'cash', p_reference: null, p_note: null }); assert.ok(r.receipt_no);
  const bm = await rpc('billing_month', { p_token: O, p_month: '2026-12-01' }); assert.equal(bm.rows.length, 4); assert.equal(bm.missing, 0);
  assert.equal(bm.rows.find(x => x.room_no === '102').bill.status, 'upcoming');
});

await c.end(); await admin.end(); await fresh.end();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
