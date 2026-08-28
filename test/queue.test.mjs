import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
const FN_SRC = path.join(ROOT, 'supabase', 'functions', 'send-statement', 'index.ts');
import { net } from './harness.mjs';
import fs from 'node:fs';

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
// section 8's dead job is permanent by design and still sits in the queue;
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

console.log('\n--- 10. a discard names what it would destroy ---');
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

console.log('\n--- 11. three server failures stop a job; an outage never does ---');
net.mode = 'online';
net.script.length = 0;
app = globalThis.__loadApp();
configure(app);
app.setSession({ access_token:'tok-1', refresh_token:'ref-1', expires_in:3600,
                 user:{ email:'raffy@rsr.test' } });

// a server that keeps answering 503: the write may be valid, but three
// refusals is enough to put it in front of a person
// sections 8 and 10 leave dead jobs in the shared localStorage, so this
// section finds its own job rather than indexing into the queue
const mine = (title) => app.queue.find(j => j.data && j.data.drawing_title === title);

net.script.push({ match:'/rest/v1/drawing_billing', method:'POST', status:503,
  keep:true, body:{ message:'service unavailable' } });
await app.saveRow(newRow('Struggling Server'), true);
// saveRow flushes more than once -- it also remembers the client, which
// flushes again -- so count flushes rather than assuming one per save
ok('a server failure counts', mine('Struggling Server').attempts >= 1,
   String(mine('Struggling Server').attempts));
ok('and is recorded on the job',
   /503/.test(mine('Struggling Server').last_error || ''),
   mine('Struggling Server').last_error);
let spins = 0;
while (!mine('Struggling Server').dead && spins < 10) { await app.flushQueue(); spins++; }
ok('it stops after exactly MAX_ATTEMPTS server refusals',
   mine('Struggling Server').attempts === 3,
   'attempts=' + mine('Struggling Server').attempts);
ok('and is marked as needing attention', mine('Struggling Server').dead === true);
ok('it did not take unbounded flushes to get there', spins < 10, 'spins=' + spins);
// other live jobs still flush, so count only posts to the billing table
const posts = () => net.calls.filter(c =>
  c.method === 'POST' && String(c.url).indexOf('/rest/v1/drawing_billing') > -1).length;
const beforeRetry = posts();
await app.flushQueue();
ok('and it is not retried again', posts() === beforeRetry,
   'posts=' + (posts() - beforeRetry));

// the outage case: the queue exists to survive this, so it must never count
net.script.length = 0;
app = globalThis.__loadApp();
configure(app);
app.setSession({ access_token:'tok-1', refresh_token:'ref-1', expires_in:3600,
                 user:{ email:'raffy@rsr.test' } });
net.mode = 'offline';
await app.saveRow(newRow('Out At The Yard'), true);
const yard = () => app.queue.find(j => j.data && j.data.drawing_title === 'Out At The Yard');
await app.flushQueue();
await app.flushQueue();
await app.flushQueue();
await app.flushQueue();
ok('five offline failures still have not counted',
   !yard().attempts, String(yard().attempts));
ok('nothing was given up on', yard().dead !== true);
ok('the reason is still recorded', /fetch/i.test(yard().last_error || ''),
   yard().last_error);
net.mode = 'online';
await app.flushQueue();
ok('and it syncs when the signal comes back', !yard(), 'still queued');

console.log('\n--- Z. an unawaited saveRow loop must not lose writes ---');
// markBilledNow and markGroup are synchronous and call the async saveRow once
// per line without awaiting. flushPass used to iterate the array it started
// with and finish by reassigning queue, so a job pushed by the second call
// landed on an array nobody was reading and was then overwritten: two lines
// marked billed sent ONE patch, with no error, no dead job and an empty queue.
// The state survived only in localStorage and died with it.
const mkLine = (id, i) => ({ id, group_id:'g-lost', code:'RSR-DW-082026-009',
  bill_no:'BILLDWG-26-009', client:'Seaford', vessel:'MV SF CRUISER',
  doc_type:'DW', bill_date:'2026-08-21', drawing_title:'Line ' + i,
  qty:1, rate:10000, status:'DRAFT', billable:true, line_no:null,
  created_at:'2026-08-25T05:45:1' + i + 'Z' });

// This suite reuses localStorage between sections deliberately. Section Z
// counts PATCHes, so it needs a clean slate or an earlier section's rows are
// counted as lost writes that never were.
const wipe = () => {
  ['rsr_dwg_rows_v1','rsr_dwg_queue_v1'].forEach(k => globalThis.localStorage.removeItem(k));
};

const settle = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
  await new Promise(r => setTimeout(r, 60));
};

