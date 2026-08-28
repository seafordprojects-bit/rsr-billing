# RSR Billing — manual test checklist

Everything here is something the automated suites **cannot** verify: real
layout, real printing, real focus, real touch. Ordered by risk — if you only
have twenty minutes, do section 1. If you are setting the app up on a phone
for the first time, start at section 0.

The suites cover logic, data and wiring — `node test/run.mjs`, 30 suites, 1336
assertions. They do **not** render, paginate, or lay anything out. Every bug you
hit that the tests missed was in this category.

---

## 0. First run on the phone — once, after deploying

The live app: **https://seafordprojects-bit.github.io/rsr-billing/**

Do this on the handset you will actually bill from, not a desktop emulator.
Everything below is per-device: the project URL, the anon key and the session
live in that phone's `localStorage` and are not carried over from the laptop.

- [ ] **Before anything else — signup is disabled.** Supabase → Authentication
      → Providers → Email, turn **off** "Allow new users to sign up". RLS is
      `to authenticated using (true)` on all five tables, so anyone who can
      create an account can read and rewrite every billing record — and the
      app is now on a public URL. Confirm it by trying to sign up with a
      throwaway address and being refused.
- [ ] **The page loads over HTTPS** at the URL above and shows the sign-in
      gate with the red RSR mark. If it 404s, Pages has not finished building.
- [ ] **Connection settings.** Tap **Connection settings** on the gate and
      enter the Supabase project URL and the **anon** key (never the service
      role key — it bypasses RLS entirely). Save.
- [ ] **Sign in** with your Supabase user. The gate closes and Monitoring
      loads. If it refuses, check you are in `billing_senders` only for
      *emailing* — signing in does not need it.
- [ ] **Install it.** Chrome ⋮ menu → the entry must read **"Install app"**.
      If it says "Add to Home screen" you are getting a bookmark, not an app:
      the manifest is not being accepted, so check it loads at
      `…/rsr-billing/manifest.webmanifest` and comes back as
      `application/manifest+json`.
- [ ] **The home-screen icon is a full red tile** with the white RSR mark
      filling it — not a small logo floating in a white circle, which means
      the maskable icon was not picked up.
- [ ] **It opens as an app**: no address bar, dark splash, and "RSR Billing"
      in the task switcher.
- [ ] **Now close the browser tab and work only from the installed app** for
      the rest of this. The installed PWA and the tab share `localStorage` on
      the same origin, so you should already be signed in — confirm that
      rather than assuming it.
- [ ] **Walk the combobox checks** from section 2 inside the installed app:
      all three client entry points, popup fully visible and unclipped, and
      the near-the-bottom-of-the-screen case. The installed app has no
      browser chrome, so the viewport is taller than the tab — this is a
      different layout from the one you checked in the browser.
- [ ] **Walk the covering-letter checks** from section 8 from the installed
      app: the review sheet opens with the letter filled in, editing it
      affects that send only, Back claims no billing number, and a
      successful send marks the billing BILLED. Send one real billing to
      yourself and read it in a phone mail client.
- [ ] **Then print one** from the installed app — Share → Print — and confirm
      it matches section 1. Mobile print is a different renderer, and the
      installed app is a different surface again.

---

## 1. Print — highest risk, least covered

Print to PDF first, then to paper. Chrome desktop, margins **Default**.

- [ ] **Margins hold.** With the Margins dropdown on **Default** the content
      sits inside a 12mm margin on all four sides — measure it, or check the
      PDF at 100%. The sides come out ~4mm wider (16mm) because the `.stmt`
      inset adds to the page margin; that is expected. Then switch to **None**:
      the page margin is gone and only the 4mm side inset remains, which should
      still keep the text off the paper edge. **Chrome remembers this dropdown
      between prints** — if the sides look narrow, check it is back on Default
      before suspecting the CSS.
- [ ] **Nothing spills into the margin.** Overflow is painted into the @page
      margin instead of being clipped, so a too-wide element eats the inch.
      Print a billing with a ~60-character client name, a ~40-character vessel
      and a contact no. typed as one unbroken token: each must wrap inside its
      box, and the side margins must measure the same as on a short billing.
