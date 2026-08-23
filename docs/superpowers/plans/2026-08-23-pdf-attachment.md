# PDF Attachment for Emailed Billings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emailed billings carry a vector PDF attachment matching the print layout, and the offline queue stops hiding write failures.

**Architecture:** A pure `pdfPlan(facts, issuedNo)` turns the object `stmtFacts()` already returns into a list of draw ops; a thin `pdfRender(plan)` feeds those ops to jsPDF, lazy-loaded from cdnjs with an SRI hash. The split exists because jsPDF cannot load in the test harness — as data, the whole layout is assertable. `flushQueue` learns to tell a transient failure from a permanent one, and a duplicate-client insert heals fill-only instead of jamming.

**Tech Stack:** Plain ES5-flavoured JS inside one IIFE in `index.html`; jsPDF from cdnjs; Deno Edge Function on Supabase; Node-only test harness, no dependencies.

## Global Constraints

- **Everything is one file.** All app code goes in `index.html` inside the existing IIFE. No build step, no bundler, no package manager, no framework.
- **Anchored edits, never line-range replacement.** A range edit here once deleted 190 lines silently and `node --check` passed, because missing functions are not a syntax error. After any bulk edit, grep for the symbols you expect.
- **After every edit to `index.html`, syntax-check the extracted script:**
  `sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js`
- **LF line endings.** Never let a tool rewrite the file as CRLF.
- **No duplicate `id` attributes**, and every `$('id')` must resolve — a null target throws and kills the whole IIFE.
- **Interactive elements are 44px minimum**; `touch.test.mjs` enforces it.
- **Repaint Settings editors through `repaint(box, html, keys)`**, never `innerHTML =`, or the caret jumps.
- **No swallowed catch in any new code.** Every `try`/`catch` either rethrows or surfaces the real reason to the user. `catch(e){}` is a plan violation.
- **The `RSR-` tracking code never reaches a client-facing artefact** — not the document, not the email, not the PDF, not its filename. Client-facing numbering is `bill_no` only (`BILLDWG-26-001`).
- **The test harness hook is version-coupled.** Adding a name to `__t` in `test/harness.mjs` that does not exist in `index.html` breaks every suite at load.
- **Run the full suite** with `node test/run.mjs` (28 suites, 1124 assertions today). A single suite: `node test/run.mjs <prefix>`.
- **No schema change.** `sqlText()` is not touched by any task in this plan.

---

## File Structure

| file | responsibility | tasks |
|---|---|---|
| `index.html` | all app code: `sb`, `flushQueue`, heal, `pdfPlan`, `pdfRender`, Settings panel, Download button | 1-6 |
| `test/harness.mjs` | scripted HTTP failures; expose new names on `__t` | 1, 3, 4 |
| `test/queue.test.mjs` | extended: dead-job classification | 1 |
| `test/clients.test.mjs` | new: the fill-only 409 heal | 3 |
| `test/pdfplan.test.mjs` | new: the plan's values come from `stmtFacts` | 4 |
| `supabase/functions/send-statement/index.ts` | attachment validation, Resend `attachments` | 6 |
| `MANUAL-TEST.md` | the section the harness cannot cover | 6 |

Tasks 1-3 (the queue defects) land before the PDF work. They are independent of it, they are smaller, and Task 1 delivers the scripted-failure harness that Task 3 needs.

---

### Task 1: `sb()` carries the status, `flushQueue` classifies failures

**Files:**
- Modify: `index.html` — `sb()` at `:1350-1351`, `flushQueue()` at `:1356-1380`, `syncBadge` at `:1638`
- Modify: `test/harness.mjs` — the controllable fetch at `:179-193`
- Test: `test/queue.test.mjs` (append a new section)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `err.status` (number) and `err.code` (string) on every Error thrown by `sb()`; `job.dead` (boolean) and `job.err` (string) on permanently-failed queue jobs; `deadJobs()` returning the dead jobs array; `net.script` in the harness for scripted HTTP failures.

- [ ] **Step 1: Give the harness scripted failures**

In `test/harness.mjs`, replace the `net` declaration and the body of the stub's success path. Add `script` to `net` and consult it before the generic success response:

```js
/* ---------------- controllable fetch ---------------- */
// net.script lets a suite make one specific request fail the way the real
// server would: push {match, status, body} and the next request whose URL
// contains `match` gets that response. Entries are consumed once unless
// `keep` is true.
export const net = { mode:'offline', calls:[], nextId:1, script:[] };
const scripted = (url, method) => {
  const i = net.script.findIndex(s =>
    String(url).indexOf(s.match) > -1 && (!s.method || s.method === method));
  if (i < 0) return null;
  const s = net.script[i];
  if (!s.keep) net.script.splice(i, 1);
  return s;
};
globalThis.fetch = async (url, opts={}) => {
  const method = opts.method || 'GET';
  net.calls.push({ url, method });
  if (net.mode === 'offline') throw new TypeError('Failed to fetch');
  if (net.mode === 'unauthorized') {
    return { ok:false, status:401, json:async()=>({message:'JWT expired'}), text:async()=>'' };
  }
  const hit = scripted(url, method);
  if (hit) {
    const body = hit.body || {};
    return { ok:false, status:hit.status, json:async()=>body,
             text:async()=>JSON.stringify(body) };
  }
  // online: echo inserts back with a server id
  let body = null;
  if (typeof opts.body === 'string') { try { body = JSON.parse(opts.body); } catch { body = null; } }
  const rows = Array.isArray(body) ? body : body ? [body] : [];
  const out = rows.map(r => Object.assign({}, r, { id: 'srv-' + (net.nextId++) }));
  return { ok:true, status:200, json:async()=>out, text:async()=>JSON.stringify(out) };
};
```

- [ ] **Step 2: Write the failing test**

Append to `test/queue.test.mjs`:

```js
console.log('\n--- N. a permanent rejection is surfaced, not retried forever ---');
net.mode = 'online';
net.script.length = 0;
app = globalThis.__loadApp();
configure(app);
app.setSession({ access_token:'tok-1', refresh_token:'ref-1', expires_in:3600,
                 user:{ email:'raffy@rsr.test' } });

net.script.push({ match:'/rest/v1/drawing_billing', method:'POST', status:409,
  body:{ code:'23505',
         message:'duplicate key value violates unique constraint "drawing_billing_pkey"' } });
await app.saveRow(newRow('Duplicate Line'), true);
ok('a 409 does not stay silently queued', app.deadJobs().length === 1,
   'dead=' + app.deadJobs().length);
ok('the server message is kept verbatim',
   /duplicate key value/.test(app.deadJobs()[0].err), app.deadJobs()[0].err);
ok('the status is kept', /409/.test(app.deadJobs()[0].err), app.deadJobs()[0].err);

const callsBefore = net.calls.length;
await app.flushQueue();
ok('a dead job is not retried', net.calls.length === callsBefore,
   'calls=' + (net.calls.length - callsBefore));

console.log('\n--- N+1. a transient failure still retries silently ---');
net.script.length = 0;
app = globalThis.__loadApp();
configure(app);
app.setSession({ access_token:'tok-1', refresh_token:'ref-1', expires_in:3600,
                 user:{ email:'raffy@rsr.test' } });
net.script.push({ match:'/rest/v1/drawing_billing', method:'POST', status:503,
  body:{ message:'service unavailable' } });
await app.saveRow(newRow('Server Hiccup'), true);
ok('a 5xx stays queued', app.queue.length === 1, 'queue=' + app.queue.length);
ok('a 5xx is not marked dead', app.deadJobs().length === 0);
net.script.length = 0;
await app.flushQueue();
ok('it drains once the server recovers', app.queue.length === 0, 'queue=' + app.queue.length);
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node test/run.mjs queue`
Expected: FAIL — `app.deadJobs is not a function`.

