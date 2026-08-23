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

// ===========================================================================
// SENDER IDENTITY — THIS IS WHAT CHANGES WHEN A DOMAIN IS VERIFIED IN RESEND
// ===========================================================================
// RSR has no verified sending domain yet, so mail leaves through Resend's
// shared sandbox address. That address has one hard limitation, and it is not
// an error you will see: Resend accepts the send, returns an id, and then
// DELIVERS ONLY TO THE MAILBOX THAT OWNS THE RESEND ACCOUNT
// (rsrengineering.services2025@gmail.com). Mail addressed to a real client is
// dropped silently. Until a domain is verified, this function can only usefully
// mail RSR itself — treat any other recipient as a test that did not arrive.
//
// Replies to the sandbox address go nowhere, which is why REPLY_TO carries a
// real mailbox: a client answering the billing lands in RSR's inbox, not
// Resend's void.
//
// ---- once <yourdomain> is verified in Resend, do this and nothing else -----
//   supabase secrets set STATEMENT_FROM="RSR Engineering <billing@yourdomain>"
//   supabase secrets set STATEMENT_REPLY_TO="billing@yourdomain"
// Both are read at invocation, so NO redeploy is needed. Once they are set the
// two constants below are dead and can be deleted along with this comment.
// Leave STATEMENT_FROM unset and every billing keeps going only to RSR.
// ---------------------------------------------------------------------------
const SANDBOX_FROM = "RSR Engineering <onboarding@resend.dev>";
const SANDBOX_REPLY_TO = "rsrengineering.services2025@gmail.com";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  // see SENDER IDENTITY above. A malformed STATEMENT_REPLY_TO falls back to the
  // constant rather than shipping a broken header.
  const FROM = Deno.env.get("STATEMENT_FROM") || SANDBOX_FROM;
  const REPLY_TO = cleanEmail(Deno.env.get("STATEMENT_REPLY_TO")) || SANDBOX_REPLY_TO;

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
    const match = Array.isArray(found) && found.some((c: { name?: string }) => c?.name === client);
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

  console.log(`statement ${statementNo || "(no number)"} sent to ${to} by ${senderEmail}`);
  return json({ ok: true, id: parsed?.id ?? null, to, statement_no: statementNo || null });
});
