---
name: image-generator
title: Image Generation Agent
description: Generate high-quality images from text prompts using Prexzy AI art endpoints.
version: 1.0.0
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

## Preferred endpoint order
1. `image.genimage` — best overall quality
2. `image.txt2img`
3. `image.dalle`
4. `image.aiwriter` — fallback

## Parameters
| Name    | Required | Description                                      | Example                  |
|---------|----------|--------------------------------------------------|--------------------------|
| prompt  | yes      | Full detailed description of the desired image   | "a red fox in a snowy forest, cinematic lighting" |
| size    | no       | Output size                                      | "1024x1024", "1024x1792", "1792x1024" |
| steps   | no       | Diffusion steps (if supported)                   | 30                       |

## Instructions for the agent
- Always pass the complete user description as the `prompt`.
- If the user specifies orientation (portrait / landscape / square), map it to the correct `size`.
- After receiving the result, return the image URL (or base64 data) so the UI can display it.
- If the call fails, return a clear error message and the remaining quota for the `image` feature.

## Example
User: “Make a cinematic image of a lone samurai standing under cherry blossoms at dusk”
→ Call `image.genimage` with prompt = the full sentence above.
