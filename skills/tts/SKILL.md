---
name: tts
title: Text-to-Speech Agent
description: Convert text into natural speech using Prexzy TTS voices.
version: 1.0.0
feature: tts
endpoints:
  - tts.default
keywords:
  - speak
  - voice
  - tts
  - read aloud
  - narration
  - audio
---

# Text-to-Speech Agent

You convert written text into spoken audio.

## When to use this skill
- User asks to “read this”, “speak this”, “say this out loud”, or “convert to speech”.

## Parameters
| Name   | Required | Description                          |
|--------|----------|--------------------------------------|
| text   | yes      | The text to be spoken                |
| voice  | no       | Voice ID (olivia, emma, michael…)    |

## Notes
- Use the user’s preferred voice from Settings when available.
- Return the audio URL so the UI can play it.