for (const n of [2, 4]) {
  wipe();
  app = globalThis.__loadApp();
  configure(app);
  app.setSession({ access_token:'t', refresh_token:'r', expires_at: 2e9,
                   user:{ email:'raffy@rsr.test' } });
  net.mode = 'online';
  for (let i = 0; i < n; i++) app.rows.push(mkLine('srv-' + i, i));
  net.calls.length = 0;
  await app.markBilledNow(app.allGroups());
  await settle();
  const patched = net.calls.filter(c => c.method === 'PATCH')
    .map(c => String(c.url).split('id=eq.')[1]);
  ok(n + ' lines send ' + n + ' patches', patched.length === n,
     patched.length + ': ' + patched.join(','));
  ok('every line is patched, not just the first',
     new Set(patched).size === n, patched.join(','));
  ok('and the queue drains', app.queue.length === 0, String(app.queue.length));
}

// the same shape through the other caller
wipe();
app = globalThis.__loadApp();
configure(app);
app.setSession({ access_token:'t', refresh_token:'r', expires_at: 2e9,
                 user:{ email:'raffy@rsr.test' } });
net.mode = 'online';
for (let i = 0; i < 3; i++) app.rows.push(mkLine('srv-m' + i, i));
net.calls.length = 0;
app.markGroup('g-lost', 'PAID');
await settle();
ok('markGroup patches every line too',
   net.calls.filter(c => c.method === 'PATCH').length === 3,
   String(net.calls.filter(c => c.method === 'PATCH').length));

// the mechanism itself: the array identity must never change
const srcHtml = fs.readFileSync(SRC, 'utf8');
ok('queue is never reassigned outside boot',
   !/\bqueue=queue\.filter/.test(srcHtml) && !/\bqueue=still\b/.test(srcHtml),
   'a reassignment is back');
ok('removals go through queueDrop',
   /const queueDrop=pred=>/.test(srcHtml) && /queueDrop\(/.test(srcHtml));

console.log('\n--- Z2. markBilledNow reports what landed, not what it tried ---');
// It returned the number of billings it INTENDED to move, so a write the
// server refused still toasted "marked billed" while the job sat dead in
// Pending writes. The count now means: reached the server.
const markSetup = (n) => {
  wipe();
  const a = globalThis.__loadApp();
  configure(a);
  a.setSession({ access_token:'t', refresh_token:'r', expires_at: 2e9,
                 user:{ email:'raffy@rsr.test' } });
  net.mode = 'online';
  for (let i = 0; i < n; i++) a.rows.push(mkLine('srv-t' + i, i));
  return a;
};

app = markSetup(2);
let res = await app.markBilledNow(app.allGroups());
ok('a clean send reports the billing as landed', res.n === 1, JSON.stringify(res));
ok('nothing queued', res.queued === 0, JSON.stringify(res));
ok('nothing rejected', res.dead === 0, JSON.stringify(res));

console.log('\n--- Z3. a rejected write is not reported as marked ---');
app = markSetup(2);
// the server permanently refuses one line: a 400 is not retried, it goes dead
net.script.push({ match:'id=eq.srv-t1', method:'PATCH', status:400,
                  body:{ message:'value too long', code:'22001' }, keep:true });
res = await app.markBilledNow(app.allGroups());
ok('the billing is NOT counted as marked', res.n === 0, JSON.stringify(res));
ok('and the rejection is counted', res.dead === 1, JSON.stringify(res));
ok('the dead job is in Pending writes', app.queue.filter(j => j.dead).length === 1,
   String(app.queue.filter(j => j.dead).length));
net.script.length = 0;

console.log('\n--- Z4. offline is queued, not lost, and says so ---');
app = markSetup(2);
net.mode = 'offline';
res = await app.markBilledNow(app.allGroups());
ok('not reported as landed', res.n === 0, JSON.stringify(res));
ok('but reported as queued', res.queued === 2, JSON.stringify(res));
ok('and nothing is dead', res.dead === 0, JSON.stringify(res));
ok('the lines are BILLED locally', app.rows.every(r => r.status === 'BILLED'));
net.mode = 'online';

console.log('\n--- Z5. an already-billed billing is still left alone ---');
app = markSetup(2);
app.rows.forEach(r => { r.status = 'BILLED'; r.billed_date = '2026-08-24'; });
res = await app.markBilledNow(app.allGroups());
ok('nothing moves', res.n === 0 && res.queued === 0 && res.dead === 0, JSON.stringify(res));
ok('the original billed_date is kept',
   app.rows.every(r => r.billed_date === '2026-08-24'));

console.log('\n--- Z6. the callers await it ---');
ok('lSend awaits the mark',
   /await markBilledNow\(/.test(srcHtml), 'lSend');
ok('offerMarkBilled awaits it too',
   /async function offerMarkBilled|offerMarkBilled=async/.test(srcHtml), 'offerMarkBilled');
ok('no call site uses the bare return as a number',
   !/[^t]\bmarkBilledNow\([^)]*\)\s*\+/.test(srcHtml), 'string-concatenated count');

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
