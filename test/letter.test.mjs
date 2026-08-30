// The covering letter, the review step, and what a send does to status.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
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
const reset = () => {
  KEYS.forEach(k => globalThis.localStorage.removeItem(k));
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify({ seededDW:true }));
  el('sNo').value = '';
  return globalThis.__loadApp();
};
const make = async (app, titles, vessel='MV SF Voyager') => {
  app.openEntry(null, 'DW');
  el('eClient').value = 'Seaford'; el('eVessel').value = vessel;
  el('eDate').value = '2026-08-21'; el('eRate').value = '1000';
  app.mlines = titles.map(t => ({ id:null, title:t, ref:'DWG-'+t.length, qty:1, rate:'',
                                  billable:true, rev_of:null, rev_no:null }));
  app.renderML();
  await el('eSave').onclick();
};
const openStmt = (app) => {
  el('sClient').value = 'Seaford';
  el('sFrom').value = '2026-08-01'; el('sTo').value = '2026-08-31';
  el('sType').value = ''; el('sTerms').value = '7'; el('sVat').value = '0';
  app.buildPick();
};
// The send refuses to run with anything still queued, so a suite that wants
// to reach it has to be online from the first write, not just at send time.
const online = (app) => {
  net.mode = 'online';
  app.cfg.url = 'https://proj.supabase.co'; app.cfg.key = 'anon';
  app.setSession({ access_token:'t', refresh_token:'r', expires_at: 2e9,
                   user:{ email:'me@rsr.test' } });
  return app;
};

// lSend now builds a PDF before posting. pdfRender loads jsPDF from a CDN
// <script> tag; the harness's appendChild is a no-op so that would hang
// forever. loadJsPdf's own fast path — a jsPDF already on window — is the
// seam this suite uses instead, set up once for every send driven below.
globalThis.window.jspdf = {
  jsPDF: class {
    constructor(){}
    setFont(){} setFontSize(){} setLineWidth(){}
    setFillColor(){} setDrawColor(){} setTextColor(){}
    text(){} line(){} rect(){} addImage(){} addPage(){}
    output(){ return 'data:application/pdf;base64,' + Buffer.from('fake-pdf').toString('base64'); }
  },
};

net.mode = 'offline';
let app = reset();

console.log('\n--- 1. the seeded template ---');
ok('Settings carries the letter box', /id="cLetter"/.test(html));
ok('an unset template resolves to the standard wording',
   app.letterTemplate() === app.LETTER_DEFAULT);
ok('it opens with the salutation', /^Dear \{contact\},/.test(app.LETTER_DEFAULT));
ok('it names billing, vessel, period and total',
   ['{billno}','{vessel}','{period}','{total}'].every(k => app.LETTER_DEFAULT.includes(k)),
   app.LETTER_DEFAULT);
ok('it carries the agreed-terms sentence',
   /We would appreciate settlement within the agreed terms\./.test(app.LETTER_DEFAULT));
ok('and the closing block',
   /Respectfully yours,[\s\S]*Raffy J\. Ramirez[\s\S]*Naval Architect & Marine Engineer[\s\S]*RSR Engineering Services$/
     .test(app.LETTER_DEFAULT), JSON.stringify(app.LETTER_DEFAULT.slice(-90)));
ok('every documented placeholder is substitutable',
   ['contact','billno','vessel','period','total','due'].every(k => app.LETTER_KEYS.includes(k)),
   app.LETTER_KEYS.join(','));
ok('Settings shows the seeded wording in the box',
   (app.openCfg(), el('cLetter').value === app.LETTER_DEFAULT), el('cLetter').value.slice(0, 40));

console.log('\n--- 2. placeholders resolve ---');
await app.cliSave({ name:'Seaford', contact_person:'Mr. Chua', address:'Cebu',
                    billing_email:'ap@seaford.test' }, true);
await make(app, ['Shell Expansion Plan']);
openStmt(app);
let letter = app.composeLetter(app.pickedRows(), 'BILLDWG-26-001');
ok('the contact person becomes the salutation',
   /^Dear Mr\. Chua,/.test(letter), letter.split('\n')[0]);
