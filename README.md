# Canton Node

Private multi-tool generative hub. Vanilla HTML + Tailwind CDN + plain JS, deployed on Vercel with zero build step.

The Master Agent routes natural-language requests (chat, image, video, code, TTS, …) and executes them through resilient fallback chains. Specialist agent cards were removed — everything goes through Master; quotas live on the **Limits** tab.

**Live:** [canton-node.vercel.app](https://canton-node.vercel.app) · **Repo:** [awesomejoses11-code/Canton-Node](https://github.com/awesomejoses11-code/Canton-Node)

---

## Architecture

```
/
├── index.html              # Auth gate + Agents / Limits / Settings tabs
├── favicon.svg             # Neon circuit badge
├── vercel.json
├── tools.json              # Endpoint registry hints
├── skills.json             # Skill index → skills/*/SKILL.md
├── mcp-config.json         # MCP servers (optional)
├── api/
│   ├── master.js           # Router: OpenRouter free models → HF Qwen/Llama backup
│   ├── image.js            # Image: HF FLUX.1-schnell → Prexzy
│   ├── video.js            # Video: Pixazo LTX → Pyramid Flow → Prexzy
│   ├── video-status.js     # Pixazo task_id polling (key stays server-side)
│   └── log.js              # Optional client event log
├── js/
│   ├── quota.js            # Per-user daily limits (localStorage, midnight refresh)
│   ├── auth.js             # Sign-in / register (salted SHA-256, local)
│   ├── settings.js         # Theme, accent, defaults
│   ├── api.js              # PrexzyAPI: call / callResilient / generateImage / generateVideo
│   ├── skill-loader.js     # Loads skills.json + SKILL.md frontmatter
│   ├── hub.js              # Quota dashboard + media wire (image.* / video.* → /api)
│   ├── history.js          # Chat history drawer
│   ├── output-actions.js   # Download / Copy media + code + Copy/Edit/Refresh
│   ├── prexzy-shim.js      # Safety net if api.js fails to load
│   └── master-client.js    # Master UI: route → Execute → media render
└── skills/
    ├── image-generator/
    ├── video-generator/
    ├── music-generator/
    ├── tts/
    └── code/
```

---

## Generation chains

| Feature | Primary | Backups |
|---------|---------|---------|
| **Routing** (Master) | OpenRouter free-model chain | HF Qwen2.5-7B → Llama-3.1-8B |
| **Image** | Hugging Face **FLUX.1-schnell** | Prexzy (genimage → txt2img → dalle → aiwriter) |
| **Video** | **Pixazo LTX** (async + poll) | Pyramid Flow (HF) → Prexzy |

Client helpers:

```js
await PrexzyAPI.generateImage({ prompt, size }, { loadingEl })
await PrexzyAPI.generateVideo({ prompt, duration: 5 }, { loadingEl, poll: true })
```

`hub.js` also redirects `callResilient('image.*' | 'video.*')` through those helpers so skills never hit Prexzy first.

---

## Daily quotas (per signed-in user)

Stored in `localStorage` under `prexzy.quota.v2.<email>`, reset at local midnight.

| Bucket | Limit / day |
|--------|-------------|
| Master Agent routing | **80** |
| Text / chat | 80 |
| TTS | 50 |
| Code | 50 |
| Web | 30 |
| Image → HTML | 25 |
| HTML → Image | 15 |
| **Image** | **12** |
| Music | 8 |
| **Video** | **4** |

Failed requests refund the consumed unit.

---

## Environment variables (Vercel)

| Variable | Required | Used for |
|----------|----------|----------|
| `HF_TOKEN` | Strongly recommended | Image (FLUX), video (Pyramid), Master routing backup |
| `PIXAZO_API_KEY` | For video | Pixazo LTX primary path |
| `OPENROUTER_API_KEY` | Optional | Master free-model router (may work without on some setups) |

No Prexzy API key is required for the public endpoints used here.

---

## Local development

```bash
# Full stack (UI + /api/* serverless)
npx --yes vercel dev

# Static UI only (master / image / video APIs will 404)
python3 -m http.server 8080
```

Open the URL Vercel prints (usually `http://localhost:3000`).

---

## Deploy

```bash
npx --yes vercel deploy --prod
```

Set the env vars above in the Vercel project settings, then redeploy.

---

## Auth & settings

- **Auth** is local-only: accounts and salted password hashes live in `localStorage`. “Keep me signed in” uses a 30-day session; otherwise sessionStorage for the tab.
- **Settings:** display name, theme (system/light/dark), accent color, default code language, image size, TTS voice, routing mode (auto/manual), confirm-before-heavy-calls.

---

## Skills

`skills.json` points at `skills/*/SKILL.md` files (YAML frontmatter + body). `js/skill-loader.js` loads them at runtime. Image and video skills document the server chains above; execution still goes through Master + `PrexzyAPI`.

---

## Notes

- Specialist homepage cards were removed; Master routes everything.
- Media responses (including nested Prexzy/DALL·E `image_url` shapes) are walked recursively so images actually render.
- `output-actions.js` adds **Download** / **Copy image|link** under media and **Copy / Edit / Refresh** under assistant bubbles.
- Video generation is slow (often 30–90s) and scarce (4/day) — loading UI is required.

---

## License

See [LICENSE](./LICENSE).