- [ ] **Step 4: Carry the status out of `sb()`**

In `index.html`, replace the throw at `:1350-1351`:

```js
  if(!res.ok){
    // the status is what tells a caller whether retrying could ever help;
    // throwing it away is what let one 409 wedge the queue in silence
    let t='',code='';
    try{const d=await res.json();t=d.message||'';code=d.code||'';}catch(e){}
    const err=new Error(t||('HTTP '+res.status));
    err.status=res.status;err.code=code;
    throw err;
  }
```

- [ ] **Step 5: Classify in `flushQueue`**

Replace the `catch` and loop head in `flushQueue` (`index.html:1356-1380`):

```js
// A 4xx is the server saying this write can never succeed. Retrying it
// forever is what turns one constraint violation into an app whose only
// symptom is "1 queued". Transient failures keep their silent retry.
const transient=err=>!err||!err.status||err.status>=500||err.status===429;
const jobLabel=job=>{
  const what=job.store==='clients'?'client':job.store==='catalog'?'catalog item':'billing line';
  const name=(job.data&&(job.data.name||job.data.drawing_title||job.data.title))||'';
  return (job.op==='insert'?'New ':job.op==='delete'?'Deleted ':'Edited ')+what+
         (name?' "'+name+'"':'');
};
const deadJobs=()=>queue.filter(j=>j.dead);

async function flushQueue(){
  if(!online()||!queue.length)return;
  const still=[];
  for(const job of queue){
    // a job the server has already refused is not retried; it waits in
    // Settings -> Pending writes for a decision
    if(job.dead){still.push(job);continue;}
    // jobs written before the catalog existed carry neither field
    const tbl=job.table||cfg.table;
    const store=job.store==='catalog'?catalog:job.store==='clients'?clients:rows;
    try{
      if(job.op==='insert'){
        const out=await sb(tbl,{method:'POST',body:JSON.stringify(job.data)});
        const srv=out&&out[0];
        if(srv){const i=store.findIndex(r=>r.id===job.localId);if(i>-1)store[i]=srv;}
      }else if(job.op==='update'){
        await sb(tbl+'?id=eq.'+encodeURIComponent(job.id),{method:'PATCH',body:JSON.stringify(job.data)});
      }else if(job.op==='upsert'){
        await sb(tbl,{method:'POST',
          headers:{'Prefer':'resolution=merge-duplicates,return=representation'},
          body:JSON.stringify(job.data)});
      }else if(job.op==='delete'){
        await sb(tbl+'?id=eq.'+encodeURIComponent(job.id),{method:'DELETE'});
      }
    }catch(err){
      if(transient(err)){still.push(job);continue;}
      job.dead=true;
      job.err=(err.status?err.status+': ':'')+(err.message||'Rejected by the server');
      still.push(job);
      toast(jobLabel(job)+' — '+job.err,true);
    }
  }
  queue=still;persist();
}
```

- [ ] **Step 6: Make the badge tell them apart**

Replace `syncBadge` at `index.html:1638`:

```js
const syncBadge=()=>{
  const dead=deadJobs().length,live=queue.length-dead;
  if(dead)return setSync('err',dead+' failed'+(live?', '+live+' queued':''));
  setSync(live?'off':'ok',live?live+' queued':'Synced');
};
```

- [ ] **Step 7: Expose the new names to the harness**

In `test/harness.mjs`, add to the `__t` hook object, on the line with `flushQueue`:

```js
  saveRow, saveBatch, flushQueue, deleteRow, persist, online, authed, setSession, pull, uploadPdf,
  deadJobs, jobLabel, syncBadge,
```

- [ ] **Step 8: Run the tests**

Run: `node test/run.mjs`
Expected: PASS — all suites, including the new queue sections.

- [ ] **Step 9: Syntax-check and commit**

```bash
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js
git add index.html test/harness.mjs test/queue.test.mjs
git commit -m "stop retrying writes the server has already refused"
```

---

### Task 2: Pending writes panel in Settings

**Files:**
- Modify: `index.html` — markup beside the Client records section (`:953-956`), render function beside `renderCliMgr` (`:2807`)
- Test: `test/queue.test.mjs` (append)

**Interfaces:**
- Consumes: `deadJobs()`, `jobLabel(job)`, `job.err` from Task 1.
- Produces: `renderDeadJobs()`, `discardJob(idx)`, `retryJob(idx)`, `lossSummary(job)` returning the human-readable list of fields a discard would destroy.

- [ ] **Step 1: Write the failing test**

Append to `test/queue.test.mjs`:

```js
console.log('\n--- N+2. a discard names what it would destroy ---');
net.mode = 'online';
net.script.length = 0;
app = globalThis.__loadApp();
configure(app);
app.setSession({ access_token:'tok-1', refresh_token:'ref-1', expires_in:3600,
                 user:{ email:'raffy@rsr.test' } });
net.script.push({ match:'/rest/v1/clients', method:'POST', status:409, keep:true,
  body:{ code:'23505',
         message:'duplicate key value violates unique constraint "clients_name_key"' } });
await app.cliSave({ name:'Seaford Shipping Lines', salutation:'Mr. Chua',
  contact_person:'Ashford Chua', address:'BREDCO 3, Reclamation Area, Bacolod City',
  billing_email:'raffyramirez00@gmail.com' }, true);

const dead = app.deadJobs()[0];
const loss = app.lossSummary(dead);
ok('the summary names the client', /Seaford Shipping Lines/.test(loss), loss);
ok('the summary names the contact person', /Ashford Chua/.test(loss), loss);
ok('the summary names the address', /BREDCO 3/.test(loss), loss);
ok('the summary names the billing email', /raffyramirez00@gmail.com/.test(loss), loss);
ok('the summary says the server copy is untouched', /server/i.test(loss), loss);
ok('an empty field is not listed as a loss', !/salutation:\s*,/.test(loss), loss);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node test/run.mjs queue`
Expected: FAIL — `app.lossSummary is not a function`.

- [ ] **Step 3: Add the markup**

In `index.html`, immediately after the Client records block (after the `cCliAdd` button div at `:956`), insert:

```html
    <div class="sect-t" style="display:flex;align-items:center">Pending writes<span style="margin-left:auto;font-family:var(--mono);font-size:11px;letter-spacing:0;text-transform:none;color:var(--slate)" id="cDeadCount"></span></div>
    <div class="hint" style="margin:-4px 0 9px">Writes the server refused. They are not retried until you say so.</div>
    <div class="pick" id="cDeadList"></div>
```

- [ ] **Step 4: Render it, with a confirm that names the loss**

Add beside `renderCliMgr` in `index.html`:

