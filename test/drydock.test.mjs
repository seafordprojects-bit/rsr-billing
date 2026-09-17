// drydock.test.mjs — a received drydocking job in Monitoring: the receipt map,
// the "From drydocking" badge and meta on its card, and their absence from
// the statement and the email.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
import { net, mnlToday, codeStamp } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const el = id => document.getElementById(id);
const KEYS = ['rsr_dwg_cfg_v1','rsr_dwg_rows_v1','rsr_dwg_queue_v1','rsr_dwg_session_v1',
              'rsr_dwg_catalog_v1','rsr_dwg_clients_v1','rsr_dwg_shared_v1'];
const TODAY = mnlToday(), MM = codeStamp();
const GID = 'dd-11111111-1111-4111-8111-111111111111';
const REMARKS = 'Drydocking documents emailed September 9, 2026, confirmed by Raffy J. Ramirez. Transmittal completed by Raffy J. Ramirez on September 9, 2026. Project 25-016.';
const line = (gid, n, code, title) => ({ id:'srv-'+gid+'-'+n, group_id:gid, line_no:n, code, doc_type:'DC', bill_date:TODAY,
  client:'Seaford Shipping Lines, Inc.', vessel:'MV "SF RISER"', drawing_no:null, drawing_title:title, qty:1, rate:2500,
  status:'DRAFT', remarks:REMARKS, billable:true, created_at:'2026-09-09T10:21:00Z' });
// the second line is the yard's listed-but-not-charged document, as the RPC now stores it
const ROWS = [ line(GID, 1, 'RSR-DC-'+MM+'-001', 'Load Line Certificate'),
               Object.assign(line(GID, 2, 'RSR-DC-'+MM+'-001', 'Drydocking List of Vessel'), { billable:false }),
               // its own client: the DOM stub reads input:checked from the picker MARKUP
               // (every candidate ticked), not the live property openStmtFor unticks, so a
               // same-client sibling would ride into the statement under the harness
               Object.assign(line('hand1', 1, 'RSR-DC-'+MM+'-002', 'Typed by hand'), { remarks: '', client: 'Hand Entered Co.' }) ];
KEYS.forEach(k => globalThis.localStorage.removeItem(k));
globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW:true, url:'https://proj.supabase.co', key:'anon' }));
globalThis.localStorage.setItem('rsr_dwg_rows_v1', JSON.stringify(ROWS));
// the client record Bill To reads (by name, not from the line): a three-line address
globalThis.localStorage.setItem('rsr_dwg_clients_v1', JSON.stringify([
  { id:'srv-c1', name:'Seaford Shipping Lines, Inc.', salutation:'', contact_person:'', address:'1st Street\nNorth Reclamation Area\nCebu City', billing_email:'billing@seaford.test', email_cc:'' } ]));
const app = globalThis.__loadApp();
net.mode = 'online';
app.setSession({ access_token:'t', refresh_token:'r', expires_at: 2e9, user:{ email:'raffy@rsr.test' } });

console.log('\n--- A. the receipt map ---');
net.script.push({ match:'billing_drydock_receipt', method:'GET', status:200, body:[
  { dispatch_id:'11111111-1111-4111-8111-111111111111', group_id:GID, received_at:'2026-09-09T10:21:00Z', unpriced:[],
    payload:{ confirmed_by:'Raffy J. Ramirez', sent_at:'2026-09-09T10:20:00Z' } } ] });
await app.refreshReceiptMap();
ok('receiptMap keyed by group id, with confirmed_by and sent_at lifted from the payload',
   app.receiptMap[GID] && app.receiptMap[GID].confirmed_by === 'Raffy J. Ramirez' && app.receiptMap[GID].sent_at === '2026-09-09T10:20:00Z',
   JSON.stringify(app.receiptMap[GID]));
net.script.push({ match:'billing_drydock_receipt', method:'GET', status:500, body:{} });
const before = JSON.stringify(app.receiptMap);
let threw = false;
try { await app.refreshReceiptMap(); } catch (e) { threw = true; }
ok('a failed refresh keeps the last map and never throws (decoration must not break sync)',
   !threw && JSON.stringify(app.receiptMap) === before);

