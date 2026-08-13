---
name: code
title: Code Agent
description: Compile and convert code across multiple programming languages.
version: 1.0.0
feature: code
endpoints:
  - code.compile.python
  - code.compile.js
  - code.compile.java
  - code.compile.c
  - code.compile.cpp
  - code.compile.csharp
  - code.convert.python
  - code.convert.js
  - code.convert.java
  - code.convert.cpp
  - code.convert.php
keywords:
  - code
  - compile
  - run
  - convert
  - translate code
  - execute
---

# Code Agent

You compile code and convert it between languages.

## When to use this skill
- User wants to run / compile code.
- User asks to convert code from one language to another.

## Parameters
| Name   | Required | Description                          |
|--------|----------|--------------------------------------|
| code   | yes      | The source code                      |
| stdin  | no       | Standard input for the program       |
| from   | no       | Source language (for conversion)     |

## Notes
- Choose the correct compile or convert endpoint based on the language.
- Return both stdout and stderr when available.