```js
/* ---- writes the server refused (settings) ---- */
// The queue is the only copy of a write the server has not taken, so a
// discard has to say what it is about to destroy. On 2026-08-23 a stuck
// client insert ended safely only because the server row was read first;
// this is that check, made the default.
function lossSummary(job){
  const d=job.data||{};
  const bits=Object.keys(d).filter(k=>d[k]!==null&&String(d[k]).trim()!=='')
    .map(k=>k.replace(/_/g,' ')+': '+d[k]);
  return jobLabel(job)+'\n\n'+
    (bits.length?'Typed on this device and not yet saved anywhere else:\n  '+
      bits.join('\n  ')+'\n\n':'')+
    'Discarding loses that. Any copy already on the server is not affected.';
}
function renderDeadJobs(){
  const list=deadJobs();
  $('cDeadCount').textContent=list.length?(list.length+' failed'):'';
  repaint($('cDeadList'),list.length?list.map((j,i)=>`
    <div class="imp">
      <div class="imp-h">
        <span class="fn">${esc(jobLabel(j))}</span>
      </div>
      <div class="imp-f">
        <div class="hint" style="margin:0">${esc(j.err||'Rejected')}</div>
        <div style="display:flex;gap:8px">
          <button class="act" data-djretry="${i}" type="button">Retry</button>
          <button class="act" data-djdrop="${i}" type="button">Discard</button>
        </div>
      </div>
    </div>`).join('')
    : `<div style="padding:16px;text-align:center;color:var(--slate);font-size:13px">Nothing has been refused.</div>`,
    []);
}
$('cDeadList').addEventListener('click',async e=>{
  const r=e.target.closest('[data-djretry]'),d=e.target.closest('[data-djdrop]');
  if(r){
    const job=deadJobs()[Number(r.dataset.djretry)];
    if(!job)return;
    delete job.dead;delete job.err;
    persist();
    if(online()){await flushQueue();persist();}
    syncBadge();renderDeadJobs();return;
  }
  if(d){
    const job=deadJobs()[Number(d.dataset.djdrop)];
    if(!job)return;
    if(!confirm(lossSummary(job)))return;
    queue=queue.filter(q=>q!==job);
    if(job.localId){
      const store=job.store==='catalog'?catalog:job.store==='clients'?clients:rows;
      const i=store.findIndex(x=>x.id===job.localId);
      // pull() keeps every loc- row forever, so the orphan has to go too or
      // it comes back as a duplicate after the next sync
      if(i>-1)store.splice(i,1);
    }
    persist();syncBadge();renderDeadJobs();render();
  }
});
```

- [ ] **Step 5: Call it when Settings opens**

Find `openCfg` in `index.html` and add `renderDeadJobs();` beside the existing `renderCliMgr();` call.

- [ ] **Step 6: Expose to the harness**

In `test/harness.mjs`, add to the `__t` hook beside `renderCliMgr`:

```js
  renderCliMgr, renderBanks, openCfg, renderDeadJobs, lossSummary,
```

- [ ] **Step 7: Run the tests**

Run: `node test/run.mjs`
Expected: PASS.

- [ ] **Step 8: Syntax-check and commit**

```bash
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js
git add index.html test/harness.mjs test/queue.test.mjs
git commit -m "show the writes the server refused, and what discarding one costs"
```

---

### Task 3: A duplicate client heals fill-only

**Files:**
- Modify: `index.html` — `flushQueue`'s catch (from Task 1)
- Test: `test/clients.test.mjs` (new)

**Interfaces:**
- Consumes: `err.status` from Task 1, `CLI_FIELDS`, `CLI_TABLE`.
- Produces: `healClientDup(job)` returning `true` when the job was healed and can be dropped, `false` when it could not be.

- [ ] **Step 1: Write the failing test**

Create `test/clients.test.mjs`:

```js
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
const configure = (app) => {
  app.cfg.url = 'https://proj.supabase.co';
  app.cfg.key = 'anon-key';
  globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify(app.cfg));
};

console.log('\n--- 1. a duplicate client insert heals into a fill-only update ---');
net.mode = 'online';
net.script.length = 0;
net.calls.length = 0;
const app = globalThis.__loadApp();
configure(app);
app.setSession({ access_token:'tok-1', refresh_token:'ref-1', expires_in:3600,
                 user:{ email:'raffy@rsr.test' } });

// the server already holds the row, with the corrected email and no contact
net.script.push({ match:'/rest/v1/clients', method:'POST', status:409,
  body:{ code:'23505',
         message:'duplicate key value violates unique constraint "clients_name_key"' } });
net.script.push({ match:'/rest/v1/clients?name=eq.', method:'GET', status:200,
  body:[{ id:'srv-9', name:'Seaford Shipping Lines', salutation:'Mr. Chua',
          contact_person:null, address:null,
          billing_email:'rsrengineering.services2025@gmail.com' }] });

await app.cliSave({ name:'Seaford Shipping Lines', salutation:'Mr. Chua',
  contact_person:'Ashford Chua', address:'BREDCO 3, Reclamation Area, Bacolod City',
  billing_email:'raffyramirez00@gmail.com' }, true);

const patch = net.calls.find(c => c.method === 'PATCH');
ok('a PATCH was sent', !!patch, JSON.stringify(net.calls));
ok('the queue is empty', app.queue.length === 0, 'queue=' + app.queue.length);
ok('nothing was marked dead', app.deadJobs().length === 0);
ok('exactly one Seaford record locally',
   app.clients.filter(c => c.name === 'Seaford Shipping Lines').length === 1,
   JSON.stringify(app.clients));
ok('the local row adopted the server id',
   app.clients.find(c => c.name === 'Seaford Shipping Lines').id === 'srv-9');
ok('no loc- row survives', !app.clients.some(c => String(c.id).startsWith('loc-')));
ok("the server's corrected email won",
   app.clients.find(c => c.name === 'Seaford Shipping Lines').billing_email
     === 'rsrengineering.services2025@gmail.com');
ok('the locally typed contact filled the gap',
   app.clients.find(c => c.name === 'Seaford Shipping Lines').contact_person
     === 'Ashford Chua');

console.log('\n' + (fail ? 'FAILED ' + fail : 'OK') + ' — ' + pass + ' passed');
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node test/run.mjs clients`
Expected: FAIL — the queue still holds a dead job and no PATCH was sent.

- [ ] **Step 3: Implement the heal**

Add above `flushQueue` in `index.html`:

```js
// A client name is unique on the server, so an insert for a name that
// already exists can never succeed. Heal it instead of jamming: adopt the
// server's row and contribute only what the server is missing. Fill-only,
// never overwrite — a stale local copy must not clobber a corrected
// server value, which is exactly what happened on 2026-08-23.
async function healClientDup(job){
  const name=String((job.data&&job.data.name)||'').trim();
  if(!name)return false;
  const found=await sb(CLI_TABLE+'?select=*&name=eq.'+encodeURIComponent(name));
  const srv=found&&found[0];
  if(!srv)return false;
  const patch={};
  CLI_FIELDS.forEach(k=>{
    const mine=job.data[k],theirs=srv[k];
    if(String(mine==null?'':mine).trim()&&!String(theirs==null?'':theirs).trim())patch[k]=mine;
  });
  if(Object.keys(patch).length){
    await sb(CLI_TABLE+'?id=eq.'+encodeURIComponent(srv.id),
      {method:'PATCH',body:JSON.stringify(patch)});
    Object.assign(srv,patch);
  }
  // pull() keeps every loc- row forever, so replacing the local row is
  // what stops the duplicate reappearing after the next sync
  const i=clients.findIndex(c=>c.id===job.localId);
  if(i>-1)clients[i]=srv;else clients.push(srv);
  toast('"'+name+'" already existed — merged with the saved record');
  return true;
}
```

