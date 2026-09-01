// Unbilling is a server-side write now. rsr_dwg_unbill_guard refuses
// BILLED -> DRAFT unless unbill_group set its transaction-local flag, so the
// old path -- flip locally, queue a PATCH -- cannot work: the PATCH is refused
// and lands in Pending writes. Nothing here may queue anything.
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
const rpcCalls = () => net.calls.filter(c => String(c.url).includes('rpc/unbill_group')).length;

const boot = async () => {
  net.mode = 'offline';
  ['rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_clients_v1']
    .forEach(k => globalThis.localStorage.removeItem(k));
  const a = globalThis.__loadApp();
  await new Promise(r => setTimeout(r, 0));
  net.mode = 'online';
  net.script.length = 0; net.calls.length = 0;
  a.cfg.url = 'https://proj.supabase.co'; a.cfg.key = 'anon';
  a.setSession({ access_token:'t', refresh_token:'r', expires_at: 2e9,
                 user:{ email:'me@rsr.test' } });
  a.rows.push(
    { id:'u1', group_id:'gb', line_no:1, code:'RSR-DW-082026-021', bill_no:'BILLDWG-26-021',
      client:'Seaford', vessel:'MV SF Voyager', drawing_no:'D-1', drawing_title:'Shell',
      qty:1, rate:2000, status:'BILLED', billed_date:'2026-08-20', bill_date:'2026-08-20' },
    { id:'u2', group_id:'gb', line_no:2, code:'RSR-DW-082026-021', bill_no:'BILLDWG-26-021',
      client:'Seaford', vessel:'MV SF Voyager', drawing_no:'D-2', drawing_title:'Midship',
      qty:1, rate:1000, status:'BILLED', billed_date:'2026-08-20', bill_date:'2026-08-20' });
  return a;
};

console.log('\n--- 1. the sheet names the billing it is about ---');
let app = await boot();
app.openUnbill('gb');
ok('the sheet opened', el('sheetUnbill').classList.contains('on'));
ok('it names the billing number', el('ubWhich').innerHTML.includes('BILLDWG-26-021'),
   el('ubWhich').innerHTML);
ok('and the client', el('ubWhich').innerHTML.includes('Seaford'));
ok('the passcode starts empty', el('ubCode').value === '');
ok('no error showing yet', el('ubErr').hidden === true);

console.log('\n--- 2. a missing reason never reaches the server ---');
el('ubCode').value = '123456'; el('ubReason').value = '';
await app.doUnbill();
ok('refused', el('ubErr').hidden === false && /reason/i.test(el('ubErr').textContent),
   el('ubErr').textContent);
ok('the server was not called', rpcCalls() === 0, String(rpcCalls()));
ok('and it is still BILLED', app.groupById('gb').status === 'BILLED');

console.log('\n--- 3. a malformed passcode never reaches the server either ---');
el('ubCode').value = '12'; el('ubReason').value = 'Wrong vessel on the billing';
await app.doUnbill();
ok('refused', /six digits/i.test(el('ubErr').textContent), el('ubErr').textContent);
ok('the server was not called', rpcCalls() === 0, String(rpcCalls()));
ok('the reason survives the retry', el('ubReason').value === 'Wrong vessel on the billing');

console.log('\n--- 4. offline is refused before calling, not queued ---');
net.mode = 'offline';
el('ubCode').value = '123456';
await app.doUnbill();
ok('refused with a reason a person can act on',
   /connection/i.test(el('ubErr').textContent), el('ubErr').textContent);
ok('nothing was queued', app.queue.length === 0, JSON.stringify(app.queue));
ok('still BILLED', app.groupById('gb').status === 'BILLED');
net.mode = 'online';

console.log('\n--- 5. the server refuses: its wording is shown verbatim ---');
net.script.push({ match:'rpc/unbill_group', method:'POST', status:200,
                  body:{ ok:false, reason:'Wrong passcode' } });
el('ubCode').value = '000000';
await app.doUnbill();
ok('the sheet stays open', el('sheetUnbill').classList.contains('on'));
ok('showing exactly what the server said',
   el('ubErr').textContent === 'Wrong passcode', el('ubErr').textContent);
ok('the passcode is cleared for another try', el('ubCode').value === '');
ok('the reason is not', el('ubReason').value === 'Wrong vessel on the billing');
ok('still BILLED', app.groupById('gb').status === 'BILLED');
ok('and nothing was queued', app.queue.length === 0, JSON.stringify(app.queue));

console.log('\n--- 6. the throttle lock reaches the user in full ---');
net.script.push({ match:'rpc/unbill_group', method:'POST', status:200,
  body:{ ok:false, reason:'Too many wrong attempts — unbilling is locked for 15 minutes' } });
