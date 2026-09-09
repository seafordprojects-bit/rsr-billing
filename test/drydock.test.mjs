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
const REMARKS = 'Drydocking documents emailed September 9, 2026, confirmed by Raffy J. Ramirez. Project 25-016.';
const line = (gid, n, code, title) => ({ id:'srv-'+gid+'-'+n, group_id:gid, line_no:n, code, doc_type:'DC', bill_date:TODAY,
  client:'Seaford Shipping Lines, Inc.', vessel:'MV "SF RISER"', drawing_no:null, drawing_title:title, qty:1, rate:2500,
  status:'DRAFT', remarks:REMARKS, billable:true, created_at:'2026-09-09T10:21:00Z' });
const ROWS = [ line(GID, 1, 'RSR-DC-'+MM+'-001', 'Transmittal'), line(GID, 2, 'RSR-DC-'+MM+'-001', 'Load Line Certificate'),
               Object.assign(line('hand1', 1, 'RSR-DC-'+MM+'-002', 'Typed by hand'), { remarks: '' }) ];
KEYS.forEach(k => globalThis.localStorage.removeItem(k));
globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW:true, url:'https://proj.supabase.co', key:'anon' }));
globalThis.localStorage.setItem('rsr_dwg_rows_v1', JSON.stringify(ROWS));
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
ok('a hand-entered DC group has no badge and no receipt meta', !!handCard && !/badge dd/.test(handCard) && !/Emailed /.test(handCard),
   handCard ? '' : 'hand card not rendered');

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
ok('the statement carries the lines but no From drydocking badge or receipt meta',
   /Load Line Certificate/.test(doc) && doc.indexOf('From drydocking') < 0 && doc.indexOf('badge dd') < 0 && doc.indexOf('Emailed ') < 0,
   /Load Line Certificate/.test(doc) ? '' : 'statement has no lines');
const mail = String(app.statementEmailHtml());
ok('the email body carries none either', mail.indexOf('From drydocking') < 0 && mail.indexOf('badge dd') < 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
