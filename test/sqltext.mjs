// sqltext.mjs — print the generated SQL (sqlText() from index.html) to stdout.
//   node test/sqltext.mjs > /tmp/rsr.sql
// Run as a CHILD PROCESS by rpc.test.mjs: the harness installs window/document
// stubs to boot the app, and pglite, seeing a window, takes its browser
// loader and dies on location.pathname. Extracting the SQL here keeps the
// pglite process free of stubs.
import './harness.mjs';
const KEYS = ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1',
              'rsr_dwg_catalog_v1','rsr_dwg_clients_v1','rsr_dwg_shared_v1'];
KEYS.forEach(k => globalThis.localStorage.removeItem(k));
globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW:true, bucket:'drawings' }));
const app = globalThis.__loadApp();
process.stdout.write(app.sqlText());