- [ ] **Both papers.** Try A4 and Letter. Nothing should be scaled or clipped;
      `@page` declares no paper size on purpose.
- [ ] **The mark prints as black ink**, not a red box, and survives with
      "Background graphics" switched **off** — it is an `<img>`, not a
      background. Print one page in greyscale to confirm it reads.
- [ ] **Line numbers read `1.0`, `2.0`** on one line each — not `1.` with a
      stray `0` beneath. This regressed once already.
- [ ] **Backgrounds print.** The table header is dark with white text and the
      RSR mark is red. If they come out white, "Background graphics" is off in
      the print dialog.
- [ ] **No tracking codes anywhere.** The client's copy shows the `BILLDWG`
      number only — no `RSR-DW-…` on any line or in the meta strip.
- [ ] **Header block.** Company name, address, the contact line, then
      `contact no.: …` beneath it. Clear the Contact no. field in Settings and
      reprint — the line disappears rather than leaving a gap.
- [ ] **Vessel once, in its own box.** A normal billing shows a full-width
      `VESSEL NAME` box between Bill to and the meta row, and **no** vessel
      under any line item — only the drawing no. Then import a PDF batch with
      two different vessels: that billing drops the box and puts the vessel
      back on each line. Check both shapes on paper. Casing and spacing do not
      count as a difference — `MV SF Voyager` and `MV SF VOYAGER` stay one
      vessel, printed the way the first line spells it.
- [ ] **Bill to holds only the client.** Contact person (when set) above the
      company name, then the address — no vessel. With no contact person the
      company name sits alone with no empty line above it.
- [ ] **Meta strip.** Period covered / Terms / Due on sit in **one** box with
      a single outer border and exactly **two** inner vertical dividers — no
      gaps between cells. Count the verticals: four total across the strip.
      Any fifth is the old artifact — look for a short rule hanging off the
      right of a label, and for a doubled (thicker) line on a divider. Period
      covered's date range must sit on **one** line; it is the cell that runs
      closest to its width.
- [ ] **Long values.** Bill a drawing with a ~90-character title, a client name
      of ~60 characters, a vessel of ~40, and a rate of 1,000,000. Nothing
      overflows the page or truncates mid-number.
- [ ] **Page breaks.** Build a billing with ~30 lines. The table header repeats
      on page 2, no row is split across pages, and the totals / amount-in-words
      / payment block / thank-you are never orphaned from the table.
- [ ] **No-charge lines** show `No Charge` in both rate and amount, keep their
      number in the sequence, and add nothing to the total.
- [ ] **Settings → "Leave no-charge lines off the billing"** removes them and
      renumbers 1.0, 2.0 with no gap.
- [ ] **Terms and Due on.** A new billing opens at **7 days** and prints
      `7 days` with **Due on** seven days out. Type over it on one billing —
      the printed Terms and Due on follow — then open a fresh billing and
      confirm it is back to 7. Settings -> Billing defaults -> Payment terms
      changes what new billings open on; **0** is a real setting (due on
      issue) and must stay 0, while clearing the box returns it to 7.
- [ ] **Preview** prints with "Preview — not yet issued" and does **not**
      consume a number: check Settings afterwards, the counter has not moved.
- [ ] **No signature block.** No "Prepared by" line unless the Settings toggle
      is on; never a signature space or "Received / conforme".

## 2. Mobile — deploying to a phone

Chrome on the phone, or DevTools at **380 × 780**.

- [ ] **Segmented tabs.** Monitoring / Create Billing, then UTG / Drawing /
      Drydocking Cert. Every tap registers first time, including on the gaps
      between buttons and at the far edges.
- [ ] **Touch targets.** Everything interactive is now declared at 44px or more.
      Judge them in the hand: the expand control on a billing card, the status
      filter chips, the header sync/settings icons, the ↑↓/× buttons in
      Settings, Mark billed / Edit on a card, and the typeahead suggestion rows.
