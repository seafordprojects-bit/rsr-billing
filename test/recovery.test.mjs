import { net } from './harness.mjs';

/* Audit M23 -- the password-reset link's landing. The mail's link comes back
   to this app with the session in the URL fragment (#access_token=...&
   type=recovery) or an error (#error_code=otp_expired). The app has its own
   auth (fetch against /auth/v1, its own session object), so nothing parsed
   that fragment: the token sat in the browser history and the person had no
   way to set a password -- "Forgot password" sent a mail that dead-ended.
   Now boot() hands such a fragment to recoverFromHash(): scrub the URL, learn
   whose token it is, show the set-password panel inside the gate, PUT the new
   password under the link's bearer, then the usual membership pull decides
   whether the gate opens. Forgot names THIS app as the redirect. */

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const el = id => document.getElementById(id);
const gateOn = () => el('gate').classList.contains('on');
const clearLS = () => ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1']
  .forEach(k => globalThis.localStorage.removeItem(k));
const setCfg = () => globalThis.localStorage.setItem('rsr_dwg_cfg_v1',
  JSON.stringify({ url:'https://proj.supabase.co', key:'anon-key', table:'drawing_billing' }));
const settle = (ms=60) => new Promise(r => setTimeout(r, ms));
const calls = (m, part) => net.calls.filter(c => c.method === m && String(c.url).indexOf(part) > -1);
const FRAG = '#access_token=frag-access&expires_in=3600&refresh_token=frag-refresh&token_type=bearer&type=recovery';
const ERR = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
let app;

console.log('\n--- A. the reset link lands: set-password panel, token scrubbed, account learned ---');
clearLS(); setCfg(); net.mode = 'online'; net.role = 'admin'; net.calls.length = 0;
globalThis.location.hash = FRAG; globalThis.history.length = 2;
el('gate').classList.remove('on'); el('gRecover').hidden = true; el('gCreds').hidden = false;
app = globalThis.__loadApp();
await settle();
ok('the gate is up with the set-password panel, not the credentials', gateOn() && el('gRecover').hidden === false && el('gCreds').hidden === true,
   JSON.stringify({ gate: gateOn(), rec: el('gRecover').hidden, creds: el('gCreds').hidden }));
ok('the token is scrubbed from the URL without adding a history entry', globalThis.location.hash === '' && !/access_token/.test(globalThis.location.href) && globalThis.history.length === 2,
   JSON.stringify({ href: globalThis.location.href, len: globalThis.history.length }));
const who = calls('GET', '/auth/v1/user');
ok('it asked the server whose token it is, under the link\'s bearer, and names the account',
   who.length === 1 && /Bearer frag-access/.test(who[0].headers.Authorization || '') && /raffy@rsr\.test/.test(el('gMsg').textContent),
   JSON.stringify({ n: who.length, auth: who[0] && who[0].headers.Authorization, msg: el('gMsg').textContent }));
ok('the fragment session is held for the set, not yet the signed-in session', !!app.recovery && app.recovery.access_token === 'frag-access' && !app.authed(),
   JSON.stringify({ rec: app.recovery, authed: app.authed() }));

console.log('\n--- B. mismatch refused locally; a valid pair sets the password and signs in ---');
el('rPw1').value = 'harbour-2026'; el('rPw2').value = 'harbour-2027';
await app.doSetPassword(); await settle();
ok('mismatched passwords: a sentence, no request', /match/i.test(el('rErr').textContent) && calls('PUT', '/auth/v1/user').length === 0,
   JSON.stringify({ err: el('rErr').textContent, puts: calls('PUT', '/auth/v1/user').length }));
el('rPw1').value = 'abc'; el('rPw2').value = 'abc';
await app.doSetPassword(); await settle();
ok('too short: refused locally too', /6 characters/.test(el('rErr').textContent) && calls('PUT', '/auth/v1/user').length === 0, el('rErr').textContent);
el('rPw1').value = 'harbour-2026'; el('rPw2').value = 'harbour-2026';
await app.doSetPassword(); await settle();
const put = calls('PUT', '/auth/v1/user')[0];
ok('ONE PUT /auth/v1/user with the new password under the link\'s bearer',
   calls('PUT', '/auth/v1/user').length === 1 && put && JSON.parse(put.body).password === 'harbour-2026' && /Bearer frag-access/.test(put.headers.Authorization || ''),
   JSON.stringify(put));
