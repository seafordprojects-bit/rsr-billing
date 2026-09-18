import { net } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const gateOn = () => document.getElementById('gate').classList.contains('on');
const el = id => document.getElementById(id);
const reset = () => { for (const k of [...Object.keys({})]) {} };
const clearLS = () => ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1']
  .forEach(k => globalThis.localStorage.removeItem(k));
const setCfg = () => globalThis.localStorage.setItem('rsr_dwg_cfg_v1',
  JSON.stringify({ url:'https://proj.supabase.co', key:'anon-key', table:'drawing_billing' }));
const setSession = (expiresInMs) => globalThis.localStorage.setItem('rsr_dwg_session_v1',
  JSON.stringify({ access_token:'tok', refresh_token:'ref',
                   expires_at: Date.now() + expiresInMs, email:'raffy@rsr.test' }));
const settle = () => new Promise(r => setTimeout(r, 20));

console.log('\n--- A. no project configured: blocked, only Connection settings reachable ---');
clearLS();
document.getElementById('gate').classList.remove('on');
let app = globalThis.__loadApp();
await settle();
ok('gate shown -- nothing is reachable without a project', gateOn() === true);
ok('credentials are pointless with no project to sign in to, so hidden',
   el('gCreds').hidden === true);
ok('the message explains what to do next',
   el('gMsg').textContent === 'Set up your Supabase project to continue.');
ok('Connection settings stays reachable', el('gCfg').hidden === false);

console.log('\n--- B. project configured, never signed in: gate blocks the app ---');
clearLS(); setCfg();
document.getElementById('gate').classList.remove('on');
net.mode = 'offline';
app = globalThis.__loadApp();
await settle();
ok('gate shown', gateOn() === true);
ok('credentials are back, there is a project to sign in to',
   el('gCreds').hidden === false);
ok('the message asks for sign-in, not project setup',
   el('gMsg').textContent === 'Sign in to open the billing records.');

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

console.log('\n--- F. C4: a session is not enough -- the account must be a billing user ---');
// The Supabase project is shared with the kiosk/payroll app, so carmen@ and
// mandaue@ hold valid logins that are NOT billing accounts. The SQL (RLS on
// billing_users, own-row read) is the control; this is the screen that says so.
clearLS(); setCfg(); setSession(3600 * 1000);
document.getElementById('gate').classList.remove('on');
net.mode = 'online'; net.role = null;                 // GET billing_users -> []
app = globalThis.__loadApp();
await new Promise(r => setTimeout(r, 60));
ok('a signed-in NON-member is shown the gate again', gateOn() === true);
ok('the message says why', /not a billing account/i.test(el('gErr').textContent), el('gErr').textContent);
ok('and its session is cleared, so a kiosk token does not linger on the billing origin', app.authed() === false);

clearLS(); setCfg(); setSession(3600 * 1000);
document.getElementById('gate').classList.remove('on');
net.role = 'staff';
app = globalThis.__loadApp();
await new Promise(r => setTimeout(r, 60));
ok('a STAFF member goes straight in', gateOn() === false);
ok('and the app knows its role', app.role() === 'staff', String(app.role()));
ok('staff sees no admin-only Settings: payment details, covering letter, document types and catalogue editing are hidden',
   el('cfgPayment').hidden === true && el('cfgLetter').hidden === true && el('cfgTypes').hidden === true && el('cfgCatalog').hidden === true);

net.role = 'admin';
clearLS(); setCfg(); setSession(3600 * 1000);
document.getElementById('gate').classList.remove('on');
app = globalThis.__loadApp();
await new Promise(r => setTimeout(r, 60));
ok('an ADMIN goes straight in with every Settings section', gateOn() === false && app.role() === 'admin' &&
   el('cfgPayment').hidden === false && el('cfgLetter').hidden === false && el('cfgTypes').hidden === false && el('cfgCatalog').hidden === false);

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