- [ ] **Density.** The header, chip row, card actions and Settings rows are all
      taller than before. Check nothing wraps awkwardly or pushes the fold — in
      particular a Settings catalog row, which carries three 44px buttons plus a
      label on one line.
- [ ] **Typeahead popups.** Type in a line title. The list appears below the
      field, is reachable by scrolling, and is not clipped by the sheet edge.
      Tapping a suggestion picks it — it does not just dismiss.
- [ ] **Client typeahead, all three entry points.** Focus the Client field in
      Add manually, in the PDF import sheet, and in the From catalog sheet.
      Each drops a list directly under **its own field** — not full-sheet
      width, not at the bottom of the screen, not missing. Type "sea" and it
      filters. This broke once because the popup is `position:absolute` and
      its wrapper was not positioned, so it painted below the sheet: the list
      was built correctly and simply could not be seen. Automated tests
      cannot catch that; only this check can.
- [ ] **On the phone, at ~390px — not just desktop Chrome.** Desktop lays the
      sheet out as a centred dialog; the phone lays it out as a bottom sheet,
      and that is the layout that actually ships. On a real handset (or
      DevTools at 390px) open all three client entry points — Add manually,
      the PDF import sheet, the From catalog sheet — and for each confirm the
      list is **fully visible**: not clipped at either side, not cut off by
      the sheet edge, and not painted behind the footer buttons or anything
      else. Then scroll so the Client input sits **near the bottom of the
      screen** and focus it: the popup opens downward, so it will run past
      the bottom of the scrollable body — it must scroll into view rather
      than be lost. `.sheet-body` is a scroll container and therefore clips
      the popup in both axes; that is the one place this can go wrong.
- [ ] **Revision hint.** Type a title billed before. The history list (up to six
      prior billings) fits and scrolls rather than covering the whole sheet.
- [ ] **Multi-line editor.** Add six lines. The list scrolls, the running total
      stays visible, and the Add button label tracks the count.
- [ ] **After creating**, one confirmation line appears naming the billing, its
      item count and total. It carries no status badge. Switch tabs and back —
      it is gone. "View in Monitoring" lands on that billing, expanded.
- [ ] **Settings rows.** The type editor's code / label / prefix / counter all
      reachable and tappable without zooming.
- [ ] **Keyboard.** With the on-screen keyboard up, the field being typed into
      stays visible and the sheet does not jump.
- [ ] **Print from mobile Chrome.** Share → Print. Confirm it produces the same
      A4 layout as desktop; mobile print is a different renderer.
- [ ] **Installs as an app, not a shortcut.** On Android Chrome, open the
      Pages URL and check the ⋮ menu says **"Install app"** — if it says
      "Add to Home screen" the manifest is not being accepted. Install it,
      then confirm: the RSR mark on the home screen is a **full red tile**
      (not a white circle with a shrunken logo — that means the maskable icon
      is missing), it opens with **no browser address bar**, the task
      switcher shows "RSR Billing", and the splash is dark. There is no
      install *banner* by design; the menu is the way in.
- [ ] **Installed app still signs in and syncs.** The session lives in
      localStorage per origin — an installed PWA shares it with the browser
      on Android, so you should already be signed in. Create a billing from
      the installed app and confirm it reaches Supabase.
- [ ] **iOS**, if you use it: Share → Add to Home Screen shows the RSR icon
      and the name "RSR Billing". iOS has no install prompt at all.

## 3. Focus and caret

The counter/name bug was here, and only the browser shows the truth.

- [ ] **Settings → Document types.** Type into the counter field. The digits go
      into the counter and **never** into the name beside it. Check DW
      specifically.
- [ ] The caret stays in the field you are typing in, across all four editors:
      types, clients, catalog, banks.
- [ ] **Tab order** through a Settings row is left to right, no jumping back.
- [ ] **Line title typeahead.** Type mid-word, arrow down, Enter. The caret does
      not jump and the popup does not close and reopen on each keystroke.
- [ ] Open a sheet with a suggestion list showing, close the sheet, reopen it.
      No orphan popup, and arrow keys elsewhere do nothing odd.

## 4. Overlays and clicks

