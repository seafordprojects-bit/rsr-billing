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
// the Manila year, matching yy2() in the app: deriving it from the device
// makes the suite disagree with the code on 31 Dec / 1 Jan across zones
const YY = new Intl.DateTimeFormat('en-CA',
  { timeZone:'Asia/Manila', year:'numeric' }).format(new Date()).slice(2);
const reset = () => {
  KEYS.forEach(k => globalThis.localStorage.removeItem(k));
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW:true }));
  el('sNo').value = ''; document.activeElement = null;
  return globalThis.__loadApp();
};
const make = async (app, titles, o={}) => {
  app.openEntry(null, o.type || 'DW');
  el('eClient').value = o.client || 'Seaford';
  el('eVessel').value = 'MV X';
  el('eDate').value = o.date || '2026-08-21';
  el('eRate').value = '1000';
  app.mlines = titles.map(t => ({ id:null, title:t, ref:'', qty:1, rate:'',
                                  billable:true, rev_of:null, rev_no:null }));
  app.renderML();
  await el('eSave').onclick();
  return app.allGroups()[0];
};
const openStmt = (app) => {
  el('sClient').value = 'Seaford';
  el('sFrom').value = '2026-01-01'; el('sTo').value = '2026-12-31';
  el('sType').value = ''; el('sTerms').value = '30'; el('sVat').value = '0';
  app.openStmt();
};
const type = (v) => { el('sNo').value = v; el('sNo').fire('input', {}); };

net.mode = 'offline';
let app = reset();

console.log('\n--- 1. not issued: a live auto value ---');
await make(app, ['A']);
openStmt(app);
ok('field shows the next number', el('sNo').value === `BILLDWG-${YY}-001`, el('sNo').value);
ok('labelled as auto', el('sNoHint').textContent === `auto — will issue as BILLDWG-${YY}-001`,
   el('sNoHint').textContent);
ok('hint is visible', el('sNoHint').hidden === false);
ok('no reset control while already auto', el('sNoReset').hidden === true);
ok('nothing claimed yet', !app.allGroups()[0].bill_no);
ok('counter untouched', app.billSeqOf('DW') === 0, String(app.billSeqOf('DW')));

console.log('\n--- it follows the counter ---');
await app.setBillSeq('DW', 7);
app.refreshBillNo();
ok('auto value tracks the counter', el('sNo').value === `BILLDWG-${YY}-008`, el('sNo').value);
ok('and the label follows', /will issue as BILLDWG-26-008/.test(el('sNoHint').textContent) ||
   el('sNoHint').textContent === `auto — will issue as BILLDWG-${YY}-008`,
   el('sNoHint').textContent);
await app.setBillSeq('DW', 0);
app.refreshBillNo();
ok('and back down again', el('sNo').value === `BILLDWG-${YY}-001`, el('sNo').value);

console.log('\n--- 4. hand-edited values are kept verbatim ---');
type('BILLDWG-26-099');
ok('mode switches to manual', app.sNoMode === 'manual', app.sNoMode);
ok('hint says so', /typed by hand/.test(el('sNoHint').textContent), el('sNoHint').textContent);
ok('reset control appears', el('sNoReset').hidden === false);
await app.setBillSeq('DW', 40);
app.refreshBillNo();
ok('it does not drift with the counter', el('sNo').value === 'BILLDWG-26-099', el('sNo').value);
app.buildPick();                      // the picker refresh must not clobber it either
ok('nor when the picks change', el('sNo').value === 'BILLDWG-26-099', el('sNo').value);
await app.setBillSeq('DW', 0);

console.log('\n--- clearing the field hands back to auto ---');
type('');
ok('mode returns to auto', app.sNoMode === 'auto', app.sNoMode);
ok('and the auto value is back', el('sNo').value === `BILLDWG-${YY}-001`, el('sNo').value);
ok('reset control hidden again', el('sNoReset').hidden === true);

