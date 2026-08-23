import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
const FN_SRC = path.join(ROOT, 'supabase', 'functions', 'send-statement', 'index.ts');
import { net } from './harness.mjs';

process.argv[2] = process.argv[2] || SRC;

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

// mirror what saveCfg() writes, so a reload comes back configured
const configure = (app) => {
  app.cfg.url = 'https://proj.supabase.co';
  app.cfg.key = 'anon-key';
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify(app.cfg));
};

const newRow = (title) => ({
  code:'RSR-DWG-082026-001', bill_date:'2026-08-19', client:'Seaford Shipping Lines',
  vessel:'MV SF Voyager', drawing_no:'D-101', drawing_title:title, qty:1, rate:1500,
  status:'DRAFT', billed_date:null, paid_date:null, invoice_no:'', remarks:'',
  file_name:null, file_url:null, pages:1,
});

console.log('\n--- 1. no project configured: purely local, nothing queued to a server ---');
let app = globalThis.__loadApp();
ok('online() false with no url/key', app.online() === false);
await app.saveRow(newRow('Shell Expansion Plan'), true);
ok('row stored locally', app.rows.length === 1, 'rows=' + app.rows.length);
ok('row has a loc- id', String(app.rows[0].id).startsWith('loc-'));
ok('queued for later sync', app.queue.length === 1, 'queue=' + app.queue.length);
ok('no network calls attempted', net.calls.length === 0, 'calls=' + net.calls.length);

console.log('\n--- 2. project configured + signed in, but the network is down ---');
net.calls.length = 0;
configure(app);
app.setSession({ access_token:'tok-1', refresh_token:'ref-1', expires_in:3600,
                 user:{ email:'raffy@rsr.test' } });
ok('online() true once url+key set', app.online() === true);
ok('authed() true', app.authed() === true);

net.mode = 'offline';
await app.saveRow(newRow('Midship Section'), true);
ok('second row stored locally', app.rows.length === 2, 'rows=' + app.rows.length);
ok('both edits still queued', app.queue.length === 2, 'queue=' + app.queue.length);
ok('flush was attempted over the network', net.calls.length > 0, 'calls=' + net.calls.length);
ok('session survives the outage', app.authed() === true);

console.log('\n--- 3. edits and deletes while offline keep accumulating ---');
const target = app.rows[0];
target.status = 'BILLED';
await app.saveRow(target, false);
ok('editing a queued insert does not add a job', app.queue.length === 2,
   'queue=' + app.queue.length);
await app.deleteRow(app.rows[1].id);
ok('deleting a local row drops its job', app.queue.length === 1,
   'queue=' + app.queue.length);
ok('row removed from view', app.rows.length === 1, 'rows=' + app.rows.length);

console.log('\n--- 4. queue survives a reload (localStorage round trip) ---');
const queuedBefore = app.queue.length;
const rowsBefore = app.rows.length;
app = globalThis.__loadApp();          // fresh boot, same localStorage
ok('config restored after reload', app.online() === true, 'url=' + app.cfg.url);
ok('rows restored after reload', app.rows.length === rowsBefore,
   'rows=' + app.rows.length + ' expected ' + rowsBefore);
ok('queue restored after reload', app.queue.length === queuedBefore,
   'queue=' + app.queue.length + ' expected ' + queuedBefore);
ok('session restored after reload', app.authed() === true);

console.log('\n--- 5. back online: the queue drains ---');
net.mode = 'online';
net.calls.length = 0;
await app.flushQueue();
ok('queue emptied', app.queue.length === 0, 'queue=' + app.queue.length);
ok('server ids swapped in', app.rows.every(r => !String(r.id).startsWith('loc-')),
   JSON.stringify(app.rows.map(r => r.id)));
ok('POST was issued', net.calls.some(c => c.method === 'POST'));

console.log('\n--- 6. expired token mid-flush does not destroy queued work ---');
net.mode = 'online';
await app.saveRow(newRow('Docking Plan'), true);
ok('new row queued then flushed', app.queue.length === 0, 'queue=' + app.queue.length);

await app.saveRow(newRow('Capacity Curve'), true);
const beforeAuthFail = app.queue.length;
net.mode = 'offline';                   // drop the network before it can flush
await app.saveRow(newRow('Lines Plan'), true);
ok('work queued while unreachable', app.queue.length >= 1, 'queue=' + app.queue.length);
const survived = app.queue.length;
net.mode = 'unauthorized';              // now the server rejects the token
try { await app.flushQueue(); } catch (e) { /* surfaced to the user, not fatal */ }
ok('queued jobs are NOT dropped on 401', app.queue.length === survived,
   'queue=' + app.queue.length + ' expected ' + survived);