Desktop, a wide window — the closed-sheet bug only showed above 760px.

- [ ] With no modal open, every control on Monitoring and Create Billing
      responds — especially anything in the middle of the window.
- [ ] Open the entry sheet, close it, then click the sub-tabs. Still responsive.
- [ ] Open Settings, close it, click a billing card. Still responsive.
- [ ] Open a sheet from the gate (Connection settings), close it — you land back
      on the gate, not in the app.
- [ ] The scrim dismisses a sheet, and afterwards the page scrolls again.

## 5. Number claiming — two devices

Needs two browsers signed into the same project.

- [ ] Device A and B both open the statement sheet for different billings.
      Both press Print at about the same time. They get **different** numbers.
- [ ] Print the same billing twice. The number does **not** change and the
      counter does not move.
- [ ] Turn the network off mid-print. You get a provisional number, a warning
      toast, and the Print button is not left disabled. Turn it back on and
      print again — the same number is reused.
- [ ] **Settings → counter reset.** With a billing already numbered, try setting
      the counter below it. The confirm names the clashing number. Read it.
- [ ] **Billing no. field.** Not yet issued: it reads `auto — will issue as
      BILLDWG-26-00N` and follows the Settings counter. Type over it: the value
      sticks and stops following. Clear it: back to auto. After printing it
      shows the stored number and reprints reuse it.
- [ ] **Reset to auto** appears only on a draft. It warns, names the number, and
      says the number stays consumed. Afterwards the next print claims the
      *following* number, not the released one.

## 6. Offline

- [ ] Go offline. Create a billing, mark it billed, edit a line. The sync dot
      shows queued work.
- [ ] Hard-refresh while offline with items queued. Everything is still there.
- [ ] Come back online. The queue drains, the dot goes green, and the records
      appear in Supabase with the right group and line order.
- [ ] Offline with an expired-ish session: you are **not** signed out and the
      queue survives.

## 7. Data hygiene

- [ ] Enter a client as `Seaford`, then `seaford `, then ` SEAFORD` on three
      billings. All three land on one client and one statement finds all three.
- [ ] The typeahead lists that client once, not three times.
- [ ] Contact person and address entered in Settings appear under Bill To.
- [ ] **Salutation is not Bill To.** With Salutation `Mr. Chua` and Contact
      person `Ashford Chua`, the printed Bill To reads `Ashford Chua` over the
      company name. `Mr. Chua` appears nowhere on the document.

## 8. Email

- [ ] A client with no billing email on file: the Email button prompts once,
      and the address is saved for next time.
- [ ] The received email matches the printed layout — Bill To, numbered lines,
      totals, payment details, thank-you. No tracking codes.
- [ ] Sending as a user **not** in `billing_senders` is refused with a clear
      message.
- [ ] **The covering letter.** Email opens a review sheet, not a send. The
      letter is filled in: salutation from the client's Salutation field,
      billing no., vessel, period, total. Read it in a real inbox — the
      letter sits above the billing, paragraphs are separated, and the date
      is today's.
- [ ] **Salutation.** {contact} prints the client's **Salutation** field
      verbatim. Blank it and the letter falls back to Contact person; blank
      both and it reads "Dear Sir/Madam,". Nothing derives an honorific — for
      "Dear Mr. Chua," someone must have typed `Mr. Chua` into Salutation.
- [ ] **Editing at review** changes that send only. Reopen Settings after —
      the template is unchanged.
- [ ] **Back claims nothing.** Open the review on an unnumbered draft, press
      Back, and check Settings: the counter has **not** moved and the billing
      is still DRAFT. The number is claimed on Send, not on review.
- [ ] **Subject line** reads `Billing BILLDWG-26-00N — MV … — RSR Engineering
      Services` in the inbox.
- [ ] **Auto-mark on send.** A successful send flips the billing to BILLED
      with today's billed_date, no prompt, and toasts "Sent to … — marked
      billed". Check Monitoring.
- [ ] **A failed send marks nothing.** Turn the network off at the review
      step and press Send: an error toast, and the billing is still DRAFT
      with no billed_date. The letter is still there to retry.
