# Email Desk

A single-page CSM email tool for ecoPortal Customer Success. Paste a draft, check it
for AI tells, pick what to fix, and get back a cleaner version with the tone dialled in —
formatting (bullets, bold, links) survives the round-trip to Gmail.

## How it's hosted

Two pieces, because the browser must never hold the Anthropic API key:

| Piece | Where | What it does |
|---|---|---|
| Frontend (`ecoportal-csm-email-desk.html`) | **GitHub Pages** (static) | The whole UI. Calls the backend for rewrites. |
| Backend proxy (`supabase/functions/rewrite`) | **Supabase Edge Function** | Holds the API key, adds `anthropic-version`, pins model/max_tokens, rate-limits, proxies to Anthropic. |

`index.html` just redirects to the app. `proxy.example.js` is the same proxy in
generic Web-Fetch form (Vercel/Cloudflare/Netlify/Node) if you ever move off Supabase.

## Deploy the backend (Supabase)

1. **Add the secret** — Supabase dashboard → your project → *Project Settings → Edge
   Functions → Secrets* (or `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`).
2. **Deploy the function** — dashboard *Edge Functions → Deploy a new function* named
   `rewrite`, paste `supabase/functions/rewrite/index.ts`, and turn **off** "Enforce JWT
   verification" (the public page calls it without a Supabase login). CLI equivalent:
   `supabase functions deploy rewrite --no-verify-jwt`.
3. **Get the URL** — `https://<your-project-ref>.supabase.co/functions/v1/rewrite`.

## Point the frontend at it

In `ecoportal-csm-email-desk.html`, in the `CONFIG` block near the top of the script:

```js
endpoint: "https://<your-project-ref>.supabase.co/functions/v1/rewrite",
useStructuredOutput: true,
```

Commit and push; GitHub Pages redeploys in a minute or two.

## Security / cost notes

- The API key lives **only** in the Supabase secret. Never put it in the HTML.
- The function rate-limits per IP and caps request size, but the in-memory limiter is
  best-effort (per isolate). For an open-to-the-internet deployment, back it with a
  Supabase table or Upstash, or put the function behind auth.
- This is a prototype. Always read a rewrite before sending — especially dates, ticket
  numbers, prices, and anything you've committed to.