ok('the billing number is quoted', letter.includes('BILLDWG-26-001'));
ok('the vessel is named', letter.includes('MV SF Voyager'));
// The period is the billings on the document, not the window browsed to find
// them. Every fixture line is dated 2026-08-19, so one day is the whole period
// -- the sheet's 01-31 Aug filter is a selection mechanism and must not reach
// the client. This assertion used to expect that filter range.
ok('the period is the billings, not the filter window',
   letter.includes('21 Aug 2026'), letter);
ok('and a single day is not written as a range',
   !letter.includes('21 Aug 2026 — 21 Aug 2026') &&
   !letter.includes('01 Aug 2026 — 31 Aug 2026'), letter);
ok('the total is the document total',
   letter.includes(app.money(app.stmtFacts(app.pickedRows()).grand)) &&
   /₱1,000\.00/.test(letter), letter);
ok('no placeholder is left unresolved', !/\{(contact|billno|vessel|period|total|due)\}/.test(letter),
   (letter.match(/\{[a-z]+\}/) || [''])[0]);

console.log('\n--- the total cannot drift from the document ---');
el('sVat').value = '12';
app.renderStatement(app.pickedRows());
const withVat = app.composeLetter(app.pickedRows(), 'BILLDWG-26-001');
ok('VAT moves the letter total too',
   withVat.includes('₱1,120.00') && el('printRoot').innerHTML.includes('₱1,120.00'),
   (withVat.match(/₱[\d,.]+/) || [''])[0]);
el('sVat').value = '0';

console.log('\n--- a client with no contact person ---');
// a second cliSave adds a record rather than replacing, and clientRec takes
// the first match — so this needs its own app, not an overwrite
const noContact = reset();
await noContact.cliSave({ name:'Seaford', contact_person:'', address:'Cebu',
                          billing_email:'ap@seaford.test' }, true);
await make(noContact, ['Shell Expansion Plan']);
openStmt(noContact);
ok('falls back to Sir/Madam',
   /^Dear Sir\/Madam,/.test(noContact.composeLetter(noContact.pickedRows(), 'X')),
   noContact.composeLetter(noContact.pickedRows(), 'X').split('\n')[0]);

console.log('\n--- Salutation opens the letter; Bill To keeps the full name ---');
// The reason the column exists: the letter wants "Dear Mr. Chua," while the
// document wants "Ashford Chua" printed over the company name. One field
// cannot serve both, and nothing is derived from the other.
const both = reset();
await both.cliSave({ name:'Seaford', salutation:'Mr. Chua', contact_person:'Ashford Chua',
                     address:'Cebu', billing_email:'ap@seaford.test' }, true);
await make(both, ['Shell Expansion Plan']);
openStmt(both);
const bothLetter = both.composeLetter(both.pickedRows(), 'BILLDWG-26-001');
ok('the letter opens with the salutation, not the full name',
   /^Dear Mr\. Chua,/.test(bothLetter), bothLetter.split('\n')[0]);
both.renderStatement(both.pickedRows());
ok('Bill To still carries the full contact person',
   el('printRoot').innerHTML.includes('Ashford Chua'));
ok('and the salutation never reaches the document',
   !el('printRoot').innerHTML.includes('Mr. Chua'),
   (el('printRoot').innerHTML.match(/Mr\.[^<]*/) || [''])[0]);
ok('the salutation is queued for sync, not dropped on the device',
   (both.queue.find(j => j.store === 'clients') || { data:{} }).data.salutation === 'Mr. Chua',
   JSON.stringify((both.queue.find(j => j.store === 'clients') || {}).data));

console.log('\n--- and it falls back when left blank ---');
const blankSal = reset();
await blankSal.cliSave({ name:'Seaford', salutation:'', contact_person:'Ashford Chua',
                         address:'Cebu', billing_email:'ap@seaford.test' }, true);
await make(blankSal, ['Shell Expansion Plan']);
openStmt(blankSal);
ok('a blank salutation uses the contact person',
   /^Dear Ashford Chua,/.test(blankSal.composeLetter(blankSal.pickedRows(), 'X')),
   blankSal.composeLetter(blankSal.pickedRows(), 'X').split('\n')[0]);
const neither = reset();
await neither.cliSave({ name:'Seaford', salutation:'', contact_person:'',
                        address:'Cebu', billing_email:'ap@seaford.test' }, true);
