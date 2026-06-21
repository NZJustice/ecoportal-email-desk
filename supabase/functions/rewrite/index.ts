// =====================================================================
// Email Desk — Supabase Edge Function (backend proxy)
// ---------------------------------------------------------------------
// Holds the Anthropic API key server-side so it never reaches the browser.
// The GitHub Pages frontend POSTs { system, messages, output_config } here;
// this function adds the key + anthropic-version, pins model/max_tokens,
// rate-limits, and returns Anthropic's JSON unchanged.
//
// DEPLOY (Supabase CLI):
//   supabase functions deploy rewrite --no-verify-jwt
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// or via the Supabase dashboard: Edge Functions -> Deploy a new function
//   (turn OFF "Enforce JWT verification"), then add the secret under
//   Project Settings -> Edge Functions -> Secrets.
//
// The function URL will be:
//   https://<your-project-ref>.supabase.co/functions/v1/rewrite
// Put that into the frontend's CONFIG.endpoint, and set
// CONFIG.useStructuredOutput = true.
// =====================================================================

const CONFIG = {
  anthropicUrl: "https://api.anthropic.com/v1/messages",
  anthropicVersion: "2023-06-01",
  model: "claude-sonnet-4-6",      // server owns this — client value is ignored
  maxTokens: 4096,                 // server owns this too
  maxBodyBytes: 60 * 1024,         // ~60 KB request cap
  rateLimit: { windowMs: 60_000, max: 20 }, // 20 req / min / IP (per isolate; see note)
  // Lock this to your Pages origin in production, e.g.
  // "https://nzjustice.github.io". "*" is fine for an internal demo.
  allowOrigin: "*",
  logBodies: false,                // leave off unless you've set a retention policy
};

const CORS = {
  "Access-Control-Allow-Origin": CONFIG.allowOrigin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// In-memory rate limiter. NOTE: an Edge Function isolate is short-lived and not
// shared, so this is best-effort throttling, not a hard global limit. For an
// open-to-the-internet deployment, back it with a Supabase table or Upstash.
const hits = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  let rec = hits.get(ip);
  if (!rec || now > rec.resetAt) { rec = { count: 0, resetAt: now + CONFIG.rateLimit.windowMs }; hits.set(ip, rec); }
  rec.count++;
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
  return rec.count > CONFIG.rateLimit.max;
}

function json(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json(500, { error: "Server is not configured." });

  const ip =
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    request.headers.get("cf-connecting-ip") || "unknown";
  if (rateLimited(ip)) return json(429, { error: "Too many requests. Please wait a moment and try again." });

  const raw = await request.text();
  if (raw.length > CONFIG.maxBodyBytes) return json(413, { error: "That email is too long. Please shorten it and try again." });

  let incoming: any;
  try { incoming = JSON.parse(raw); } catch { return json(400, { error: "Bad request." }); }

  const { system, messages, output_config } = incoming || {};
  if (typeof system !== "string" || !Array.isArray(messages) || !messages.length) {
    return json(400, { error: "Bad request." });
  }

  const body: Record<string, unknown> = {
    model: CONFIG.model,
    max_tokens: CONFIG.maxTokens,
    system,
    messages,
  };
  if (output_config && output_config.format) body.output_config = output_config;

  if (CONFIG.logBodies) console.log("[emaildesk]", ip, raw.length, "bytes");

  let upstream: Response;
  try {
    upstream = await fetch(CONFIG.anthropicUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": CONFIG.anthropicVersion,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return json(502, { error: "The rewrite service is unreachable right now. Try again shortly." });
  }

  if (!upstream.ok) {
    let detail = ""; try { detail = await upstream.text(); } catch { /* ignore */ }
    console.error("[emaildesk] upstream", upstream.status, detail.slice(0, 500));
    if (upstream.status === 429) return json(429, { error: "Busy right now. Please wait a moment and try again." });
    return json(502, { error: "The rewrite service had a problem. Try again shortly." });
  }

  // Pass Anthropic's JSON through unchanged so the frontend parser works as-is.
  const data = await upstream.text();
  return new Response(data, { status: 200, headers: { "Content-Type": "application/json", ...CORS } });
});
