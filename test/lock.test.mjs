// The inactivity lock: a passcode overlay that arms on a timer, not on
// visibilitychange -- a desktop tab switch and a phone sleeping are the same
// event with no way to tell them apart, and the shared PC would be unusable.
//
// What the harness CANNOT see, and MANUAL-TEST.md has to: whether the overlay
// actually covers the screen, whether it swallows a tap, whether it prints.
// Everything here is the state machine and the markup/CSS contracts.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
process.argv[2] = SRC;
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
const MIN = 60000;
const T = 1000000;
// arm it the way Settings would, without going through the sheet
const boot = (over) => {
  KEYS.forEach(k => globalThis.localStorage.removeItem(k));
  net.mode = 'offline';
  const a = globalThis.__loadApp();
  Object.assign(a.cfg, over || {});
  return a;
};

console.log('\n--- A. off by default, so the shared PC is untouched ---');
let app = boot();
ok('lockMins defaults to 0', !app.cfg.lockMins, JSON.stringify(app.cfg.lockMins));
ok('no passcode by default', !app.cfg.lockCode, JSON.stringify(app.cfg.lockCode));
ok('so it is not armed', app.lockArmed() === false);
app.bumpLock(1000);
ok('a tick a year later still does not lock',
   app.lockTick(1000 + 365 * 24 * 60 * MIN) === false && app.locked === false);
// untouched, not merely released: nothing has held the body at all. The stub
// models body.style as a bare object, so unset reads undefined where a browser
// gives '' -- both mean the same thing here, and neither is 'hidden'.
ok('and nothing is holding the body', !document.body.style.overflow,
   JSON.stringify(document.body.style.overflow));

console.log('\n--- B. arming needs both a window and a passcode ---');
app = boot({ lockMins: 5 });
ok('minutes alone do not arm it', app.lockArmed() === false);
app = boot({ lockCode: '2468' });
ok('a passcode alone does not arm it', app.lockArmed() === false);
app = boot({ lockMins: 5, lockCode: '2468' });
ok('both together do', app.lockArmed() === true);
app = boot({ lockMins: 0, lockCode: '2468' });
ok('zero minutes is off, not instant', app.lockArmed() === false);
app = boot({ lockMins: -3, lockCode: '2468' });
ok('a negative window is off, not a lock that never opens', app.lockArmed() === false);
app = boot({ lockMins: 5, lockCode: '   ' });
ok('a blank passcode does not arm it', app.lockArmed() === false);

console.log('\n--- C. the grace window ---');
app = boot({ lockMins: 5, lockCode: '2468' });
app.bumpLock(T);
ok('the deadline is the window away', app.lockAt === T + 5 * MIN, String(app.lockAt - T));
ok('one tick before the deadline does not lock', app.lockTick(T + 5 * MIN - 1) === false);
ok('and it is still unlocked', app.locked === false);
ok('on the deadline it locks', app.lockTick(T + 5 * MIN) === true);
ok('and reports itself locked', app.locked === true);
ok('a second tick does not re-fire', app.lockTick(T + 99 * MIN) === false);

app = boot({ lockMins: 5, lockCode: '2468' });
app.bumpLock(T);
app.bumpLock(T + 4 * MIN);              // activity, four minutes in
ok('activity pushes the deadline out', app.lockAt === T + 9 * MIN, String(app.lockAt - T));
ok('so the old deadline passes harmlessly', app.lockTick(T + 5 * MIN) === false);
ok('and the new one still bites', app.lockTick(T + 9 * MIN) === true);