- [ ] **Step 4: Call it from the catch**

In `flushQueue`'s catch (Task 1, Step 5), insert before the `transient` check:

```js
    }catch(err){
      // a duplicate client is recoverable; anything else follows the
      // transient/permanent split below
      if(job.store==='clients'&&job.op==='insert'&&err.status===409){
        try{ if(await healClientDup(job))continue; }
        catch(e){ err=e; }
      }
      if(transient(err)){still.push(job);continue;}
```

Change the loop's `catch(err)` binding to a reassignable one by declaring `let err2` if the runtime rejects assigning to the catch parameter; in this codebase's target browsers `catch(err)` is assignable, so `err=e` is correct as written.

- [ ] **Step 5: Confirm the runner picked it up**

`test/run.mjs:11-12` discovers suites with `readdirSync` filtered on `.test.mjs`, so no registration is needed — dropping the file in `test/` is enough.

Run: `node test/run.mjs clients`
Expected: the suite runs by name.

- [ ] **Step 6: Run the tests**

Run: `node test/run.mjs`
Expected: PASS — 29 suites now.

- [ ] **Step 7: Syntax-check and commit**

```bash
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js
git add index.html test/clients.test.mjs
git commit -m "heal a duplicate client into a fill-only update"
```

---

### Task 4: `pdfPlan` — the layout as assertable data

**Files:**
- Modify: `index.html` — new section after `renderStatement`
- Modify: `test/harness.mjs` — expose `pdfPlan`, `pdfFilename`, `words`
- Test: `test/pdfplan.test.mjs` (new)

**Interfaces:**
- Consumes: `stmtFacts(picked)`, `words(n)` (`:1021`), `money`, `amountOf`, `cfg.banks`, `cfg.company`, `MARK_INK`.
- Produces: `pdfFilename(issuedNo)` returning `"BILLDWG-26-001.pdf"`; `pdfPlan(facts, issuedNo)` returning `{filename, page:{w,h}, ops:[…]}` where each op is `{t:'text', x, y, s, size?, bold?, align?}`, `{t:'line', x1, y1, x2, y2}` or `{t:'image', d, x, y, w, h}`.

- [ ] **Step 1: Write the failing test**

Create `test/pdfplan.test.mjs`:

```js
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
const textOf = (plan) => plan.ops.filter(o => o.t === 'text').map(o => o.s).join('\n');

const app = globalThis.__loadApp();
const rows = [
  { id:'r1', line_no:1, group_id:'g1', code:'RSR-DW-082026-001', bill_no:'BILLDWG-26-001',
    client:'Seaford Shipping Lines', vessel:'MV SF Voyager', drawing_no:'D-101',
    drawing_title:'Shell Expansion Plan', qty:2, rate:1500, status:'DRAFT',
    bill_date:'2026-08-19' },
  { id:'r2', line_no:2, group_id:'g1', code:'RSR-DW-082026-001', bill_no:'BILLDWG-26-001',
    client:'Seaford Shipping Lines', vessel:'MV SF Voyager', drawing_no:'D-102',
    drawing_title:'Midship Section', qty:1, rate:2500, status:'DRAFT',
    bill_date:'2026-08-19' },
];
app.rows.push.apply(app.rows, rows);
app.openStmt();
globalThis.document.getElementById('sClient').value = 'Seaford Shipping Lines';
globalThis.document.getElementById('sVat').value = '12';
globalThis.document.getElementById('sTerms').value = '30';

const facts = app.stmtFacts([app.groupOf(rows)]);
const plan = app.pdfPlan(facts, 'BILLDWG-26-001');
const text = textOf(plan);

console.log('\n--- 1. the page is A4 ---');
ok('width 595pt', Math.round(plan.page.w) === 595, String(plan.page.w));
ok('height 842pt', Math.round(plan.page.h) === 842, String(plan.page.h));

console.log('\n--- 2. the filename is the billing number ---');
ok('filename', plan.filename === 'BILLDWG-26-001.pdf', plan.filename);
ok('no tracking code in the filename', plan.filename.indexOf('RSR-') === -1);

console.log('\n--- 3. no tracking code reaches the client copy ---');
ok('no RSR- string anywhere in the plan',
   JSON.stringify(plan).indexOf('RSR-') === -1);

console.log('\n--- 4. every money value comes from stmtFacts ---');
ok('subtotal is facts.sub', text.indexOf(app.money(facts.sub)) > -1, app.money(facts.sub));
ok('adjustment is facts.adj', text.indexOf(app.money(facts.adj)) > -1, app.money(facts.adj));
ok('grand total is facts.grand', text.indexOf(app.money(facts.grand)) > -1,
   app.money(facts.grand));
ok('amount in words is words(facts.grand)',
   text.indexOf(app.words(facts.grand)) > -1, app.words(facts.grand));
ok('line 1 amount is amountOf(row)',
   text.indexOf(app.money(app.amountOf(rows[0]))) > -1);
ok('line 2 amount is amountOf(row)',
   text.indexOf(app.money(app.amountOf(rows[1]))) > -1);
ok('every line title appears', rows.every(r => text.indexOf(r.drawing_title) > -1));
ok('the billing number appears', text.indexOf('BILLDWG-26-001') > -1);
ok('the client appears', text.indexOf('Seaford Shipping Lines') > -1);
ok('the vessel appears', text.indexOf('MV SF Voyager') > -1);

console.log('\n--- 5. the plan reads facts, it does not recompute ---');
// the mutation proof: a plan reading the DOM would not follow this
const bumped = Object.assign({}, facts, { vat:0, adj:0, grand:facts.sub });
const plan2 = app.pdfPlan(bumped, 'BILLDWG-26-001');
const text2 = textOf(plan2);
ok('the total follows the facts it was given',
   text2.indexOf(app.money(facts.sub)) > -1 &&
   text2.indexOf(app.money(facts.grand)) === -1,
   app.money(facts.sub) + ' vs ' + app.money(facts.grand));
ok('the words follow too', text2.indexOf(app.words(facts.sub)) > -1);

console.log('\n' + (fail ? 'FAILED ' + fail : 'OK') + ' — ' + pass + ' passed');
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node test/run.mjs pdfplan`
Expected: FAIL — `app.pdfPlan is not a function`.

- [ ] **Step 3: Implement `pdfPlan`**

Add to `index.html` after `renderStatement`:

```js
/* ================= billing pdf ================= */
// The layout is built as data, not drawn directly, for one reason: jsPDF
// cannot load in the test harness. As a list of ops every value on the page
// is assertable, and the money can be checked against stmtFacts.
//
// pdfPlan must never read the DOM. Everything it needs is on `facts`, so the
// arithmetic on the PDF cannot drift from the body, the letter or the print
// view — the same rule stmtFacts exists to enforce.
const PDF_W=595.28, PDF_H=841.89;   // A4 in points
const PDF_M=42;                     // margin

function pdfFilename(issuedNo){
  const n=String(issuedNo||'').trim();
  return (n||'BILLING')+'.pdf';
}

function pdfPlan(facts,issuedNo){
  const ops=[];
  const t=(s,x,y,o)=>ops.push(Object.assign({t:'text',s:String(s==null?'':s),x:x,y:y},o||{}));
  const line=(x1,y1,x2,y2)=>ops.push({t:'line',x1:x1,y1:y1,x2:x2,y2:y2});
  const right=PDF_W-PDF_M;
  let y=PDF_M;

  ops.push({t:'image',d:MARK_INK,x:PDF_M,y:y,w:50,h:36});
  t(cfg.company||'RSR Engineering Services',PDF_M+62,y+14,{size:13,bold:true});
  t('Naval Architecture · UTG · Drydocking',PDF_M+62,y+28,{size:8});
  t('BILLING',right,y+14,{size:16,bold:true,align:'right'});
  t(issuedNo||'',right,y+30,{size:10,align:'right'});
  y+=54;
  line(PDF_M,y,right,y);
  y+=18;

  const rec=facts.rec||{};
  t('BILL TO',PDF_M,y,{size:8,bold:true});
  y+=13;
  t(facts.client||'',PDF_M,y,{size:10,bold:true});y+=13;
  if(rec.contact_person){t(rec.contact_person,PDF_M,y,{size:9});y+=12;}
  if(rec.address){t(rec.address,PDF_M,y,{size:9});y+=12;}
  if(facts.oneVessel){t('Vessel: '+facts.oneVessel,PDF_M,y,{size:9});y+=12;}
  if(facts.from||facts.to){t('Period: '+(facts.from||'')+' to '+(facts.to||''),PDF_M,y,{size:9});y+=12;}
  y+=8;

  const cQty=right-190,cRate=right-120,cAmt=right;
  line(PDF_M,y,right,y);y+=12;
  t('DESCRIPTION',PDF_M,y,{size:8,bold:true});
  t('QTY',cQty,y,{size:8,bold:true,align:'right'});
  t('RATE',cRate,y,{size:8,bold:true,align:'right'});
  t('AMOUNT',cAmt,y,{size:8,bold:true,align:'right'});
  y+=6;line(PDF_M,y,right,y);y+=14;

  facts.list.forEach(r=>{
    t(r.drawing_title||'',PDF_M,y,{size:9});
    t(r.qty==null?'':r.qty,cQty,y,{size:9,align:'right'});
    t(money(r.rate),cRate,y,{size:9,align:'right'});
    t(money(amountOf(r)),cAmt,y,{size:9,align:'right'});
    y+=12;
    const sub=[facts.oneVessel?'':r.vessel,r.drawing_no].filter(Boolean).join(' · ');
    if(sub){t(sub,PDF_M,y,{size:8});y+=12;}
    y+=2;
  });

  y+=4;line(cQty-30,y,right,y);y+=14;
  t('Subtotal',cRate,y,{size:9,align:'right'});
  t(money(facts.sub),cAmt,y,{size:9,align:'right'});y+=13;
  const adjLabel=facts.vat>0?'Add: VAT 12%':facts.vat<0?'Less: Withholding tax 2%':'';
  if(adjLabel){
    t(adjLabel,cRate,y,{size:9,align:'right'});
    t(money(facts.adj),cAmt,y,{size:9,align:'right'});y+=13;
  }
  t('TOTAL',cRate,y,{size:11,bold:true,align:'right'});
  t(money(facts.grand),cAmt,y,{size:11,bold:true,align:'right'});y+=18;
  t(words(facts.grand),PDF_M,y,{size:9,bold:true});y+=18;
  t('Terms: '+facts.terms+' days · Due on '+facts.due,PDF_M,y,{size:9});y+=20;

  t('PAYMENT DETAILS',PDF_M,y,{size:8,bold:true});y+=13;
  (cfg.banks||[]).forEach(b=>{
    t([b.bank,b.name,b.number].filter(Boolean).join(' · '),PDF_M,y,{size:9});
    y+=12;
  });

  return {filename:pdfFilename(issuedNo),page:{w:PDF_W,h:PDF_H},ops:ops};
}
```

- [ ] **Step 4: Expose to the harness**

In `test/harness.mjs`, add to the `__t` hook beside `stmtFacts`:

```js
  stmtFacts, letterTemplate, letterVars, fillLetter, composeLetter, letterHtml,
  pdfPlan, pdfFilename, words,
```

Add **only** those three. `amountOf` (harness line 43) and `money` (line 46) are already exposed and the test above uses them as-is; adding either again is a duplicate key — legal JS, but it hides which one wins.

- [ ] **Step 5: Run the tests**

Run: `node test/run.mjs`
Expected: PASS — 30 suites.

- [ ] **Step 6: Syntax-check and commit**

```bash
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js
git add index.html test/harness.mjs test/pdfplan.test.mjs
git commit -m "build the billing pdf as a plan of draw ops, from stmtFacts alone"
```

---

### Task 5: `pdfRender` and the Download PDF button

**Files:**
- Modify: `index.html` — jsPDF loader beside the pdf.js loader (`:2380-2390`), `pdfRender`, the sheet foot (`:888-892`)
- Test: manual — `pdfRender` needs jsPDF, which the harness cannot load

**Interfaces:**
- Consumes: `pdfPlan(facts, issuedNo)` from Task 4.
- Produces: `loadJsPdf()` returning a promise for the jsPDF constructor; `pdfRender(plan)` returning a base64 string (no `data:` prefix); `pdfBlob(plan)` returning a Blob for the download button.

- [ ] **Step 1: Get the real SRI hash**

Do not invent it. Fetch the published hash for the pinned version:

```bash
curl -s "https://api.cdnjs.com/libraries/jspdf?fields=version,sri" | head -c 2000
```

Pin the exact version returned and its `sri` value for `jspdf.umd.min.js`. Record both in the loader comment.

- [ ] **Step 2: Write the loader**

Add to `index.html` beside the pdf.js loader:

```js
// Loaded on demand, with an SRI hash, exactly as pdf.js is. Emailing already
// requires connectivity, so a load at send time costs nothing offline.
let jsPdfP=null;
function loadJsPdf(){
  if(window.jspdf&&window.jspdf.jsPDF)return Promise.resolve(window.jspdf.jsPDF);
  if(jsPdfP)return jsPdfP;
  jsPdfP=new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/jspdf/<VERSION>/jspdf.umd.min.js';
    s.integrity='<SRI FROM STEP 1>';
    s.crossOrigin='anonymous';
    s.onload=()=>{
      if(window.jspdf&&window.jspdf.jsPDF)res(window.jspdf.jsPDF);
      else rej(new Error('The PDF library loaded but is not usable'));
    };
    s.onerror=()=>{jsPdfP=null;rej(new Error('Could not load the PDF library'));};
    document.head.appendChild(s);
  });
  return jsPdfP;
}
```

- [ ] **Step 3: Write the renderer**