- [ ] **Re-sending a BILLED billing** leaves its original billed_date alone,
      and re-sending a **PAID** one does not walk it back to BILLED.
- [ ] **Print still asks.** With Settings → "Auto-mark billed on print" off,
      printing confirms first. Turn it on and print — it marks without
      asking. Print cannot detect a cancelled print dialog either way.

---

## 9. The PDF attachment

The harness has no layout and no painting. It can prove the numbers on the
PDF come from `stmtFacts`; it cannot see the page. This section is the only
check that anyone can read the document.

- [ ] Open a billing with at least two lines, one of them a revision, one
      no-charge line, and one with a long title. Tap **Download PDF**.
- [ ] Put the PDF beside the printed page — Print, same billing — and
      compare: the mark, the company name **with its address and contact
      no.**, the **date**, Bill To (contact person first, then company, then
      address), vessel, period, every line with its drawing number, subtotal,
      the VAT or withholding line, the total, the amount in words, terms and
      due date, payment details **including the "Please issue payment to" and
      deposit-slip lines**, and the closing thank-you.
- [ ] **The rules and boxes.** Still side by side: Bill To, the vessel line,
      the period/terms/due row, the amount in words and the payment details
      each sit inside a box, all five boxes share the same left and right
      edges, and the period row is split into three cells by two dividers.
      The table header is a dark band the colour of the printed one with
      white labels on it, and the rule above the totals is visibly heavier
      than every other rule. Nothing may touch a rule: no label sitting on a
      divider, no descender cut by a box edge, no text jammed against a side.
- [ ] **No box may cross a page break.** Check it on the 25-line billing
      below, and again on a client with a long multi-line address. A box
      split across two pages is the failure this pass is most likely to have
      missed — the harness can prove the coordinates, never the paint.
- [ ] Two differences from print are **deliberate, not omissions**: the PDF
      has no alternating row shading, and its figures are not in a monospace
      face — jsPDF carries no Consolas, so Courier would change the look
      rather than match it.
- [ ] **Read the amounts.** Every figure must be plain and correct — no `±`,
      no stray characters, no gaps between digits. The column reads
      **Amount (PHP)** and a line above the amount in words says all amounts
      are in Philippine Pesos. There is deliberately no ₱ sign on the PDF:
      jsPDF's standard font cannot encode it. This is the one place the PDF
      is allowed to differ from the printed page.
- [ ] Three known, deliberate substitutions: the em dash in the period range
      and the subtotal label prints as a hyphen, and curly quotes print
      straight. Anything else non-Latin prints as `?` — if you see a `?` on
      the document, tell Claude, it means a character has no substitute yet.
- [ ] A no-charge line reads **No Charge** in *both* the Rate and Amount
      columns, exactly as it does on paper — never a rate beside a zero.
- [ ] The long title wraps inside the Description column. It must not run
      under Qty, Rate or Amount.
- [ ] **Pagination.** Build a billing with **25 or more lines** and download
      it. There must be a second page; the table header repeats on it; every
      page is footed with the billing number and `Page N of M`; and the
      totals, amount in words and payment details all survive to the last
      page. Before this was fixed they fell off the bottom of page one
      silently, so two lines is not enough to test it.
- [ ] Confirm the billing number matches the printed copy and that no
      `RSR-` code appears anywhere on the PDF.
- [ ] Print the PDF. The mark must read as solid black on a mono printer.
- [ ] Email the billing to your own address. Open it on a phone: the body
      keeps the letter and the inline billing, and the attachment opens as
      `BILLDWG-26-0NN.pdf`.
- [ ] Break it on purpose once: turn off the network after the letter opens
      and press Send. The send must fail with a visible message, nothing is
      marked billed, and the letter is still there to retry.

---

## 10. Client edits from two devices at once

The suites can prove the merge rule field by field, but they run one fake
server against one fake device. Nothing automated can stage two real writers
disagreeing, which is the whole point of this mechanism — so it is here.

