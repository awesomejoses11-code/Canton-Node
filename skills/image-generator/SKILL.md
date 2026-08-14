---
name: image-generator
title: Image Generation Agent
description: Generate high-quality images from text prompts using Hugging Face FLUX primary and Prexzy backup.
version: 1.1.0
feature: image
endpoints:
  - image.genimage
  - image.txt2img
  - image.dalle
  - image.aiwriter
keywords:
  - image
  - picture
  - photo
  - art
  - illustration
  - draw
  - painting
  - visual
---

# Image Generation Agent

You create images from natural language descriptions.

## When to use this skill
- The user asks to generate, draw, create, or make an image / picture / illustration / artwork.
- The request contains visual descriptions (e.g. “a cyberpunk city at night”, “portrait of a fox in watercolor”).

## Fallback chain (server `/api/image`)
1. **Hugging Face FLUX.1-schnell** (primary)
2. **Prexzy** endpoints (genimage → txt2img → dalle → aiwriter) — backup

Prefer `PrexzyAPI.generateImage({ prompt, size }, { loadingEl })` from the client.
That helper routes through `/api/image`, consumes the `image` quota once, and returns `{ url, source }`.

## Parameters
| Name    | Required | Description                                      | Example                  |
|---------|----------|--------------------------------------------------|--------------------------|
| prompt  | yes      | Full detailed description of the desired image   | "a red fox in a snowy forest, cinematic lighting" |
| size    | no       | Output size                                      | "1024x1024", "1024x1792", "1792x1024" |

## Instructions for the agent
- Always pass the complete user description as the `prompt`.
- If the user specifies orientation (portrait / landscape / square), map it to the correct `size`.
- After receiving the result, return the image URL (or base64 data) so the UI can display it.
- If the call fails, return a clear error message and the remaining quota for the `image` feature.

## Example
User: “Make a cinematic image of a lone samurai standing under cherry blossoms at dusk”
→ Call `PrexzyAPI.generateImage` with prompt = the full sentence above.
