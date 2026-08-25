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

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
