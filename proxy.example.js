/* =====================================================================
   ecoPortal CS Email Desk — backend proxy (reference implementation)
   ---------------------------------------------------------------------
   WHY THIS EXISTS
     The prototype (ecoportal-csm-email-desk.html) calls Anthropic from the
     browser with NO API key. That only works inside a Claude.ai artifact,
     where the runtime injects auth. On a real host the browser call is
     blocked by a CORS preflight (api.anthropic.com sends no
     Access-Control-Allow-Origin for site origins) and is also missing the
     required x-api-key and anthropic-version headers. This proxy is the fix:
     it holds the key server-side, adds the version header, enforces abuse
     controls, and is same-origin with the frontend so there is no CORS issue.

   WHAT IT DOES (the four things a hosted build needs — see HANDOVER §1, §6, §7)
     1. Holds ANTHROPIC_API_KEY server-side and adds anthropic-version.
     2. PINS model + max_tokens server-side. It does NOT trust the client's
        model/max_tokens (a stranger could otherwise dial up cost).
     3. Enforces a request size cap and a simple per-IP rate limit.
     4. Maps upstream errors to short, safe messages (no raw upstream body
        leaked to end users) and passes Anthropic's success JSON through
        unchanged so the frontend's existing parser keeps working.

   WIRING THE FRONTEND
     In the HTML, set CONFIG.endpoint to this proxy's URL (same origin, e.g.
     "/api/rewrite") and set CONFIG.useStructuredOutput = true. No other
     frontend change is needed — callClaude already POSTs { system, messages,
     model, max_tokens, output_config }; this proxy keeps system/messages/
     output_config and overrides model/max_tokens.

   DEPLOY
     Runs on any Web-Fetch runtime (Vercel, Cloudflare Workers, Netlify, Deno)
     via `handle(request)`, or on Node/Express via the adapter at the bottom.
     Requires: process.env.ANTHROPIC_API_KEY. Node 18+ (global fetch).

   STILL TO DECIDE BEFORE GOING LIVE (HANDOVER §6)
     - Is this internal (behind SSO) or open to the internet? If open, put a
       real rate limiter (Redis/Upstash/Cloudflare KV) in place of the
       in-memory one below, which resets on every cold start / per instance.
     - Logging & retention: customer email content flows through here. Decide
       what (if anything) is logged and for how long. LOG_BODIES defaults off.
   ===================================================================== */

"use strict";

const CONFIG = {
  anthropicUrl: "https://api.anthropic.com/v1/messages",
  anthropicVersion: "2023-06-01",
  // Server owns these — client values are ignored.
  model: "claude-sonnet-4-6",
  maxTokens: 4096,
  // Abuse controls. Tune to your traffic; these are advisory defaults.
  maxBodyBytes: 60 * 1024,     // ~60 KB request cap (a long CSM email is well under this)
  rateLimit: { windowMs: 60_000, max: 20 }, // 20 requests / minute / IP
  // Lock this to your site's origin(s) in production. "*" is fine only if the
  // proxy is same-origin with the frontend (recommended) and never needs CORS.
  allowOrigin: "*",
  // Privacy switch. Leave false unless you have decided on a retention policy.
  logBodies: false,
};

/* ---------- tiny in-memory rate limiter (replace for production) ---------- */
const hits = new Map(); // ip -> { count, resetAt }
function rateLimited(ip) {
  const now = Date.now();
  let rec = hits.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + CONFIG.rateLimit.windowMs };
    hits.set(ip, rec);
  }
  rec.count++;
  // opportunistic cleanup so the map doesn't grow unbounded
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
  return rec.count > CONFIG.rateLimit.max;
}

function json(status, obj, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign(
      { "Content-Type": "application/json", "Access-Control-Allow-Origin": CONFIG.allowOrigin },
      extraHeaders || {}
    ),
  });
}

/* ---------- the handler (Web Fetch signature) ---------- */
async function handle(request) {
  // CORS preflight (only relevant if the proxy is cross-origin from the frontend)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": CONFIG.allowOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(500, { error: "Server is not configured." });

  // Per-IP rate limit
  const ip =
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    request.headers.get("cf-connecting-ip") ||
    "unknown";
  if (rateLimited(ip)) return json(429, { error: "Too many requests. Please wait a moment and try again." });

  // Read body with a hard size cap
  const raw = await request.text();
  if (raw.length > CONFIG.maxBodyBytes) {
    return json(413, { error: "That email is too long. Please shorten it and try again." });
  }

  let incoming;
  try { incoming = JSON.parse(raw); } catch { return json(400, { error: "Bad request." }); }

  // Accept only what we need from the client; the server owns model + max_tokens.
  const { system, messages, output_config } = incoming || {};
  if (typeof system !== "string" || !Array.isArray(messages) || !messages.length) {
    return json(400, { error: "Bad request." });
  }

  const body = {
    model: CONFIG.model,
    max_tokens: CONFIG.maxTokens,
    system,
    messages,
  };
  // Forward structured-output config if the client asked for it (frontend sets this
  // when CONFIG.useStructuredOutput is true). The backend is the authoritative place
  // to enforce the JSON shape, which removes the code-fence / stray-prose parse risk.
  if (output_config && output_config.format) body.output_config = output_config;

  if (CONFIG.logBodies) console.log("[emaildesk]", ip, raw.length, "bytes"); // policy-gated

  let upstream;
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
    // Log the real upstream detail server-side; show the user something safe and generic.
    let detail = ""; try { detail = await upstream.text(); } catch {}
    console.error("[emaildesk] upstream", upstream.status, detail.slice(0, 500));
    if (upstream.status === 429) return json(429, { error: "Busy right now. Please wait a moment and try again." });
    return json(502, { error: "The rewrite service had a problem. Try again shortly." });
  }

  // Success: pass Anthropic's JSON through unchanged so the frontend parser
  // (content[] + stop_reason, including the max_tokens truncation check) works as-is.
  const data = await upstream.text();
  return new Response(data, {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": CONFIG.allowOrigin },
  });
}

/* ---------- adapters ---------- */

// Web Fetch runtimes (Vercel Edge / Cloudflare Workers / Netlify / Deno):
//   export default { fetch: handle };           // Workers / Deno
//   export const POST = handle;                  // Next.js app router (route.js)
export { handle };
export default handle;

// Node / Express:
//   const express = require("express");
//   const app = express();
//   app.use(express.text({ type: "*/*", limit: "128kb" }));
//   app.post("/api/rewrite", async (req, res) => {
//     const r = await handle(new Request("http://x/api/rewrite", {
//       method: "POST", headers: req.headers, body: req.body,
//     }));
//     res.status(r.status);
//     r.headers.forEach((v, k) => res.setHeader(k, v));
//     res.send(await r.text());
//   });
//   app.listen(3000);
