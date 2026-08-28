// send-statement — emails a rendered statement of account via Resend.
//
// Deploy:
//   supabase functions deploy send-statement
//   supabase secrets set RESEND_API_KEY=re_...
//
// Who the mail comes from is decided by the SENDER IDENTITY block below —
// read that before changing anything about the From or Reply-To.
//
// Authorisation, in three layers, because this endpoint sends mail from a
// verified company domain and would otherwise be a phishing relay for
// anyone holding any account on the project:
//   1. the caller's JWT must belong to a real user
//   2. that user's email must be listed in billing_senders
//   3. the recipient must be the on-file billing address of the very
//      client the statement is for
// Every check fails closed: a missing secret or an unreadable table
// refuses to send rather than falling through.

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// A statement is one address, one message. Anything list-shaped is a mistake
// or an attempt to use this as a relay. The strictness here is also what lets
// the address be interpolated into a PostgREST filter further down.
function cleanEmail(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s || s.length > 254) return "";
  if (/[,;\s"'\\()]/.test(s)) return "";
  if (/[\r\n]/.test(s)) return "";
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s) ? s : "";
}

// header injection guard for anything that lands in a header
const cleanHeader = (v: unknown, max: number) =>
  String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

// A billing stores the client name as text when it is created, and everything
// else about that client is looked up live by that name. The app matches it
// case- and spacing-insensitively (clientRec in index.html); this compared
// exactly, so "Seaford Shipping lines" matched happily in the app and was then
// refused here -- with a message about the billing email, which is not what
// had gone wrong. Both sides now canonicalise the same way.
const canonName = (v: unknown) =>
  String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

