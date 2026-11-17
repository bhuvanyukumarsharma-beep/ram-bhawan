import { fileURLToPath } from 'node:url';
// The setup helper page must produce keys the delivery function accepts, commands that really run, and a website zip that is the tested app.
// Run `python3 package/build.py` first. Set HELPER=/path/to/setup-helper.html to test another copy.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { vapidJwt, encryptPayload } from '../supabase/functions/notify/index.ts';
import { freshDb } from './db.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HELPER = process.env.HELPER || fileURLToPath(new URL('../package/out/ram-bhawan/setup-helper.html', import.meta.url));
const DIST = fileURLToPath(new URL('../app/dist/', import.meta.url));
const browser = await chromium.launch(); const ctx = await browser.newContext({ acceptDownloads: true }); const page = await ctx.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));   // the page asks "leave without saving your secrets?" when it is reloaded; say yes
const errors = []; page.on('console', (m) => m.type() === 'error' && errors.push(m.text())); page.on('pageerror', (e) => errors.push(String(e)));
let pass = 0, fail = 0; const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', String(e.message).split('\n').slice(0, 3).join(' | ')); } };

const REF = 'abcdefghijklmnopqrst', URL_OK = `https://${REF}.supabase.co`;
const PUBKEY = 'sb_publishable_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
const GOOD = { url: URL_OK, key: PUBKEY, gmail: 'ramhawan.alerts@gmail.com', gpass: 'abcd efgh ijkl mnop', oid: 'owner', oname: "Ravi D'Souza O'Brien", oemail: 'ravi.owner@example.com', opass: `pa'ss"w\\ord;--$1` };
const fill = async (o) => { for (const [k, v] of Object.entries({ url: o.url, key: o.key, gmail: o.gmail ?? '', gpass: o.gpass ?? '', oid: o.oid, oname: o.oname, oemail: o.oemail, opass: o.opass })) await page.fill('#' + k, v); };
const submit = async (o) => { await page.goto('file://' + HELPER); await fill(o); await page.click('button[type=submit]'); };
const errText = async () => { await page.waitForFunction(() => document.getElementById('err').style.display === 'block', null, { timeout: 3000 }); return page.textContent('#err'); };
const jwtOf = (role) => 'eyJ' + Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url').slice(3) + '.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.sig';

await t('the helper is a real file from the build, with the website inside it', async () => {
  const html = fs.readFileSync(HELPER, 'utf8'); assert.ok(!html.includes('__SCHEDULE_SQL__') && !html.includes('__SITE_FILES__'));
  const m = html.match(/const SITE_FILES = (\{.*?\});\s*\/\/ the finished app/s); assert.ok(m, 'the website files are not inside the helper');
  const names = Object.keys(JSON.parse(m[1])); for (const need of ['index.html', 'config.js', 'sw.js', 'manifest.webmanifest']) assert.ok(names.includes(need), need + ' is missing');
});

console.log('Checks on what you type');
const bad = [
  ['the SECRET key is refused', { ...GOOD, key: 'sb_secret_' + 'x'.repeat(30) }, /SECRET key/],
  ['a service_role key is refused', { ...GOOD, key: jwtOf('service_role') }, /service_role/],
  ['a key of some other kind is refused', { ...GOOD, key: 'hello-world' }, /does not look like a Supabase key/],
  ['a web address that is not a Supabase project is refused', { ...GOOD, url: 'https://example.com' }, /Project URL/],
  ['Gmail address without its app password is refused', { ...GOOD, gpass: '' }, /both the Gmail address/],
  ['a normal Gmail password (not 16 letters) is refused', { ...GOOD, gpass: 'MyRealPassword1' }, /exactly 16 letters/],
  ['a short owner password is refused', { ...GOOD, opass: 'abc123' }, /at least 8/],
  ['a password with only numbers is refused', { ...GOOD, opass: '123456789' }, /only of numbers/],
  ['a password equal to the login ID is refused', { ...GOOD, oid: 'ownerowner', opass: 'ownerowner' }, /must not be the same/],
  ['a login ID with a space is refused', { ...GOOD, oid: 'my owner' }, /login ID must be/],
];
for (const [name, input, re] of bad) await t(name, async () => { await submit(input); const m = await errText(); assert.match(m, re); assert.equal(await page.isVisible('#out'), false); });
await t('a wrong email address is refused (the browser itself stops the form)', async () => {
  await submit({ ...GOOD, oemail: 'ravi.at.example' });
  assert.equal(await page.$eval('#f', (f) => f.checkValidity()), false); assert.equal(await page.isVisible('#out'), false);
});