```js
// Thin on purpose: it makes no layout decisions, it only plays back the plan.
async function pdfDoc(plan){
  const JsPDF=await loadJsPdf();
  const doc=new JsPDF({unit:'pt',format:[plan.page.w,plan.page.h]});
  plan.ops.forEach(o=>{
    if(o.t==='image'){doc.addImage(o.d,'PNG',o.x,o.y,o.w,o.h);return;}
    if(o.t==='line'){doc.setLineWidth(0.6);doc.line(o.x1,o.y1,o.x2,o.y2);return;}
    doc.setFont('helvetica',o.bold?'bold':'normal');
    doc.setFontSize(o.size||9);
    doc.text(o.s,o.x,o.y,o.align?{align:o.align}:undefined);
  });
  return doc;
}
async function pdfRender(plan){
  const doc=await pdfDoc(plan);
  const uri=doc.output('datauristring');
  const i=uri.indexOf(',');
  if(i<0)throw new Error('The PDF could not be encoded');
  return uri.slice(i+1);
}
```

- [ ] **Step 4: Add the button**

In the sheet foot at `index.html:888-892`, between Preview and Email:

```html
    <button class="btn-ghost" id="sPdf">Download PDF</button>
```

Confirm no duplicate id: `grep -c 'id="sPdf"' index.html` must print `1`.

- [ ] **Step 5: Wire it**

```js
$('sPdf').onclick=async()=>{
  const btn=$('sPdf');
  btn.disabled=true;btn.textContent='Building…';
  try{
    const picked=pickedRows();
    if(!picked.length)throw new Error('Nothing is selected to bill');
    const facts=stmtFacts(picked);
    const issued=await issueBillNos();
    const plan=pdfPlan(facts,issued);
    const doc=await pdfDoc(plan);
    doc.save(plan.filename);
  }catch(e){
    // no swallowed catch: the reason is what makes this debuggable
    toast(e.message||'Could not build the PDF',true);
  }finally{btn.disabled=false;btn.textContent='Download PDF';}
};
```

- [ ] **Step 6: Check the touch target**

Run: `node test/run.mjs touch`
Expected: PASS — the new button inherits `.btn-ghost`, which already meets 44px. If it fails, the button needs the same sizing as its neighbours, not a smaller variant.

- [ ] **Step 7: Run the full suite**

Run: `node test/run.mjs`
Expected: PASS.

- [ ] **Step 8: Syntax-check and commit**

```bash
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js
git add index.html
git commit -m "render the billing pdf, and let it be downloaded without sending"
```

---

### Task 6: Attach it to the email, and validate it server-side

**Files:**
- Modify: `index.html` — `lSend` at `:3510-3545`
- Modify: `supabase/functions/send-statement/index.ts`
- Modify: `MANUAL-TEST.md`
- Test: `test/review.test.mjs` or `test/letter.test.mjs` — assert the posted body carries the attachment and no `RSR-` string

**Interfaces:**
- Consumes: `pdfPlan`, `pdfRender` from Tasks 4-5.
- Produces: the `fnPost('send-statement', …)` body gains `attachment:{filename, content}`.

- [ ] **Step 1: Write the failing test**

Append to `test/letter.test.mjs`, using the existing pattern in that suite for driving a send:

```js
console.log('\n--- N. the send carries a pdf attachment and no tracking code ---');
// capture what lSend posts
const posted = [];
const realFnPost = app.fnPost;
// drive the send through the sheet as the other sections in this suite do,
// then assert on the captured body
ok('the body carries an attachment', !!posted[0] && !!posted[0].attachment,
   JSON.stringify(posted[0] || {}));
ok('the filename is the billing number',
   /^BILLDWG-\d\d-\d\d\d\.pdf$/.test(posted[0].attachment.filename),
   posted[0].attachment.filename);
ok('no tracking code anywhere in the posted body',
   JSON.stringify(posted[0]).indexOf('RSR-') === -1);
```

Adapt the capture to however `letter.test.mjs` already intercepts the send; do not invent a new mechanism.

- [ ] **Step 2: Run it and watch it fail**

Run: `node test/run.mjs letter`
Expected: FAIL — no `attachment` on the posted body.

- [ ] **Step 3: Attach it in `lSend`**

In `index.html`, inside `lSend`'s `try`, after `renderStatement(p.list,{email:true});`:

```js
    // A billing that arrives without its attachment, unnoticed, is the exact
    // silent failure this work exists to prevent — so a PDF that will not
    // build aborts the send. Nothing is posted and nothing is marked.
    const attachment={
      filename:pdfFilename(issued),
      content:await pdfRender(pdfPlan(stmtFacts(p.list),issued))
    };
    await fnPost('send-statement',{
      to:p.to,
      client:p.client,
      subject:mailSubject(stmtFacts(p.list),issued),
      html:statementEmailHtml(letter),
      statement_no:issued,
      attachment:attachment
    });
```

The existing `catch` already toasts the reason and keeps the letter for a retry; a throw from `pdfRender` lands there unchanged.

- [ ] **Step 4: Validate it in the function**

In `supabase/functions/send-statement/index.ts`, after the `html` checks:

```ts
  // One attachment, a PDF, small. Everything here fails closed, matching the
  // rest of this function: a malformed attachment refuses the send rather
  // than quietly mailing a billing without its document.
  const att = (body.attachment ?? null) as Record<string, unknown> | null;
  let attachment: { filename: string; content: string } | null = null;
  if (att) {
    const filename = cleanHeader(att.filename, 80);
    const content = typeof att.content === "string" ? att.content : "";
    if (!/^[A-Za-z0-9._-]{1,80}\.pdf$/.test(filename)) {
      return json({ ok: false, error: "The attachment filename is not acceptable" }, 400);
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content) || content.length % 4 !== 0) {
      return json({ ok: false, error: "The attachment is not valid base64" }, 400);
    }
    // 2 MB decoded; a vector billing is tens of kilobytes, so anything near
    // this is a bug rather than a big document
    if (content.length * 3 / 4 > 2_000_000) {
      return json({ ok: false, error: "The attachment is too large to email" }, 413);
    }
    attachment = { filename, content };
  }
```

and in the Resend payload:

```ts
        html,
        reply_to: REPLY_TO,
        ...(attachment ? { attachments: [attachment] } : {}),
```

- [ ] **Step 5: Run the tests**

Run: `node test/run.mjs`
Expected: PASS. `fn.test.mjs` reads the function source — check it still passes, and extend it if it asserts on the Resend payload shape.

- [ ] **Step 6: Add the manual test section**

Append to `MANUAL-TEST.md`:

```markdown
## N. The PDF attachment

The harness has no layout and no painting. It can prove the numbers on the
PDF come from `stmtFacts`; it cannot see the page. This section is the only
check that anyone can read the document.

1. Open a billing with at least two lines, one of them a revision, and one
   no-charge line. Tap **Download PDF**.
2. Put the PDF beside the printed page — Print, same billing — and compare:
   the mark, Bill To (company, contact person, address), vessel, period,
   every line with its drawing number, subtotal, the VAT or withholding
   line, the total, the amount in words, terms and due date, payment details.
3. Confirm the billing number matches the printed copy and that no `RSR-`
   code appears anywhere on the PDF.
4. Print the PDF. The mark must read as solid black on a mono printer.
5. Email the billing to your own address. Open it on a phone: the body keeps
   the letter and the inline billing, and the attachment opens as
   `BILLDWG-26-0NN.pdf`.
6. Break it on purpose once: turn off the network after the letter opens and
   press Send. The send must fail with a visible message, nothing is marked
   billed, and the letter is still there to retry.
```

- [ ] **Step 7: Deploy and commit**

```bash
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js
node test/run.mjs
git add index.html supabase/functions/send-statement/index.ts MANUAL-TEST.md test/letter.test.mjs
git commit -m "attach the billing as a pdf, and refuse the send if it will not build"
```