// ===========================================================================
// SENDER IDENTITY — the From and Reply-To on every billing
// ===========================================================================
// Billings leave from the firm's own domain rather than Resend's shared
// sandbox address, which delivered only to the mailbox owning the Resend
// account and dropped everything else in silence.
//
// rsrengg.com is VERIFIED in Resend -- confirmed 2026-08-26 by a test billing
// that arrived DKIM-signed by rsrengg.com, mailed by send.rsrengg.com, with an
// external CC delivered. So this is settled, not a prerequisite to arrange:
// real clients receive billings, and cc carries a second recipient.
//
// It stays true only while billing@rsrengg.com sits on a verified domain. If
// verification ever lapses Resend refuses with a 403 "domain is not verified",
// which this function passes straight back -- so the failure is a failed send,
// never mail that vanishes. That is the one thing to check first if sending
// breaks for every client at once.
//
// But check the ACCOUNT before the domain: that same 403 is far more often a
// key minted on the wrong Resend account. rsrengg.com is verified on
// seafordprojects@gmail.com ONLY. rsrengineering.services2025@gmail.com -- the
// Reply-To below, and the owner of the old sandbox account -- holds no domains
// at all, so every key from it 403s with a message about the domain. Two hours
// went into learning that on 2026-08-26. Mint RESEND_API_KEY on the first.
//
// Reply-To is a different mailbox on purpose: replies to a billing should land
// where they are read, which is the Gmail account, not an alias on the sending
// domain that nobody watches.
//
// ---- to change either without a redeploy --------------------------------
//   supabase secrets set STATEMENT_FROM="RSR Engineering Services <billing@rsrengg.com>"
//   supabase secrets set STATEMENT_REPLY_TO="someone@example.com"
// Both are read at invocation, so the secret wins over the constant below and
// no deploy is needed. The constants are the default a fresh deploy starts
// from; the secrets are how you move either address in a hurry.
// ---------------------------------------------------------------------------
const DEFAULT_FROM = "RSR Engineering Services <billing@rsrengg.com>";
const DEFAULT_REPLY_TO = "rsrengineering.services2025@gmail.com";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  // see SENDER IDENTITY above. A malformed STATEMENT_REPLY_TO falls back to the
  // constant rather than shipping a broken header.
  const FROM = Deno.env.get("STATEMENT_FROM") || DEFAULT_FROM;
  const REPLY_TO = cleanEmail(Deno.env.get("STATEMENT_REPLY_TO")) || DEFAULT_REPLY_TO;

  if (!RESEND_API_KEY) {
    return json({ ok: false, error: "RESEND_API_KEY is not set on the function" }, 500);
  }
  if (!SUPABASE_URL || !ANON_KEY) {
    return json({ ok: false, error: "Function is missing its Supabase environment" }, 500);
  }
  // Without the service key the allowlist cannot be read. Refuse rather than
  // silently downgrading to "any authenticated user may send".
  if (!SERVICE_KEY) {
    return json({ ok: false, error: "Function cannot check its sender allowlist" }, 500);
  }

  const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  // (1) the caller's JWT must belong to a real user
  const auth = req.headers.get("Authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token || token === ANON_KEY) {
    return json({ ok: false, error: "Sign in to email a statement" }, 401);
  }

  let user: { id: string; email?: string };
  try {
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!who.ok) return json({ ok: false, error: "Your session is not valid" }, 401);
    user = await who.json();
    if (!user?.id) return json({ ok: false, error: "Your session is not valid" }, 401);
  } catch {
    return json({ ok: false, error: "Could not verify your session" }, 401);
  }

  // (2) that user must be on the sender allowlist. Read with the service key
  // so the table stays unreadable to ordinary sessions.
  const senderEmail = cleanEmail(user.email);
  if (!senderEmail) {
    return json({ ok: false, error: "Your account has no usable email address" }, 403);
  }
  try {
    const alw = await fetch(
      `${SUPABASE_URL}/rest/v1/billing_senders?select=email&email=eq.${encodeURIComponent(senderEmail)}`,
      { headers: svc },
    );
    if (!alw.ok) {
      console.error("allowlist lookup failed", alw.status, await alw.text());
      return json({ ok: false, error: "Could not check your sending permission" }, 500);
    }
    const hits = await alw.json();
    if (!Array.isArray(hits) || hits.length === 0) {
      console.warn(`blocked send attempt by ${senderEmail}`);
      return json({ ok: false, error: "Your account is not allowed to email statements" }, 403);
    }
  } catch (e) {
    console.error("allowlist lookup threw", e);
    return json({ ok: false, error: "Could not check your sending permission" }, 500);
  }

  // accept {to, client, subject, html, statement_no}
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Body must be JSON" }, 400);
  }

  const to = cleanEmail(body.to);
  const client = cleanHeader(body.client, 200);
  const subject = cleanHeader(body.subject, 200);
  const statementNo = cleanHeader(body.statement_no, 60);
  const html = typeof body.html === "string" ? body.html : "";

  // Which billings this email covers. One send-log row is written per billing,
  // because bill_no is per group and so is its send history. Absent means an
  // older app build: the mail still goes, it simply is not recorded.
  const gids = Array.isArray(body.gids)
    ? (body.gids as unknown[]).map((g) => cleanHeader(g, 80)).filter(Boolean)
    : [];

  // What the sending device believed each billing totals, keyed by gid. This
  // is a CROSS-CHECK and nothing else: record_billing_send still builds its
  // snapshot from drawing_billing, and never from anything here. A device can
  // hold a line the server has never seen -- that is exactly what happened on
  // 2026-08-28 -- and the only way that shows up is by recording both numbers
  // and comparing them.
  const gidTotals: Record<string, number> = {};
  if (body.gid_totals && typeof body.gid_totals === "object") {
    for (const [k, v] of Object.entries(body.gid_totals as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n)) gidTotals[cleanHeader(k, 80)] = n;
    }
  }

  // The CC is optional, but a malformed one must not be dropped in silence --
  // the sender would believe a second party was copied when nobody was. Absent
  // and blank are fine; present-and-unparseable is a refusal.
  const ccRaw = String(body.cc ?? "").trim();
  const cc = ccRaw ? cleanEmail(ccRaw) : "";
  if (ccRaw && !cc) {
    return json({ ok: false, error: "The CC address is not a single valid email address" }, 400);
  }

  if (!to) return json({ ok: false, error: "A single valid recipient address is required" }, 400);
  if (!client) return json({ ok: false, error: "The client is required" }, 400);
  if (!html.trim()) return json({ ok: false, error: "The statement body is empty" }, 400);
  if (html.length > 750_000) return json({ ok: false, error: "The statement is too large to email" }, 413);

  // One attachment, a PDF, small, and required. There is deliberately no
  // service worker in this app, so a stale cached index.html could still
  // post without one — this is the last place that can stop a billing from
  // mailing with no document. Everything here fails closed, matching the
  // rest of this function: a missing or malformed attachment refuses the
  // send rather than quietly mailing a billing without its document.
  const att = (body.attachment ?? null) as Record<string, unknown> | null;
  if (!att) {
    // there is no service worker, so the realistic cause is a browser holding
    // an old copy of the app -- name the remedy rather than only the symptom
    return json({
      ok: false,
      error: "This billing carried no PDF. Reload the app and send again.",
    }, 400);
  }
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
  if ((content.length * 3) / 4 > 2_000_000) {
    return json({ ok: false, error: "The attachment is too large to email" }, 413);
  }
  const attachment: { filename: string; content: string } = { filename, content };

  // (3) the recipient must be this client's on-file billing address, so the
  // endpoint can only ever mail addresses already recorded in the app — and
  // cannot send one client's statement to another client's address.
  try {
    const cl = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?select=name,billing_email&billing_email=eq.${encodeURIComponent(to)}`,
      { headers: svc },
    );
    if (!cl.ok) {
      console.error("client lookup failed", cl.status, await cl.text());
      return json({ ok: false, error: "Could not verify the recipient" }, 500);
    }
    const found = await cl.json();
    const match = Array.isArray(found) &&
      found.some((c: { name?: string }) => canonName(c?.name) === canonName(client));
    if (!match) {
      console.warn(`blocked send to ${to} for client "${client}" by ${senderEmail}`);
      return json({
        ok: false,
        error: "That address is not the billing email on file for this client. Save it against the client first.",
      }, 403);
    }
  } catch (e) {
    console.error("client lookup threw", e);
    return json({ ok: false, error: "Could not verify the recipient" }, 500);
  }

  // send via Resend
  let sent: Response;
  try {
    sent = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        // omitted entirely when blank -- Resend is given no empty array
        ...(cc ? { cc: [cc] } : {}),
        subject: subject || (statementNo ? `Statement of Account ${statementNo}` : "Statement of Account"),
        html,
        // the company mailbox, not the person who pressed Send — see SENDER
        // IDENTITY. The sender is still recorded in the log line below.
        reply_to: REPLY_TO,
        attachments: [attachment],
      }),
    });
  } catch (e) {
    return json({ ok: false, error: `Could not reach the mail service: ${e}` }, 502);
  }

  const raw = await sent.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* keep raw */ }

  // report success or failure
  if (!sent.ok) {
    const msg = (parsed?.message as string) || raw || `Mail service returned ${sent.status}`;
    console.error("resend failed", sent.status, msg);
    return json({ ok: false, error: msg }, sent.status === 422 ? 400 : 502);
  }

  // ===========================================================================
  // The mail has gone. Everything below is bookkeeping.
  //
  // A failure here must NEVER be reported as a failed send. The client already
  // has the billing, and lSend skips markBilledNow on a failure -- so returning
  // ok:false would leave a sent billing sitting in DRAFT and tell the user to
  // send it again. Refusing to send fails closed; refusing to *log* fails open,
  // loudly, and says so in the response.
  //
  // The snapshot itself is built inside record_billing_send, from
  // drawing_billing. Nothing about the lines is passed from here, and nothing
  // came from the caller: this table is the record of what the client actually
  // received, and a stale device must not be able to write it.
  // ===========================================================================
  let logged = gids.length > 0;
  let sendNo: number | null = null;
  let mismatch = false;
  for (const gid of gids) {
    try {
      const rec = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_billing_send`, {
        method: "POST",
        headers: { ...svc, "Content-Type": "application/json" },
        body: JSON.stringify({
          p_gid: gid,
          p_bill_no: statementNo || null,
          p_to: to,
          p_cc: cc ? [cc] : [],
          p_sent_by_uid: user?.id ?? null,
          p_sent_by_email: senderEmail,
          p_provider_id: (parsed?.id as string) ?? null,
          p_letter_text: html,
          p_client_total: gid in gidTotals ? gidTotals[gid] : null,
        }),
      });
      const txt = await rec.text();
      let out: Record<string, unknown> = {};
      try { out = txt ? JSON.parse(txt) : {}; } catch { /* keep txt */ }
      if (!rec.ok || out?.ok !== true) {
        logged = false;
        console.error("send log refused", gid, rec.status, out?.reason ?? txt);
      } else {
        if (sendNo === null) sendNo = out.send_no as number;
        if (out.total_mismatch === true) {
          mismatch = true;
          console.error("send total mismatch", gid,
            "client", out.client_total, "server", out.total);
        }
      }
    } catch (e) {
      logged = false;
      console.error("send log threw", gid, e);
    }
  }

  console.log(
    `statement ${statementNo || "(no number)"} sent to ${to}${cc ? ` cc ${cc}` : ""}` +
    ` by ${senderEmail}${logged ? ` (send #${sendNo})` : " (not logged)"}`,
  );
  return json({ ok: true, id: parsed?.id ?? null, to,
                statement_no: statementNo || null, logged, send_no: sendNo,
                total_mismatch: mismatch });
});
