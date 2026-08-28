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
  return globalThis.__loadApp();
};
// the type editor is rendered by innerHTML, so drive its handlers the way a
// browser would: fire input on the field, then click the button
const typeIndex = (app, code) => app.cfg.types.findIndex(t => t.code === code);
const typeInto = (app, i, value) =>
  el('cTypeList').fire('input', { target: { closest: sel =>
    sel === '[data-tf]' ? { dataset:{ tf:'seq', ti:String(i) }, value:String(value) } : null } });
const blur = (app, i, value) =>
  el('cTypeList').fire('change', { target: { closest: sel =>
    sel === '[data-tf]' ? { dataset:{ tf:'seq', ti:String(i) }, value:String(value) } : null } });
const pressSet = (app, i) =>
  el('cTypeList').fire('click', { target: { closest: sel =>
    sel === '[data-treset]' ? { dataset:{ treset:String(i) } } : null } });

net.mode = 'offline';
let app = reset();
app.renderTypes();
const DW = typeIndex(app, 'DW');

console.log('\n--- the counter field is not the label field ---');
const labelBefore = app.cfg.types[DW].label;
typeInto(app, DW, '0');
ok('typing a counter leaves the label alone',
   app.cfg.types[DW].label === labelBefore,
   app.cfg.types[DW].label + ' (was ' + labelBefore + ')');
ok('and does not touch the code', app.cfg.types[DW].code === 'DW', app.cfg.types[DW].code);
ok('and does not touch the billing prefix',
   app.cfg.types[DW].bill === 'BILLDWG', app.cfg.types[DW].bill);
ok('the label input is explicitly tagged', /data-tf="label"/.test(html));
ok('the input handler no longer falls through to the label',
   !/else item\.label=t\.value;/.test(html));

console.log('\n--- blurring the field does not discard what was typed ---');
ok('change ignores the counter field', /if\(t\.dataset\.tf==='seq'\)return;/.test(html));
blur(app, DW, '0');
await new Promise(r => setTimeout(r, 5));
ok('the counter is untouched until Set counter is pressed',
   app.billSeqOf('DW') === 0, String(app.billSeqOf('DW')));

console.log('\n--- reset DW to 0 so the next number is 001 ---');
await app.setBillSeq('DW', 4);
ok('DW starts burned at 4', app.billSeqOf('DW') === 4, String(app.billSeqOf('DW')));
ok('so the next would be 005', app.nextBillNo('DW') === `BILLDWG-${YY}-005`,
   app.nextBillNo('DW'));

app.renderTypes();
typeInto(app, DW, '0');
await pressSet(app, DW);
await new Promise(r => setTimeout(r, 10));
ok('0 is accepted', app.billSeqOf('DW') === 0, String(app.billSeqOf('DW')));
ok('the next number is 001', app.nextBillNo('DW') === `BILLDWG-${YY}-001`,
   app.nextBillNo('DW'));
ok('DW now matches where UT and DC start',
   app.billSeqOf('DW') === app.billSeqOf('UT') &&
   app.billSeqOf('DW') === app.billSeqOf('DC'),
   [app.billSeqOf('DW'), app.billSeqOf('UT'), app.billSeqOf('DC')].join(','));
ok('the reset is shared, not device-local',
   app.queue.some(j => j.op === 'upsert' && j.key === 'billseq:DW'));
ok('the label survived the whole exchange',
   app.cfg.types[DW].label === labelBefore, app.cfg.types[DW].label);

console.log('\n--- other values still work ---');
app.renderTypes();
typeInto(app, DW, '12');
await pressSet(app, DW);
await new Promise(r => setTimeout(r, 10));
ok('a non-zero reset lands', app.billSeqOf('DW') === 12, String(app.billSeqOf('DW')));
ok('next is 013', app.nextBillNo('DW') === `BILLDWG-${YY}-013`, app.nextBillNo('DW'));

console.log('\n--- guards ---');
app.renderTypes();
typeInto(app, DW, '');
await pressSet(app, DW);
await new Promise(r => setTimeout(r, 10));
ok('a blank field does not silently zero the counter',
   app.billSeqOf('DW') === 12, String(app.billSeqOf('DW')));
app.renderTypes();
typeInto(app, DW, '-3');
await pressSet(app, DW);
await new Promise(r => setTimeout(r, 10));
ok('a negative value is refused', app.billSeqOf('DW') === 12, String(app.billSeqOf('DW')));

console.log('\n--- setBillSeq itself accepts zero ---');
ok('0 stored as 0', (await app.setBillSeq('UT', 0)) === 0);
ok('and read back as 0', app.billSeqOf('UT') === 0, String(app.billSeqOf('UT')));
ok('the field is rendered with min 0', /data-tf="seq"[^>]*min="0"/.test(html) ||
   /min="0"[^>]*data-tf="seq"/.test(html) ||
   /data-tf="seq"[\s\S]{0,120}min="0"/.test(html), 'min attribute');

console.log('\n--- a fresh render starts from the stored values ---');
app.renderTypes();
ok('held drafts cleared on render', /function renderTypes\(\)\{\s*seqDraft=\{\};/.test(html));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
