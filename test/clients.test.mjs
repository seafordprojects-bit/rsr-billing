// Client writes reconcile against a server-stamped updated_at rather than
// overwriting. The rule, in one line: a field only this device changed is
// applied, a field only the server changed is kept, and a field both changed
// is never guessed at -- it goes to Pending writes with both values named.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.argv[2] = process.argv[2] || path.join(ROOT, 'index.html');
import { net } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const boot = async () => {
  net.mode = 'online';
  net.script.length = 0;
  net.calls.length = 0;
  // localStorage survives __loadApp(), so without this each section inherits
  // the last one's clients and queue -- six Seaford rows by section 5
  globalThis.localStorage.removeItem('rsr_dwg_clients_v1');
  globalThis.localStorage.removeItem('rsr_dwg_queue_v1');
  globalThis.localStorage.removeItem('rsr_dwg_rows_v1');
  // the app's own boot fires an async pull(); left online it races the test
  // and consumes the scripted replies below. Boot offline, then come online.
  net.mode = 'offline';
  const a = globalThis.__loadApp();
  // the app's boot fires an async pull(); let it finish failing while still
  // offline, or it lands mid-test and replaces clients with the stub's empty
  // GET result -- and consumes the scripted replies on its way
  await new Promise(r => setTimeout(r, 0));
  net.mode = 'online';
  net.calls.length = 0;
  a.cfg.url = 'https://proj.supabase.co';
  a.cfg.key = 'anon-key';
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify(a.cfg));
  a.setSession({ access_token:'tok-1', refresh_token:'ref-1', expires_in:3600,
                 user:{ email:'raffy@rsr.test' } });
  return a;
};
const seaford = (a) => a.clients.find(c => c.name === 'Seaford Shipping Lines');
const patches = () => net.calls.filter(c => c.method === 'PATCH');
const el = id => document.getElementById(id);

const BASE = '2026-08-24T00:13:27.973208+00:00';
const MOVED = '2026-08-24T00:14:56.011412+00:00';

console.log('\n--- 1. an edit nobody raced carries its base and is applied ---');
let app = await boot();
app.clients.push(app.cliFromServer({ id:'srv-9', name:'Seaford Shipping Lines', salutation:'Mr. Chua',
  contact_person:'Ashford Chua', address:'BREDCO 3, Bacolod City',
  billing_email:'ap@seaford.test', updated_at:BASE }));
const mine = Object.assign({}, seaford(app), { billing_email:'billing@seaford.test' });
await app.cliSave(mine, false);

const cas = patches()[0];
ok('the write went out as a compare-and-swap', !!cas &&
   String(cas.url).indexOf('updated_at=eq.') > -1, cas && cas.url);
ok('it swapped against the row it was based on', !!cas &&
   String(cas.url).indexOf(encodeURIComponent(BASE)) > -1, cas && cas.url);
ok('the queue cleared', app.queue.length === 0, 'queue=' + app.queue.length);
ok('nothing needs attention', app.deadJobs().length === 0);

console.log('\n--- 2. the server moved in a field I did not touch: merged, silently ---');
app = await boot();
app.clients.push(app.cliFromServer({ id:'srv-9', name:'Seaford Shipping Lines', salutation:'Mr. Chua',
  contact_person:'Ashford Chua', address:'BREDCO 3, Bacolod City',
  billing_email:'ap@seaford.test', updated_at:BASE }));
// my edit: the address. meanwhile the PC corrected the email.
net.script.push({ match:'updated_at=eq.', method:'PATCH', status:200, body:[] });
net.script.push({ match:'/rest/v1/clients?select=*&id=eq.', method:'GET', status:200,
  body:[{ id:'srv-9', name:'Seaford Shipping Lines', salutation:'Mr. Chua',
          contact_person:'Ashford Chua', address:'BREDCO 3, Bacolod City',
          billing_email:'rsrengineering.services2025@gmail.com', updated_at:MOVED }] });

await app.cliSave(Object.assign({}, seaford(app),
  { address:'BREDCO 3, Reclamation Area, Bacolod City' }), false);

ok('it re-read the row after the miss',
   net.calls.some(c => c.method === 'GET' && String(c.url).indexOf('id=eq.') > -1),
   JSON.stringify(net.calls.map(c => c.method + ' ' + c.url)));
ok('it retried against the moved version',
   patches().some(p => String(p.url).indexOf(encodeURIComponent(MOVED)) > -1),
   JSON.stringify(patches().map(p => p.url)));
