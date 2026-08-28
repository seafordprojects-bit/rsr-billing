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
              'rsr_dwg_catalog_v1','rsr_dwg_clients_v1'];
const reset = (cfg) => {
  KEYS.forEach(k => globalThis.localStorage.removeItem(k));
  if (cfg) globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify(cfg));
  return globalThis.__loadApp();
};
const YY = String(new Date().getFullYear()).slice(2);
net.mode = 'offline';
let app = reset();

console.log('\n--- A. a prefix per document type ---');
ok('DW -> BILLDWG', app.billPrefixOf('DW') === 'BILLDWG', app.billPrefixOf('DW'));
ok('UT -> BILLUTG', app.billPrefixOf('UT') === 'BILLUTG', app.billPrefixOf('UT'));
ok('DC -> BILLDC',  app.billPrefixOf('DC') === 'BILLDC',  app.billPrefixOf('DC'));
ok('a custom type gets BILL+code', app.billPrefixOf('ZZ') === 'BILLZZ', app.billPrefixOf('ZZ'));

console.log('\n--- B. each type runs its own yearly series ---');
ok('DW starts at 001', app.nextBillNo('DW') === `BILLDWG-${YY}-001`, app.nextBillNo('DW'));
ok('UT starts at 001', app.nextBillNo('UT') === `BILLUTG-${YY}-001`, app.nextBillNo('UT'));
app.commitBillNo(`BILLDWG-${YY}-001`, 'DW');
app.commitBillNo(`BILLDWG-${YY}-002`, 'DW');
ok('DW advanced to 003', app.nextBillNo('DW') === `BILLDWG-${YY}-003`, app.nextBillNo('DW'));
ok('UT untouched by DW', app.nextBillNo('UT') === `BILLUTG-${YY}-001`, app.nextBillNo('UT'));
ok('DC untouched by DW', app.nextBillNo('DC') === `BILLDC-${YY}-001`, app.nextBillNo('DC'));
app.commitBillNo(`BILLDC-${YY}-005`, 'DC');
ok('DC honours an edited number', app.nextBillNo('DC') === `BILLDC-${YY}-006`, app.nextBillNo('DC'));
ok('DW still on its own run', app.nextBillNo('DW') === `BILLDWG-${YY}-003`, app.nextBillNo('DW'));

console.log('\n--- C. series roll over per type, per year ---');
app.cfg.billSeries.DW = { y: String(Number(YY) - 1), n: 88 };
ok('a new year restarts that type', app.nextBillNo('DW') === `BILLDWG-${YY}-001`, app.nextBillNo('DW'));
ok('other types unaffected', app.nextBillNo('DC') === `BILLDC-${YY}-006`);

console.log('\n--- D. upgrade from the single shared series ---');
app = reset({ billYear: YY, billSeq: 12 });
ok('the old counter becomes the drawing series',
   app.nextBillNo('DW') === `BILLDWG-${YY}-013`, app.nextBillNo('DW'));
ok('the other types start clean',
   app.nextBillNo('UT') === `BILLUTG-${YY}-001` &&
   app.nextBillNo('DC') === `BILLDC-${YY}-001`);

console.log('\n--- E. prefixes are editable per type ---');
app = reset();
const t = app.typeList().find(x => x.code === 'UT');
t.bill = 'BILLULTRA';
ok('edited prefix used', app.nextBillNo('UT') === `BILLULTRA-${YY}-001`, app.nextBillNo('UT'));
ok('Settings renders a prefix field per type',
   /data-tf="bill"/.test(html));
app.renderTypes();
ok('and previews each type\'s next number',
   el('cTypeList').innerHTML.includes(`BILLDWG-${YY}-`) &&
   el('cTypeList').innerHTML.includes(`BILLULTRA-${YY}-`),
   el('cTypeList').innerHTML.slice(0, 200));
ok('the single global prefix field is gone', !/id="cBillPrefix"/.test(html));

console.log('\n--- F. the builder picks the series from the billing itself ---');
app = reset();
app.rows.push(
 { id:'a', code:'RSR-DW-082026-001', doc_type:'DW', bill_date:'2026-08-10', client:'Seaford',
   drawing_title:'Shell', qty:1, rate:1000, status:'DRAFT' },
 { id:'b', code:'RSR-DC-082026-001', doc_type:'DC', bill_date:'2026-08-11', client:'Seaford',
   drawing_title:'Cert',  qty:1, rate:1000, status:'DRAFT' });
el('sClient').value = 'Seaford';
el('sFrom').value = '2026-08-01'; el('sTo').value = '2026-08-31';

el('sType').value = 'DC';
ok('an explicit type filter selects that series', app.billTypeFor() === 'DC', app.billTypeFor());
el('sType').value = 'UT';
ok('and again for UT', app.billTypeFor() === 'UT', app.billTypeFor());

el('sType').value = '';
app.buildPick();
ok('unfiltered but mixed rows fall back to the default',
   app.billTypeFor() === 'DW', app.billTypeFor());

