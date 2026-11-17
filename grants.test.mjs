import { fileURLToPath } from 'node:url';
// Who may run what, checked against the real database privileges (with Supabase's generous defaults imitated).
// The functions the app calls and the functions the internet may call must be exactly the same list.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { freshDb } from './db.mjs';

const c = await freshDb('rb_grants');
let pass = 0, fail = 0; const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', String(e.message).split('\n')[0]); } };
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const uiFns = new Set(walk(fileURLToPath(new URL('../app/src', import.meta.url))).filter((f) => /\.tsx?$/.test(f)).flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/rpc(?:<[^>]*>)?\(\s*'([a-z_]+)'/g)].map((m) => m[1])));
const LEGACY = ['billing_month'];
console.log('Permissions');
await t('the app calls 40+ functions (sanity check that the scan worked)', async () => assert.ok(uiFns.size >= 40, 'found ' + uiFns.size));
await t('the internet roles (anon, authenticated) can run exactly the functions the app calls', async () => {
  const r = await c.query(`select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')) order by 1`);
  // billing_month is no longer called by the version 2 website, but stays open on purpose: a phone that still shows
  // the version 1 website (before the owner uploads the new one) keeps working on the updated database.
  assert.deepEqual(r.rows.map((x) => x.proname), [...new Set([...uiFns, ...LEGACY])].sort());
});
await t('the version 2 functions are all there, for the website to call', async () => {
  for (const f of ['lodging_list', 'add_old_dues', 'building_bill', 'payments_month', 'edit_payment', 'tenant_documents_list', 'add_tenant_document', 'delete_tenant_document', 'send_reminder', 'storage_info'])
    assert.ok(uiFns.has(f), 'the website does not call ' + f);
  assert.ok(!uiFns.has('billing_month'), 'the website should use building_bill, not the old billing_month');
});
await t('no function name exists twice with different arguments (an old copy would stay open by name)', async () => {
  const r = await c.query(`select proname, count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace group by 1 having count(*) > 1`);
  assert.deepEqual(r.rows, []);
});
await t('helpers whose name starts with "_" are never open to the internet', async () => {
  const r = await c.query(`select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and left(p.proname, 1) = '_'
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`);
  assert.deepEqual(r.rows, []);
  assert.ok((await c.query(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and left(proname, 1) = '_'`)).rows[0].n > 20);
});
await t('the Lodging and Documents tables cannot be reached from the internet in any way', async () => {
  for (const tb of ['audit_log', 'tenant_documents']) for (const role of ['anon', 'authenticated']) {
    const r = await c.query(`select has_table_privilege($1, $2, 'select,insert,update,delete,truncate,references,trigger') as any_right`, [role, tb]);
    assert.equal(r.rows[0].any_right, false, role + ' on ' + tb);
  }
  await c.query('set role anon');
  for (const q of ['select * from audit_log', 'select * from tenant_documents', `insert into audit_log (action, group_name, summary) values ('x.y', 'bills', 'z')`, 'delete from audit_log', 'select * from audit_log_id_seq'])
    await assert.rejects(c.query(q), /permission denied/, q);
  await c.query('reset role');
});
await t('anon and authenticated have exactly the same function rights', async () => {
  const r = await c.query(`select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute') <> has_function_privilege('authenticated', p.oid, 'execute')`);
  assert.deepEqual(r.rows, []);
});
await t('only the delivery key (service_role) can run the three delivery helpers', async () => {
  for (const f of ['claim_notifications', 'drop_push_subscriptions', 'session_ok']) {
    const r = await c.query(`select has_function_privilege('service_role', p.oid, 'execute') s, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u from pg_proc p where p.proname = $1 and p.pronamespace = 'public'::regnamespace`, [f]);
    assert.deepEqual(r.rows[0], { s: true, a: false, u: false }, f);
  }
});
await t('the internet roles have no rights at all on any table or counter', async () => {
  const r = await c.query(`select c.relname, c.relkind from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'S', 'm', 'p')
    and (case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'usage,select,update') or has_sequence_privilege('authenticated', c.oid, 'usage,select,update')
         else has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger') or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate,references,trigger') end)`);
  assert.deepEqual(r.rows, []);
});
await t('every table has row level security switched on', async () => {
  const r = await c.query(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`);
  assert.deepEqual(r.rows, []);
});
await t('nothing is allowed on the owner-only functions (set-up, password recovery, wipe) from the internet', async () => {
  for (const sig of ['setup_owner(text,text,text,text)', 'reset_owner_password(text)', 'wipe_everything_except_owner(text)', 'generate_reminders(date)']) {
    const r = await c.query(`select has_function_privilege('anon', $1, 'execute') a, has_function_privilege('authenticated', $1, 'execute') u`, [sig]);
    assert.deepEqual(r.rows[0], { a: false, u: false }, sig);
  }
});
await c.end(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
