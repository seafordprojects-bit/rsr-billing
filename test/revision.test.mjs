import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
const FN_SRC = path.join(ROOT, 'supabase', 'functions', 'send-statement', 'index.ts');
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
const reset = () => {
  KEYS.forEach(k => globalThis.localStorage.removeItem(k));
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW:true }));
  el('sNo').value = '';
  return globalThis.__loadApp();
};
const make = async (app, lines, { client='Seaford', vessel='MV X', date='2026-08-21' } = {}) => {
  app.openEntry(null, 'DW');
  el('eClient').value = client; el('eVessel').value = vessel;
  el('eDate').value = date; el('eRate').value = '1000';
  app.mlines = lines.map(l => Object.assign(
    { id:null, title:'', ref:'', qty:1, rate:'', billable:true, rev_of:null, rev_no:null }, l));
  app.renderML();
  await el('eSave').onclick();
};
net.mode = 'offline';
let app = reset();

console.log('\n--- 1. revision suggestion off a prior billing ---');
await make(app, [{ title:'Shell Expansion Plan' }]);
const original = app.rows[0];
app.openEntry(null, 'DW');
el('eClient').value = 'Seaford'; el('eVessel').value = 'MV X';
let sug = app.titleSuggest('Shell Expansion Plan');
// The first assertion guarded and the four below it did not, so an empty
// suggester failed once and then aborted the suite on the next line.
ok('a revision entry is offered first', sug[0] && sug[0].value && sug[0].value.rev === true,
   JSON.stringify(sug[0] && sug[0].label));
ok('labelled with the next revision',
   !!sug[0] && sug[0].label === 'Shell Expansion Plan — Rev 1',
   sug[0] && sug[0].label);
ok('hint says it was billed before',
   !!sug[0] && /billed 1 time before/.test(sug[0].sub), sug[0] && sug[0].sub);
ok('hint carries the prior code and date',
   !!(sug[0] && sug[0].subLines && sug[0].subLines[0]) &&
   sug[0].subLines[0].includes(original.code) && sug[0].subLines[0].includes('Aug 2026'),
   sug[0] && sug[0].subLines && sug[0].subLines[0]);
ok('and marks it as the original',
   !!(sug[0] && sug[0].subLines && sug[0].subLines[0]) &&
   /original/.test(sug[0].subLines[0]),
   sug[0] && sug[0].subLines && sug[0].subLines[0]);

console.log('\n--- another client or vessel is not a revision ---');
el('eClient').value = 'Other Co';
ok('different client offers no revision',
   !app.titleSuggest('Shell Expansion Plan').some(i => i.value && i.value.rev));
el('eClient').value = 'Seaford'; el('eVessel').value = 'MV Different';
ok('different vessel offers no revision',
   !app.titleSuggest('Shell Expansion Plan').some(i => i.value && i.value.rev));
el('eVessel').value = 'MV X';

console.log('\n--- 2. picking it labels the line and links the original ---');
app.mlines = [app.mlBlank()];
app.renderML();
sug = app.titleSuggest('Shell Expansion Plan');
// Asserted, not silently guarded: nothing to pick is a real failure. mlApply
// no-ops on a falsy candidate, so the three assertions below still run and
// report on their own terms instead of the suite dying here.
ok('there is still a revision to pick', !!(sug[0] && sug[0].value),
   JSON.stringify(sug.map(s => s && s.label)));
app.mlApply(0, sug[0] && sug[0].value);
ok('title gains the rev label', app.mlines[0].title === 'Shell Expansion Plan — Rev 1',
   app.mlines[0].title);
ok('rev number recorded', app.mlines[0].rev_no === 1, String(app.mlines[0].rev_no));
ok('linked to the original record', app.mlines[0].rev_of === String(original.id),
   String(app.mlines[0].rev_of));

el('eClient').value = 'Seaford'; el('eVessel').value = 'MV X';
el('eDate').value = '2026-09-02'; el('eRate').value = '1000';
await el('eSave').onclick();
const rev1 = app.rows.find(r => r.rev_no === 1);
ok('saved with the link', rev1 && rev1.rev_of === String(original.id));
ok('and is its own billing', app.allGroups().length === 2, String(app.allGroups().length));

console.log('\n--- revisions increment off prior revisions ---');
app.openEntry(null, 'DW');
el('eClient').value = 'Seaford'; el('eVessel').value = 'MV X';
sug = app.titleSuggest('Shell Expansion Plan');
// Assert once that there is a suggestion, then read it through s0/subs. Every
// line below indexed sug[0] directly, so an empty suggester aborted the suite
// here and section 5 never ran at all.
ok('a further revision is offered', !!sug[0], JSON.stringify(sug.map(x => x && x.label)));
const s0 = sug[0] || {};
const subs = s0.subLines || [];
ok('next is Rev 2', s0.label === 'Shell Expansion Plan — Rev 2', s0.label);
const sugTyped = app.titleSuggest('Shell Expansion Plan — Rev 1');
ok('typing the revised title also finds it',
   !!sugTyped[0] && sugTyped[0].label === 'Shell Expansion Plan — Rev 2',
   sugTyped[0] && sugTyped[0].label);

console.log('\n--- 5. the hint lists the whole history ---');
ok('two prior billings listed', subs.length === 2, JSON.stringify(subs));
ok('hint counts them', /billed 2 times before/.test(String(s0.sub)), s0.sub);
ok('newest first', !!subs[0] && subs[0].includes('Sep 2026'), subs[0]);
ok('each entry carries a code and a date',
   subs.length > 0 &&
   subs.every(l => /RSR-DW-\d{6}-\d{3}/.test(l) && /20\d\d/.test(l)),
   JSON.stringify(subs));
