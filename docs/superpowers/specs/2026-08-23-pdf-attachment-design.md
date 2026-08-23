# PDF attachment for emailed billings, and two queue defects

**Date:** 2026-08-23
**Status:** approved, ready for implementation plan

## Why

A billing currently arrives as HTML in the email body. Clients need a document
they can file, forward and print — a PDF attachment — while the body keeps the
covering letter and the inline billing exactly as they are today.

Two defects found while getting the email path working are fixed in the same
piece of work, because both are the same failure mode the PDF work must not
repeat: an error that is caught and discarded, leaving the app stuck with
nothing to read.

## Scope

In scope:

1. A PDF attachment on the emailed billing, matching the print layout.
2. An in-app **Download PDF** button using the same generator.
3. `flushQueue` surfacing failures instead of retrying them forever in silence.
4. A `clients` insert conflict healing into an update instead of jamming.

Not in scope: any schema change (`sqlText()` is untouched), the print path,
the two-step email handoff, tracking-code rules, the sandbox sender.

---

## 1. PDF generation

### Approach

Vector PDF generated **in the browser**, drawn from `stmtFacts()`, posted to the
Edge Function as base64. Chosen over three alternatives:

| option | rejected because |
|---|---|
| raster the print DOM (html2canvas) | 300 KB-1.5 MB, no selectable text, soft on paper; html2canvas re-implements CSS, which is this project's documented blind spot |
| draw in the Edge Function (pdf-lib) | lands in the one file the test harness cannot reach; a redeploy per layout tweak; no preview without sending |
| third-party HTML to PDF API | new vendor, new secret, per-document cost, client data egress, second remote failure mode in the send path |

Supabase Edge Functions are Deno isolates, so there is no Chromium and no
Puppeteer. Rendering the existing print CSS server-side is not available.

### Shape

```
pdfPlan(facts, issuedNo)  ->  { filename, page:{w,h}, ops:[...] }   pure
pdfRender(plan)           ->  base64                               thin driver
```

`pdfPlan` reads the object `stmtFacts()` returns and nothing else. It must not
touch the DOM, must not read `$('sVat')` or any input, and must not recompute a
total that `facts` already carries. `pdfRender` walks `ops` calling jsPDF and
makes no decisions.

The split exists for testability: **jsPDF cannot load in the harness** — no
network, no CDN. As a plain list of ops the entire layout is assertable data.

### Library

jsPDF from cdnjs, lazy-loaded on first use with an SRI hash, following the
existing pdf.js pattern at `index.html:2380-2390`. Version and hash are taken
from cdnjs and verified at implementation time, never invented. Loading on
demand costs nothing offline, because emailing already requires connectivity.

### Document contents — A4, 595x842pt

Header: `MARK_INK` via `addImage`, plus the company block. Then **BILLING** with
the billing number; Bill To (client name, `contact_person`, address); vessel and
period; the line table (no., description with drawing no., qty, rate, amount);
subtotal, the VAT/withholding line using the same label logic as the sheet, and
the grand total; the amount in words via the existing `words()`
(`index.html:1021`); terms and due date; payment details from `cfg.banks`.

Filename is the **billing number** — `BILLDWG-26-001.pdf`. The `RSR-` tracking
code is internal and never appears on a client-facing file, in the document or
in its name.

Open question for implementation, not a design decision: whether `MARK_INK`'s
transparent PNG needs a white matte to render correctly through jsPDF.

### Transport and function changes

`lSend` adds `attachment:{filename, content}` to the existing `fnPost` body;
`content` is base64 with no `data:` prefix.

`send-statement` validates before calling Resend, failing closed as every other
check in that file does:

- filename matches `/^[A-Za-z0-9._-]{1,80}\.pdf$/`
- content is valid base64
- decoded size is 2 MB or less

then passes `attachments:[{filename, content}]` to Resend.

### Download PDF button

On the billing sheet beside Print and Email. Same `pdfPlan` then `pdfRender`,
saved locally rather than posted. It is the only way to inspect output without
sending, and doubles as the manual-send route for clients who are not emailed.

### Failure policy

A PDF that will not build **aborts the send**. Nothing is posted, nothing is
marked billed, the letter is kept for a retry — identical to how a failed send
already behaves. A formal billing arriving without its attachment, unnoticed, is
the exact failure this work exists to prevent.