console.log('\n--- B. the card ---');
app.filters = Object.assign({}, app.filters, { status:'ALL', type:'', client:'', month:'', q:'' });
app.render();
// one <article class="row"> per group; the group id sits at the END of its
// card (expand button, actions), so cards are split on the opening tag and
// picked by id rather than sliced forward from the id
const cardsOf = html => html.split('<article class="row').slice(1);
const cardFor = (html, gid) => cardsOf(html).find(c => c.indexOf('data-exp="' + gid + '"') > -1) || '';
const html = el('list').innerHTML;            // Monitoring renders into <div id="list">
const ddCard = cardFor(html, GID), handCard = cardFor(html, 'hand1');
ok('the received group carries the From drydocking badge', !!ddCard && /badge dd/.test(ddCard) && /From drydocking/.test(ddCard),
   ddCard ? ddCard.slice(0, 200) : 'card not rendered');
ok('its meta names who confirmed and the emailed date', /Emailed/.test(ddCard) && /Raffy J\. Ramirez/.test(ddCard));
// sent_at is an instant; the card must show the MANILA day (dayOf), not a
// UTC date slice -- 10:20Z on the 9th is the 9th in Manila...
ok('...and the emailed date is the Manila day', /Emailed 09 Sep 2026/.test(ddCard), (ddCard.match(/Emailed [^<]*/) || [''])[0]);
ok('a hand-entered DC group has no badge and no receipt meta', !!handCard && !/badge dd/.test(handCard) && !/Emailed /.test(handCard),
   handCard ? '' : 'hand card not rendered');

// ...but a late-evening UTC send is the NEXT Manila day
net.script.push({ match:'billing_drydock_receipt', method:'GET', status:200, body:[
  { dispatch_id:'11111111-1111-4111-8111-111111111111', group_id:GID, received_at:'2026-09-09T22:21:00Z', unpriced:[],
    payload:{ confirmed_by:'Raffy J. Ramirez', sent_at:'2026-09-09T22:20:00Z' } } ] });
await app.refreshReceiptMap(); app.render();
const late = cardFor(el('list').innerHTML, GID);
ok('a late-evening UTC send reads as the next Manila day (10 Sep, not 09 Sep)', /Emailed 10 Sep 2026/.test(late), (late.match(/Emailed [^<]*/) || [''])[0]);

console.log('\n--- C. unpriced count on the badge ---');
net.script.push({ match:'billing_drydock_receipt', method:'GET', status:200, body:[
  { dispatch_id:'11111111-1111-4111-8111-111111111111', group_id:GID, received_at:'2026-09-09T10:21:00Z', unpriced:['Transmittal','Load Line Certificate'],
    payload:{ confirmed_by:'Raffy J. Ramirez', sent_at:'2026-09-09T10:20:00Z' } } ] });
await app.refreshReceiptMap(); app.render();
const dd2 = cardFor(el('list').innerHTML, GID);
ok('two unpriced titles show on the badge', /2 unpriced/.test(dd2));

console.log('\n--- D. never on the document ---');
app.openStmtFor(GID);
app.renderStatement(app.pickedRows());
const doc = el('printRoot').innerHTML;        // the statement renders into <div id="printRoot">
ok('the List of Vessel line is on the statement as No Charge and the total is the other line alone',
   /Drydocking List of Vessel/.test(doc) && /No Charge/.test(doc) && /2,500\.00/.test(doc) && !/5,000\.00/.test(doc),
   (doc.match(/No Charge|[0-9],[0-9]{3}\.[0-9]{2}/g) || []).join(' '));
ok('Bill To prints the received address across its three lines',
   /1st Street<br>North Reclamation Area<br>Cebu City/.test(doc), (doc.match(/1st Street[^<]{0,80}(<br>[^<]{0,80}){0,3}/) || [''])[0]);
ok('the statement carries the lines but no From drydocking badge or receipt meta',
   /Load Line Certificate/.test(doc) && doc.indexOf('From drydocking') < 0 && doc.indexOf('badge dd') < 0 && doc.indexOf('Emailed ') < 0,
   /Load Line Certificate/.test(doc) ? '' : 'statement has no lines');
const mail = String(app.statementEmailHtml());
ok('the email body carries none either', mail.indexOf('From drydocking') < 0 && mail.indexOf('badge dd') < 0);