**Both writers must be running this build.** Pages serves `main`, so until
this is merged a phone loading the live URL is the *old* app and will not
reconcile anything. Either serve the branch to the phone over your LAN
(`python -m http.server 8000` on the laptop, then `http://<laptop-ip>:8000`
on the phone, same Wi-Fi), or walk this section again after the merge.

**If you only have one device**, the Supabase SQL editor is a perfectly good
second writer — to the app it is indistinguishable from a phone. Use:

```sql
update clients set billing_email = 'someone@example.test'
where name = 'Seaford Shipping Lines';
```

That fires the `rsr_clients_touch` trigger and moves `updated_at`, exactly as
another device would.

### A. Different fields — merges silently, nothing to decide

- [ ] On the **phone**, go offline (airplane mode, or DevTools → Network →
      Offline). Edit the client's **address** and tap out of the field so it
      saves. The badge should read `1 queued`.
- [ ] On the **PC** (or in the SQL editor), change that client's **billing
      email** to something new. Let it sync.
- [ ] Bring the phone back online and let it flush.
- [ ] The phone now shows **your new address and the PC's new email**. No
      toast asking anything, nothing in Pending writes, badge back to
      `Synced`. Both edits survived because they touched different fields.

### B. The same field — surfaced, never guessed

- [ ] Phone offline again. Edit the client's **billing email** to one value.
- [ ] PC (or SQL editor): set that same **billing email** to a *different*
      value. Let it sync.
- [ ] Bring the phone online.
- [ ] A toast fires naming the conflict, and **Settings → Pending writes**
      lists the job with a reason naming the field and **both values** —
      yours and the server's. Read it: if it does not show both, the message
      is not doing its job.
- [ ] The client list on the phone shows the **server's** value, not yours.
      Your value is not lost — it is held in the pending job.
- [ ] Confirm nothing was written: re-read the row in the SQL editor. It must
      still hold the PC's value.

### C. All-or-nothing, and Discard leaves the row alone

- [ ] Repeat B, but on the phone edit **both** the billing email (conflicting)
      **and** the contact person (which the PC did not touch).
- [ ] After the flush, check the SQL editor: **neither** field changed. The
      clean edit is deliberately *not* applied when any part of the write
      conflicts — a half-applied write is harder to reason about than one to
      redo.
- [ ] Tap **Discard** on the pending job and confirm the prompt names the
      fields it is about to destroy. After discarding, the server row is
      **unchanged** and the phone shows the server's values.

### D. Retry, after the disagreement is settled

- [ ] Repeat B to get a conflicting job in Pending writes.
- [ ] Decide the PC was right: tap **Discard**, then re-enter nothing. The
      phone should already show the server's value.
- [ ] Now decide *you* were right: edit the field again on the phone, online
      this time. It saves normally — the version it swaps against is the one
      it just read, so there is nothing to conflict with.

### E. The guard against silent overwrites

- [ ] Sanity check that the version is actually moving. In the SQL editor:
      `select name, updated_at from clients;` — note the value, change any
      field on that client from the app, and re-read. **`updated_at` must
      change.** If it does not, the trigger is missing and every write will
      silently win, with the suite still green.

---

## 11. Re-sending a corrected billing

Everything in this section is a **second** copy of a document a client already
holds. That is what makes it worth walking: the billing number does not change
on a correction, so the only things telling the two copies apart are a line on
the PDF, a sentence in the letter, and a badge in Monitoring. All three are
invisible to the harness — it has no layout, and it cannot see an email.

The off-by-one that shipped here is the reason to take it slowly. The PDF's
Revised line was gated on the wrong boundary and marked nothing until the
*third* send, and the test asserted that mistake, so the suite stayed green.
A green suite proves the rule was not deleted. It never proves the client can
see it.

Do the whole section on one billing, in order: parts A–D set up state that
parts E–H read back.

**You need the unbill passcode before you start.** Correcting a billing is not
just editing it. Once a billing is BILLED every title and rate in the editor is
disabled and the remove-line button with them, so each correction below is
really three steps: **Unbill** on the card, make the change, then re-send. If
you do not have the passcode, you can walk part A and nothing after it.

