# Canton Node — Prexzy Multi-Tool Platform

Private, stable multi-tool generative platform built on the free
[Prexzy APIs](https://prexzyapis.com). Vanilla HTML + Tailwind CDN + plain
JS. Deployable to Vercel with zero build step.

## What's in this build

**Step 3 rework — Prexzy-native master router + auth + per-user quotas.**

    /
    ├── index.html            # Auth gate + tabbed hub (Agents / Limits / Settings)
    ├── js/
    │   ├── quota.js          # Per-user daily rate limiter (localStorage, midnight auto-refresh)
    │   ├── auth.js           # Sign-in/register + session persistence (30-day or tab-scoped)
    │   ├── settings.js       # Per-user customization store (theme, accent, defaults)
    │   ├── api.js            # Prexzy fetch wrapper (all calls go through here)
    │   ├── hub.js            # Renders the dashboard + tool picker
    │   └── master-client.js  # Master Agent browser wiring (route → execute)
    ├── api/
    │   └── master.js         # Vercel serverless router — GPT-5.4 via Prexzy Chatex
    ├── tools.json            # Specialist agent registry
    ├── skills.json           # Skill index (empty; step 5)
    ├── mcp-config.json       # MCP servers (empty; step 6)
    └── vercel.json           # Vercel config (static site + /api functions)

## Key changes vs step 1

1. **Master router runs on Prexzy, not Anthropic.** The Anthropic keys were
   emptied, so `api/master.js` now routes with **GPT-5.4 (`/ai/chatex`)** —
   the most capable model on Prexzy — falling back to **GPT-5
   (`/ai/askgpt5`)** then **Mistral (`/ai/mistral`)**. No API key needed;
   no secrets in the repo. The router prompt asks for raw JSON and the
   function parses it defensively (fences stripped, first `{...}` block).

2. **Session persistence for logins.** `js/auth.js` keeps registered users
   as salted SHA-256 hashes in localStorage. "Keep me signed in" persists
   the session for 30 days (localStorage); unchecked it lives only in the
   tab (sessionStorage). Sessions auto-restore on load and expire cleanly.

3. **Quota integration + no reset button.** New `master` quota bucket
   (30/day) consumed by every routing request; the target agent's bucket is
   consumed on execution via `PrexzyAPI.call` as before. Quotas are scoped
   per account (`Quota.setScope(email)`) and refresh automatically at local
   midnight (timer + refresh-on-focus). The manual reset button is gone.

4. **Standard, aligned UI.** Single header grid: logo left, centered tab
   bar (Agents / Limits / Settings — uniform button base classes), user +
   logout right. Full dark-mode support across every view.

5. **User customization (Settings tab).** Display name, theme
   (system/light/dark), accent color (indigo/violet/emerald/rose/amber),
   default code language, default image size, default TTS voice (used by
   the rewired `/tts/<voice>` endpoint), master routing mode
   (auto/manual), confirm-before-heavy-calls, compact cards. All stored
   per account and applied instantly.

## Local test

Anything that serves static files works for the UI; the master router
needs Vercel dev for the `/api/master` function:

    # Full stack (recommended — includes /api/master)
    npx --yes vercel dev

    # Static only (hub, quota, auth — master routing will 404)
    python3 -m http.server 8080

Then open http://localhost:3000 (vercel dev) or http://localhost:8080.

## Deploy

    npx --yes vercel deploy --prod

No environment variables required — the router needs no keys anymore.

## Roadmap

1. ✅ Static hub + quota + api wrapper
2. Image Generation specialist (first end-to-end pattern)
3. ✅ Master Agent orchestrator (Prexzy GPT-5.4 router) + auth + settings
4. Convert agents into SKILL.md + skill loader
5. MCP client support
6. x402 awareness in the Web agent (starts report-only)
