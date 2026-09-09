// rpc.test.mjs — the generated SQL on a BRAND-NEW database (pglite, real
// Postgres in WASM), then receive_drydock_job exercised as the roles involved.
//   node --experimental-strip-types test/rpc.test.mjs
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
import { spawnSync } from 'node:child_process';
let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
// The harness's window/document stubs make pglite take its browser loader,
// so the SQL is extracted in a child process (test/sqltext.mjs) and this
// process never loads the harness.
const gen = spawnSync(process.execPath, [path.join(ROOT, 'test', 'sqltext.mjs'), SRC],
                      { encoding: 'utf8', maxBuffer: 1 << 26 });
if (gen.status !== 0) { console.log('sqltext.mjs failed: ' + gen.stderr); process.exit(1); }
const SQL = gen.stdout;
const SHIM = fs.readFileSync(path.join(ROOT, 'test', 'supabase_shim.sql'), 'utf8');

console.log('\n--- A. the SQL text itself ---');
const count = (s, needle) => s.split(needle).length - 1;
ok('no backtick inside the generated SQL', SQL.indexOf('`') < 0);
ok('no ${ inside the generated SQL', SQL.indexOf('$' + '{') < 0);
ok('receipt table created exactly once', count(SQL, 'create table if not exists billing_drydock_receipt') === 1);
ok('receive_drydock_job defined exactly once', count(SQL, 'create or replace function public.receive_drydock_job') === 1);
ok('receive_drydock_job is in the revoke/grant loop', count(SQL, "'public.receive_drydock_job(jsonb)'") === 1);
ok('receipt read policy is rsr_dwg_ prefixed and to authenticated',
   /create policy rsr_dwg_ddreceipt_read on billing_drydock_receipt\s+for select to authenticated/.test(SQL));

console.log('\n--- B. runs on a fresh database, twice ---');
export async function freshDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SHIM);
  await db.exec(SQL);
  return db;
}
let db;
try { db = await freshDb(); ok('sqlText applies to a brand-new database', true); }
catch (e) { ok('sqlText applies to a brand-new database', false, String(e.message).slice(0, 300)); }
if (db) {
  try { await db.exec(SQL); ok('sqlText is idempotent (second run)', true); }
  catch (e) { ok('sqlText is idempotent (second run)', false, String(e.message).slice(0, 300)); }
  const fn = await db.query("select to_regprocedure('public.receive_drydock_job(jsonb)') as f");
  ok('receive_drydock_job exists after the script', fn.rows[0].f != null, JSON.stringify(fn.rows[0]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
