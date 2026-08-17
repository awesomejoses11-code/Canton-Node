# Canton Node

**Open-source multi-tool generative hub.** Vanilla HTML + Tailwind CDN + plain JS, deployed on Vercel with zero build step.

The **Master Agent** routes natural-language requests (chat, image, video, music, TTS, code, file edit, …), streams answers in real time, and can call live tools (web search, page browse, MCP inventory) via **GLM-5.2** `tool_stream`.

- **Live demo:** [canton-node.vercel.app](https://canton-node.vercel.app)
- **Source code:** [github.com/awesomejoses11-code/Canton-Node](https://github.com/awesomejoses11-code/Canton-Node)

---

## Features

- **Master Agent** — chat, web, code, file edit, media routing
- **SSE streaming** — progressive tokens for all standard LLM paths (including file attachments)
- **GLM-5.2 primary** — deep thinking, high output limits, native tools (`web_search`, `browse_url`, `list_connected_mcps`)
- **Tool streaming** — `tool_stream=true` on Zhipu; agentic loop up to 3 tool rounds
- **Media chains**
  - Image: Hugging Face FLUX → Prexzy
  - Video: MuAPI → Pixazo → Pyramid Flow → Prexzy
  - Music / TTS: Prexzy endpoints via Execute
- **MCP** — connect servers; inventory injected into every prompt; client Execute for tool calls
- **Kernel stealth browse** — optional live page extract when `KERNEL_API_KEY` is set
- **Vector / reference memory** — learn from docs and user logs while working
- **Personalization** — display name + reply tone
- **Session history** — local + optional server sync

---

## Architecture

```
/
├── index.html
├── api/
│   ├── master.js           # Router + GLM-5.2 agent loop + SSE
│   ├── image.js / video.js # Media chains
│   └── …
├── lib/
│   ├── llm-stream.js       # SSE parser + tool_calls assembly
│   ├── master-tools.js     # web_search / browse_url / list_connected_mcps
│   ├── analyze-attachment.js
│   ├── kernel-lib.js
│   └── memory-index.js
├── js/
│   ├── master-client.js    # UI + SSE consumer
│   └── …
└── README.md
```

---

## Environment variables (Vercel)

| Variable | Purpose |
|----------|---------|
| `ZAI_API_KEY` / `ZHIPU_API_KEY` | **Primary** chat (GLM-5.2) |
| `VINCI_API_KEY` | Chat fallback |
| `OPENROUTER_API_KEY` | Free model fallback + vision |
| `HF_TOKEN` | HF chat + FLUX images |
| `KERNEL_API_KEY` | Stealth page browse |
| `MUAPI_API_KEY` / `PIXAZO_API_KEY` | Video |
| Database URL (if used) | Auth / memory |

Set in Vercel → Project → Settings → Environment Variables, then redeploy.

---

## How Master works

```
You type (or attach a file)
  → client always requests stream: true
  → heuristic route (media / browse / web / chat)
  → GLM-5.2 streams tokens (and tool calls when needed)
  → tools run server-side → model continues → final answer
  → media tools: route card → ▶ Execute
```

Under every reply: **Copy** · **Edit prompt** · **Regenerate**.

---

## Local / deploy

Static site + serverless `api/*`. No build step.

```bash
git clone https://github.com/awesomejoses11-code/Canton-Node.git
cd Canton-Node
# optional local static check
npx serve .
# deploy: link the repo to Vercel
```

---

## License

Released as **open source**. You are free to use, modify, and deploy your own instance.

If you ship a public fork, a link back to [awesomejoses11-code/Canton-Node](https://github.com/awesomejoses11-code/Canton-Node) is appreciated.

```
MIT License — Copyright (c) 2026 Canton Node contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
```