ok('exactly one client row survives', app.clients.length === 1,
   JSON.stringify(app.clients.map(c => c.id)));
// the row must be the reconciled one, not the local copy cliSave already
// wrote -- checking the address alone would pass either way
ok('the local row was replaced by the reconciled one',
   seaford(app).id === 'srv-9' && seaford(app).updated_at === MOVED,
   seaford(app).id + ' @ ' + seaford(app).updated_at);
ok('my address was applied', seaford(app).address === 'BREDCO 3, Reclamation Area, Bacolod City',
   seaford(app).address);
ok("the PC's corrected email survived",
   seaford(app).billing_email === 'rsrengineering.services2025@gmail.com',
   seaford(app).billing_email);
ok('the queue cleared without asking', app.queue.length === 0, 'queue=' + app.queue.length);
ok('nothing needs attention', app.deadJobs().length === 0);

console.log('\n--- 3. both changed the same field: surfaced, never guessed ---');
app = await boot();
app.clients.push(app.cliFromServer({ id:'srv-9', name:'Seaford Shipping Lines', salutation:'Mr. Chua',
  contact_person:'Ashford Chua', address:'BREDCO 3, Bacolod City',
  billing_email:'ap@seaford.test', updated_at:BASE }));
net.script.push({ match:'updated_at=eq.', method:'PATCH', status:200, body:[], keep:true });
net.script.push({ match:'/rest/v1/clients?select=*&id=eq.', method:'GET', status:200,
  body:[{ id:'srv-9', name:'Seaford Shipping Lines', salutation:'Mr. Chua',
          contact_person:'Ashford Chua', address:'BREDCO 3, Bacolod City',
          billing_email:'rsrengineering.services2025@gmail.com', updated_at:MOVED }] });

// this device also edited the email, to something else
await app.cliSave(Object.assign({}, seaford(app),
  { billing_email:'raffyramirez00@gmail.com' }), false);

const stuck = app.deadJobs()[0];
ok('the job is put in front of a person', !!stuck, JSON.stringify(app.queue));
ok('the message names the field', !!stuck && /billing_email/.test(stuck.err), stuck && stuck.err);
ok('it names my value', !!stuck && /raffyramirez00@gmail\.com/.test(stuck.err), stuck && stuck.err);
ok("it names the server's value",
   !!stuck && /rsrengineering\.services2025@gmail\.com/.test(stuck.err), stuck && stuck.err);
ok('nothing was written', !patches().some(p =>
   String(p.url).indexOf(encodeURIComponent(MOVED)) > -1),
   JSON.stringify(patches().map(p => p.url)));
ok("the list shows the server's value, not mine",
   seaford(app).billing_email === 'rsrengineering.services2025@gmail.com',
   seaford(app).billing_email);

console.log('\n--- 4. a job queued before this shipped has no base, so it asks ---');
app = await boot();
app.clients.push(app.cliFromServer({ id:'srv-9', name:'Seaford Shipping Lines', salutation:'Mr. Chua',
  contact_person:'Ashford Chua', address:'BREDCO 3, Bacolod City',
  billing_email:'ap@seaford.test', updated_at:BASE }));
// hand-roll the old shape: an update job with no `base` field at all
app.queue.push({ op:'update', store:'clients', table:'clients', id:'srv-9',
  data:{ name:'Seaford Shipping Lines', salutation:'Mr. Chua',
         contact_person:'Ashford Chua', address:'BREDCO 3, Bacolod City',
         billing_email:'raffyramirez00@gmail.com' } });
await app.flushQueue();
ok('it is not applied blind', app.deadJobs().length === 1, JSON.stringify(app.queue));
ok('and the reason says why',
   app.deadJobs().length === 1 && /version|base|older/i.test(app.deadJobs()[0].err),
   app.deadJobs()[0] && app.deadJobs()[0].err);

console.log('\n--- 5. an insert whose name already exists ---');
app = await boot();
net.script.push({ match:'/rest/v1/clients', method:'POST', status:409,
  body:{ code:'23505',
         message:'duplicate key value violates unique constraint "clients_name_key"' } });
net.script.push({ match:'/rest/v1/clients?select=*&name_canon=eq.', method:'GET', status:200,
  body:[{ id:'srv-9', name:'Seaford Shipping Lines', salutation:'Mr. Chua',
          contact_person:null, address:null,
          billing_email:'rsrengineering.services2025@gmail.com', updated_at:BASE }] });