el('ubCode').value = '111111';
await app.doUnbill();
ok('the lock is explained, not reduced to "failed"',
   /15 minutes/.test(el('ubErr').textContent), el('ubErr').textContent);

console.log('\n--- 7. success: the server did the write, so we queue nothing ---');
net.script.push({ match:'rpc/unbill_group', method:'POST', status:200,
                  body:{ ok:true, lines:2, by:'Raffy Ramirez' } });
el('ubCode').value = '123456';
const before = rpcCalls();
await app.doUnbill();
ok('the RPC was called once', rpcCalls() === before + 1, String(rpcCalls() - before));
ok('the sheet closed', !el('sheetUnbill').classList.contains('on'));
ok('both lines are DRAFT now',
   app.rows.filter(r => r.group_id === 'gb').every(r => r.status === 'DRAFT'),
   JSON.stringify(app.rows.map(r => r.status)));
ok('billed_date cleared', app.rows.filter(r => r.group_id === 'gb').every(r => !r.billed_date));
ok('paid_date cleared', app.rows.filter(r => r.group_id === 'gb').every(r => !r.paid_date));
// the whole point: the trigger would refuse a queued PATCH, so there must be none
ok('NOTHING was queued — the RPC is the write',
   !app.queue.some(j => j.store !== 'clients'), JSON.stringify(app.queue));
ok('the toast names who it was recorded against',
   /Raffy Ramirez/.test(el('toast').textContent), el('toast').textContent);
ok('and how many lines moved', /2 lines/.test(el('toast').textContent), el('toast').textContent);

console.log('\n--- 8. only a BILLED billing can be unbilled ---');
app.openUnbill('gb');           // it is DRAFT now
ok('refused', !el('sheetUnbill').classList.contains('on'));
ok('with a reason', /billed/i.test(el('toast').textContent), el('toast').textContent);

console.log('\n--- 8b. a PARTLY billed billing can still be unbilled ---');
// The guard used to read g.status, the rolled-up value, which takes the
// least-advanced line -- so one DRAFT line among billed ones made the whole
// billing unrefusable here while delete refused it too and said 'unbill it
// first'. Both doors shut on the one billing that needed the way out.
app = await boot();
app.rows.find(r => r.id === 'u2').status = 'DRAFT';
app.rows.find(r => r.id === 'u2').billed_date = null;
ok('the group rolls up to DRAFT', app.groupById('gb').status === 'DRAFT',
   app.groupById('gb').status);
app.openUnbill('gb');
ok('the sheet still opens', el('sheetUnbill').classList.contains('on'));
app.hide();
// an all-PAID billing has no billed line and is still refused, unchanged
app = await boot();
app.rows.forEach(r => { r.status = 'PAID'; r.paid_date = '2026-08-26'; });
app.openUnbill('gb');
ok('a paid billing is still refused', !el('sheetUnbill').classList.contains('on'));

console.log('\n--- 9. a billed billing cannot be deleted either ---');
// rsr_dwg_delete_guard raises on DELETE of a BILLED row, so queueing one buys
// a dead write and a row that disappears locally while still on the server.
app = await boot();
const gone = await app.deleteRow('u1');
ok('the delete is refused', gone === false, String(gone));
ok('the row is still here', app.rows.some(r => r.id === 'u1'));
ok('and nothing was queued', !app.queue.some(j => j.op === 'delete'),
   JSON.stringify(app.queue));
ok('the message says what to do instead',
   /unbill it first/i.test(el('toast').textContent), el('toast').textContent);

// PAID is deliberately NOT blocked -- the guard allows it, so neither do we
app.rows.forEach(r => { if (r.group_id === 'gb') r.status = 'PAID'; });
const paidGone = await app.deleteRow('u1');
ok('a paid line still deletes, as the guard allows', paidGone === true, String(paidGone));
ok('and it is gone locally', !app.rows.some(r => r.id === 'u1'));
console.log('\n--- Y. one unbill per press, whichever way it is fired ---');
// The button's disabled flag guarded a second CLICK. The Enter handler on
// #ubCode calls doUnbill directly and never looked at it, so two quick presses
// ran two unbills and wrote two rows to the log.
app = await boot();
app.openUnbill('gb');
el('ubCode').value = '123456';
el('ubReason').value = 'wrong rate on the shafting line';
net.script.push({ match:'rpc/unbill_group', method:'POST', status:200, keep:true,
                  body:{ ok:true, lines:2, by:'Raffy' } });
net.calls.length = 0;

// two presses before the first write can return
const p1 = app.doUnbill();
const p2 = app.doUnbill();
await Promise.all([p1, p2]);
await new Promise(r => setTimeout(r, 40));
ok('a second press while one is in flight sends nothing', rpcCalls() === 1,
   String(rpcCalls()) + ' calls');