console.log('\n--- C2. a real event reaches the deadline ---');
// Everything above calls bumpLock() directly. The app never does: it hangs the
// bump off passive listeners on document, which the harness stubbed as a
// no-op -- so the wiring between an actual event and lockAt was the one part
// of this never exercised. `input` is the one worth pinning: paste, autofill
// and a context-menu paste fire it and no key event at all, so editing the
// covering letter that way used to read as idleness.
app = boot({ lockMins: 5, lockCode: '2468' });
app.bumpLock(T);                        // a deadline in 1970, so any move shows
const t0 = Date.now();
app.fireDoc('input');
ok('an input event moves the deadline a full window out',
   app.lockAt >= t0 + 5 * MIN && app.lockAt <= Date.now() + 5 * MIN,
   'lockAt - now - window = ' + (app.lockAt - t0 - 5 * MIN));

console.log('\n--- D. an open sheet is not activity; interaction is ---');
// This section used to assert the opposite, and that is what kept the lock
// from ever firing on the phone: lockTick suppressed on `openSheet`, so a
// covering letter left open bumped its own deadline every 15s tick and the
// window never elapsed. Being open is not evidence of a person. Touching the
// thing is, and the passive document listeners carry that from inside a sheet
// exactly as they do from anywhere else.
app = boot({ lockMins: 5, lockCode: '2468' });
app.bumpLock(T);
app.show('sheetLetter');
ok('an untouched sheet does not hold the lock off',
   app.lockTick(T + 60 * MIN) === true, String(app.locked));
ok('and the sheet is still open underneath the overlay',
   app.openSheet === 'sheetLetter', String(app.openSheet));

// the same sheet, with somebody actually working in it
app = boot({ lockMins: 5, lockCode: '2468' });
app.show('sheetLetter');
app.fireDoc('pointerdown');             // a tap landing inside the sheet
const dTap = app.lockAt;
ok('a tap inside a sheet moves the deadline a window out',
   dTap > Date.now() && dTap <= Date.now() + 5 * MIN, String(dTap - Date.now()));
ok('so a tick inside that window does not lock', app.lockTick(dTap - 1) === false);
ok('and one past it does', app.lockTick(dTap) === true);

// a paste into the letter: input fires, no key event does
app = boot({ lockMins: 5, lockCode: '2468' });
app.show('sheetLetter');
app.fireDoc('input');
ok('a paste into an open letter keeps it unlocked',
   app.lockTick(app.lockAt - 1) === false && app.locked === false);

// the gate is not special either. #lock is z-index 95 and #gate 90, so the
// overlay covers sign-in; passcode then sign-in, two prompts, is the shape.
app = boot({ lockMins: 5, lockCode: '2468' });
app.bumpLock(T);
app.showGate('x');
ok('the sign-in gate no longer suppresses it', app.lockTick(T + 60 * MIN) === true);
ok('and the gate is still up beneath the lock', el('gate').classList.contains('on'));
app.hideGate();

console.log('\n--- E. locked ---');
app = boot({ lockMins: 5, lockCode: '2468' });
app.bumpLock(T);
app.lockTick(T + 5 * MIN);
ok('the overlay is on', el('lock').classList.contains('on'));
ok('the body is held', document.body.style.overflow === 'hidden',
   JSON.stringify(document.body.style.overflow));
ok('the passcode box starts empty', el('kCode').value === '');

console.log('\n--- E2. Escape does not reach the sheet underneath ---');
app = boot({ lockMins: 5, lockCode: '2468' });
app.show('sheetCfg');
app.bumpLock(T);
ok('an untouched sheet locks like anything else', app.lockTick(T + 60 * MIN) === true &&
   app.openSheet === 'sheetCfg' && app.locked === true);
app.showLock();                         // the `if(locked)return` guard
ok('raising an already-raised lock is a no-op', app.locked === true &&
   el('lock').classList.contains('on'));
ok('Escape is swallowed', app.escClose() === false);
ok('and the sheet underneath is still open', app.openSheet === 'sheetCfg',
   String(app.openSheet));
ok('the body is still held', document.body.style.overflow === 'hidden');