await make(neither, ['Shell Expansion Plan']);
openStmt(neither);
ok('both blank still reaches Sir/Madam',
   /^Dear Sir\/Madam,/.test(neither.composeLetter(neither.pickedRows(), 'X')),
   neither.composeLetter(neither.pickedRows(), 'X').split('\n')[0]);

console.log('\n--- the column is plumbed through settings and SQL ---');
const plumb = reset();
await plumb.cliSave({ name:'Seaford', salutation:'Mr. Chua', contact_person:'Ashford Chua',
                      address:'Cebu', billing_email:'ap@seaford.test' }, true);
plumb.renderCliMgr();
const salBox = el('cCliList')
  .querySelector('[data-clf="salutation"][data-cli="' + plumb.clients[0].id + '"]');
ok('the client editor exposes a salutation field', !!salBox);
ok('and shows the stored value', salBox && salBox.value === 'Mr. Chua', salBox && salBox.value);
el('sqlWrap').hidden = true;
el('cSql').onclick();
const cliSql = el('cSqlBox').value;
ok('a fresh clients table declares the column',
   /create table if not exists clients[\s\S]*?salutation\s+text/.test(cliSql));
ok('an existing one gets it added, never with a bare alter',
   /alter table clients add column if not exists salutation\s+text;/.test(cliSql));
ok('Settings documents the fallback order',
   /\{contact\}[\s\S]{0,200}Salutation[\s\S]{0,200}Sir\/Madam/.test(html));

app = reset();
await app.cliSave({ name:'Seaford', contact_person:'Mr. Chua', address:'Cebu',
                    billing_email:'ap@seaford.test' }, true);
await make(app, ['Shell Expansion Plan']);
openStmt(app);

console.log('\n--- {due} follows the terms field ---');
el('sTerms').value = '7';
ok('7 days is reflected',
   app.fillLetter('Due {due}', app.letterVars(app.stmtFacts(app.pickedRows()), 'X'))
     === 'Due ' + app.fmtDate(app.stmtFacts(app.pickedRows()).due));

console.log('\n--- an unknown token is left visible, not blanked ---');
ok('a typo survives to the review step',
   app.fillLetter('Hi {contct}', app.letterVars(app.stmtFacts(app.pickedRows()), 'X'))
     === 'Hi {contct}');

console.log('\n--- 3. the letter renders above the billing ---');
app.renderStatement(app.pickedRows(), { email:true });
const mail = app.statementEmailHtml('Dear Sir/Madam,\n\nOne\nTwo\n\nRespectfully yours,');
ok('the body is the letter, and nothing follows it',
   mail.indexOf('class="ltr"') > -1 && !/class="stmt"/.test(mail));
ok('it carries the send date',
   new RegExp('class="ltr-d">' + app.fmtDate(app.today())).test(mail));
const block = app.letterHtml('Dear Sir/Madam,\n\nOne\nTwo\n\nRespectfully yours,');
ok('blank lines become paragraphs',
   (block.match(/<p>/g) || []).length === 3, block);