Start from a billing with **at least three lines** — part D removes one, and a
billing must keep at least two for the rest of the section to mean anything.

### A. The first send is not a correction

- [ ] Pick the DRAFT billing you chose above. Note its number.
- [ ] Send it to yourself. Open the mail.
- [ ] **The PDF must carry no "Revised" line.** A first send is not a
      correction, and marking one would make the mark meaningless.
- [ ] **The letter must read normally.** If your template in Settings uses
      `{revised_note}` or `{change_note}`, both resolve to nothing on a first
      send — so there must be no stray blank paragraph, no double space, and
      no sentence that starts mid-air where a note would have gone.
- [ ] Monitoring shows **`Sent · <your name>`** on that card — no count on a
      first send.

### B. The correction — the case the feature exists for

- [ ] **Unbill it first.** The card shows an Unbill button once a billing is
      BILLED; it asks for the passcode and a reason, and the reason goes in
      the unbill log. Without this the editor is read-only and the next step
      is impossible — that is the guard working, not a fault.
- [ ] **Change one line's rate**, so the total moves by an amount you can
      recognise. Do not add or remove a line yet.
- [ ] Re-send the same billing.
- [ ] **The billing number must be identical to step A.** No `-R1`, no `-2`,
      no suffix of any kind, on the document, in the subject or in the letter.
      If a suffix appears anywhere, stop — the numbering model has changed
      under you and nothing below is meaningful.
- [ ] **The PDF must now carry `Revised <date>`**, right-aligned under the
      date in the header. This is the **second** send: if it is missing here
      and only appears on the third, the off-by-one is back.
- [ ] The Revised date is the date of the **previous** send, not today's.
- [ ] Read the line as text, not as a shape: `Revised 28 Aug 2026`, no `?`
      where a character should be, no gap between digits.
- [ ] Monitoring shows **`Sent ×2 · <your name>`**.

### C. What the letter says about the change

Skip to D if your template uses neither placeholder — but read the first
checkbox first, because adding them is a one-line change in Settings and this
is the only place their wording gets checked.

> **The letter template is shared, not per-device.** `cfg.letter` travels in
> `app_settings`, so editing it here publishes the change to every device on
> the project, not just this one. Note what the box holds before you touch it.
> Afterwards either paste the original text back, or **clear the box entirely**
> — empty means `LETTER_DEFAULT`, which is the standard wording. Leaving the
> placeholders in is fine if you want them; just decide, rather than leaving a
> test edit live on everyone's device.

- [ ] In Settings, put `{revised_note}` and `{change_note}` into the letter
      template on their own paragraph. Save. Re-send.
- [ ] `{revised_note}` renders as a real sentence: *"This billing replaces the
      copy sent on \<date\>. The billing number is unchanged."* — the date is
      the previous send, and the second sentence is the one that stops the
      client filing two invoices.
- [ ] `{change_note}` names the **direction and the amount**: decreased by
      the figure you recognise from step B, and it must match what the
      document actually shows. This is computed against the copy that was
      sent, not read off a stored field, so a wrong figure here means the
      snapshot and the document disagree.
- [ ] It names the **line you changed** and does **not** name the lines you
      did not.
- [ ] **No `{token}` survives anywhere in the letter.** A literal
      `{revised_note}` in the body means the placeholder is not whitelisted —
      that is the failure the leftover-token behaviour exists to reveal, and
      it is visible to the client if you send it.

### D. Adding and removing a line

Each of these is Unbill → edit → re-send, the same cycle as part B.

- [ ] Add a line, re-send. `{change_note}` reads **increased**, names the new
      line, and the PDF total matches the letter's figure.
- [ ] Delete a line, re-send. It reads **decreased** and names the removed
      line. The remove button is disabled until you unbill, and a BILLED row
      cannot be deleted at all — `rsr_dwg_delete_guard` refuses it server
      side even if the button were live.
- [ ] Re-send once more with **no change at all**. The note reads *"The total
      is unchanged."* and names nothing. A billing can be re-sent because the
      client lost the first copy; saying nothing changed is correct, and
      inventing a change would not be.

### E. Sender attribution

