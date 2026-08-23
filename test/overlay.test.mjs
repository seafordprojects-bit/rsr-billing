import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
const FN_SRC = path.join(ROOT, 'supabase', 'functions', 'send-statement', 'index.ts');
// Anything hidden only visually must also stop hit-testing, or it silently
// eats clicks on whatever is underneath.
import { net } from './harness.mjs';
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const el = id => document.getElementById(id);
const html = fs.readFileSync(SRC, 'utf8');

const ruleFor = (sel) => {
  const i = html.indexOf('\n' + sel + '{');
  return i < 0 ? null : html.slice(i + 1, html.indexOf('}', i) + 1);
};

console.log('\n--- A. the specific regression: closed sheets ate desktop clicks ---');
const base = ruleFor('.sheet');
ok('.sheet exists', !!base);
ok('a closed sheet does not hit-test', /pointer-events:none/.test(base), base);
const on = ruleFor('.sheet.on');
ok('an open sheet does hit-test again', /pointer-events:auto/.test(on), on);

const desktop = html.match(/\.sheet\{border-radius:16px[^}]*\}/)[0];
ok('desktop still parks closed sheets centred at opacity 0 (so the guard matters)',
   /top:50%/.test(desktop) && /opacity:0/.test(desktop));

console.log('\n--- B. the general rule, across every overlay ---');
// selector -> the rule that represents its HIDDEN state
const OVERLAYS = ['.scrim', '.toast', '.sheet'];
for (const sel of OVERLAYS) {
  const css = ruleFor(sel);
  const hidesVisually = /opacity:0/.test(css) || /transform:translate/.test(css);
  const guarded = /pointer-events:none/.test(css);
  ok(`${sel} hidden state does not hit-test`, !hidesVisually || guarded, css);
}

console.log('\n--- C. overlays that hide with display/visibility need no guard ---');
for (const sel of ['#gate', '#dropOverlay', '#printRoot']) {
  const css = ruleFor(sel);
  ok(`${sel} hides with display:none`, /display:none/.test(css || ''), css || '(missing)');
}

console.log('\n--- D. z-order sanity: what sits above the app content ---');
const z = (sel) => { const m = (ruleFor(sel) || '').match(/z-index:(\d+)/); return m ? +m[1] : null; };
ok('.sheet is above .scrim', z('.sheet') > z('.scrim'), `${z('.sheet')} > ${z('.scrim')}`);
ok('the gate is above the sheets', z('#gate') > z('.sheet'), `${z('#gate')} > ${z('.sheet')}`);
ok('sheets sit above the sticky header',
   z('.sheet') > z('header.top') || z('.sheet') > 40, String(z('.sheet')));

console.log('\n--- E. opening and closing a sheet leaves nothing behind ---');
net.mode = 'offline';
const app = globalThis.__loadApp();
app.setTab('new');
app.openEntry(null, 'DW');
ok('entry sheet marked open', el('sheetEntry').classList.contains('on'));
ok('scrim marked open', el('scrim').classList.contains('on'));
ok('body scroll locked while open', document.body.style.overflow === 'hidden');

el('scrim').fire && el('scrim').fire('click', { target: el('scrim') });
// the scrim handler is assigned via .onclick, so call it directly
if (typeof el('scrim').onclick === 'function') el('scrim').onclick();
ok('entry sheet closed', !el('sheetEntry').classList.contains('on'));
ok('scrim closed', !el('scrim').classList.contains('on'));
ok('body scroll released', document.body.style.overflow === '');

console.log('\n--- F. sub-tabs still switch after a modal has been used ---');
app.setMakeType('UT');
app.openEntry(null, 'UT');
if (typeof el('scrim').onclick === 'function') el('scrim').onclick();
app.setMakeType('DC');
ok('switching works after opening and closing a sheet', app.makeType === 'DC', app.makeType);
ok('no sheet left marked open',
   ['sheetEntry','sheetImp','sheetCat','sheetStmt','sheetCfg']
     .every(id => !el(id).classList.contains('on')));

console.log('\n--- G. sheets share a z-index, so a closed sibling can cover an open one ---');
const sheetIds = [...html.matchAll(/class="sheet" id="([a-zA-Z]+)"/g)].map(m => m[1]);
ok('more than one sheet lives in the DOM at once', sheetIds.length > 1, sheetIds.join(','));
ok('they all share one z-index (paint order = DOM order)',
   (html.match(/\.sheet\{[\s\S]*?z-index:\d+/) || []).length === 1);
ok('so the closed ones must not hit-test, or the last would cover the open one',
   /pointer-events:none/.test(ruleFor('.sheet')));

console.log('\n--- H. a locked control has to look locked ---');
const fBase = html.match(/\.f input,\.f select,\.f textarea\{[^}]*\}/)[0];
ok('.f sets an explicit background (which defeats UA greying)',
   /background:var\(--card\)/.test(fBase));
ok('so an explicit :disabled rule exists', /\.f select:disabled/.test(html));
const dis = html.match(/\.f input:disabled[^{]*\{[^}]*\}/)[0];
ok('disabled controls change background', /background:var\(--paper\)/.test(dis), dis);
ok('and stay legible on iOS', /-webkit-text-fill-color/.test(dis));
ok('with a not-allowed cursor', /cursor:not-allowed/.test(dis));

console.log('\n--- I. the type select is locked exactly where the type is fixed ---');
app.openEntry(null, 'DC');
ok('locked when opened from a Create Billing tab',
   el('eType').disabled === true && el('eTypeHint').hidden === false);
app.openEntry(null);
ok('choosable from the Monitoring empty state',
   el('eType').disabled === false && el('eTypeHint').hidden === true);
app.rows.push({ id:'rz', code:'RSR-DW-082026-050', doc_type:'DW', bill_date:'2026-08-21',
                client:'C', drawing_title:'T', qty:1, rate:1, status:'DRAFT' });
app.openEntry(app.groupIdOf(app.rows.find(r => r.id === 'rz')));
ok('fixed when editing an existing billing',
   el('eType').disabled === true && el('eTypeHint').hidden === false);
app.openEntry(null, 'UT');
ok('a disabled select still reports its value to eSave',
   el('eType').value === 'UT', el('eType').value);

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
