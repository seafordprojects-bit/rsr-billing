import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'index.html');
const FN_SRC = path.join(ROOT, 'supabase', 'functions', 'send-statement', 'index.ts');
// Runs the real inline script from index.html against a stubbed DOM so the
// offline queue can be exercised end to end.
import fs from 'node:fs';

const html = fs.readFileSync(SRC, 'utf8');
const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
if (!m) { console.error('no inline script found'); process.exit(1); }
let js = m[1];

// expose the closure internals for assertions (test copy only, not the source)
const hook = `
globalThis.__t={
  get queue(){return queue}, get rows(){return rows}, get cfg(){return cfg},
  get session(){return session},
  saveRow, saveBatch, flushQueue, deleteRow, persist, online, authed, setSession, pull, uploadPdf,
  deadJobs, jobLabel, syncBadge,
  get catalog(){return catalog}, catSave, catDelete, catReorder, catSorted, catActive,
  effRate, openCat, renderCat, catShown, renderCatMgr, get kPicked(){return kPicked}, nextCode,
  codePrefix, typeOf, typeList, typeLabel, renderTypes, render, visible,
  get filters(){return filters}, set filters(v){filters=v}, openStmt, buildPick, stmtCandidates, saveCfg,
  objectPath, signedUrl, openPdf, fnPost, statementEmailHtml, renderStatement, pickedRows,
  get clients(){return clients}, billingEmail, setBillingEmail, offerMarkBilled,
  setTab, setMakeType, renderMake, get tab(){return tab}, get makeType(){return makeType},
  refLabel, builtIn, TAB_TYPES, BUILT_IN, openEntry, openImport,
  nextBillNo, commitBillNo, payBlock, cliSave, cliDelete, cliSorted, clientRec,
  renderCliMgr, renderBanks, openCfg, renderDeadJobs, lossSummary,
  get mlines(){return mlines}, set mlines(v){mlines=v}, renderML, promoteToCatalog,
  get multiMode(){return multiMode}, mlBlank, mlRate,
  billPrefixOf, billTypeFor, refreshBillNo, billSampleFor, renderTypes,
  cmbFilter, cmbShow, cmbHide, cmbMove, cmbTake, get cmbOpen(){return cmbOpen},
  titleSuggest, clientSuggest, mlApply, mlTotals, rememberClient,
  maybeSeedCatalog, MARINA_DW,
  get settings(){return settings}, applySettings, queueSetting, pushSharedSettings,
  migrateSettings, claimBillNo, raiseBillNo, normaliseTypes,
  allGroups, groupById, groupsFrom, groupOf, groupIdOf, migrateGroups, markGroup,
  get expanded(){return expanded}, set expanded(v){expanded=v},
  get multiLocked(){return multiLocked}, get editingId(){return editingId},
  issueBillNos, setGroupBillNo, billSeqOf, setBillSeq,
  noCharge, baseTitle, revNoOf, priorBillings, nextRevNo, amountOf, confirmMultiGroup, repaint, canonClient, maxIssuedNo, cmbHide, get sNoMode(){return sNoMode},
  stmtFacts, letterTemplate, letterVars, fillLetter, composeLetter, letterHtml,
  mailSubject, markBilledNow, termsDefault, canonVessel, LETTER_DEFAULT, LETTER_KEYS,
  fmtDate, today, money,
  get pendingSend(){return pendingSend}
};
`;
const lastIdx = js.lastIndexOf('})();');
js = js.slice(0, lastIdx) + hook + js.slice(lastIdx);