- [ ] The badge sits in the meta row with the vessel and date, **not** in the
      card head beside the status. If it has crowded into the head and pushed
      the amount onto a second line, that is the failure — check it on a
      phone, in portrait, on the longest client name you have.
- [ ] It shows the **local part only** — `raffy`, not the whole address. Long
      press or hover: the full address is the title.
- [ ] If a second person is in `billing_senders`, have them send one and
      confirm their name appears on that card and yours does not change.

### F. The mismatch flag — a document the database cannot reproduce

This is the one warning that outlives the moment it happened. Read it even if
you never trigger it deliberately.

- [ ] Find a billing whose card shows **`⚠ total differs · send N`**. At the
      time of writing that is `BILLDWG-26-002`, flagged for send 4 — but if
      you have used that billing for parts A–D its send count has moved on.
      The flag stays on the send that was wrong; only the total count grows.
      Confirm which sends are flagged with the query below rather than
      trusting the number written here.
- [ ] **It must stay flagged after a clean re-send.** Send that billing again
      with no changes; the badge must still name send 4. The bad copy is with
      a client and a later good send does not take it back.
- [ ] The flag names **which** send, not just that one exists. With more than
      one it reads `totals differ · sends 2, 4`.
- [ ] Cross-check in the SQL editor:
      `select send_no, total, client_total, total_mismatch from`
      `drawing_billing_send_log where gid = '<gid>' order by send_no;`
      The flagged sends are exactly the rows with `total_mismatch = true`.

### G. The record matches what was sent

- [ ] After the last send, read the newest row:
      `select send_no, bill_no, total, client_total, total_mismatch,`
      `change_kind, total_delta, sent_by_email from`
      `drawing_billing_send_log order by id desc limit 1;`
- [ ] `bill_no` is the **same** number as every earlier row for that billing.
- [ ] `total` equals the figure on the PDF you just received.
- [ ] `client_total` equals `total`, and `total_mismatch` is `false`. If it is
      `true`, the device sent a document the database cannot reproduce —
      **stop and find out why before sending anything to a real client.**
- [ ] `sent_by_email` is you.
- [ ] `send_no` is one higher than the previous row, with no gap. A gap means
      a send was not recorded.

### H. The status actually moved

The queue used to destroy every write after the first, so a billing reported
as marked was marked only in that browser's local storage.

- [ ] After the send, the toast says **marked billed** — and if it says
      anything about writes waiting or refused, believe it over the status
      badge.
- [ ] In the SQL editor:
      `select line_no, status, billed_date, bill_no from drawing_billing`
      `where coalesce(group_id::text, id::text) = '<gid>' order by line_no;`
- [ ] **Every line** is `BILLED`, every line has the **same** `billed_date`,
      and every line has the **same** `bill_no`. One line lagging behind the
      others is the failure this check exists for.
- [ ] The card shows no **Lines differ** badge. If it does, it names the
      field that disagrees — read it, then re-check the query above.

---

## Open items — your call, not fixed

1. **Offline numbers are not reconciled.** A billing numbered while offline
   keeps that number after syncing, even if another device has since used it.
   The window is small (only numbers issued during an outage) and the local
   counter does catch up on the next sync, but the already-issued number does
   not. Fixing it properly means marking such numbers provisional and
   re-claiming on reconnect — a behaviour change, so it is left alone.

2. ~~Touch targets below 40px.~~ Done — everything interactive is 44px or more.
   Checkbox rows (`.pick-item`, `.chk`) keep small boxes, but the whole label is
   the tap target, so the effective area is a full row.

3. **A deliberate counter reset can still hand out a number already in use.**
   The confirm now names the clash, but proceeding is allowed — you may well be
   clearing test data. There is no automatic skip.

4. **Revisions are scoped to an exact client and vessel match.** Rename a client
   and its earlier billings stop being offered as revisions. Client names are
   now canonicalised, so case and spacing no longer split them, but a genuine
   rename does.

5. **The type list, payment details and counters live in Supabase; the project
   URL, key and session stay per-device.** A new device needs the URL and key
   entered once before anything syncs.
