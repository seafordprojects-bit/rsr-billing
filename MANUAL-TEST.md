# RSR Billing — manual test checklist

Everything here is something the automated suites **cannot** verify: real
layout, real printing, real focus, real touch. Ordered by risk — if you only
have twenty minutes, do section 1. If you are setting the app up on a phone
for the first time, start at section 0.

The suites cover logic, data and wiring — `node test/run.mjs`, 28 suites, 1113
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

- [ ] Open a billing with at least two lines, one of them a revision, and one
      no-charge line. Tap **Download PDF**.
- [ ] Put the PDF beside the printed page — Print, same billing — and
      compare: the mark, Bill To (company, contact person, address), vessel,
      period, every line with its drawing number, subtotal, the VAT or
      withholding line, the total, the amount in words, terms and due date,
      payment details.
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
