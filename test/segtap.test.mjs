import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
const FN_SRC = path.join(ROOT, 'supabase', 'functions', 'send-statement', 'index.ts');
// Regression for the sub-tab dead-zone bug: taps on the segmented control's
// track padding or between buttons were silently dropped.
import { net } from './harness.mjs';
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const el = id => document.getElementById(id);
const html = fs.readFileSync(SRC, 'utf8');

net.mode = 'offline';
const app = globalThis.__loadApp();

// Lay the real control out: 4px track padding, three buttons, 4px gaps.
// track 0..300, buttons at 4..99, 103..198, 202..297  (gaps 99..103, 198..202)
const tabs = el('typeTabs');
tabs._rect = { left:0, right:300, top:0, bottom:44 };
const mk = (type, left, right) => {
  const b = tabs.addChild(new (Object.getPrototypeOf(tabs).constructor)('btn-' + type));
  b.dataset.type = type;
  b._rect = { left, right, top:4, bottom:40 };
  return b;
};
tabs.children.length = 0;
mk('UT', 4, 99); mk('DW', 103, 198); mk('DC', 202, 297);

// `from` is a start state the tap must move away from, so "resolved to X"
// is never confused with "the press was ignored".
const tap = (x, { from = 'DW', target = null } = {}) => {
  app.setMakeType(from);
  tabs.fire('click', { target: target || tabs, clientX: x });
  return app.makeType;
};

console.log('\n--- A. taps landing squarely on a button ---');
ok('centre of Drawing selects DW',
   tap(150, { from:'UT', target: tabs.children[1] }) === 'DW');
ok('centre of Drydocking Cert selects DC',
   tap(250, { from:'UT', target: tabs.children[2] }) === 'DC');

console.log('\n--- B. the bug: taps in the gaps and track padding ---');
// x=101 is the exact midpoint of the UT/DW gap, so either neighbour is a
// correct answer — what matters is that it is no longer ignored.
ok('midpoint of the UTG/Drawing gap is acted on (was dropped)',
   ['UT','DW'].includes(tap(101, { from:'DC' })) , tap(101, { from:'DC' }));
ok('midpoint of the Drawing/Drydocking gap is acted on (was dropped)',
   ['DW','DC'].includes(tap(200, { from:'UT' })), tap(200, { from:'UT' }));
ok('right-edge track padding resolves to Drydocking Cert',
   tap(299, { from:'UT' }) === 'DC', tap(299, { from:'UT' }));
ok('left-edge track padding resolves to UTG',
   tap(1, { from:'DC' }) === 'UT', tap(1, { from:'DC' }));
ok('a tap in the 4px above the buttons still lands',
   tap(150, { from:'UT' }) === 'DW', tap(150, { from:'UT' }));

console.log('\n--- C. nearest wins, so a gap tap is never arbitrary ---');
ok('just left of the DW/DC gap picks DW', tap(199, { from:'UT' }) === 'DW',
   tap(199, { from:'UT' }));
ok('just right of the DW/DC gap picks DC', tap(201, { from:'UT' }) === 'DC',
   tap(201, { from:'UT' }));

console.log('\n--- D. a tap with no coordinates does not throw or misfire ---');
let threw = false;
try { tabs.fire('click', { target: tabs }); } catch (e) { threw = true; }
ok('no coordinates is handled safely', !threw);

console.log('\n--- E. handler survival across a re-render ---');
const catBefore = el('mkCat').onclick, oneBefore = el('mkOne').onclick;
for (let i = 0; i < 25; i++) app.setMakeType(i % 2 ? 'DC' : 'DW');
ok('#mkCat handler survives 25 re-renders', el('mkCat').onclick === catBefore);
ok('#mkOne handler survives 25 re-renders', el('mkOne').onclick === oneBefore);
ok('the tab listener is still the same one',
   (tabs._on.click || []).length === 1, String((tabs._on.click || []).length));
ok('taps still work after repeated re-rendering', tap(250) === 'DC', tap(250));

console.log('\n--- F. the switch stays synchronous and offline ---');
net.calls.length = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < 50; i++) app.setMakeType(i % 2 ? 'DC' : 'DW');
const per = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
ok('no network call in the switch path', net.calls.length === 0, String(net.calls.length));
ok('a switch costs well under a frame', per < 8, per.toFixed(2) + 'ms');

console.log('\n--- G. the control is set up for instant touch feedback ---');
// strip comments first — a comment mentioning "transition" is not a transition
const segCss = html.match(/\.seg button\{[^}]*\}/)[0].replace(/\/\*[\s\S]*?\*\//g, '');
ok('no transition delaying the selected pill', !/transition:/.test(segCss), segCss);
ok('touch-action manipulation set', /touch-action:manipulation/.test(html));
ok('touch target at least 44px', /min-height:44px/.test(segCss), segCss);
ok('sub-tabs get the same target size',
   /\.seg\.sub button\{[^}]*min-height:44px/.test(html));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
