import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
const FN_SRC = path.join(ROOT, 'supabase', 'functions', 'send-statement', 'index.ts');
// Pre-deployment review: the bugs found by sweeping, plus the edge cases.
import { net } from './harness.mjs';
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const el = id => document.getElementById(id);
const html = fs.readFileSync(SRC, 'utf8');
const KEYS = ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1',
              'rsr_dwg_catalog_v1','rsr_dwg_clients_v1','rsr_dwg_shared_v1'];
// the Manila year, matching yy2() in the app: deriving it from the device
// makes the suite disagree with the code on 31 Dec / 1 Jan across zones
const YY = new Intl.DateTimeFormat('en-CA',
  { timeZone:'Asia/Manila', year:'numeric' }).format(new Date()).slice(2);
const reset = (cfg) => {
  KEYS.forEach(k => globalThis.localStorage.removeItem(k));
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1',
    JSON.stringify(Object.assign({ seededDW:true }, cfg||{})));
  el('sNo').value = ''; document.activeElement = null;
  return globalThis.__loadApp();
};
const make = async (app, titles, o={}) => {
  app.openEntry(null, o.type || 'DW');
  el('eClient').value = o.client || 'Seaford';
  el('eVessel').value = o.vessel === undefined ? 'MV X' : o.vessel;
  el('eDate').value = o.date || '2026-08-21';
  el('eRate').value = o.rate || '1000';
  app.mlines = titles.map(t => ({ id:null, title:t, ref:'', qty:1, rate:'',
                                  billable:true, rev_of:null, rev_no:null }));
  app.renderML();
  await el('eSave').onclick();
  return app.allGroups()[0];
};
const openStmt = (app, client='Seaford') => {
  el('sClient').value = client;
  el('sFrom').value = '2026-01-01'; el('sTo').value = '2026-12-31';
  el('sType').value = ''; el('sTerms').value='30'; el('sVat').value='0';
  app.buildPick();
};
net.mode = 'offline';

