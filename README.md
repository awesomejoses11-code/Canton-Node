# Prexzy Multi-Tool Platform

Private, stable multi-tool generative platform built on the free
[Prexzy APIs](https://prexzyapis.com). Vanilla HTML + Tailwind CDN + plain
JS. Deployable to Vercel with zero build step.

## Current build step

**Step 1/7 — Static hub + quota + API wrapper.**

Files that exist so far:

    /
    ├── index.html            # Hub UI (master panel + quota dashboard + tool picker)
    ├── js/
    │   ├── quota.js          # Client-side daily rate limiter (localStorage)
    │   ├── api.js            # Prexzy fetch wrapper (calls go through here)
    │   └── hub.js            # Renders the dashboard + tool picker
    ├── tools.json            # Specialist agent registry
    ├── skills.json           # Skill index (empty; step 5)
    ├── mcp-config.json       # MCP servers (empty; step 6)
    └── vercel.json           # Vercel config (static site)

## Local test

Anything that serves static files works. Two easy options:

    # Python
    python3 -m http.server 8080

    # Or npx (no install)
    npx --yes serve .

Then open http://localhost:8080.

## Roadmap

1. ✅ Static hub + quota + api wrapper
2. Image Generation specialist (first end-to-end pattern)
3. Master Agent orchestrator
4. Convert agents into SKILL.md + skill loader
5. MCP client support
6. x402 awareness in the Web agent (starts report-only)
