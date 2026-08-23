import { net } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const gateOn = () => document.getElementById('gate').classList.contains('on');
const reset = () => { for (const k of [...Object.keys({})]) {} };
const clearLS = () => ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1']
  .forEach(k => globalThis.localStorage.removeItem(k));
const setCfg = () => globalThis.localStorage.setItem('rsr_dwg_cfg_v1',
  JSON.stringify({ url:'https://proj.supabase.co', key:'anon-key', table:'drawing_billing' }));
const setSession = (expiresInMs) => globalThis.localStorage.setItem('rsr_dwg_session_v1',
  JSON.stringify({ access_token:'tok', refresh_token:'ref',
                   expires_at: Date.now() + expiresInMs, email:'raffy@rsr.test' }));
const settle = () => new Promise(r => setTimeout(r, 20));

console.log('\n--- A. no project configured: local-only, gate stays down ---');
clearLS();
document.getElementById('gate').classList.remove('on');
let app = globalThis.__loadApp();
await settle();
ok('gate hidden so the device can be used offline', gateOn() === false);

console.log('\n--- B. project configured, never signed in: gate blocks the app ---');
clearLS(); setCfg();
document.getElementById('gate').classList.remove('on');
net.mode = 'offline';
app = globalThis.__loadApp();
await settle();
ok('gate shown', gateOn() === true);

console.log('\n--- C. valid unexpired session: straight into the app ---');
clearLS(); setCfg(); setSession(60 * 60 * 1000);
document.getElementById('gate').classList.remove('on');
net.mode = 'offline';                       // pull will fail, gate must stay down
app = globalThis.__loadApp();
await settle();
ok('gate hidden', gateOn() === false);
ok('still authed', app.authed() === true);

console.log('\n--- D. near-expiry session while offline: session kept, no lockout ---');
clearLS(); setCfg(); setSession(10 * 1000);  // inside the 120s refresh window
document.getElementById('gate').classList.remove('on');
net.mode = 'offline';
app = globalThis.__loadApp();
await settle();
ok('gate hidden (offline must not lock the user out)', gateOn() === false);
ok('session preserved for queued work', app.authed() === true);

console.log('\n--- E. near-expiry session, server rejects the refresh token ---');
clearLS(); setCfg(); setSession(10 * 1000);
document.getElementById('gate').classList.remove('on');
net.mode = 'unauthorized';
app = globalThis.__loadApp();
await settle();
ok('gate shown after a real rejection', gateOn() === true);
ok('session cleared', app.authed() === false);

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
