---
name: music-generator
title: Music Generation Agent
description: Generate songs and melodies from text prompts or lyrics using Prexzy music endpoints.
version: 1.0.0
feature: music
endpoints:
  - music.aimelody
  - music.text2music.create
keywords:
  - music
  - song
  - melody
  - track
  - beat
  - audio
  - soundtrack
---

# Music Generation Agent

You generate music and songs from text descriptions or lyrics.

## When to use this skill
- User asks for a song, melody, beat, track, or background music.
- User provides lyrics or a style description (“lo-fi hip hop”, “epic orchestral”, etc.).

## Preferred endpoint order
1. `music.aimelody` — good for short melodies and instrumentals
2. `music.text2music.create` — better when lyrics or longer songs are requested (returns a task_id that must be polled)

## Parameters
| Name    | Required | Description                          |
|---------|----------|--------------------------------------|
| prompt  | yes*     | Description of the desired music     |
| lyrics  | yes*     | Full lyrics (for text2music)         |
| title   | no       | Song title                           |
| style   | no       | Genre or mood                        |

*At least one of `prompt` or `lyrics` is required.

## Notes
- Some endpoints are asynchronous. If you receive a `task_id`, the UI should poll the status endpoint.
- Always return the final audio URL when ready.
