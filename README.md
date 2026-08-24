# Canton Node

**Open-source multi-tool generative hub.** Vanilla HTML + Tailwind CDN + plain JS, deployed on Vercel with zero build step.

The **Master Agent** routes natural-language requests (chat, image, video, music, TTS, code, file edit, …), streams answers in real time, and can call live tools (web search, page browse, MCP inventory) via **GLM-5.2** `tool_stream`.

| | |
|--|--|
| **Live demo** | [canton-node.vercel.app](https://canton-node.vercel.app) |
| **Source / Docs** | [github.com/awesomejoses11-code/Canton-Node](https://github.com/awesomejoses11-code/Canton-Node) |

---

## Features

- **Master Agent** — chat, web, code, file edit, media routing
- **SSE streaming** — progressive tokens for chat, code, and file attachments
- **GLM-5.2 primary** — deep thinking, high output limits, native tools
- **Tool loop** — `web_search`, `browse_url`, `list_connected_mcps` with recovery if the model narrates tools as text
- **Google sign-in** — GIS One Tap / button → same Neon session as email auth
- **MCP** — connect servers; inventory in every prompt
- **Kernel stealth browse** — when `KERNEL_API_KEY` is set
- **Vector / reference memory** — learn from docs while working
- **History merge** — local ∪ server so logins don’t wipe chats
- **Personalization** — display name + reply tone

---

## Environment variables (Vercel)

| Variable | Purpose |
|----------|---------|
| `ZAI_API_KEY` / `ZHIPU_API_KEY` | Primary chat (GLM-5.2) |
| `VINCI_API_KEY` | Chat fallback |
| `OPENROUTER_API_KEY` | Free models + vision |
| `HF_TOKEN` | HF chat + FLUX images |
| `KERNEL_API_KEY` | Stealth page browse |
| `GOOGLE_CLIENT_ID` | Google sign-in |
| `DATABASE_URL` | Neon auth / history / memory |
| `MUAPI_API_KEY` / `PIXAZO_API_KEY` | Video |

---

## How Master tools work

1. Model may emit **structured** `tool_calls` (preferred) or, rarely, text like `web_search: "…"`.
2. Server executes tools and continues the conversation.
3. If the reply is only “I’ll search…”, a **recovery pass** runs a forced web search and synthesizes a real answer.
4. Tool names are stripped from user-facing Markdown.

---

## Local / deploy

```bash
git clone https://github.com/awesomejoses11-code/Canton-Node.git
cd Canton-Node
npx serve .   # optional static check
# Link the repo to Vercel and set env vars, then deploy
```

---

## License

MIT — use, modify, and deploy freely. A link back to the repo is appreciated.
