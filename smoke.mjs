import { freshDb } from './db.mjs';
try {
  const c = await freshDb();
  console.log('setup.sql ran OK');
  console.log((await c.query("select setup_owner('owner','Test Owner','o@example.com','secret1') as r")).rows[0].r);
  const r = (await c.query("select login('owner','secret1','test') as r")).rows[0].r;
  console.log('login ok, role =', r.user.role, 'token len', r.token.length);
  await c.end();
} catch (e) { console.error('FAIL:', e.message, e.position ? 'pos ' + e.position : '', e.where || ''); process.exit(1); }