await app.cliSave({ name:'Seaford Shipping Lines', salutation:'Mr. Chua',
  contact_person:'Ashford Chua', address:'BREDCO 3, Reclamation Area, Bacolod City',
  billing_email:'raffyramirez00@gmail.com' }, true);

ok('the local duplicate is gone', app.clients.filter(
   c => c.name === 'Seaford Shipping Lines').length === 1, JSON.stringify(app.clients));
ok('no loc- row survives', !app.clients.some(c => String(c.id).startsWith('loc-')));
ok('the list shows the server row', seaford(app).id === 'srv-9');
ok("the server's corrected email is what is shown",
   seaford(app).billing_email === 'rsrengineering.services2025@gmail.com',
   seaford(app).billing_email);
// contact_person and address were empty on the server, so they are gaps to
// fill, not a disagreement -- only billing_email is contested
const dup = app.deadJobs()[0];
ok('the contested field is surfaced', !!dup && /billing_email/.test(dup.err),
   dup && dup.err);
ok('the gaps are not treated as a conflict',
   !!dup && !/contact_person|address/.test(dup.err), dup && dup.err);


console.log('\n--- 6. the canonical name key is in the SQL ---');
// clients.name is raw text, so "Seaford" and "seaford  " both satisfy `unique`
// and a case variant inserts a second row instead of 409ing. name_canon is
// exactly what canonClient compares on, and the unique index is on that. It is
// GENERATED, never written: no existing spelling is rewritten, so a billing
// still matches the client name it was issued under.
app = await boot();
el('sqlWrap').hidden = true;
el('cSql').onclick();
const sql = el('cSqlBox').value;
// A literal backslash, built rather than typed: an escape in this file would
// be the very thing under test.
const BS = String.fromCharCode(92);
ok('name_canon is added as a generated column',
   /alter table clients\s+add column if not exists name_canon text\s+generated always as/.test(sql),
   sql.slice(sql.indexOf('name_canon') - 60, sql.indexOf('name_canon') + 200));
ok('it is stored, so it can carry an index',
   /generated always as \([^;]*\) stored;/.test(sql));
ok('the unique index is on the canonical form, not on name',
   /create unique index if not exists clients_name_canon_key\s+on clients \(name_canon\)/.test(sql));
// The whole point of computing it server-side is that it computes the SAME
// thing as canonClient: trim, collapse runs of whitespace, lowercase. Collapse
// happens BEFORE the trim, because btrim strips spaces only -- a leading tab
// trimmed second would otherwise survive as a leading space.
ok('the expression matches canonClient: collapse, then trim, then lower',
   sql.indexOf("lower(btrim(regexp_replace(name, '" + BS + "s+', ' ', 'g')))") > -1,
   sql.slice(sql.indexOf('generated always as'), sql.indexOf('generated always as') + 120));
// sqlText() returns a template literal, where \s is not an escape sequence and
// evaluates to a bare "s". Written unescaped, the index would silently be built
// on a regex that collapses the letter s.
ok('the whitespace class survived the template literal', sql.indexOf("'" + BS + "s+'") > -1);
ok("it was not flattened to 's+'", sql.indexOf("'s+'") < 0);
// A bare create would abort every statement after it on a project that already
// has duplicates -- the same trap the unbill-log policy is guarded against.
ok('the index is guarded, so duplicates warn rather than killing the script',
   /do \$BODY\$[\s\S]*?having count\(\*\) > 1[\s\S]*?create unique index if not exists clients_name_canon_key[\s\S]*?raise warning[\s\S]*?\$BODY\$;/.test(sql));
ok('and the warning names the duplicates it found', /raise warning[^;]*%/.test(sql));

console.log('\n--- 7. an insert differing only in case heals against the canonical row ---');
// The index makes this a 409 instead of a silent second row. healClientDup can
// only resolve it if its lookup asks the question the constraint asks: an exact
// name=eq. would miss the differently-spelled row and the job would go dead.
app = await boot();
net.script.push({ match:'/rest/v1/clients', method:'POST', status:409,
  body:{ code:'23505',
         message:'duplicate key value violates unique constraint "clients_name_canon_key"' } });
net.script.push({ match:'/rest/v1/clients?select=*&name_canon=eq.', method:'GET', status:200,
  body:[{ id:'srv-9', name:'Seaford Shipping Lines', salutation:'Mr. Chua',
          contact_person:'Ashford Chua', address:'BREDCO 3, Bacolod City',
          billing_email:'ap@seaford.test', email_cc:null,
          name_canon:'seaford shipping lines', updated_at:BASE }] });