// and the same through the keyboard path, which is the one that was open
app = await boot();
app.openUnbill('gb');
el('ubCode').value = '123456';
el('ubReason').value = 'wrong rate on the shafting line';
net.script.push({ match:'rpc/unbill_group', method:'POST', status:200, keep:true,
                  body:{ ok:true, lines:2, by:'Raffy' } });
net.calls.length = 0;
// Three, not two. Two passes even with the guard INSIDE the try: press #2
// returns through the finally, which clears the flag while #1 is still in
// flight -- and only a third press gets through the door that reopens. The
// early exit has to sit above `try{`, and this is the assertion that says so.
el('ubCode').fire('keydown', { key:'Enter' });
el('ubCode').fire('keydown', { key:'Enter' });
el('ubCode').fire('keydown', { key:'Enter' });
await new Promise(r => setTimeout(r, 40));
ok('three Enters are one unbill', rpcCalls() === 1, String(rpcCalls()) + ' calls');

// the guard must not stick: a later unbill still works. Fresh boot, because
// the previous case left this group DRAFT and openUnbill refuses those.
app = await boot();
net.script.push({ match:'rpc/unbill_group', method:'POST', status:200, keep:true,
                  body:{ ok:true, lines:2, by:'Raffy' } });
net.calls.length = 0;
app.openUnbill('gb');
el('ubCode').value = '123456';
el('ubReason').value = 'again';
await app.doUnbill();
await new Promise(r => setTimeout(r, 40));
ok('the guard clears, so the next unbill goes through', rpcCalls() === 1,
   String(rpcCalls()) + ' calls');

console.log('\n--- Y2. the card history repaints without a reload ---');
app = await boot();
// a card that is open, with a history already fetched and now out of date
app.expanded = { gb: true };
app.histMap = { gb: [{ kind:'send', at:'2026-08-27T02:00:00Z', send_no:1,
                       sent_by_email:'raffy@rsr.test', total:'4000.00',
                       change_kind:'first', total_mismatch:false, changed_lines:[] }] };
ok('the stale history is showing', /#1/.test(app.historyLines({ id:'gb' })),
   app.historyLines({ id:'gb' }));

net.script.push({ match:'rpc/unbill_group', method:'POST', status:200,
                  body:{ ok:true, lines:2, by:'Raffy' } });
// what the refetch will find: the send, plus the unbill that just happened
net.script.push({ match:'drawing_billing_send_log', method:'GET', status:200, keep:true,
                  body:[{ send_no:1, sent_at:'2026-08-27T02:00:00Z',
                          sent_by_email:'raffy@rsr.test', total:'4000.00',
                          change_kind:'first', total_mismatch:false, changed_lines:[] }] });
net.script.push({ match:'drawing_billing_unbill_log', method:'GET', status:200, keep:true,
                  body:[{ unbilled_at:'2026-08-29T01:00:00Z', operator_name:'Raffy',
                          reason:'wrong rate on the shafting line', rows_affected:2 }] });
app.openUnbill('gb');
el('ubCode').value = '123456';
el('ubReason').value = 'wrong rate on the shafting line';
await app.doUnbill();
await new Promise(r => setTimeout(r, 60));

const after = app.historyLines({ id:'gb' });
ok('the unbill is in the timeline now', /unbilled/.test(after), after);
ok('it names the operator', /Raffy/.test(after), after);
ok('and the reason', /wrong rate on the shafting line/.test(after), after);
ok('the earlier send is still there', /#1/.test(after), after);
ok('no reload was needed', app.histMap.gb.length === 2,
   JSON.stringify((app.histMap.gb || []).map(e => e.kind)));

// a card that is closed is invalidated but not refetched
app = await boot();
app.expanded = {};
app.histMap = { gb: [{ kind:'send', at:'2026-08-27T02:00:00Z', send_no:1,
                       sent_by_email:'r@t.test', total:'1.00', change_kind:'first',
                       total_mismatch:false, changed_lines:[] }] };
net.script.push({ match:'rpc/unbill_group', method:'POST', status:200,
                  body:{ ok:true, lines:2, by:'Raffy' } });
net.calls.length = 0;
app.openUnbill('gb');
el('ubCode').value = '123456'; el('ubReason').value = 'closed card';
await app.doUnbill();
await new Promise(r => setTimeout(r, 40));
ok('a closed card drops its cache', app.histMap.gb === undefined,
   JSON.stringify(app.histMap.gb));
// pull() refreshes the badge map, which reads the send log unfiltered. What
// must NOT happen is the per-billing history fetch, which carries gid=eq.
ok('and does not refetch the history nobody is looking at',
   !net.calls.some(c => /gid=eq\.gb/.test(String(c.url))),
   JSON.stringify(net.calls.filter(c => /gid=eq/.test(String(c.url))).map(c => c.url)));



console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