/* ---------------- DOM stub ---------------- */
class El {
  // a real <input>.value is a DOMString, so `el.value = 7` reads back as '7'.
  // Without this the app can assign a number and a suite comparing to '7'
  // fails on a value that is correct in the browser.
  get value(){ return this._value; }
  set value(v){ this._value = v==null ? '' : String(v); }
  constructor(id){ this.id=id; this._cls=new Set(); this.value=''; this.textContent='';
    this._html=''; this.checked=false; this.disabled=false; this.hidden=false;
    this.style={}; this.dataset={};
    this.children=[]; this._on={}; this._parent=null; this._rect=null; this._attr={};
    this.classList={ add:c=>this._cls.add(c), remove:c=>this._cls.delete(c),
                     contains:c=>this._cls.has(c),
                     toggle:(c,on)=>{ const want = on===undefined ? !this._cls.has(c) : !!on;
                                      if(want) this._cls.add(c); else this._cls.delete(c);
                                      return want; } };
  }
  // a real <select> adopts the value of whichever <option> carries `selected`
  get innerHTML(){ return this._html; }
  set innerHTML(v){
    this._html = String(v ?? '');
    const m = this._html.match(/<option value="([^"]*)"[^>]*\sselected/);
    if (m) this.value = m[1];
    else if (/<option/.test(this._html) && !/\sselected/.test(this._html)) {
      const first = this._html.match(/<option value="([^"]*)"/);
      this.value = first ? first[1] : '';
    }
    this.options = [...this._html.matchAll(/<option value="([^"]*)"/g)].map(o => ({ value:o[1] }));
    // rebuild child inputs from the markup, so focus/caret behaviour across a
    // repaint can actually be exercised
    const tags = [...this._html.matchAll(/<(input|select|button)([^>]*)>/g)];
    const kids = [];
    for (const t of tags) {
      const attrs = t[2];
      const kid = new El("");
      kid._parent = this;
      for (const d of attrs.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
        kid.dataset[d[1].replace(/-(.)/g, (_, x) => x.toUpperCase())] = d[2];
      }
      const v = attrs.match(/value="([^"]*)"/);
      kid.value = v ? v[1] : "";
      kid.checked = /\schecked/.test(attrs);
      kid.disabled = /\sdisabled/.test(attrs);
      kid.selectionStart = kid.value.length;
      kids.push(kid);
    }
    this.children = kids;
  }
  get className(){ return [...this._cls].join(' '); }
  set className(v){ this._cls=new Set(String(v).split(/\s+/).filter(Boolean)); }
  addEventListener(type, fn){ (this._on[type] ||= []).push(fn); }
  removeEventListener(){}
  focus(){ globalThis.document.activeElement = this; }
  blur(){ if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; }
  click(){} select(){}
  setSelectionRange(a){ this.selectionStart = a; }
  contains(n){ while (n) { if (n === this) return true; n = n._parent; } return false; }
  // dispatch to delegated listeners, the way a real click would
  fire(type, ev){ (this._on[type] || []).forEach(fn => fn(ev)); }
  // children registered via addChild participate in querySelectorAll/closest
  addChild(el){ el._parent = this; this.children.push(el); return el; }
  querySelectorAll(sel){
    // innerHTML-rendered checkbox lists: parse them back out so code that
    // reads `input:checked` (the statement picker) is actually exercised
    if (sel === 'input' || sel === 'input:checked') {
      const onlyChecked = sel.endsWith(':checked');
      return [...this._html.matchAll(/<input\b([^>]*)>/g)]
        .map(m => m[1])
        .filter(a => !onlyChecked || /\schecked\b/.test(a))
        .map(a => {
          const v = a.match(/value="([^"]*)"/);
          const box = { value: v ? v[1] : '', checked: /\schecked\b/.test(a) };
          box.onchange = null;
          return box;
        });
    }
    const clauses = [...sel.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)];
    if (!clauses.length) return [];
    const key = a => a.replace(/^data-/,'').replace(/-(.)/g, (_,x)=>x.toUpperCase());
    return this.children.filter(c => clauses.every(cl => {
      const v = c.dataset[key(cl[1])];
      return cl[2] === undefined ? v !== undefined : String(v) === cl[2];
    }));
  }
  querySelector(sel){ return this.querySelectorAll(sel)[0] || null; }
  closest(sel){
    const attr = (sel.match(/^\[([a-z-]+)\]$/) || [])[1];
    if (!attr) return null;
    const key = attr.replace(/^data-/,'').replace(/-(.)/g, (_,x)=>x.toUpperCase());
    let n = this;
    while (n) { if (n.dataset && n.dataset[key] !== undefined) return n; n = n._parent; }
    return null;
  }
  getBoundingClientRect(){ return this._rect || { left:0, right:0, top:0, bottom:0 }; }
  setAttribute(k,v){ this._attr[k]=String(v); }
  getAttribute(k){ return k in this._attr ? this._attr[k] : null; }
  removeAttribute(k){ delete this._attr[k]; }
  appendChild(){} remove(){}
}
const els = new Map();
const el = id => { if(!els.has(id)) els.set(id, new El(id)); return els.get(id); };

globalThis.document = {
  activeElement: null,
  getElementById: el,
  createElement: () => new El('created'),
  querySelectorAll: () => [],
  addEventListener(){},
  head: { appendChild(){} },
  body: { style:{} },
};
globalThis.window = {
  addEventListener(){}, print(){},
  get pdfjsLib(){ return undefined; },
};
globalThis.location = { href:'https://example.test/index.html' };
globalThis.confirm = () => true;
globalThis.alert = () => {};

const store = new Map();
globalThis.localStorage = {
  getItem: k => store.has(k) ? store.get(k) : null,
  setItem: (k,v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

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

// The MARINA seed fires on any boot with an empty drawing catalog, which
// would perturb every suite that starts from empty storage. Suppressed by
// default; seed.test.mjs opts in with globalThis.__seedOK = true.
globalThis.__loadApp = () => {
  // A reload re-registers every listener on the same cached elements. Left
  // to accumulate, an older closure fires first and overwrites what the
  // current one is about to read.
  for (const node of els.values()) node._on = {};
  globalThis.document.activeElement = null;
  if (globalThis.__seedOK !== true) {
    let c = {};
    try { c = JSON.parse(globalThis.localStorage.getItem('rsr_dwg_cfg_v1') || '{}'); } catch {}
    if (!c.seededDW) {
      c.seededDW = true;
      globalThis.localStorage.setItem('rsr_dwg_cfg_v1', JSON.stringify(c));
    }
  }
  (0,eval)(js);
  return globalThis.__t;
};