await t('only the 20 letters of the project are enough, and a trailing slash does no harm', async () => {
  await submit({ ...GOOD, url: ` ${REF}/ ` }); await page.waitForSelector('#out', { state: 'visible' });
  assert.match(await page.inputValue('#o-sched'), new RegExp(`https://${REF}\\.supabase\\.co/functions/v1/notify`));
});

console.log('What it makes');
await submit(GOOD); await page.waitForSelector('#out', { state: 'visible' });
const secrets = (await page.inputValue('#o-secrets')).split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]); const S = Object.fromEntries(secrets);
const ownerSql = await page.inputValue('#o-owner'), sched = await page.inputValue('#o-sched');

await t('the secrets block has exactly the names the function reads, and none that Supabase forbids', async () => {
  assert.deepEqual(secrets.map(([k]) => k), ['CRON_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'GMAIL_USER', 'GMAIL_APP_PASSWORD']);
  assert.ok(secrets.every(([k]) => !k.startsWith('SUPABASE_')));
  assert.equal(S.GMAIL_USER, GOOD.gmail); assert.equal(S.GMAIL_APP_PASSWORD, 'abcdefghijklmnop'); assert.equal(S.VAPID_SUBJECT, 'mailto:' + GOOD.oemail);
});
await t('the table with one Copy button per item matches the block', async () => {
  const rows = await page.$$eval('#secret-table tr', (trs) => trs.map((r) => [r.querySelector('code').textContent, r.querySelectorAll('button').length]));
  assert.deepEqual(rows, secrets.map(([k]) => [k, 2]));   // each row: the name, with a "Copy name" and a "Copy value" button
});
await t('without Gmail details, the Gmail secrets are left out', async () => {
  await submit({ ...GOOD, gmail: '', gpass: '' }); await page.waitForSelector('#out', { state: 'visible' });
  const names = (await page.inputValue('#o-secrets')).split('\n').map((l) => l.split('=')[0]); assert.deepEqual(names, ['CRON_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']);
  await submit(GOOD); await page.waitForSelector('#out', { state: 'visible' });   // (back to the full set; keys are new after a reload)
});
const K = Object.fromEntries((await page.inputValue('#o-secrets')).split('\n').map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
const sched2 = await page.inputValue('#o-sched'), ownerSql2 = await page.inputValue('#o-owner');

await t('public key is a 65-byte uncompressed P-256 point, private key is 32 bytes, cron secret is 48 hex characters', async () => {
  const pub = Buffer.from(K.VAPID_PUBLIC_KEY, 'base64url'), priv = Buffer.from(K.VAPID_PRIVATE_KEY, 'base64url');
  assert.equal(pub.length, 65); assert.equal(pub[0], 4); assert.equal(priv.length, 32); assert.match(K.CRON_SECRET, /^[0-9a-f]{48}$/); assert.doesNotMatch(K.VAPID_PUBLIC_KEY + K.VAPID_PRIVATE_KEY, /[+/=]/);
});
await t('the delivery function can sign with these keys, and the signature verifies with the public key', async () => {
  const jwt = await vapidJwt('https://fcm.googleapis.com', K.VAPID_SUBJECT, K.VAPID_PRIVATE_KEY, K.VAPID_PUBLIC_KEY); const [h, c, s] = jwt.split('.');
  const pub = Buffer.from(K.VAPID_PUBLIC_KEY, 'base64url');
  const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});
await t('the encryption routine accepts a phone subscription and returns a message (the full decrypt proof is in webpush.test.mjs)', async () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const auth = crypto.randomBytes(16);
  const body = await encryptPayload(ua.getPublicKey().toString('base64url'), auth.toString('base64url'), new TextEncoder().encode('hello'));
  assert.ok(body.length > 86);   // header (21 + 65) plus cipher text
});
await t('two page loads give two different sets of keys; the same page keeps its keys when the form is sent again', async () => {
  const first = K.VAPID_PUBLIC_KEY; await page.click('button[type=submit]'); await page.waitForTimeout(300);
  assert.equal((await page.inputValue('#o-secrets')).split('\n')[1].split('=')[1], first);
  await submit(GOOD); await page.waitForSelector('#out', { state: 'visible' }); assert.notEqual((await page.inputValue('#o-secrets')).split('\n')[1].split('=')[1], first);
});

// Everything below uses the keys of the LAST page load, so read them again.
const L = Object.fromEntries((await page.inputValue('#o-secrets')).split('\n').map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
const ownerLast = await page.inputValue('#o-owner'), schedLast = await page.inputValue('#o-sched');

const db = await freshDb('rb_keys');
await t('the owner command runs in the database, even with apostrophes and quote marks in the name and password, and that password signs in', async () => {
  const r = await db.query(ownerLast); assert.match(Object.values(r.rows[0])[0], /^Owner created\. Sign in with ID: owner$/);
  const ok = (await db.query(`select login($1, $2) r`, ['owner', GOOD.opass])).rows[0].r; assert.ok(ok.token, JSON.stringify(ok)); assert.equal(ok.user.full_name, GOOD.oname); assert.equal(ok.user.email, GOOD.oemail);
  const no = (await db.query(`select login($1, $2) r`, ['owner', 'wrong-password'])).rows[0].r; assert.ok(no.error);
});
await t('running the owner command twice is refused politely (it cannot create a second owner)', async () => {
  await assert.rejects(db.query(ownerLast), /An owner already exists/);
});
await t('the schedule command has no placeholders left, carries the project, secret and public key, and never the secret key', async () => {
  assert.doesNotMatch(schedLast, /YOUR-/); assert.ok(schedLast.includes(`https://${REF}.supabase.co/functions/v1/notify`)); assert.ok(schedLast.includes(L.CRON_SECRET));
  assert.equal(schedLast.split(PUBKEY).length - 1, 2); assert.doesNotMatch(schedLast, /sb_secret_|service_role/);
});
await t('the schedule command runs (with stand-ins for pg_cron and pg_net), makes both jobs, and only calls the function when something is waiting', async () => {
  await db.query(`create schema if not exists cron; create table cron.job (jobid serial primary key, jobname text, schedule text, command text, active boolean default true);
    create function cron.schedule(job_name text, sched text, cmd text) returns bigint language plpgsql as $$ begin insert into cron.job (jobname, schedule, command) values (job_name, sched, cmd); return 1; end $$;
    create function cron.unschedule(job_id bigint) returns boolean language plpgsql as $$ begin delete from cron.job where jobid = job_id; return true; end $$;
    create schema if not exists net; create table net.calls (url text, body jsonb, headers jsonb, timeout int);
    create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language plpgsql as $$ begin insert into net.calls values (url, body, headers, timeout_milliseconds); return 1; end $$;`);
  const runnable = schedLast.split('\n').filter((l) => !/^create extension/.test(l)).join('\n');   // the two "create extension" lines need the real Supabase
  const res = await db.query(runnable); const last = Array.isArray(res) ? res[res.length - 1] : res;
  assert.deepEqual(last.rows.map((r) => r.jobname), ['rb-deliver', 'rb-morning']);
  const jobs = (await db.query(`select jobname, schedule, command from cron.job order by jobname`)).rows;
  assert.deepEqual(jobs.map((j) => [j.jobname, j.schedule]), [['rb-deliver', '*/10 * * * *'], ['rb-morning', '30 2 * * *']]);
  await db.query(runnable);                                                   // safe to run again
  assert.equal((await db.query(`select count(*)::int n from cron.job`)).rows[0].n, 2);
  await db.query(`select rb_deliver_waiting()`); assert.equal((await db.query(`select count(*)::int n from net.calls`)).rows[0].n, 0);
  const uid = (await db.query(`select id from users where role = 'owner'`)).rows[0].id; await db.query(`select _notify($1, 'test', 'Hello', 'Body', null, null)`, [uid]);
  await db.query(`select rb_deliver_waiting()`); const calls = (await db.query(`select * from net.calls`)).rows; assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://${REF}.supabase.co/functions/v1/notify`); assert.equal(calls[0].timeout, 30000);
  assert.deepEqual(calls[0].headers, { 'Content-Type': 'application/json', 'x-cron-secret': L.CRON_SECRET, apikey: PUBKEY, Authorization: 'Bearer ' + PUBKEY });
  await assert.rejects(db.query(`set role anon; select rb_deliver_waiting()`), /permission denied/);   // the internet cannot trigger it
  await db.query('reset role');
});

console.log('The website zip');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-zip-'));
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-site')]); const zipPath = path.join(tmp, dl.suggestedFilename()); await dl.saveAs(zipPath);
await t('the zip downloads under the promised name and passes a strict integrity check', async () => {
  assert.equal(dl.suggestedFilename(), 'ram-bhawan-website.zip');
  const py = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip() or "ok")', zipPath]).toString().trim(); assert.equal(py, 'ok');
  try { const u = execFileSync('unzip', ['-t', zipPath]).toString(); assert.match(u, /No errors detected/); } catch (e) { if (e.code !== 'ENOENT') throw e; }
});
const out = path.join(tmp, 'site'); fs.mkdirSync(out);
execFileSync('python3', ['-I', '-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipPath, out]);
await t('index.html is at the top of the zip (not inside a folder) and every file of the tested app is there, byte for byte', async () => {
  assert.ok(fs.existsSync(path.join(out, 'index.html')));
  const all = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? all(path.join(dir, d.name), base + d.name + '/') : [base + d.name]);
  const want = all(DIST).filter((f) => !f.endsWith('.map')).sort(), got = all(out).sort(); assert.deepEqual(got, want);
  for (const f of want) if (f !== 'config.js') assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(DIST, f))), f + ' differs');
});
await t('config.js in the zip connects the website to the typed project, key and phone-alert key (and nothing else)', async () => {
  const src = fs.readFileSync(path.join(out, 'config.js'), 'utf8'); const w = {}; new Function('window', src)(w);
  assert.deepEqual(w.RB_CONFIG, { SUPABASE_URL: URL_OK, SUPABASE_KEY: PUBKEY, VAPID_PUBLIC_KEY: L.VAPID_PUBLIC_KEY });
  assert.doesNotMatch(src, /PASTE|sb_secret|service_role|GMAIL|PRIVATE|password/i);
});
await t('the placeholder config.js in the build really is a placeholder (so a zip without the helper cannot silently pass)', async () => {
  assert.match(fs.readFileSync(path.join(DIST, 'config.js'), 'utf8'), /PASTE-YOUR-PROJECT-URL-HERE/);
});

console.log('The private file');
const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#dl-secrets')]); const txt = fs.readFileSync(await dl2.path(), 'utf8');
await t('YOUR-SECRETS.txt has the login, the project and every secret, and says to keep it private', async () => {
  assert.equal(dl2.suggestedFilename(), 'YOUR-SECRETS.txt');
  for (const need of ['Login ID: owner', 'Password: ' + GOOD.opass, URL_OK, REF, PUBKEY, 'CRON_SECRET=' + L.CRON_SECRET, 'VAPID_PRIVATE_KEY=' + L.VAPID_PRIVATE_KEY, 'GMAIL_APP_PASSWORD=abcdefghijklmnop', 'Keep this file private']) assert.ok(txt.includes(need), need);
});
await t('no page errors in the browser', async () => { assert.deepEqual(errors, []); });
await db.end(); await browser.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