console.log('\n--- 1a. nothing hidden still hit-tests ---');
const rules = [...html.matchAll(/\n([#.][A-Za-z0-9_.\-\[\]="\s,:>()]+)\{([^}]*)\}/g)];
const leaky = rules.filter(([,sel,b]) =>
  (b.includes('opacity:0') || b.includes('visibility:hidden')) &&
  !b.includes('display:none') && !b.includes('pointer-events:none') &&
  !/\.on\b/.test(sel));
ok('no overlay hides by opacity without disabling clicks',
   leaky.length === 0, leaky.map(m => m[1].trim()).join(', '));
ok('a global [hidden] override still exists', /\[hidden\]\{display:none ?!important\}/.test(html));
ok('closing a sheet closes any open suggestion list',
   /function hide\(\)\{\s*cmbHide\(\);/.test(html));

console.log('\n--- 1b. no input handler repaints its own container ---');
const selfRepaint = [...html.matchAll(/\$\('(c\w+List|mlList|impList)'\)\.addEventListener\('input',([\s\S]{0,700}?)\n\}\);/g)]
  .filter(m => new RegExp('repaint\\(\\$\\(\'' + m[1] + '\'').test(m[2]) ||
               /render(Types|CatMgr|CliMgr|Banks|ML|Imp)\(/.test(m[2]));
ok('no panel rebuilds itself while being typed into',
   selfRepaint.length === 0, selfRepaint.map(m => m[1]).join(', '));

console.log('\n--- 1c. long values cannot break their box ---');
ok('a large amount on a card stays on one line',
   /\.row-amt\{[^}]*white-space:nowrap/.test(html));
ok('the printed meta boxes can shrink instead of overflowing',
   /\.stmt-meta>div\{flex:1;min-width:0/.test(html));
ok('the vessel box can too', /\.ves-box \.v\{min-width:0/.test(html));
ok('and its values wrap rather than push the page wide',
   /\.stmt-meta \.v\{[^}]*overflow-wrap:break-word/.test(html));
ok('totals cells already ellipsis', /\.tcell \.val\{[^}]*text-overflow:ellipsis/.test(html));

let app = reset();
await make(app, ['A drawing title that is really quite long indeed and keeps going'],
           { client:'A Very Long Client Company Name Incorporated', rate:'1000000' });
app.expanded = { [app.allGroups()[0].id]: true };
app.render();
ok('a long title and a millions amount render without throwing',
   el('list').innerHTML.includes('1,000,000.00'), 'card rendered');

console.log('\n--- 2a. a claim that fails mid-print ---');
app = reset({ url:'https://p.supabase.co', key:'k' });
app.setSession({ access_token:'t', refresh_token:'r', expires_in:3600, user:{email:'a@b.c'} });
await make(app, ['A']);
openStmt(app);
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
let threw = null;
try { await el('sPrint').onclick(); } catch (e) { threw = e.message; }
ok('print does not throw out to the user', threw === null, String(threw));
ok('the Print button is re-enabled', el('sPrint').disabled === false);
ok('a number was still assigned, provisionally',
   !!app.allGroups()[0].bill_no, String(app.allGroups()[0].bill_no));
const held = app.allGroups()[0].bill_no;
await el('sPrint').onclick();
ok('retrying reuses it rather than claiming twice',
   app.allGroups()[0].bill_no === held, app.allGroups()[0].bill_no);

console.log('\n--- 2b. resetting below what has been issued is called out ---');
app = reset();
await make(app, ['A']);
openStmt(app);
await app.issueBillNos();
ok('a number is on the billing', app.allGroups()[0].bill_no === `BILLDWG-${YY}-001`);
ok('maxIssuedNo sees it', app.maxIssuedNo('DW') === 1, String(app.maxIssuedNo('DW')));
app.renderTypes();
const DW = app.cfg.types.findIndex(t => t.code === 'DW');
let asked = null;
const realConfirm = globalThis.confirm;
globalThis.confirm = (m) => { asked = m; return false; };
el('cTypeList').fire('input', { target: { closest: s2 =>
  s2.startsWith('[data-') ? { dataset:{ tf:'seq', ti:String(DW) }, value:'0' } : null } });
await el('cTypeList').fire('click', { target: { closest: s2 =>
  s2 === '[data-treset]' ? { dataset:{ treset:String(DW) } } : null } });
ok('the reset warns about numbers already in use',
   asked && /already on a billing/.test(asked), String(asked));
ok('and names the clashing number', asked && asked.includes(`BILLDWG-${YY}-001`), String(asked));
ok('declining leaves the counter alone', app.billSeqOf('DW') === 1, String(app.billSeqOf('DW')));
globalThis.confirm = realConfirm;

console.log('\n--- 2c. revisions ---');
app = reset();
await make(app, ['Shell Plan']);
const orig = app.rows[0];
app.openEntry(null, 'DW');
el('eClient').value='Seaford'; el('eVessel').value='MV X';
app.mlines = [app.mlBlank()];
app.mlApply(0, app.titleSuggest('Shell Plan')[0].value);
el('eDate').value='2026-09-01'; el('eRate').value='1000';
await el('eSave').onclick();
app.openEntry(null, 'DW');
el('eClient').value='Seaford'; el('eVessel').value='MV X';
ok('a revision of a revision is Rev 2',
   app.titleSuggest('Shell Plan — Rev 1')[0].label === 'Shell Plan — Rev 2',
   app.titleSuggest('Shell Plan — Rev 1')[0].label);
ok('and the base title is not doubled up',
   !/Rev 1 — Rev/.test(app.titleSuggest('Shell Plan — Rev 1')[0].label));

const rev = app.rows.find(r => r.rev_no === 1);
await app.deleteRow(orig.id);
app.expanded = { [app.groupIdOf(rev)]: true };
app.render();
ok('deleting the original does not break the card',
   el('list').innerHTML.includes('Rev 1'));
ok('and the revision says its original is gone',
   /original deleted/.test(el('list').innerHTML),
   (el('list').innerHTML.match(/revision of[^<]*|original deleted/) || [''])[0]);

console.log('\n--- 2d. groups ---');
app = reset();
const g = await make(app, ['A','B']);
app.openEntry(g.id);
app.mlines = [];
app.renderML();
await el('eSave').onclick();
ok('a group cannot be emptied to nothing', app.rows.length === 2, String(app.rows.length));
ok('the billing survives', app.allGroups().length === 1);

app = reset({ url:'https://p.supabase.co', key:'k' });
app.setSession({ access_token:'t', refresh_token:'r', expires_in:3600, user:{email:'a@b.c'} });
globalThis.fetch = async () => { throw new TypeError('offline'); };
const g2 = await make(app, ['X','Y']);
app.openEntry(g2.id);
app.mlines[0].title = 'X edited';
app.renderML();
await el('eSave').onclick();
const ins = app.queue.filter(j => j.op === 'insert' && !j.store);
ok('editing a still-queued billing does not double-insert', ins.length === 2, String(ins.length));
ok('the edit folds into the pending insert',
   ins.some(j => j.data.drawing_title === 'X edited'),
   JSON.stringify(ins.map(j => j.data.drawing_title)));
ok('no stray update job for an unsynced row',
   app.queue.filter(j => j.op === 'update' && !j.store).length === 0,
   String(app.queue.filter(j => j.op === 'update' && !j.store).length));

console.log('\n--- 3. offline, then online ---');
app = reset({ url:'https://p.supabase.co', key:'k' });
await make(app, ['Offline Line']);
openStmt(app);
const prov = await app.issueBillNos();
ok('offline printing still yields a number', !!prov, prov);
ok('it is stored on the billing', app.allGroups()[0].bill_no === prov);
const queuedBefore = app.queue.length;
ok('the rows are queued', queuedBefore > 0, String(queuedBefore));
// hard refresh mid-queue
app = globalThis.__loadApp();
ok('the queue survives a reload', app.queue.length === queuedBefore,
   app.queue.length + ' vs ' + queuedBefore);
ok('and so does the billing number', app.allGroups()[0].bill_no === prov,
   String(app.allGroups()[0].bill_no));
ok('and the lines', app.allGroups()[0].count === 1);

console.log('\n--- 5. client names ---');
app = reset();
await make(app, ['A'], { client:'Seaford' });
await make(app, ['B'], { client:'seaford ' });
await make(app, ['C'], { client:' SEAFORD' });
ok('one spelling survives', [...new Set(app.rows.map(r => r.client))].length === 1,
   JSON.stringify([...new Set(app.rows.map(r => r.client))]));
ok('the first spelling wins', app.rows.every(r => r.client === 'Seaford'),
   JSON.stringify(app.rows.map(r => r.client)));
ok('one client record, not three', app.clients.length === 1,
   JSON.stringify(app.clients.map(c => c.name)));
ok('the typeahead offers it once', app.clientSuggest('sea').length === 1,
   JSON.stringify(app.clientSuggest('sea').map(i => i.label)));
openStmt(app, 'Seaford');
ok('the statement finds all three billings', app.stmtCandidates().length === 3,
   String(app.stmtCandidates().length));
ok('inner whitespace is collapsed too',
   app.canonClient('  Cebu   Drydock  ') === 'Cebu Drydock',
   app.canonClient('  Cebu   Drydock  '));
ok('an unknown name is just trimmed',
   app.canonClient('  New Yard ') === 'New Yard', app.canonClient('  New Yard '));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