console.log('\n--- E3. one owner for the body scroll lock ---');
// gate, sheets and the overlay all want it. hide() used to clear it flat,
// which would have let the page scroll behind a lock that was still up.
app = boot({ lockMins: 5, lockCode: '2468' });
app.show('sheetCfg');
app.showLock();
app.hide();
ok('closing the sheet under a lock does not release the body',
   document.body.style.overflow === 'hidden', JSON.stringify(document.body.style.overflow));
el('kCode').value = '2468';
app.doUnlock();
ok('and it is released once unlocked with nothing else open',
   document.body.style.overflow === '', JSON.stringify(document.body.style.overflow));

console.log('\n--- F. unlocking ---');
app = boot({ lockMins: 5, lockCode: '2468' });
app.bumpLock(T);
app.lockTick(T + 5 * MIN);
el('kCode').value = '';
app.doUnlock();
ok('an empty passcode does not unlock', app.locked === true);
ok('and says so', !!el('kErr').textContent, el('kErr').textContent);
el('kCode').value = '1111';
app.doUnlock();
ok('a wrong passcode does not unlock', app.locked === true);
ok('the box is cleared for a retry', el('kCode').value === '');
el('kCode').value = '2468';
app.doUnlock();
ok('the right passcode unlocks', app.locked === false);
ok('the overlay is off', !el('lock').classList.contains('on'));
ok('the body scrolls again', document.body.style.overflow === '',
   JSON.stringify(document.body.style.overflow));
ok('and it re-arms rather than staying open', app.lockAt > Date.now());

console.log('\n--- G. an overlay, never a reload ---');
// the whole point: a half-composed send has to survive being locked
app = boot({ lockMins: 5, lockCode: '2468' });
const mid = { list:[{ id:'g-1' }], to:'ap@seaford.test', cc:'', client:'Seaford',
              shownNo:'BILLDWG-26-001' };
app.pendingSend = mid;
app.bumpLock(T);
app.lockTick(T + 5 * MIN);
ok('pendingSend survives the lock', app.pendingSend === mid);
el('kCode').value = '2468';
app.doUnlock();
ok('and survives the unlock', app.pendingSend === mid);
ok('the same object, not a rebuilt one', app.pendingSend.shownNo === 'BILLDWG-26-001');

console.log('\n--- H. markup and CSS contracts ---');
ok('there is exactly one #lock', (html.match(/id="lock"/g) || []).length === 1);
ok('and one passcode input', (html.match(/id="kCode"/g) || []).length === 1);
const lockCss = (html.match(/#lock\{[^}]*\}/) || [''])[0];
ok('it is a fixed full-screen layer',
   /position:fixed/.test(lockCss) && /inset:0/.test(lockCss), lockCss);
// display, not opacity: a closed overlay at opacity:0 ate clicks across the
// whole window once already, which is why .sheet carries pointer-events:none
ok('it toggles display, not opacity',
   /display:none/.test(lockCss) && !/opacity/.test(lockCss), lockCss);
ok('and .on turns it on', /#lock\.on\{display:grid\}/.test(html));
const zLock = Number((lockCss.match(/z-index:(\d+)/) || [])[1]);
const zGate = Number(((html.match(/#gate\{[^}]*\}/) || [''])[0]
                      .match(/z-index:(\d+)/) || [])[1]);
ok('it sits above the sign-in gate', zLock > zGate, zLock + ' vs ' + zGate);
// left out of the print list, it prints on top of the billing
const printRule = (html.match(/#app,[^\n]*display:none !important[^\n]*/) || [''])[0];
ok('it is hidden for print', /#lock/.test(printRule), printRule);

console.log('\n--- I. per-device, like autoMarkPrint and terms ---');
const pushed = html.slice(html.indexOf('function pushSharedSettings'),
                          html.indexOf('function pushSharedSettings') + 900);
ok('lockMins is never published', !/lockMins/.test(pushed));
ok('nor is the passcode', !/lockCode/.test(pushed));
ok('the passcode is never queued as a setting at all',
   !/lockCode/.test(html.slice(html.indexOf('function queueSetting'),
                               html.indexOf('function queueSetting') + 600)));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