console.log('\n--- E. a job RE-SENT while its earlier bill is unpaid ---');
{
  const OLD = 'dd-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NEW = 'dd-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const pair = [ line(OLD, 1, 'RSR-DC-'+MM+'-003', 'Load Line Certificate'), line(NEW, 1, 'RSR-DC-'+MM+'-004', 'Load Line Certificate') ];
  app.rows.push(...pair.map(r => Object.assign({}, r)));
  const rcpt = (gid, id, over) => Object.assign({ dispatch_id:id, draft_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd', group_id:gid,
    received_at:'2026-09-10T07:01:00Z', unpriced:[], payload:{ confirmed_by:'Raffy J. Ramirez', sent_at:'2026-09-10T07:00:00Z' },
    resend_of:[], resend_kept_at:null }, over || {});
  const load = async (list) => { net.script.push({ match:'billing_drydock_receipt', method:'GET', status:200, body:list }); await app.refreshReceiptMap(); app.render(); };
  const RECEIPTS = () => [ rcpt(OLD, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), rcpt(NEW, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { resend_of:[OLD] }) ];
  await load(RECEIPTS());
  let L = el('list').innerHTML, oc = cardFor(L, OLD), nc = cardFor(L, NEW);
  ok('the NEWER card is flagged and names the earlier unpaid bill by code',
     /badge resend/.test(nc) && nc.indexOf('earlier bill RSR-DC-'+MM+'-003 unpaid') > -1, (nc.match(/badge resend[^<]*/) || ['no badge'])[0]);
  ok('the OLDER card is flagged too and names the bill that replaced it',
     /badge resend/.test(oc) && oc.indexOf('sent again as RSR-DC-'+MM+'-004') > -1, (oc.match(/badge resend[^<]*/) || ['no badge'])[0]);
  ok('both carry Keep both; the unrelated cards carry neither the badge nor the button',
     /data-keepresend="/.test(oc) && /data-keepresend="/.test(nc) &&
     !/badge resend|data-keepresend/.test(cardFor(L, GID)) && !/badge resend|data-keepresend/.test(cardFor(L, 'hand1')));

  const flagged = () => { const f = app.resendFlags(); return !!(f[OLD] || f[NEW]); };
  // the old bill voided: its lines gone, the receipt still names it
  const saved = app.rows.filter(r => r.group_id === OLD);
  app.rows.splice(0, app.rows.length, ...app.rows.filter(r => r.group_id !== OLD));
  app.render();
  ok('deleting the old bill clears the flag on the new one with no server call', !flagged() && !/badge resend/.test(cardFor(el('list').innerHTML, NEW)));
  app.rows.push(...saved);
  saved.forEach(r => { r.status = 'PAID'; }); app.render();
  ok('the old bill PAID: nothing left to decide, no flag', !flagged());
  saved.forEach(r => { r.status = 'DRAFT'; });
  app.rows.filter(r => r.group_id === NEW).forEach(r => { r.status = 'PAID'; }); app.render();
  ok('the NEW bill paid: no flag either', !flagged());
  app.rows.filter(r => r.group_id === NEW).forEach(r => { r.status = 'BILLED'; }); app.render();
  ok('BILLED is still unpaid: the flag is back', flagged());
  app.rows.filter(r => r.group_id === NEW).forEach(r => { r.status = 'DRAFT'; });
  await load([ rcpt(OLD, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), rcpt(NEW, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { resend_of:[OLD], resend_kept_at:'2026-09-18T01:00:00Z' }) ]);
  ok('a receipt already kept on the server raises no flag on either card (every device agrees)', !flagged());

  // Keep both, offline: refused before any request
  await load(RECEIPTS());
  net.mode = 'offline';                           // the connection drops mid-tap
  await app.keepResend(NEW);
  ok('Keep both with the connection down changes nothing locally -- the warning stays until the server has recorded it', flagged());
  net.mode = 'online';
  const bodies = [], realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => { if (/keep_drydock_resend/.test(url)) bodies.push((opts && opts.body) || ''); return realFetch(url, opts); };
  // online: the RPC, then both cards clear
  net.script.push({ match:'keep_drydock_resend', method:'POST', status:200, body:{ ok:true, kept:1, by:'summer@rsr.test' } });
  const p1 = app.keepResend(OLD), p2 = app.keepResend(OLD);   // a double tap
  await p1; await p2;
  globalThis.fetch = realFetch;
  ok('Keep both posts keep_drydock_resend ONCE for a double tap, naming the tapped bill',
     bodies.length === 1 && JSON.parse(bodies[0] || '{}').p_group_id === OLD, JSON.stringify(bodies));
  L = el('list').innerHTML;
  ok('...and both cards clear at once', !flagged() && !/badge resend|data-keepresend/.test(L));

  // never on the client's copy
  await load(RECEIPTS());
  app.openStmtFor(NEW);
  app.renderStatement(app.pickedRows());
  const doc2 = el('printRoot').innerHTML, mail2 = String(app.statementEmailHtml());
  ok('the Re-sent warning never reaches the statement or the email',
     /Load Line Certificate/.test(doc2) && !/Re-sent|badge resend|Keep both/.test(doc2) && !/Re-sent|badge resend|Keep both/.test(mail2));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