ok('signed in with the link\'s session, membership pulled, gate down (admin@)',
   app.authed() && app.session.access_token === 'frag-access' && app.session.email === 'raffy@rsr.test' && !gateOn() && app.recovery === null,
   JSON.stringify({ authed: app.authed(), tok: app.session.access_token, gate: gateOn(), rec: app.recovery }));
ok('the session is persisted for the next boot', /frag-access/.test(globalThis.localStorage.getItem('rsr_dwg_session_v1') || ''));
ok('the panel is put away and the credentials are back for next time', el('gRecover').hidden === true && el('gCreds').hidden === false);

console.log('\n--- C. a kiosk-only account (not a billing user) still gets its password set, then the membership gate ---');
clearLS(); setCfg(); net.role = null; net.calls.length = 0;
globalThis.location.hash = FRAG;
el('gate').classList.remove('on');
app = globalThis.__loadApp(); await settle();
el('rPw1').value = 'harbour-2026'; el('rPw2').value = 'harbour-2026';
await app.doSetPassword(); await settle();
ok('the password was set (the PUT went)', calls('PUT', '/auth/v1/user').length === 1);
ok('but the gate stays up with the not-a-billing-account sentence -- the set is not a way in',
   gateOn() && /not a billing account/i.test(el('gErr').textContent + el('gMsg').textContent),
   JSON.stringify({ gate: gateOn(), err: el('gErr').textContent, msg: el('gMsg').textContent }));

console.log('\n--- D. an expired link ---');
clearLS(); setCfg(); net.role = 'admin'; net.calls.length = 0;
globalThis.location.hash = ERR; globalThis.history.length = 2;
el('gate').classList.remove('on'); el('gErr').textContent = '';
app = globalThis.__loadApp(); await settle();
ok('the gate shows the credentials with the sentence, Forgot in reach; the error is scrubbed from the URL',
   gateOn() && el('gCreds').hidden === false && el('gRecover').hidden === true && /expired or was already used/i.test(el('gErr').textContent) && globalThis.location.hash === '' && globalThis.history.length === 2,
   JSON.stringify({ gate: gateOn(), err: el('gErr').textContent, hash: globalThis.location.hash }));

console.log('\n--- E. Forgot password names THIS app as the redirect ---');
el('gEmail').value = 'raffy@rsr.test'; net.calls.length = 0;
await el('gFor').onclick(); await settle();
const rec = calls('POST', '/auth/v1/recover')[0];
ok('one /auth/v1/recover for that email with redirect_to = this app\'s own URL (not the project\'s Site URL)',
   calls('POST', '/auth/v1/recover').length === 1 && JSON.parse(rec.body).email === 'raffy@rsr.test' &&
   decodeURIComponent(rec.url).indexOf('redirect_to=https://example.test/index.html') > -1,
   JSON.stringify(rec));

console.log('\n--- F. a plain boot is untouched ---');
clearLS(); setCfg(); net.calls.length = 0; globalThis.location.hash = '';
el('gate').classList.remove('on'); el('gRecover').hidden = true; el('gErr').textContent = '';
app = globalThis.__loadApp(); await settle();
ok('no fragment: the ordinary sign-in gate, no panel, nothing asked of /auth/v1/user',
   gateOn() && el('gCreds').hidden === false && el('gRecover').hidden === true && calls('GET', '/auth/v1/user').length === 0 && app.recovery === null);

console.log('\n--- G. the server refuses the new password ---');
clearLS(); setCfg(); net.calls.length = 0;
globalThis.location.hash = FRAG;
el('gate').classList.remove('on');
app = globalThis.__loadApp(); await settle();
net.script.push({ match: '/auth/v1/user', method: 'PUT', status: 422, body: { error_code: 'weak_password', msg: 'Password should be at least 6 characters.' } });
el('rPw1').value = 'harbour-2026'; el('rPw2').value = 'harbour-2026';
await app.doSetPassword(); await settle();
ok('a refused password keeps the panel up with the server\'s sentence, nobody signed in',
   gateOn() && el('gRecover').hidden === false && /at least 6 characters/.test(el('rErr').textContent) && !app.authed() && !!app.recovery,
   JSON.stringify({ err: el('rErr').textContent, authed: app.authed() }));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