console.log('\n--- G. an edited number is never overwritten ---');
el('sType').value = 'DC';
app.refreshBillNo(true);
const auto = el('sNo').value;
ok('auto-filled for the chosen type', auto === `BILLDC-${YY}-001`, auto);
el('sNo').value = 'BILLDC-26-099'; el('sNo').fire('input', {});
app.refreshBillNo();
ok('a hand-typed number survives a refresh', el('sNo').value === 'BILLDC-26-099', el('sNo').value);
// clearing the field is how you hand it back to auto
el('sType').value = 'UT';
el('sNo').value = ''; el('sNo').fire('input', {});
ok('an auto number follows the type change',
   el('sNo').value === `BILLUTG-${YY}-001`, el('sNo').value);
ok('and is still in auto mode', app.sNoMode === 'auto', app.sNoMode);

console.log('\n--- H. issuing burns only that type ---');
app = reset();
app.commitBillNo(`BILLUTG-${YY}-001`, 'UT');
ok('UT advanced', app.nextBillNo('UT') === `BILLUTG-${YY}-002`);
ok('DW untouched', app.nextBillNo('DW') === `BILLDWG-${YY}-001`);
ok('DC untouched', app.nextBillNo('DC') === `BILLDC-${YY}-001`);
// both issue paths go through issueBillNos, which claims once per billing
ok('print path issues through issueBillNos',
   /\$\('sPrint'\)\.onclick[\s\S]{0,400}await issueBillNos\(\)/.test(html));
// the email path claims at the Send step, not when the letter is composed:
// backing out of the review must not burn a number
// the window is generous because lSend loads the PDF library before claiming,
// so the CDN cannot cost a number -- see the same order in $('sPdf')
// Ordering, asserted by position inside lSend rather than by a character
// window. The window version broke the moment a comment was added above the
// claim -- which says nothing about whether the order is still right.
const lSendSrc = (html.match(/\$\('lSend'\)\.onclick=async\(\)=>\{[\s\S]*?\n\};/) || [''])[0];
ok('the lSend block was found', lSendSrc.length > 0);
ok('email path issues through issueBillNos',
   lSendSrc.indexOf('await issueBillNos()') > -1, 'no claim in lSend');
ok('and loads the pdf library before it claims',
   lSendSrc.indexOf('await loadJsPdf()') > -1 &&
   lSendSrc.indexOf('await loadJsPdf()') < lSendSrc.indexOf('await issueBillNos()'),
   'loadJsPdf@' + lSendSrc.indexOf('await loadJsPdf()') +
   ' issue@' + lSendSrc.indexOf('await issueBillNos()'));
ok('and not before the letter is reviewed',
   !/\$\('sEmailBtn'\)\.onclick[\s\S]{0,1400}await issueBillNos\(\)/.test(html));
ok('issueBillNos resolves the type per billing',
   /async function issueBillNos\(\)[\s\S]{0,900}typeOf\(g\)/.test(html));
ok('and never re-claims an issued one',
   /if\(g\.bill_no\)continue;/.test(html));

console.log('\n--- G2. a BILLED billing can be re-sent under its own number ---');
// The send dialog was never gated on DRAFT -- stmtCandidates filters on PAID.
// What was missing was a way in: the FAB opens on the current month, so an
// older billing simply was not in the picker.
app = reset();
app.rows.push(
 { id:'s1', group_id:'g9', line_no:1, code:'RSR-DW-072026-004', doc_type:'DW',
   bill_no:'BILLDWG-' + YY + '-041', bill_date:'2026-07-14', client:'Seaford',
   drawing_title:'Shell Expansion', qty:1, rate:2500, status:'BILLED',
   billed_date:'2026-07-14' },
 { id:'s2', group_id:'g8', line_no:1, code:'RSR-DW-082026-009', doc_type:'DW',
   bill_date:'2026-08-02', client:'Seaford',
   drawing_title:'Midship', qty:1, rate:1000, status:'DRAFT' });

const beforeNo = app.nextBillNo('DW');
app.openStmtFor('g9');

ok('the sheet opened', el('sheetStmt').classList.contains('on'));
ok('scoped to that client', el('sClient').value === 'Seaford', el('sClient').value);
ok('and to its own date, not this month',
   el('sFrom').value === '2026-07-14' && el('sTo').value === '2026-07-14',
   el('sFrom').value + '..' + el('sTo').value);
const pickedIds = app.pickedRows().map(g => g.id);
ok('only that billing is ticked', pickedIds.length === 1 && pickedIds[0] === 'g9',
   JSON.stringify(pickedIds));
ok('the number shown is the one already issued',
   el('sNo').value === 'BILLDWG-' + YY + '-041', el('sNo').value);
ok('in issued mode, so a print reuses it', app.sNoMode === 'issued', app.sNoMode);
ok('the counter did not move', app.nextBillNo('DW') === beforeNo,
   beforeNo + ' -> ' + app.nextBillNo('DW'));
ok('and it is still BILLED — opening the sheet changes no status',
   app.groupById('g9').status === 'BILLED', app.groupById('g9').status);

console.log('\n--- G3. a paid billing is refused, not silently opened ---');
app.rows[0].status = 'PAID';
app.openStmtFor('g9');
ok('the toast says why', /paid/i.test(el('toast').textContent), el('toast').textContent);

console.log('\n--- G4. the card offers the way in ---');
ok('cards carry a data-send action', /data-send=/.test(html));
ok('BILLED says Re-send, DRAFT says Send',
   /'Re-send':'Send'/.test(html));
ok('PAID gets neither', /status==='DRAFT'\|\|g\.status==='BILLED'/.test(html));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