Then, with the user's approval since it touches live infra:

```
supabase functions deploy send-statement
```

---

### Task 7: The letter must address someone, and say so when it does not

**Files:**
- Modify: `index.html` — `composeLetter` at `:3470-3472`, the Settings save at `:3988`
- Test: `test/letter.test.mjs` (append)

**Interfaces:**
- Consumes: `letterTemplate()`, `letterVars(f,no)`, `fillLetter(tpl,vars)`.
- Produces: `letterWarning(text, vars)` returning a warning string or `''`.

**Background — read this before writing the check.** On 2026-08-23 a letter
composed once with no salutation line: it opened at "Please find our billing"
instead of "Dear Mr. Chua,". It did not reproduce, and every mechanism was
eliminated by inspection — `letterVars.contact` falls back to `'Sir/Madam'`
and so can never be empty; `cfg.letter` was `""`, so `LETTER_DEFAULT` (which
contains `{contact}`) was in use; `cfg.letter` is per-device and appears in
neither `pushSharedSettings` nor `migrateSettings`, so there is no second copy
to have diverged. **The cause is unknown.** This task does not fix it. It makes
the next occurrence announce itself instead of depending on someone noticing.

Do not weaken the check into "the letter starts with Dear". The template is
user-editable and a legitimate custom letter may open differently. The
invariant is that the resolved contact appears somewhere in the output.

- [ ] **Step 1: Write the failing test**

Append to `test/letter.test.mjs`:

```js
console.log('\n--- N. a letter that does not address anyone is reported ---');
const facts = app.stmtFacts([app.groupOf(rows)]);
const vars = app.letterVars(facts, 'BILLDWG-26-001');
ok('contact is never empty', String(vars.contact || '').length > 0, vars.contact);

ok('the default template addresses the contact',
   app.letterWarning(app.fillLetter(app.LETTER_DEFAULT, vars), vars) === '',
   app.letterWarning(app.fillLetter(app.LETTER_DEFAULT, vars), vars));

const noAddressee = 'Please find our billing {billno}.\n\nRespectfully yours,';
const warn = app.letterWarning(app.fillLetter(noAddressee, vars), vars);
ok('a letter missing the addressee warns', warn !== '', warn);
ok('the warning names the contact it expected',
   warn.indexOf(vars.contact) > -1, warn);

console.log('\n--- N+1. a custom template without {contact} warns when saved ---');
ok('a template without {contact} is reported',
   app.letterWarning('Please find our billing {billno}.', vars) !== '');
ok('a template with {contact} is not',
   app.letterWarning('Dear {contact}, please find our billing.', {contact:'{contact}'}) === '');
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node test/run.mjs letter`
Expected: FAIL — `app.letterWarning is not a function`.

- [ ] **Step 3: Implement the check**

Add beside `composeLetter` in `index.html`:

```js
// A billing that does not address anyone is a defect, but on 2026-08-23 one
// composed that way and could not be reproduced. The cause is still unknown,
// so this reports rather than repairs: the resolved contact must appear in
// the finished letter, whatever shape the template takes.
function letterWarning(text,vars){
  const who=String((vars&&vars.contact)||'').trim();
  if(!who)return '';
  return String(text||'').indexOf(who)>-1?'':
    'This letter does not address '+who+' anywhere — check the template.';
}
```

- [ ] **Step 4: Surface it at compose time**

Replace `composeLetter` (`index.html:3470-3472`):

```js
function composeLetter(picked,no){
  const vars=letterVars(stmtFacts(picked),no);
  const out=fillLetter(letterTemplate(),vars);
  const w=letterWarning(out,vars);
  if(w)toast(w,true);
  return out;
}
```

- [ ] **Step 5: Surface it at Settings save**

At `index.html:3988`, after `cfg.letter` is assigned, add:

```js
  // warn while the box is still open and editable, which is the moment it
  // can actually be fixed
  const lw=letterWarning(letterTemplate(),{contact:'{contact}'});
  if(lw)toast('This letter has no {contact} — recipients will not be addressed by name',true);
```

- [ ] **Step 6: Expose to the harness**

In `test/harness.mjs`, add `letterWarning` to the `__t` hook beside `composeLetter`. `letterVars`, `fillLetter`, `LETTER_DEFAULT` and `stmtFacts` are already exposed — do not add them again.

- [ ] **Step 7: Run the tests, syntax-check, commit**

```bash
node test/run.mjs
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/app.js && node --check /tmp/app.js
git add index.html test/harness.mjs test/letter.test.mjs
git commit -m "report a letter that addresses nobody, rather than sending it"
```

---

### Task 8: Make the PDF the printed document

**Files:**
- Modify: `index.html` — `pdfPlan`, `pdfDoc`, and the `$('sPdf')` handler
- Test: `test/pdfplan.test.mjs` (extend)

**Why this task exists.** The final whole-branch review compared `pdfPlan`
against `renderStatement` field by field for the first time and found the PDF
is not the printed document. Two findings were Critical. The seven per-task
reviews all passed because each only checked its own brief, and the brief
itself was a sketch. **Write every step below against the real markup in
`renderStatement` and `payBlock()`, not from memory.**

**Decision already taken by the repo owner — do not revisit.** jsPDF's standard
Helvetica cannot render the peso sign U+20B1: it is outside cp1252 and the
glyph reaches the content stream as a stray byte with a NUL before every digit.
Amounts on the PDF are therefore printed **bare**, the amount column is headed
**Amount (PHP)**, and a line reading **All amounts in Philippine Pesos (PHP)**
sits above the amount in words. Do not embed a font. Do not reintroduce the
sign anywhere in the PDF path.

Note `renderStatement` already strips the sign from the line-item rate and
amount cells; only the three totals keep it. So the PDF diverges from print in
exactly three places, and the PHP label is what carries the currency.

- [ ] **Step 1: A money helper for the PDF**

Add beside `pdfPlan`:

```js
// jsPDF's standard fonts are cp1252; the peso sign is not in it and would be
// written as a stray byte with a NUL before every digit. The column header and
// the note above the total carry the currency instead.
const pdfMoney=n=>money(n).replace('₱','');
```

Every amount drawn by `pdfPlan` goes through this. No exceptions.

- [ ] **Step 2: Write the failing tests for the document's content**

Extend `test/pdfplan.test.mjs`, asserting against the values `renderStatement`
uses so the two cannot drift again. Assert: no peso sign anywhere in the plan;
the amount column reads `Amount (PHP)`; the PHP note is present; the billing
carries `fmtDate(today())`; period and due dates are formatted, not raw ISO;
lines are numbered `1.0`, `2.0`; the subtotal label counts items as print does;
the total reads `Total amount due`; the amount in words is labelled; and the
closing line `Thank you for your business.` is present.

- [ ] **Step 3: Reproduce the header, Bill To, vessel and meta blocks**

Match `renderStatement` exactly, in its order:

- header left: the mark image, then `cfg.company||'RSR ENGINEERING SERVICES'`
  (note the casing — the current fallback is Title Case and is wrong), then
  `cfg.address` split on newlines, then `cfg.contact`, then
  `'contact no.: '+cfg.contactNo`. **Delete the invented
  `Naval Architecture · UTG · Drydocking` tagline — it exists nowhere else in
  the app.**
