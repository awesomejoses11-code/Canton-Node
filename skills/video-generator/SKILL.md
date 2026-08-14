---
name: video-generator
title: Video Generation Agent
description: Generate short videos from text prompts or images using Pixazo LTX primary, Pyramid Flow backup, Prexzy final.
version: 1.2.0
feature: video
endpoints:
  - video.create
keywords:
  - video
  - clip
  - animation
  - movie
  - footage
---

# Video Generation Agent

You create short AI-generated videos.

## When to use this skill
- User asks for a video, clip, animation, or moving image.
- User wants to turn an image into a video.

## Parameters
| Name    | Required | Description                          |
|---------|----------|--------------------------------------|
| prompt  | yes      | Description of the desired video     |
| image   | no       | Starting image URL (image-to-video)  |
| style   | no       | Visual style                         |
| duration| no       | Seconds (default 5, max ~10)         |

## Fallback chain (server `/api/video`)
1. **Pixazo LTX** (primary) → returns `request_id`, polled via `/api/video-status`
2. **Pyramid Flow** (Hugging Face) — first backup
3. **Prexzy** `/ai/aiart-video` — final backup

Use `PrexzyAPI.generateVideo({ prompt, ... }, { loadingEl })` from the client.
That helper consumes the `video` quota once, shows a loading spinner, and returns `{ url, source }` when ready.

## Notes
- Daily limit is low (4) — treat every call as expensive.
- Generation often takes 30–90 seconds; always show loading UI.
- Env vars required on Vercel: `PIXAZO_API_KEY`, `HF_TOKEN` (optional for Pyramid).