Every new `try`/`catch` either rethrows or surfaces the real reason. There is no
`catch(e){}` anywhere in the new code.

---

## 2. Defect: `flushQueue` discards every error

`index.html:1377` is `catch(err){still.push(job);}`. A permanently-failing job
retries forever and reports nothing. `sb()` compounds it by throwing away the
status code: `throw new Error(t||('HTTP '+res.status))`.

### Fix

`sb()` attaches `err.status` and PostgREST's `err.code` to the thrown Error.

`flushQueue` classifies rather than blindly re-queueing:

- **transient** — network failure, 5xx, 429: stay queued, silent, as today
- **permanent** — 4xx such as 409, 400, 404, 422: the job is marked `dead` with
  the server's own message and skipped by future flushes
- 401 and 403 keep using `sb`'s existing refresh-then-gate path

The sync badge distinguishes `1 queued` from `1 failed`. A toast fires once, at
the moment a job first turns dead, carrying the server's text.

### Pending writes panel

Settings gains a small panel listing each dead job: op, table, and the reason as
the server phrased it, with **Retry** and **Discard**.

**Discard confirms before destroying anything, and names what would be lost** —
the op, the record it targets, and the fields the payload carries with their
values. For example: discarding the stuck Seaford insert must say that the
contact person, address and billing email typed on this device will be lost, and
that a server copy, if one exists, is unaffected. The queue is the only copy of
a write the server has not taken; today's incident ended safely only because the
server row was checked first, and the confirm is what makes that check the
default rather than a habit.

---

## 3. Defect: a `clients` insert has no conflict handling

`clients.name` is `text unique not null` (`index.html:3776`). When the local
cache does not know a client the app mints a local row and POSTs it; if the
server already holds that name the insert 409s and can never succeed.

### Fix — heal into an update, fill-only

On a 409 from a `clients` insert:

1. `GET clients?name=eq.<name>&select=*`
2. build a **fill-only** patch: include a local field only where the server's
   value is null or empty and the local value is not
3. PATCH if that patch is non-empty
4. replace the local `loc-` row with the server row, adopting its id
5. drop the job and toast what merged

Fill-only can never overwrite a non-empty server value. Applied to the 2026-08-23
incident it would have kept the corrected `billing_email` and contributed only
`contact_person` and `address` — the same semantics as the `coalesce` SQL used to
resolve it by hand. A merge-duplicates upsert is explicitly rejected: it would
have let the stale local copy clobber the corrected server row.

If the heal itself fails, the job goes dead with the reason. It does not
silently vanish.

Note that `pull()` keeps every `loc-` row forever
(`index.html:1399-1400`), so a healed row must be removed from the local array,
not merely dropped from the queue, or it reappears as a duplicate client after
the next sync.

---

## 4. Tests

- **`pdfplan.test.mjs`** (new) — every money value in the plan equals its
  `facts` counterpart; the billing number equals the issued one; the filename is
  `bill_no + '.pdf'`; the amount in words equals `words(facts.grand)`; the page
  is 595x842; and **no string beginning `RSR-` appears anywhere in the plan or
  the filename**. The single-source proof is a mutation test: change
  `facts.vat`, assert the plan's totals move with it. A plan reading the DOM
  would not.
- **`queue.test.mjs`** (extended) — 409 marks the job dead and surfaces the
  reason; 500 leaves it queued; a network failure leaves it queued.
- **`clients.test.mjs`** (new) — the fill-only heal: the server keeps its email,
  the local row contributes only what the server lacks, the `loc-` row is
  replaced by the server row, the queue empties.
- **Harness** — the `fetch` stub needs scripted per-path status responses; today
  it offers only `offline | online | unauthorized`. Additive change; the `__t`
  hook stays version-coupled with `index.html`.

### Manual test

The harness has no layout and no painting, so it cannot see any of the output.
`MANUAL-TEST.md` gains a section, which the user walks personally when this
lands:

1. **Download PDF** and compare it against the printed page side by side —
   mark, Bill To, vessel and period, line items, totals, amount in words,
   payment details.
2. Print the PDF and confirm the black mark reads on a mono printer.
3. A real send to the user's own address, with the attachment opened on a
   phone.

---

## Unchanged

`sqlText()` and the schema, CORS, the two-step email handoff and `pendingSend`,
the print path, `sNoMode`, the tracking-code rules, the sandbox sender and the
`SENDER IDENTITY` block.