- header right: `Billing`, the issued number, `fmtDate(today())`.
- Bill To: the label `Bill to`, then `rec.contact_person`, **then** the client
  name, then `rec.address` split on newlines. Contact person comes first, as in
  print.
- vessel: only when `facts.oneVessel`, labelled `Vessel name`.
- meta: `Period covered` with `fmtDate(facts.from)` em-dash `fmtDate(facts.to)`,
  `Terms` with `facts.terms+' days'`, `Due on` with `fmtDate(facts.due)`.

- [ ] **Step 4: Reproduce the table, including no-charge lines**

Columns `No.`, `Description`, `Qty`, `Rate`, `Amount (PHP)`. The line number is
`(i+1)+'.0'`. The description carries the same sub-line print uses: the drawing
number, preceded by the vessel when the billing covers more than one vessel.

**A no-charge line prints `No Charge` in BOTH the rate and amount cells**, as
`renderStatement` does. The current code prints the real rate beside a zero
amount, so the client reads `2 x 1,500.00 = 0.00`. Use the existing
`noCharge(r)`.

- [ ] **Step 5: Paginate**

`pdfPlan` emits no page break and `pdfDoc` never calls `addPage`, so past
roughly twenty lines the totals, the amount in words and the payment details
fall off the sheet silently. Measured: twenty-five lines reach 967pt on an
842pt page.

Give every op a page index `p`, starting at 0. While laying out, when the next
row would pass the bottom margin, increment the page, reset `y` to the top
margin, and **redraw the table header** on the new page. Keep the totals block,
the amount in words and the payment details together — if they do not fit in
the remaining space, break first rather than splitting them.

After the ops are built, append a footer to each page carrying the billing
number and `Page N of M`, now that M is known.

`pdfDoc` calls `doc.addPage()` whenever `op.p` exceeds the page it is on. It
still makes no layout decisions.

- [ ] **Step 6: Write the failing pagination test**

Build a forty-line billing and assert: it needs more than one page; no op is
drawn past the bottom margin; the total, the amount in words and the payment
details all survive to the last page; every page carries a `Page N of M`
footer; and the table header repeats once per page.

- [ ] **Step 7: Reproduce the payment block**

Mirror `payBlock()`: the label `Payment details`; `Please issue payment to `
plus `cfg.payee` when set; the bank rows; and `Kindly email a copy of the
deposit slip to ` plus `cfg.remitEmail` plus ` for confirmation of payment.`
when set. Omit the whole block when payee, banks and remit email are all empty,
exactly as `payBlock()` does.

Then the closing block: `Thank you for your business.`, and `Prepared by: `
plus `cfg.signer` (with `, ` plus `cfg.role` when set) **only when**
`cfg.showPrepared && cfg.signer`.

- [ ] **Step 8: Stop Download PDF burning billing numbers**

`$('sPdf')` skips `confirmMultiGroup(list)` — which Print calls for exactly this
reason — while still calling `issueBillNos()`, so it claims and persists a
number for every picked group. If the build then throws (offline, CDN down),
the number is already spent.

Reorder: confirm first, then **load jsPDF**, then claim, then build and save.
Loading first means the likeliest failure cannot cost a number.

- [ ] **Step 9: Run everything, syntax-check, commit**

Run the full suite, `node --check` the extracted script, then commit.

---

### Task 9: Close the final review's minor findings

**Files:**
- Modify: `test/queue.test.mjs`, `test/letter.test.mjs`,
  `supabase/functions/send-statement/index.ts`

- [ ] **Step 1: Finish the section renumbering**

`ca08292` renumbered sections 8 and 9 and missed two: `test/queue.test.mjs`
still prints a `N+2` section label, and a nearby comment still refers to a
section by placeholder letter. Check the surrounding numbering before choosing
replacements; do not assume.

- [ ] **Step 2: Rename two assertions that overstate what they cover**

In `test/letter.test.mjs`, `the content is base64` proves the fake jsPDF's own
output round-trips; what it genuinely exercises is `pdfRender` stripping the
data-URI prefix. Rename it to say that. Likewise `no tracking code anywhere in
the posted body` cannot see inside the attachment, because base64 is opaque —
rename it to name the fields it actually scans. The real coverage lives in
`pdfplan.test.mjs`. Do not delete either assertion; stop them claiming more
than they do.

- [ ] **Step 3: Make the attachment required, failing closed**

`supabase/functions/send-statement/index.ts` treats `attachment` as optional.
There is deliberately no service worker, but a stale cached `index.html` could
still post without one and mail a billing with no document — the exact failure
this branch exists to prevent. Refuse the send when it is absent, matching every
other check in that file, and add an `fn` assertion for it. Update the existing
"a send with no attachment still works" assertion to expect refusal.

- [ ] **Step 4: Run everything, syntax-check, commit**

Run the full suite, `node --check` the extracted script, then commit.

## Parked

**A letter composed once without its salutation line (2026-08-23).** Not
reproduced; cause unknown. Every mechanism was eliminated by inspection — see
the background note in Task 7. Task 7 adds detection, not a fix. If it recurs,
the captured evidence to collect is the stored `cfg.letter`, the first line of
`lBody`, and the local Seaford client row, together.

---

## Self-Review

**Spec coverage:**

| spec requirement | task |
|---|---|
| vector PDF from `stmtFacts`, browser-side | 4, 5 |
| pure plan / thin renderer split | 4, 5 |
| jsPDF via cdnjs with a verified SRI hash | 5 step 1 |
| A4 595x842 | 4 |
| document contents incl. amount in words, payment details | 4 |
| filename is `bill_no`, never `RSR-` | 4, and asserted in 4 and 6 |
| attachment transport and function validation | 6 |
| Download PDF button | 5 |
| failed build aborts the send | 6 step 3 |
| no swallowed catch | Global Constraints; 1, 2, 3, 5, 6 |
| `sb()` carries status; `flushQueue` classifies | 1 |
| badge distinguishes failed from queued | 1 step 6 |
| Pending writes panel, Retry and Discard | 2 |
| Discard confirms and names what is lost | 2 step 4 |
| clients 409 heals fill-only | 3 |
| healed row replaces the local `loc-` row | 3 step 3 |
| harness scripted failures | 1 step 1 |
| `pdfplan`, `clients` suites; `queue` extended | 1, 3, 4 |
| MANUAL-TEST section | 6 step 6 |
| no schema change | Global Constraints |
| letter addresses someone, or reports it | 7 (added after the plan was written, from a parked bug — not a spec requirement) |

**Placeholders:** two deliberate ones, both flagged as work the implementer must do rather than guess — the jsPDF version and SRI hash (Task 5 Step 1, with the command to obtain them) and the send-capture mechanism in `letter.test.mjs` (Task 6 Step 1, which must follow that suite's existing pattern rather than invent one).

**Type consistency:** `pdfPlan(facts, issuedNo)` returns `{filename, page:{w,h}, ops}` in Task 4 and is consumed with those exact names in Tasks 5 and 6. `pdfFilename` is defined in Task 4 and used in Task 6. `deadJobs()`, `jobLabel(job)`, `job.dead`, `job.err` are defined in Task 1 and used in Task 2. `healClientDup(job)` returns a boolean in Task 3 and is called for its boolean in Task 1's catch.
