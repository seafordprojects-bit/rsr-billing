// Two billings carrying one tracking code. nextCode is a max-scan of the local
// cache and the guard at the save path checks that same cache, so a second
// device can mint a code this one has never seen; there is no unique index on
// `code` and there cannot easily be one while a group's lines share it. This is
// the detection half -- convergent, not airtight. See CLAUDE.md.
//
// Note on the literals below: the expected re-minted code is NOT clock-derived
// and does not need to be. remintCode calls nextCode(g.bill_date, ...), so the
// month stamp comes from the fixture's own bill_date, not from today(). That
// makes it self-consistent at any date -- unlike the fixtures Batch D had to
// convert, which went through the entry sheet and picked up today's month.
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
const el = id => globalThis.document.getElementById(id);
const KEYS = ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1',
              'rsr_dwg_catalog_v1','rsr_dwg_clients_v1','rsr_dwg_shared_v1'];

const SHARED = 'RSR-DW-082026-007';
// gid, line, when it reached the server, code
const L = (gid, seq, born, code = SHARED) => ({
  id: gid + '-' + seq, group_id: gid, line_no: seq, code,
  bill_no: null, doc_type: 'DW', bill_date: '2026-08-21',
  client: 'Seaford', vessel: 'MV SF Voyager', drawing_title: 'Line ' + seq,
  qty: 1, rate: 1000, billable: true, status: 'DRAFT',
  billed_date: null, paid_date: null, invoice_no: null, remarks: null,
  created_at: born
});
// ga landed first, so ga keeps the code and gb is the one offered a re-mint
const older = [L('ga', 0, '2026-08-21T05:00:00Z'), L('ga', 1, '2026-08-21T05:00:01Z')];
const newer = [L('gb', 0, '2026-08-21T09:30:00Z'), L('gb', 1, '2026-08-21T09:30:01Z')];

const reset = (rows) => {
  KEYS.forEach(k => globalThis.localStorage.removeItem(k));
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW:true }));
  if (rows) globalThis.localStorage.setItem('rsr_dwg_rows_v1', JSON.stringify(rows));
  return globalThis.__loadApp();
};

net.mode = 'offline';
let app = reset(older.concat(newer));

console.log('\n--- A. the scan finds it ---');
const dups = app.dupCodes(app.allGroups());
ok('one code is duplicated', dups.size === 1, String(dups.size));
ok('and it names both groups', (dups.get(SHARED) || []).length === 2,
   JSON.stringify(dups.get(SHARED)));
ok('a clean corpus reports nothing',
   app.dupCodes([{ id:'x', code:'RSR-DW-082026-001' },
                 { id:'y', code:'RSR-DW-082026-002' }]).size === 0);
ok('a blank code is not a duplicate',
   app.dupCodes([{ id:'x', code:'' }, { id:'y', code:null }]).size === 0);
ok('one group with two lines is not a duplicate',
   app.dupCodes(app.groupsFrom(older)).size === 0);

console.log('\n--- B. both colliding cards are badged ---');
app.render();
const list = el('list').innerHTML;
ok('two dup badges, one per card', list.split('badge dup').length - 1 === 2,
   String(list.split('badge dup').length - 1));
ok('the wording counts the others, not the total',
   list.split('Code shared with 1 other billing').length - 1 === 2,
   String(list.split('Code shared with 1 other billing').length - 1));
// forked from .badge.mixed on purpose, so the two are told apart at a glance
ok('it does not reuse the mixed badge', !/badge mixed/.test(list));

console.log('\n--- C. the action is offered on the newer side only ---');
ok('the newer billing is offered a re-mint', list.includes('data-remint="gb"'));
ok('the older one is not', !list.includes('data-remint="ga"'));

console.log('\n--- D. re-minting moves every line of the losing group ---');
const before = app.rows.filter(r => r.group_id === 'gb').length;
await app.remintCode('gb');
const gbRows = app.rows.filter(r => r.group_id === 'gb');
const gaRows = app.rows.filter(r => r.group_id === 'ga');
ok('the group still has all its lines', gbRows.length === before, String(gbRows.length));
ok('every line took the new code',
   new Set(gbRows.map(r => r.code)).size === 1 && gbRows[0].code === 'RSR-DW-082026-008',
   gbRows.map(r => r.code).join(','));
ok('not one line left behind on the old one',
   !gbRows.some(r => r.code === SHARED), gbRows.map(r => r.code).join(','));
ok('the older billing is untouched',
   gaRows.every(r => r.code === SHARED), gaRows.map(r => r.code).join(','));
ok('one queued write per line', app.queue.filter(j => j.op === 'update').length === 2,
   JSON.stringify(app.queue.map(j => j.op)));
ok('and the clash is gone', app.dupCodes(app.allGroups()).size === 0);
app.render();
ok('the badge goes with it', !/badge dup/.test(el('list').innerHTML));

console.log('\n--- E. the older side refuses ---');
app = reset(older.concat(newer));
await app.remintCode('ga');
ok('it will not re-mint the billing that got there first',
   app.rows.filter(r => r.group_id === 'ga').every(r => r.code === SHARED));
ok('and says which way round to do it', /older/i.test(el('toast').textContent),
   el('toast').textContent);

console.log('\n--- F. a group still queued locally has not won the race ---');
// bornOf sorts a row with no created_at last: it never reached the server, so
// it cannot be the one that got there first
const unsynced = app.groupOf([Object.assign(L('gc', 0, '2026-08-21T01:00:00Z'),
                                            { created_at: undefined })]);
ok('no created_at sorts last', app.bornOf(unsynced) === '9999', app.bornOf(unsynced));
ok('a synced group sorts by when it landed',
   app.bornOf(app.groupOf(older)) === '2026-08-21T05:00:00Z',
   app.bornOf(app.groupOf(older)));

console.log('\n--- G. an already-sent billing re-mints without disturbing its log ---');
// the send log keys on gid and bill_no and has no code column at all, so a
// re-mint cannot orphan a send. Nothing here may write to it either: only the
// Edge Function ever does, through record_billing_send.
app = reset(older.concat(newer));
app.sendMap = { gb: { gid:'gb', bill_no:'BILLDWG-26-009', send_no:2,
                      sent_by_email:'me@rsr.test', bad:[] } };
net.calls.length = 0;
await app.remintCode('gb');
ok('the send record is still keyed to the same billing',
   app.sendMap.gb && app.sendMap.gb.gid === 'gb', JSON.stringify(app.sendMap.gb));
ok('its billing number is unchanged', app.sendMap.gb.bill_no === 'BILLDWG-26-009',
   app.sendMap.gb.bill_no);
ok('the send count is unchanged', app.sendMap.gb.send_no === 2, String(app.sendMap.gb.send_no));
ok('nothing was written to the send log',
   !net.calls.some(c => String(c.url).includes('send_log')),
   JSON.stringify(net.calls.map(c => c.url)));
ok('the queued writes are billing rows only',
   app.queue.every(j => !j.store && j.op === 'update'),
   JSON.stringify(app.queue.map(j => j.store || 'billing')));
app.render();
ok('and the card still shows it was sent', /class="sent"/.test(el('list').innerHTML));

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
