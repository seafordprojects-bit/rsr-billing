// send-statement — emails a rendered statement of account via Resend.
//
// Deploy:
//   supabase functions deploy send-statement
//   supabase secrets set RESEND_API_KEY=re_...
//   supabase secrets set STATEMENT_FROM="RSR Engineering <billing@yourdomain.com>"
//
// The From address must be on a domain verified in Resend. Without
// STATEMENT_FROM the function falls back to Resend's onboarding sender,
// which only delivers to the address that owns the Resend account.

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
// or an attempt to use this as a relay.
function cleanEmail(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s || s.length > 254) return "";
  if (/[,;\s]/.test(s)) return "";
  if (/[\r\n]/.test(s)) return "";
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s) ? s : "";
}

// header injection guard for anything that lands in a header
const cleanHeader = (v: unknown, max: number) =>
  String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const FROM = Deno.env.get("STATEMENT_FROM") || "onboarding@resend.dev";

  if (!RESEND_API_KEY) {
    return json({ ok: false, error: "RESEND_API_KEY is not set on the function" }, 500);
  }
  if (!SUPABASE_URL || !ANON_KEY) {
    return json({ ok: false, error: "Function is missing its Supabase environment" }, 500);
  }

  // (a) verify the caller's JWT — the token must belong to a real user
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

  // (b) accept {to, subject, html, statement_no}
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Body must be JSON" }, 400);
  }

  const to = cleanEmail(body.to);
  const subject = cleanHeader(body.subject, 200);
  const statementNo = cleanHeader(body.statement_no, 60);
  const html = typeof body.html === "string" ? body.html : "";

  if (!to) return json({ ok: false, error: "A single valid recipient address is required" }, 400);
  if (!html.trim()) return json({ ok: false, error: "The statement body is empty" }, 400);
  if (html.length > 750_000) return json({ ok: false, error: "The statement is too large to email" }, 413);

  // (c) send via Resend
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
        reply_to: user.email || undefined,
      }),
    });
  } catch (e) {
    return json({ ok: false, error: `Could not reach the mail service: ${e}` }, 502);
  }

  const raw = await sent.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* keep raw */ }

  // (d) report success or failure
  if (!sent.ok) {
    const msg = (parsed?.message as string) || raw || `Mail service returned ${sent.status}`;
    console.error("resend failed", sent.status, msg);
    return json({ ok: false, error: msg }, sent.status === 422 ? 400 : 502);
  }

  console.log(`statement ${statementNo || "(no number)"} sent to ${to} by ${user.email || user.id}`);
  return json({ ok: true, id: parsed?.id ?? null, to, statement_no: statementNo || null });
});
