// receive-drydock-job — the drydocking app's Cloud Run service POSTs one
// completed job here AFTER the documents were emailed to the client. It
// becomes a DRAFT DC billing (receive_drydock_job RPC) that the user reviews
// and sends himself. Nothing here sends mail or prices anything.
//
// Deploy (verify_jwt is OFF for this function in supabase/config.toml -- the
// caller is a server holding a shared secret, not a Supabase user; forgetting
// this makes every drydocking send sit at emailed_billing_pending over there
// with "billing ingress returned 401"):
//   supabase functions deploy receive-drydock-job --no-verify-jwt
//   supabase secrets set DRYDOCK_INGRESS_SECRET=...
//
// Answers: 200 {ok,created,group_id,code,unpriced} -- created:false is a
// RETRY of a job already received (idempotent on dispatch_id) and is 200 on
// purpose: anything non-2xx makes the drydocking side keep retrying. 400 is a
// payload it would never accept (recorded as failed over there, with the
// reason). 403 wrong secret. 405 not POST. 500 misconfigured, or the
// database failed, which the caller retries later.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// header bytes and runs of whitespace collapse; nothing here is markup, and
// the RPC canonicalises the client name the same way (collapse, trim, lower)
const cleanText = (v: unknown, max: number) =>
  String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
// A postal address is the one field where line breaks are content: billing
// prints Bill To across the typed lines (statement and PDF both split on
// \n). It never reaches an HTTP header, so \n is safe here; \r and tabs are
// not content and go, spaces collapse within a line, blank lines drop, and
// the shape is capped so a pasted document cannot become an address.
const cleanAddress = (v: unknown): string =>
  String(v ?? "").replace(/\r/g, "").split("\n")
    .map((l) => l.replace(/[\t ]+/g, " ").trim().slice(0, 120))
    .filter(Boolean).slice(0, 6).join("\n");
// constant-time compare, the same intent as the drydocking server's secretOk
function secretOk(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
type Doc = { title: string; pages: number | null; billable: boolean };
export type Job = {
  dispatch_id: string; draft_id: string; source: string; project_no: string; vessel: string;
  client: string; client_address: string; client_email: string; documents: Doc[];
  sent_at: string | null; email_provider_id: string; confirmed_by: string; confirmed_at: string | null;
  completed_by: string; completed_at: string | null;
};
// an unparseable timestamp is dropped, not refused: the RPC falls back to
// now() for sent_at, and the job itself is still real
const isoOrNull = (v: unknown): string | null => {
  const s = cleanText(v, 40);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
};
// The whole payload is rebuilt from scratch here: only these keys, only
// cleaned values, reach the RPC. Anything else the caller sends is dropped.
export function validate(body: unknown): { ok: true; job: Job } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const dispatch_id = cleanText(b.dispatch_id, 40), draft_id = cleanText(b.draft_id, 40);
  if (!UUID.test(dispatch_id)) return { ok: false, error: "dispatch_id must be a UUID" };
  if (!UUID.test(draft_id)) return { ok: false, error: "draft_id must be a UUID" };
  const client = cleanText(b.client, 200);
  if (!client) return { ok: false, error: "client is required" };
  if (!Array.isArray(b.documents) || !b.documents.length) return { ok: false, error: "documents must be a non-empty list" };
  const documents: Doc[] = [];
  for (const d of b.documents as unknown[]) {
    const o = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
    const title = cleanText(o.title, 200);
    if (!title) return { ok: false, error: "every document needs a title" };
    let pages: number | null = null;
    if (o.pages != null && o.pages !== "") {
      const n = Number(o.pages);
      if (!Number.isInteger(n) || n < 0) return { ok: false, error: "pages must be an integer" };
      pages = n;
    }
    // billable: absent means charged (true); the drydocking side sends false
    // for the one title the yard lists without charging (Drydocking List of
    // Vessel). Strictly boolean -- a string "no" is a bug upstream, not a
    // value to guess at.
    let billable = true;
    if (o.billable !== undefined && o.billable !== null) {
      if (typeof o.billable !== "boolean") return { ok: false, error: "billable must be true or false" };
      billable = o.billable;
    }
    documents.push({ title, pages, billable });
  }
  return { ok: true, job: {
    dispatch_id: dispatch_id.toLowerCase(), draft_id: draft_id.toLowerCase(),
    source: cleanText(b.source, 40) || "drydocking", project_no: cleanText(b.project_no, 60),
    vessel: cleanText(b.vessel, 120), client, client_address: cleanAddress(b.client_address),
    client_email: cleanText(b.client_email, 254), documents,
    sent_at: isoOrNull(b.sent_at), email_provider_id: cleanText(b.email_provider_id, 120),
    confirmed_by: cleanText(b.confirmed_by, 120), confirmed_at: isoOrNull(b.confirmed_at),
    completed_by: cleanText(b.completed_by, 120), completed_at: isoOrNull(b.completed_at),
  } };
}
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  const SECRET = Deno.env.get("DRYDOCK_INGRESS_SECRET");
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // fail closed: a missing secret means unusable, never wide open
  if (!SECRET || !SUPABASE_URL || !SERVICE_KEY) return json({ ok: false, error: "not configured" }, 500);
  if (!secretOk(req.headers.get("x-drydock-secret") || "", SECRET)) return json({ ok: false, error: "forbidden" }, 403);
  let body: unknown;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Body must be JSON" }, 400); }
  const v = validate(body);
  if (!v.ok) return json({ ok: false, error: v.error }, 400);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/receive_drydock_job`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p: v.job }),
  });
  const text = await r.text();
  let out: any = null;
  try { out = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!r.ok) return json({ ok: false, error: `receive_drydock_job ${r.status}: ${String((out && out.message) || text).slice(0, 300)}` }, 500);
  if (!out || out.ok !== true) return json({ ok: false, error: (out && out.reason) || "refused" }, 400);
  return json({ ok: true, created: !!out.created, group_id: out.group_id, code: out.code || null, unpriced: out.unpriced || [] }, 200);
});
