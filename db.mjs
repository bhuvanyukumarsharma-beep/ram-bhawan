import pg from 'pg';
import fs from 'node:fs';
// Where the test database lives. The defaults suit a local PostgreSQL started for these tests;
// the usual PG* environment variables can point somewhere else.
const BASE = { host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 54329), user: process.env.PGUSER || 'postgres',
  ...(process.env.PGPASSWORD ? { password: process.env.PGPASSWORD } : {}) };
// Makes an empty database with the three Supabase roles, then runs one SQL file in it
// (the current setup.sql unless another file is named, for example the frozen version 1).
export async function freshDb(name = 'rb_test', file = '../supabase/setup.sql') {
  const admin = new pg.Client({ ...BASE, database: 'postgres' });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  for (const r of ['anon', 'authenticated', 'service_role']) {
    await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname='${r}') then create role ${r} nologin; end if; end $$`);
  }
  await admin.end();
  const c = new pg.Client({ ...BASE, database: name });
  await c.connect();
  // Supabase hands the three API roles broad rights on every new object in "public". Imitate that here, so the tests
  // prove that setup.sql really takes those rights away again.
  await c.query(`grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`);
  if (file) await c.query(readSql(file));
  return c;
}
export const readSql = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
export function connect(name = 'rb_test') {
  const c = new pg.Client({ ...BASE, database: name });
  return c.connect().then(() => c);
}
