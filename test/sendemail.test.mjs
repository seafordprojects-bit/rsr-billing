import { net } from './harness.mjs';
import fs from 'node:fs';

/* 2026-09-19, found at Cebu: the Email button saved the address in the Send
   box as the client's billing_email before EVERY send, silently -- because the
   send function refuses any recipient that is not the address on file, and
   the app satisfied the check by making the typed address the record first.
   A test statement to the owner's own address rewrote Seaford Shipping
   Lines' real billing email. The same happens on a one-off send to a
   client's accountant or on a typo. Now confirmBillingEmail() decides: a
   blank or missing record is filled silently (the first-send case), the same
   address writes nothing, a DIFFERENT address asks, naming both, and Cancel
   sends nothing and writes nothing. setBillingEmail stays the raw writer. */

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const el = id => document.getElementById(id);
const clearLS = () => ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1','rsr_dwg_clients_v1']
  .forEach(k => globalThis.localStorage.removeItem(k));
const setCfg = () => globalThis.localStorage.setItem('rsr_dwg_cfg_v1',
  JSON.stringify({ url:'https://proj.supabase.co', key:'anon-key', table:'drawing_billing' }));
const setSession = () => globalThis.localStorage.setItem('rsr_dwg_session_v1',
  JSON.stringify({ access_token:'tok', refresh_token:'ref', expires_at: Date.now() + 3600000, email:'raffy@rsr.test' }));
const settle = (ms=40) => new Promise(r => setTimeout(r, ms));
const asked = [];
let answer = true;
globalThis.confirm = (msg) => { asked.push(String(msg)); return answer; };
const clientWrites = () => net.calls.filter(c => /clients/.test(String(c.url)) && (c.method === 'POST' || c.method === 'PATCH')).length;
const fresh = async () => {
  clearLS(); setCfg(); setSession(); net.mode = 'online'; net.role = 'admin'; net.calls.length = 0; asked.length = 0;
  const app = globalThis.__loadApp(); await settle(); return app;
};
let app;

console.log('\n--- A. no record / blank record: filled silently, nobody asked ---');
app = await fresh();
let r = await app.confirmBillingEmail('Seaford Shipping Lines', 'ops@seaford.test'); await settle();
ok('a client with no record: created with the typed address, confirm never called, send may proceed',
   r === true && app.billingEmail('Seaford Shipping Lines') === 'ops@seaford.test' && asked.length === 0, JSON.stringify({ r, asked }));
await app.cliSave({ name:'Blank Co', salutation:'', contact_person:'', address:'', billing_email:'' }, true); await settle();
r = await app.confirmBillingEmail('Blank Co', 'ap@blank.test'); await settle();
ok('a record with a BLANK billing_email: filled silently too (the legitimate first send)',
   r === true && app.billingEmail('Blank Co') === 'ap@blank.test' && asked.length === 0, JSON.stringify({ r, asked }));

console.log('\n--- B. the same address: nothing written, nobody asked ---');
net.calls.length = 0; const q0 = app.queue.length;
r = await app.confirmBillingEmail('Seaford Shipping Lines', 'ops@seaford.test'); await settle();
ok('same address -> proceed, no confirm, no client write, nothing queued',
   r === true && asked.length === 0 && clientWrites() === 0 && app.queue.length === q0, JSON.stringify({ r, asked, writes: clientWrites() }));

console.log('\n--- C. a DIFFERENT address, Cancel: asked naming both, nothing written, not sent ---');
answer = false; net.calls.length = 0; el('toast').textContent = '';
r = await app.confirmBillingEmail('Seaford Shipping Lines', 'raffyramirez00@gmail.com'); await settle();
ok('asked ONCE, naming the address on file AND the new one, and what Cancel does',
   asked.length === 1 && /Seaford Shipping Lines is on file as ops@seaford\.test/.test(asked[0]) && /Send to raffyramirez00@gmail\.com/.test(asked[0]) && /Cancel sends nothing/.test(asked[0]),
   JSON.stringify(asked));
ok('Cancel -> not sent (false), the record unchanged, no client write, nothing queued',
   r === false && app.billingEmail('Seaford Shipping Lines') === 'ops@seaford.test' && clientWrites() === 0 && app.queue.length === q0,
   JSON.stringify({ r, onFile: app.billingEmail('Seaford Shipping Lines'), writes: clientWrites() }));
ok('and the toast names the address that stays on file', /Not sent/.test(el('toast').textContent) && /ops@seaford\.test/.test(el('toast').textContent), el('toast').textContent);

console.log('\n--- D. a DIFFERENT address, OK: written, proceed ---');
answer = true; asked.length = 0;
r = await app.confirmBillingEmail('Seaford Shipping Lines', 'raffyramirez00@gmail.com'); await settle();
ok('OK -> asked once, the record now carries the new address, send may proceed',
   r === true && asked.length === 1 && app.billingEmail('Seaford Shipping Lines') === 'raffyramirez00@gmail.com', JSON.stringify({ r, asked: asked.length, onFile: app.billingEmail('Seaford Shipping Lines') }));

console.log('\n--- E. the raw writer is unchanged ---');
asked.length = 0;
await app.setBillingEmail('Seaford Shipping Lines', 'back@seaford.test'); await settle();
ok('setBillingEmail still writes unconditionally and never asks (the ingress and the tests rely on it)',
   app.billingEmail('Seaford Shipping Lines') === 'back@seaford.test' && asked.length === 0);

console.log('\n--- F. the Email button goes through the wrapper, and stops on Cancel ---');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const btn = (html.match(/\$\('sEmailBtn'\)\.onclick=async\(\)=>\{[\s\S]*?\n\};/) || [''])[0];
ok('the handler was found', btn.length > 0);
ok('it calls confirmBillingEmail(client,to) and RETURNS when it answers false, before the letter is composed',
   /if\(!\(await confirmBillingEmail\(client,to\)\)\)return;/.test(btn) && btn.indexOf('confirmBillingEmail(client,to)') < btn.indexOf('loadStmtSend(list)'),
   btn.slice(0, 80));
ok('the raw writer is no longer called from the handler', !/await setBillingEmail\(client,to\)/.test(btn));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