ok('single newlines break within one', /One<br>Two/.test(mail));
ok('the mail stylesheet covers the letter', /\.ltr\{/.test(html) && /\.ltr p\{/.test(html));
// c9fa5e4, and nothing pinned it until now. margin:0 auto centres the 760px
// block, so in any reading pane wider than that the leftover gap lands on the
// left and the letter reads as indented by about an inch -- which is what Gmail
// was showing. The harness computes no layout, so this is a CSS-contract
// assertion: it proves the rule was not put back, never that anything is
// actually flush left on a screen. max-width stays -- it holds the line length,
// not the position.
const ltrRule = (html.match(/\.ltr\{[^}]*\}/) || [''])[0];
ok('the letter block sets its left margin to 0',
   /margin:0 0 /.test(ltrRule), ltrRule);
ok('and is never re-centred with auto',
   !/auto/.test(ltrRule), ltrRule);
ok('letter text is escaped',
   app.letterHtml('a <b>bold</b> & co').includes('&lt;b&gt;'),
   app.letterHtml('a <b>bold</b> & co'));
ok('no letter block when there is no letter', !/class="ltr"/.test(app.statementEmailHtml()));

console.log('\n--- 4. the subject line ---');
ok('billing, vessel, company',
   app.mailSubject(app.stmtFacts(app.pickedRows()), 'BILLDWG-26-001')
     === 'Billing BILLDWG-26-001 — MV SF Voyager — RSR ENGINEERING SERVICES',
   app.mailSubject(app.stmtFacts(app.pickedRows()), 'BILLDWG-26-001'));

console.log('\n--- 5. the review step ---');
ok('there is a letter sheet', /id="sheetLetter"/.test(html) && /id="lBody"/.test(html));
app = online(reset());
await app.cliSave({ name:'Seaford', contact_person:'Mr. Chua', address:'Cebu',
                    billing_email:'ap@seaford.test' }, true);
await make(app, ['Shell Expansion Plan']);
openStmt(app);
el('sEmail').value = 'ap@seaford.test';
await el('sEmailBtn').onclick();
ok('the Email button opens the review, it does not send',
   el('sheetLetter').classList.contains('on') &&
   !net.calls.some(c => String(c.url).includes('send-statement')),
   JSON.stringify(net.calls.map(c => c.url).slice(-2)));
ok('the composed letter is in the box', /^Dear Mr\. Chua,/.test(el('lBody').value));
ok('the recipient is shown for checking', el('lTo').innerHTML.includes('ap@seaford.test'));
ok('nothing is billed yet', app.allGroups()[0].status === 'DRAFT');
ok('and no number was claimed',
   !app.allGroups()[0].bill_no, String(app.allGroups()[0].bill_no));

console.log('\n--- backing out claims nothing ---');
el('lBack2').onclick();
ok('the statement sheet comes back', el('sheetStmt').classList.contains('on'));
ok('still no number burned', !app.allGroups()[0].bill_no);
ok('still a draft', app.allGroups()[0].status === 'DRAFT');
ok('and the send is disarmed', app.pendingSend === null);

console.log('\n--- 6. a successful send marks it billed ---');
await el('sEmailBtn').onclick();
el('lBody').value = el('lBody').value.replace('Please find', 'Kindly find');
let sent = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts={}) => {
  if (String(url).includes('send-statement')) {
    sent = JSON.parse(opts.body);
    return { ok:true, status:200, json:async()=>({ ok:true }), text:async()=>'{}' };
  }
  return realFetch(url, opts);
};
await el('lSend').onclick();
ok('the function was called', !!sent);
ok('the per-send edit is what went out', sent.html.includes('Kindly find'), '');
ok('and the Settings template is untouched',
   app.letterTemplate() === app.LETTER_DEFAULT);
ok('the subject names the billing and vessel',
   /^Billing BILLDWG-26-\d+ — MV SF Voyager — /.test(sent.subject), sent.subject);
ok('the billing is now BILLED', app.allGroups()[0].status === 'BILLED',
   app.allGroups()[0].status);
ok('with billed_date set to today',
   app.allGroups()[0].lines.every(r => r.billed_date === app.today()),
   JSON.stringify(app.allGroups()[0].lines.map(r => r.billed_date)));
ok('every line moved, not just the first',
   app.allGroups()[0].lines.every(r => r.status === 'BILLED'));

console.log('\n--- re-sending an already BILLED billing changes nothing ---');
const wasDate = app.allGroups()[0].lines[0].billed_date;
app.allGroups()[0].lines.forEach(r => { r.billed_date = '2026-01-01'; });
ok('markBilledNow leaves BILLED alone',
   (await app.markBilledNow(app.allGroups())).n === 0);
ok('and does not restamp the date',
   app.allGroups()[0].lines[0].billed_date === '2026-01-01', wasDate);

console.log('\n--- a PAID billing is never walked back ---');
app.markGroup(app.allGroups()[0].id, 'PAID');
ok('still PAID after a send would mark',
   (await app.markBilledNow(app.allGroups())).n === 0);
ok('status untouched', app.allGroups()[0].status === 'PAID');

console.log('\n--- 7. a failed send leaves status alone ---');
app = online(reset());
await app.cliSave({ name:'Seaford', contact_person:'Mr. Chua', address:'Cebu',
                    billing_email:'ap@seaford.test' }, true);