console.log('\n--- 2. once issued, the stored number is shown and reused ---');
const issued = await app.issueBillNos();
ok('claimed on first issue', issued === `BILLDWG-${YY}-001`, issued);
ok('mode is issued', app.sNoMode === 'issued', app.sNoMode);
app.refreshBillNo();
ok('field shows the stored number', el('sNo').value === issued, el('sNo').value);
ok('hint says issued', /issued as/.test(el('sNoHint').textContent), el('sNoHint').textContent);
ok('counter moved once', app.billSeqOf('DW') === 1, String(app.billSeqOf('DW')));
const again = await app.issueBillNos();
ok('a reprint never re-mints', again === issued, again);
ok('and the counter stays put', app.billSeqOf('DW') === 1, String(app.billSeqOf('DW')));

console.log('\n--- 3. reset to auto, while DRAFT ---');
ok('the control is offered on a draft', el('sNoReset').hidden === false);
let asked = null;
const realConfirm = globalThis.confirm;
globalThis.confirm = (m) => { asked = m; return false; };
await el('sNoReset').onclick();
ok('it warns first', !!asked, String(asked));
ok('naming the number being released', asked.includes(issued), asked);
ok('and saying it stays consumed', /stays used up/.test(asked), asked);
ok('pointing at the Settings counter', /counter in Settings/.test(asked), asked);
ok('declining keeps the number', app.allGroups()[0].bill_no === issued,
   String(app.allGroups()[0].bill_no));

globalThis.confirm = () => true;
await el('sNoReset').onclick();
ok('accepting unlinks the number', !app.allGroups()[0].bill_no,
   String(app.allGroups()[0].bill_no));
ok('mode back to auto', app.sNoMode === 'auto', app.sNoMode);
ok('the released number stays consumed', app.billSeqOf('DW') === 1,
   String(app.billSeqOf('DW')));
ok('so the next auto value is the one after it',
   el('sNo').value === `BILLDWG-${YY}-002`, el('sNo').value);
const fresh = await app.issueBillNos();
ok('the next print claims fresh', fresh === `BILLDWG-${YY}-002`, fresh);
ok('and it is stored', app.allGroups()[0].bill_no === fresh);

console.log('\n--- lowering the counter afterwards does reclaim it ---');
globalThis.confirm = () => true;
await el('sNoReset').onclick();
await app.setBillSeq('DW', 0);
app.refreshBillNo();
ok('auto is back to 001', el('sNo').value === `BILLDWG-${YY}-001`, el('sNo').value);
globalThis.confirm = realConfirm;

console.log('\n--- a billed billing is not offered the reset ---');
app = reset();
const g = await make(app, ['B']);
openStmt(app);
await app.issueBillNos();
app.markGroup(app.allGroups()[0].id, 'BILLED');
openStmt(app);
ok('still shows its number', el('sNo').value === `BILLDWG-${YY}-001`, el('sNo').value);
ok('reset hidden once billed', el('sNoReset').hidden === true);
ok('hint drops the editing offer', !/reset to auto/.test(el('sNoHint').textContent),
   el('sNoHint').textContent);

console.log('\n--- opening the sheet starts from auto again ---');
app = reset();
await make(app, ['C']);
openStmt(app);
type('BILLDWG-26-555');
ok('manual while open', app.sNoMode === 'manual');
openStmt(app);
ok('reopening resets to auto', app.sNoMode === 'auto' &&
   el('sNo').value === `BILLDWG-${YY}-001`, app.sNoMode + ' ' + el('sNo').value);

console.log('\n--- the control is wired in the markup ---');
ok('reset button present', /id="sNoReset"/.test(html));
ok('it sits beside the field', /class="f-inline"[\s\S]{0,200}id="sNo"[\s\S]{0,220}id="sNoReset"/.test(html));
ok('and is labelled plainly', /id="sNoReset"[^>]*>Reset to auto</.test(html));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