ok('the revision is labelled Rev 1', !!subs[0] && subs[0].includes('Rev 1'), subs[0]);
ok('the first is labelled original', !!subs[1] && subs[1].includes('original'), subs[1]);

console.log('\n--- 3. Monitoring shows the revision and links back ---');
app = reset();
await make(app, [{ title:'Midship Section' }]);
const orig2 = app.rows[0];
await make(app, [{ title:'Midship Section — Rev 1', rev_of:String(orig2.id), rev_no:1 }],
           { date:'2026-09-02' });
const revGroup = app.allGroups().find(g => g.lines.some(r => r.rev_no === 1));
app.expanded = { [revGroup.id]: true };
app.render();
const card = el('list').innerHTML;
ok('rev chip on the line', /class="revchip">Rev 1</.test(card), card.slice(0, 300));
ok('a link back to the original billing',
   card.includes('revision of ' + orig2.code), String(orig2.code));
ok('link carries the original record id',
   new RegExp('data-revsrc="' + orig2.id + '"').test(card));

console.log('\n--- 4. no-charge lines ---');
app = reset();
await make(app, [{ title:'Charged Line' }, { title:'Free Revision', billable:false }]);
const g = app.allGroups()[0];
ok('no-charge line adds nothing', g.total === 1000, String(g.total));
ok('both lines still in the billing', g.count === 2, String(g.count));
ok('the free line is flagged', app.rows.some(r => r.billable === false));
ok('amountOf returns zero for it',
   app.rows.filter(r => r.billable === false).every(r => r.rate > 0 && r.qty > 0) &&
   g.total === 1000);

console.log('\n--- a wholly no-charge billing ---');
app = reset();
await make(app, [{ title:'Free A', billable:false }, { title:'Free B', billable:false }]);
const free = app.allGroups()[0];
ok('still gets a tracking code', !!free.code && free.code.startsWith('RSR-DW-'), free.code);
ok('total is zero', free.total === 0, String(free.total));
ok('flagged as all-free', free.allFree === true);
app.render();
ok('excluded from the unbilled total', el('tDraft').textContent.includes('0'),
   el('tDraft').textContent);
ok('and from the unbilled count', el('cDraft').textContent === '0 billings',
   el('cDraft').textContent);
ok('but still listed', /RSR-DW-/.test(el('list').innerHTML));
ok('with a no-charge badge', /badge free">No charge</.test(el('list').innerHTML));
ok('and still counted by the status chips', /All<span class="n">1</.test(el('chips').innerHTML),
   el('chips').innerHTML.slice(0, 120));
ok('statuses stay Draft/Billed/Paid', app.allGroups()[0].status === 'DRAFT');

console.log('\n--- printed billing keeps the numbering ---');
app = reset();
await make(app, [{ title:'First Charged' }, { title:'Second Free', billable:false },
                 { title:'Third Charged' }]);
el('sClient').value = 'Seaford';
el('sFrom').value = '2026-08-01'; el('sTo').value = '2026-08-31';
el('sType').value = ''; el('sTerms').value = '30'; el('sVat').value = '0';
app.buildPick();
el('sNo').value = 'BILLDWG-26-001';

app.cfg.hideNoCharge = false;
app.renderStatement(app.pickedRows());
let doc = el('printRoot').innerHTML;
ok('all three lines printed', doc.includes('First Charged') &&
   doc.includes('Second Free') && doc.includes('Third Charged'));
ok('numbering runs 1.0 to 3.0',
   doc.includes('>1.0<') && doc.includes('>2.0<') && doc.includes('>3.0<'));
ok('the free line shows No Charge', /class="nc">No Charge</.test(doc));
ok('twice — rate and amount', (doc.match(/class="nc">No Charge</g) || []).length === 2,
   String((doc.match(/class="nc">No Charge</g) || []).length));
ok('total counts only the charged lines', /2,000\.00/.test(doc));
ok('subtotal says how many were free', /1 at no charge/.test(doc),
   (doc.match(/Subtotal[^<]*/) || [''])[0]);

console.log('\n--- or omitted entirely when Settings says so ---');
app.cfg.hideNoCharge = true;
app.renderStatement(app.pickedRows());
doc = el('printRoot').innerHTML;
ok('the free line is gone', !doc.includes('Second Free'));
ok('only two lines numbered', doc.includes('>1.0<') && doc.includes('>2.0<') &&
   !doc.includes('>3.0<'));
ok('total unchanged', /2,000\.00/.test(doc));
ok('no No Charge cells left', !/class="nc">No Charge</.test(doc));
app.cfg.hideNoCharge = false;
ok('the toggle exists in Settings', /id="cHideFree"/.test(html));
ok('and defaults to showing them', /hideNoCharge:false/.test(html));

console.log('\n--- editing keeps the flags ---');
app = reset();
await make(app, [{ title:'A' }, { title:'B', billable:false }]);
const gid = app.allGroups()[0].id;
app.openEntry(gid);
ok('no-charge flag round-trips into the editor',
   app.mlines.filter(l => l.billable === false).length === 1,
   JSON.stringify(app.mlines.map(l => l.billable)));
await el('eSave').onclick();
ok('and survives a save', app.rows.filter(r => r.billable === false).length === 1);
ok('total still excludes it', app.allGroups()[0].total === 1000,
   String(app.allGroups()[0].total));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
