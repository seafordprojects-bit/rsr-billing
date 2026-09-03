// Settings, opened signed out, should show only the account line, the
// Supabase URL/key fields and Test connection -- everything past that
// (table name, Show SQL, the schema panel, and every later section) stays
// hidden until authed() is true, since none of it means anything before a
// project is even reachable.
import { net } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const el = id => document.getElementById(id);
const KEYS = ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1'];
const clearLS = () => KEYS.forEach(k => globalThis.localStorage.removeItem(k));
const setCfg = () => globalThis.localStorage.setItem('rsr_dwg_cfg_v1',
  JSON.stringify({ url:'https://proj.supabase.co', key:'anon-key', table:'drawing_billing' }));
const setSession = () => globalThis.localStorage.setItem('rsr_dwg_session_v1',
  JSON.stringify({ access_token:'tok', refresh_token:'ref',
                   expires_at: Date.now() + 60 * 60 * 1000, email:'raffy@rsr.test' }));
const settle = () => new Promise(r => setTimeout(r, 20));

console.log('\n--- A. signed out, no project configured yet ---');
clearLS();
net.mode = 'offline';
let app = globalThis.__loadApp();
await settle();
app.openCfg();
ok('account status stays visible', el('cWho').textContent === 'Not signed in');
ok('project URL field stays visible', el('cUrl').hidden === false);
ok('anon key field stays visible', el('cKey').hidden === false);
ok('test connection stays visible', el('cTest').hidden === false);
ok('table name is hidden', el('cTableWrap').hidden === true);
ok('show SQL is hidden', el('cSql').hidden === true);
ok('the schema panel is forced closed', el('sqlWrap').hidden === true);
ok('everything past Supabase is hidden', el('cfgFull').hidden === true);

console.log('\n--- B. signed out, a project is already configured ---');
clearLS(); setCfg();
net.mode = 'offline';
app = globalThis.__loadApp();
await settle();
app.openCfg();
ok('still not signed in', el('cWho').textContent === 'Not signed in');
ok('table name still hidden', el('cTableWrap').hidden === true);
ok('show SQL still hidden', el('cSql').hidden === true);
ok('the rest still hidden', el('cfgFull').hidden === true);

console.log('\n--- C. signed in: the full dialog is back ---');
clearLS(); setCfg(); setSession();
net.mode = 'offline';       // pull fails, but authed() only needs a session
app = globalThis.__loadApp();
await settle();
app.openCfg();
ok('signed in', app.authed() === true);
ok('table name visible again', el('cTableWrap').hidden === false);
ok('show SQL visible again', el('cSql').hidden === false);
ok('the rest of the dialog is back', el('cfgFull').hidden === false);

console.log('\n--- D. recomputed on every open, not sticky from a prior state ---');
// same closure, no reload: opened once signed in (fully shown) above, so
// cfgFull is currently visible. Sign out in place and reopen -- the reduced
// view must apply again, not persist whatever the dialog last showed.
app.setSession({});                    // access_token clears -> authed() false
ok('signed out in place', app.authed() === false);
app.openCfg();
ok('back to the reduced view after signing out', el('cfgFull').hidden === true);
ok('table name hidden again', el('cTableWrap').hidden === true);

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
