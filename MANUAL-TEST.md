# RSR Billing — manual test checklist

Everything here is something the automated suites **cannot** verify: real
layout, real printing, real focus, real touch. Ordered by risk — if you only
have twenty minutes, do section 1.

The suites cover logic, data and wiring (23 suites, ~840 assertions). They do
**not** render, paginate, or lay anything out. Every bug you hit this session
that the tests missed was in this category.

---

## 1. Print — highest risk, least covered

Print to PDF first, then to paper. Chrome desktop, margins **Default**.

- [ ] **A4, balanced margins.** Content sits centred with even space on all
      four sides. No slack down the right edge.
- [ ] **Line numbers read `1.0`, `2.0`** on one line each — not `1.` with a
      stray `0` beneath. This regressed once already.
- [ ] **Backgrounds print.** The table header is dark with white text and the
      RSR mark is red. If they come out white, "Background graphics" is off in
      the print dialog.
- [ ] **No tracking codes anywhere.** The client's copy shows the `BILLDWG`
      number only — no `RSR-DW-…` on any line or in the meta strip.
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
- [ ] **Preview** prints with "Preview — not yet issued" and does **not**
      consume a number: check Settings afterwards, the counter has not moved.
- [ ] **No signature block.** No "Prepared by" line unless the Settings toggle
      is on; never a signature space or "Received / conforme".

## 2. Mobile — deploying to a phone

Chrome on the phone, or DevTools at **380 × 780**.

- [ ] **Segmented tabs.** Monitoring / Create Billing, then UTG / Drawing /
      Drydocking Cert. Every tap registers first time, including on the gaps
      between buttons and at the far edges.
- [ ] **Touch targets.** These measure under 40px and are the ones to judge in
      the hand — see "Open items" below:
      the expand control on a billing card (~21px), status filter chips (~29px),
      the header sync/settings icons (~36px), the ↑↓/× buttons in Settings (~28px).
- [ ] **Typeahead popups.** Type in a line title. The list appears below the
      field, is reachable by scrolling, and is not clipped by the sheet edge.
      Tapping a suggestion picks it — it does not just dismiss.
- [ ] **Revision hint.** Type a title billed before. The history list (up to six
      prior billings) fits and scrolls rather than covering the whole sheet.
- [ ] **Multi-line editor.** Add six lines. The list scrolls, the running total
      stays visible, and the Add button label tracks the count.
- [ ] **Settings rows.** The type editor's code / label / prefix / counter all
      reachable and tappable without zooming.
- [ ] **Keyboard.** With the on-screen keyboard up, the field being typed into
      stays visible and the sheet does not jump.
- [ ] **Print from mobile Chrome.** Share → Print. Confirm it produces the same
      A4 layout as desktop; mobile print is a different renderer.

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

## 8. Email

- [ ] A client with no billing email on file: the Email button prompts once,
      and the address is saved for next time.
- [ ] The received email matches the printed layout — Bill To, numbered lines,
      totals, payment details, thank-you. No tracking codes.
- [ ] Sending as a user **not** in `billing_senders` is refused with a clear
      message.

---

## Open items — your call, not fixed

1. **Offline numbers are not reconciled.** A billing numbered while offline
   keeps that number after syncing, even if another device has since used it.
   The window is small (only numbers issued during an outage) and the local
   counter does catch up on the next sync, but the already-issued number does
   not. Fixing it properly means marking such numbers provisional and
   re-claiming on reconnect — a behaviour change, so it is left alone.

2. **Touch targets below 40px** (listed in section 2). Raising them changes the
   density of the header, toolbar and Settings rows, so it is a design decision
   rather than a bug fix. The billing-card expand control at ~21px is the one I
   would raise first.

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