// PostgREST answers a PATCH with the whole row (sb sends return=representation),
// so the merged row is scripted the way the server would really send it.
net.script.push({ match:'/rest/v1/clients?id=eq.srv-9', method:'PATCH', status:200,
  body:[{ id:'srv-9', name:'Seaford Shipping Lines', salutation:'Mr. Chua',
          contact_person:'Ashford Chua', address:'BREDCO 3, Bacolod City',
          billing_email:'ap@seaford.test', email_cc:'accounts@seaford.test',
          name_canon:'seaford shipping lines', updated_at:MOVED }] });

await app.cliSave({ name:'SEAFORD  SHIPPING LINES', salutation:'', contact_person:'',
  address:'', billing_email:'', email_cc:'accounts@seaford.test' }, true);

const look = net.calls.find(c => c.method === 'GET' && /clients\?select=\*&name_canon=eq\./.test(String(c.url)));
ok('the lookup asks for the canonical form', !!look,
   JSON.stringify(net.calls.filter(c => c.method === 'GET').map(c => c.url)));
ok('and it carries the trimmed, collapsed, lowercased name', !!look &&
   String(look.url).indexOf(encodeURIComponent('seaford shipping lines')) > -1, look && look.url);
ok('the raw spelling is never used as the lookup',
   !net.calls.some(c => c.method === 'GET' && /clients\?select=\*&name=eq\./.test(String(c.url))),
   JSON.stringify(net.calls.filter(c => c.method === 'GET').map(c => c.url)));
ok('the case variant does not survive as a second row',
   app.clients.filter(c => /seaford/i.test(c.name || '')).length === 1,
   JSON.stringify(app.clients.map(c => c.name)));
ok('no loc- row survives', !app.clients.some(c => String(c.id).startsWith('loc-')),
   JSON.stringify(app.clients.map(c => c.id)));
// The row was found BY the canonical form of this name, so a different
// spelling of it is what matched, not what is contested. Escalating it would
// make every case variant unresolvable -- a stuck queue in place of a silent
// duplicate, which is the trade this change exists to avoid.
ok('a different spelling of the same client is not a disagreement',
   !(app.deadJobs()[0] && /both changed name/.test(app.deadJobs()[0].err || '')),
   app.deadJobs()[0] && app.deadJobs()[0].err);
ok('the heal completed, so nothing is waiting in Pending writes',
   app.deadJobs().length === 0, JSON.stringify(app.deadJobs()));
ok("the server's spelling is what is kept",
   (app.clients.find(c => c.id === 'srv-9') || {}).name === 'Seaford Shipping Lines',
   JSON.stringify(app.clients.map(c => c.name)));
ok('the cc the server lacked was filled in, not discarded',
   (app.clients.find(c => c.id === 'srv-9') || {}).email_cc === 'accounts@seaford.test',
   JSON.stringify(app.clients.find(c => c.id === 'srv-9')));
ok('and the whole row survived the merge, not just the patched column',
   (app.clients.find(c => c.id === 'srv-9') || {}).billing_email === 'ap@seaford.test');


console.log('\n--- 8. clientRec and cliKey partition names identically ---');
// The app decides what is the same client with clientRec; the server decides it
// with a unique index keyed on cliKey's rule, computed a second time in SQL. If
// those two ever disagree, a name is one client on screen and two rows in the
// table -- the silent duplicate name_canon exists to prevent. Both now go
// through cliKey, so this is structurally true; this is what keeps it that way.
app = await boot();
app.clients.push(app.cliFromServer({ id:'srv-1', name:'Seaford Shipping Lines',
  billing_email:'ap@seaford.test', updated_at:BASE }));
const REF = 'Seaford Shipping Lines';
[REF,
 'seaford shipping lines',
 'SEAFORD  SHIPPING  LINES',
 '  Seaford Shipping Lines  ',
 '\tSeaford Shipping\nLines ',
 'Seaford Shipping Line',
 'Seaford',
 ''].forEach(v => {
  const found = !!app.clientRec(v);
  const agrees = app.cliKey(v) === app.cliKey(REF);
  ok('clientRec matches exactly when cliKey agrees: ' + JSON.stringify(v),
     found === agrees,
     'clientRec ' + found + ', cliKey ' + JSON.stringify(app.cliKey(v)));
});
console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
