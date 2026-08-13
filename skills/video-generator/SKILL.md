---
name: video-generator
title: Video Generation Agent
description: Generate short videos from text prompts or images using Prexzy AI video endpoints.
version: 1.0.0
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

## Notes
- Video generation is asynchronous. The create call returns a `task_id`.
- The UI must poll the status endpoint until the video is ready.
- Daily limit is very low (3) — treat every call as expensive.