await make(app, ['Midship Section']);
openStmt(app);
el('sEmail').value = 'ap@seaford.test';
await el('sEmailBtn').onclick();
globalThis.fetch = async (url, opts={}) => {
  if (String(url).includes('send-statement'))
    return { ok:false, status:500, json:async()=>({ ok:false, error:'Resend refused' }),
             text:async()=>'' };
  return realFetch(url, opts);
};
await el('lSend').onclick();
ok('the billing is still a draft', app.allGroups()[0].status === 'DRAFT',
   app.allGroups()[0].status);
ok('no billed_date was stamped',
   app.allGroups()[0].lines.every(r => !r.billed_date));
ok('the letter is kept for another try', !!app.pendingSend);
globalThis.fetch = realFetch;

console.log('\n--- 8. print keeps its confirm, unless Settings says otherwise ---');
ok('print still routes through offerMarkBilled',
   /\$\('sPrint'\)\.onclick[\s\S]{0,700}offerMarkBilled\(list\)/.test(html));
ok('the toggle exists and defaults off',
   /id="cMarkPrint"/.test(html) && app.cfg.autoMarkPrint !== true);
ok('and it is what skips the confirm',
   /if\(!cfg\.autoMarkPrint\)\{offerMarkBilled\(list\);return;\}/.test(html));
ok('offerMarkBilled no longer overwrites a PAID billing',
   /const movable=\(list\|\|\[\]\)\.filter\(g=>g\.status==='DRAFT'\)/.test(html));

console.log('\n--- 9. the send carries a pdf attachment and no tracking code ---');
app = online(reset());
await app.cliSave({ name:'Seaford', contact_person:'Mr. Chua', address:'Cebu',
                    billing_email:'ap@seaford.test' }, true);
await make(app, ['Shell Expansion Plan']);
openStmt(app);
el('sEmail').value = 'ap@seaford.test';
await el('sEmailBtn').onclick();
let posted = null;
globalThis.fetch = async (url, opts={}) => {
  if (String(url).includes('send-statement')) {
    posted = JSON.parse(opts.body);
    return { ok:true, status:200, json:async()=>({ ok:true }), text:async()=>'{}' };
  }
  return realFetch(url, opts);
};
await el('lSend').onclick();
ok('the body carries an attachment', !!posted && !!posted.attachment,
   JSON.stringify(posted || {}));
ok('the filename is the billing number',
   !!posted && /^BILLDWG-\d\d-\d\d\d\.pdf$/.test(posted.attachment.filename),
   posted && posted.attachment.filename);
ok('pdfRender strips the data-URI prefix, leaving bare base64',
   !!posted && /^[A-Za-z0-9+/]+=*$/.test(posted.attachment.content),
   posted && posted.attachment.content);
ok('no tracking code in the subject, body, client, statement number or filename',
   JSON.stringify(posted).indexOf('RSR-') === -1);
globalThis.fetch = realFetch;

console.log('\n--- 10. a letter that does not address anyone is reported ---');
openStmt(app);
const facts10 = app.stmtFacts(app.pickedRows());
const vars10 = app.letterVars(facts10, 'BILLDWG-26-001');
ok('contact is never empty', String(vars10.contact || '').length > 0, vars10.contact);

ok('the default template addresses the contact',
   app.letterWarning(app.fillLetter(app.LETTER_DEFAULT, vars10), vars10) === '',
   app.letterWarning(app.fillLetter(app.LETTER_DEFAULT, vars10), vars10));

const noAddressee = 'Please find our billing {billno}.\n\nRespectfully yours,';
const warn10 = app.letterWarning(app.fillLetter(noAddressee, vars10), vars10);
ok('a letter missing the addressee warns', warn10 !== '', warn10);
ok('the warning names the contact it expected',
   warn10.indexOf(vars10.contact) > -1, warn10);

console.log('\n--- 11. a custom template without {contact} warns when saved ---');
ok('a template without {contact} is reported',
   app.letterWarning('Please find our billing {billno}.', vars10) !== '');
ok('a template with {contact} is not',
   app.letterWarning('Dear {contact}, please find our billing.', {contact:'{contact}'}) === '');

console.log('\n' + '='.repeat(46));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