console.log('\n--- 7. offline refresh keeps the session (regression guard) ---');
app = globalThis.__loadApp();
configure(app);
app.setSession({ access_token:'tok-2', refresh_token:'ref-2', expires_in:10,
                 user:{ email:'raffy@rsr.test' } });   // already near expiry
net.mode = 'offline';
await app.pull(true);
ok('still signed in after an offline refresh attempt', app.authed() === true,
   'session=' + JSON.stringify(app.session));
ok('queue untouched by the failed refresh', Array.isArray(app.queue));

console.log('\n--- 8. a permanent rejection is surfaced, not retried forever ---');
net.mode = 'online';
net.script.length = 0;
app = globalThis.__loadApp();
configure(app);
app.setSession({ access_token:'tok-1', refresh_token:'ref-1', expires_in:3600,
                 user:{ email:'raffy@rsr.test' } });

net.script.push({ match:'/rest/v1/drawing_billing', method:'POST', status:409,
  body:{ code:'23505',
         message:'duplicate key value violates unique constraint "drawing_billing_pkey"' } });
await app.saveRow(newRow('Duplicate Line'), true);
ok('a 409 does not stay silently queued', app.deadJobs().length === 1,
   'dead=' + app.deadJobs().length);
ok('the server message is kept verbatim',
   /duplicate key value/.test(app.deadJobs()[0].err), app.deadJobs()[0].err);
ok('the status is kept', /409/.test(app.deadJobs()[0].err), app.deadJobs()[0].err);

const callsBefore = net.calls.length;
await app.flushQueue();
ok('a dead job is not retried', net.calls.length === callsBefore,
   'calls=' + (net.calls.length - callsBefore));

console.log('\n--- 9. a transient failure still retries silently ---');
net.script.length = 0;
app = globalThis.__loadApp();
configure(app);
app.setSession({ access_token:'tok-1', refresh_token:'ref-1', expires_in:3600,
                 user:{ email:'raffy@rsr.test' } });
// section N's dead job is permanent by design and still sits in the queue;
// count live (non-dead) jobs so this section only asserts its own scenario.
const deadBefore = app.deadJobs().length;
net.script.push({ match:'/rest/v1/drawing_billing', method:'POST', status:503,
  body:{ message:'service unavailable' } });
await app.saveRow(newRow('Server Hiccup'), true);
ok('a 5xx stays queued', app.queue.length - app.deadJobs().length === 1,
   'live=' + (app.queue.length - app.deadJobs().length));
ok('a 5xx is not marked dead', app.deadJobs().length === deadBefore,
   'dead=' + app.deadJobs().length + ' expected ' + deadBefore);
net.script.length = 0;
await app.flushQueue();
ok('it drains once the server recovers', app.queue.length - app.deadJobs().length === 0,
   'live=' + (app.queue.length - app.deadJobs().length));

console.log('\n--- N+2. a discard names what it would destroy ---');
net.mode = 'online';
net.script.length = 0;
app = globalThis.__loadApp();
configure(app);
app.setSession({ access_token:'tok-1', refresh_token:'ref-1', expires_in:3600,
                 user:{ email:'raffy@rsr.test' } });
net.script.push({ match:'/rest/v1/clients', method:'POST', status:409, keep:true,
  body:{ code:'23505',
         message:'duplicate key value violates unique constraint "clients_name_key"' } });
await app.cliSave({ name:'Seaford Shipping Lines', salutation:'Mr. Chua',
  contact_person:'Ashford Chua', address:'BREDCO 3, Reclamation Area, Bacolod City',
  billing_email:'raffyramirez00@gmail.com' }, true);

// section 8's "Lines Plan" job is dead by design and still sits in the queue
// (the suite never clears localStorage between sections), so pick this
// section's own dead job by store rather than assuming index 0.
const dead = app.deadJobs().find(j => j.store === 'clients');
const loss = app.lossSummary(dead);
ok('the summary names the client', /Seaford Shipping Lines/.test(loss), loss);
ok('the summary names the contact person', /Ashford Chua/.test(loss), loss);
ok('the summary names the address', /BREDCO 3/.test(loss), loss);
ok('the summary names the billing email', /raffyramirez00@gmail.com/.test(loss), loss);
ok('the summary says the server copy is untouched', /server/i.test(loss), loss);
ok('an empty field is not listed as a loss', !/salutation:\s*,/.test(loss), loss);

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
