# Canton Node

Private multi-tool generative hub. Vanilla HTML + Tailwind CDN + plain JS, deployed on Vercel with zero build step.

The **Master Agent** routes natural-language requests (chat, image, video, music, TTS, code, …) and runs them through resilient fallback chains. Personalization (display name + reply tone) is stored per account and injected into Master chat answers.

**Live:** [canton-node.vercel.app](https://canton-node.vercel.app) · **Repo:** [awesomejoses11-code/Canton-Node](https://github.com/awesomejoses11-code/Canton-Node)

---

## Features

- **Master Agent router** — heuristic first, then Vinci → OpenRouter → Hugging Face
- **Media chains**
  - Image: Hugging Face FLUX → Prexzy
  - Video: MuAPI → Pixazo → Pyramid Flow → Prexzy
  - Music / TTS: Prexzy endpoints via Execute
- **Personalization** — display name + Master tone (friendly / professional / concise / technical / playful)
- **Session memory** — last turns sent with each chat request
- **Edit prompt / Regenerate / Copy** under assistant replies
- **Per-user daily quotas** (localStorage, midnight reset)
- **Chat history drawer** — local sessions per account

---

## Architecture

```
/
├── index.html              # Auth + Agents / Limits / Settings
├── favicon.svg
├── vercel.json
├── api/
│   ├── master.js           # Router + chat; accepts prefs { displayName, tone }
│   ├── image.js            # HF FLUX → Prexzy
│   ├── video.js            # MuAPI → Pixazo → Pyramid → Prexzy
│   ├── video-status.js     # Async video poll helper
│   └── log.js
├── js/
│   ├── quota.js
│   ├── auth.js
│   ├── settings.js         # Theme, accent, displayName, tone, defaults
│   ├── api.js              # PrexzyAPI (image/video/music/tts)
│   ├── history.js
│   ├── output-actions.js   # Copy / Edit prompt / Regenerate / media download
│   ├── master-client.js    # Master UI + Execute + prefs payload
│   ├── hub.js
│   └── prexzy-shim.js
└── README.md
```

---

## Environment variables (Vercel)

| Variable | Purpose |
|----------|---------|
| `VINCI_API_KEY` | Primary chat / route LLM (OpenAI-compatible) |
| `OPENROUTER_API_KEY` | Fallback free models |
| `HF_TOKEN` | Hugging Face (chat fallback + FLUX images) |
| `MUAPI_API_KEY` | Primary video generation |
| `PIXAZO_API_KEY` | Video fallback |
| Optional Prexzy / Pyramid keys | Final media fallbacks |

Set them in the Vercel project → Settings → Environment Variables, then redeploy.

---

## Personalization

Open **Settings** after sign-in:

1. **Display Name** — Master addresses you by this name in chat.
2. **Master Agent Tone** — shapes how answers are written:
   - Friendly · Professional · Concise · Technical · Playful

Saved per account on the device (`localStorage`). Each Master chat request sends `prefs: { displayName, tone }` to `/api/master`, which appends persona instructions to the system prompt.

Other settings: theme, accent, default image size, TTS voice, code language, confirm heavy calls, routing mode.

---

## How Master works

```
You type a request
  → heuristic route (image / video / music / capabilities / …)
  → else LLM route (Vinci → OpenRouter → HF)
  → chat/web: answer on server (with name + tone + history)
  → media tools: route card → press ▶ Execute → tool runs (quota)
```

Under every reply: **Copy** · **Edit prompt** · **Regenerate**.

---

## Local / deploy

Static site + serverless `api/*`. No build step.

```bash
# optional local check
npx serve .
# or link the repo to Vercel and deploy
```

---

## Quotas (default daily)

| Feature | Limit |
|---------|------:|
| Master routing | 80 |
| Image | 12 |
| Video | 4 |
| Music | 8 |
| TTS | 50 |
| Code | 50 |

Shown and enforced on the **Limits** tab.

---

## License

Private build — use and modify for your own deployment.
