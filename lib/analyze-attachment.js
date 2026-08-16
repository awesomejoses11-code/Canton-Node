/* lib/analyze-attachment.js — vision/OCR/text analysis + file edit */
var OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
var ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

async function safeText(resp) {
  try { return await resp.text(); } catch (_) { return ''; }
}

function openRouterHeaders(key) {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + key,
    'HTTP-Referer': 'https://canton-node.vercel.app',
    'X-Title': 'Canton Node'
  };
}

function visionModelList() {
  return [
    { model: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B free' },
    { model: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B free' },
    { model: 'nvidia/nemotron-nano-12b-v2-vl:free', label: 'Nemotron VL free' },
    { model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', label: 'Nemotron Omni free' },
    { model: 'google/gemma-3-27b-it', label: 'Gemma 3 27B' }
  ];
}

function wantsFileEdit(message) {
  var m = String(message || '').toLowerCase();
  if (/\b(edit|fix|modify|refactor|rewrite|update|change|patch|correct|repair|improve|optimize|convert|migrate|rename|add|remove|delete|implement|replace)\b/.test(m)) return true;
  if (/\b(make (it|this|the file)|please (edit|fix|update|change)|apply (the |these )?changes?|do (the |this )?edit)\b/.test(m)) return true;
  if (/\b(bug|error|broken|doesn'?t work|failing|crash)\b/.test(m) && /\b(file|code|script|function|class)\b/.test(m)) return true;
  return false;
}

function buildTextFilePrompt(message, attachment, clip, editMode) {
  var name = attachment.name || 'attachment';
  if (editMode) {
    return [
      'FILE EDIT TASK — you MUST apply the user\'s requested changes to the file below.',
      'Rules:',
      '1. Output the COMPLETE edited file in a single fenced code block (with language tag if known).',
      '2. The output file MUST differ from the input wherever the user asked for a change.',
      '3. Do NOT echo the original file unchanged. That is a failed edit.',
      '4. Do NOT only describe the changes — produce the full new file content.',
      '5. After the code block, list the concrete changes in a short bullet list (what lines/functions changed and why).',
      '6. Preserve unrelated code and style unless the user asked to restyle everything.',
      '',
      'User request:',
      String(message || 'Edit this file to fix obvious issues.'),
      '',
      '--- Original file: ' + name + ' (do not return this unchanged) ---',
      clip,
      '--- End original file ---',
      '',
      'Now output the FULL edited file, then a short change list.'
    ].join('\n');
  }
  return [
    String(message || 'Summarize and analyze this file completely. Do not truncate.'),
    '',
    '--- File: ' + name + ' ---',
    clip
  ].join('\n');
}

async function tryZhipuVision(prompt, dataUrl, attempts) {
  var key = process.env.ZAI_API_KEY || process.env.ZHIPU_API_KEY || process.env.BIGMODEL_API_KEY;
  if (!key) {
    attempts.push({ endpoint: 'zhipu-vision', error: 'ZAI_API_KEY not set' });
    return null;
  }
  var models = ['glm-4.5v', 'glm-4v-flash', 'glm-4v'];
  for (var i = 0; i < models.length; i++) {
    var model = models[i];
    try {
      var messages = [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }];
      var resp = await fetch(ZHIPU_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: model, messages: messages, max_tokens: 8000 }),
        signal: AbortSignal.timeout(90000)
      });
      if (!resp.ok) {
        var detail = await safeText(resp);
        attempts.push({ endpoint: model, error: 'HTTP ' + resp.status + ' — ' + detail.slice(0, 120) });
        continue;
      }
      var data = await resp.json();
      var msg = data && data.choices && data.choices[0] && data.choices[0].message;
      var text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text) return { text: text, model: model, provider: 'zhipu' };
      attempts.push({ endpoint: model, error: 'empty' });
    } catch (e) {
      attempts.push({ endpoint: model, error: e.message });
    }
  }
  return null;
}

async function tryOpenRouterVision(prompt, dataUrl, attempts) {
  var key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    attempts.push({ endpoint: 'openrouter', error: 'OPENROUTER_API_KEY not set' });
    return null;
  }
  var visionModels = visionModelList();
  for (var i = 0; i < visionModels.length; i++) {
    var vm = visionModels[i];
    try {
      var messages = [
        {
          role: 'system',
          content: 'You are a careful vision assistant. Describe the image, do OCR when text is present, and answer the user question completely. Never truncate mid-sentence. If it is a meme, name it and give origin when you know it.'
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ];
      var resp = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: openRouterHeaders(key),
        body: JSON.stringify({ model: vm.model, messages: messages, max_tokens: 8000 }),
        signal: AbortSignal.timeout(90000)
      });
      if (!resp.ok) {
        var detail = await safeText(resp);
        attempts.push({ endpoint: vm.model, error: 'HTTP ' + resp.status + ' — ' + detail.slice(0, 140) });
        continue;
      }
      var data = await resp.json();
      var msg = data && data.choices && data.choices[0] && data.choices[0].message;
      var text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text) return { text: text, model: vm.label, provider: 'openrouter' };
      attempts.push({ endpoint: vm.model, error: 'empty' });
    } catch (e) {
      attempts.push({ endpoint: vm.model, error: e.message });
    }
  }
  return null;
}

function looksLikeUnchangedEcho(original, response) {
  if (!original || !response) return false;
  var strip = function (s) {
    return String(s).replace(/```[\w+-]*\n?/g, '').replace(/```/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  };
  var a = strip(original);
  var b = strip(response);
  if (a.length < 40) return false;
  if (b.indexOf(a.slice(0, Math.min(400, a.length))) >= 0) {
    var ratio = Math.abs(b.length - a.length) / Math.max(a.length, 1);
    if (ratio < 0.08) return true;
  }
  if (a === b) return true;
  return false;
}

async function analyzeAttachment(message, attachment, history, prefs, tryGenerateAnswer) {
  var attempts = [];
  if (!attachment) return { text: null, attempts: attempts };

  var thinkingLines = [
    '1. Read the user request and the attached file metadata.',
    '2. Attachment: ' + (attachment.name || 'file') + ' (' + (attachment.type || attachment.kind || 'unknown') + ').',
    '3. Choose path: image → vision/OCR; text → read or EDIT; other → describe limits.',
    '4. If the user asked to edit, produce a changed full file — never echo the original.'
  ];

  if (attachment.kind === 'text' && attachment.text) {
    var clip = String(attachment.text).slice(0, 120000);
    var editMode = wantsFileEdit(message);
    thinkingLines.push(editMode
      ? '5. Edit mode ON — applying requested changes and returning the full modified file.'
      : '5. Analyze/summarize mode.');
    var userContent = buildTextFilePrompt(message, attachment, clip, editMode);
    var gen = await tryGenerateAnswer(userContent, history, prefs, null, { web: false, code: true, edit: editMode });
    var outText = gen && gen.text ? gen.text : null;

    if (editMode && outText && looksLikeUnchangedEcho(clip, outText) && typeof tryGenerateAnswer === 'function') {
      thinkingLines.push('6. Detected unchanged echo — retrying with stricter edit instructions.');
      var retryPrompt = [
        'CRITICAL: Your previous reply returned the file essentially unchanged. That is unacceptable.',
        'Apply the user\'s edit request NOW. The output file MUST be different from the input.',
        '',
        buildTextFilePrompt(message, attachment, clip, true)
      ].join('\n');
      var retry = await tryGenerateAnswer(retryPrompt, history, prefs, null, { web: false, code: true, edit: true });
      if (retry && retry.text) {
        outText = retry.text;
        gen = retry;
      }
    }

    return {
      text: outText,
      model: gen ? gen.model : null,
      provider: gen ? gen.provider : null,
      attempts: (gen && gen.attempts) ? gen.attempts : attempts,
      thinking: thinkingLines.join('\n'),
      server_executed: true
    };
  }

  if (attachment.kind === 'image' && attachment.dataUrl) {
    var prompt = String(message || 'Analyze this image. Describe it, OCR any text, and note important details. Be complete.');
    var z = await tryZhipuVision(prompt, attachment.dataUrl, attempts);
    if (z && z.text) {
      return { text: z.text, model: z.model, provider: z.provider, attempts: attempts, thinking: thinkingLines.join('\n'), server_executed: true };
    }
    var or = await tryOpenRouterVision(prompt, attachment.dataUrl, attempts);
    if (or && or.text) {
      return { text: or.text, model: or.model, provider: or.provider, attempts: attempts, thinking: thinkingLines.join('\n'), server_executed: true };
    }
    thinkingLines.push('5. Vision models unavailable — using web search on the question.');
    if (typeof tryGenerateAnswer === 'function') {
      try {
        var webPrompt = prompt + '\n\n(Note: an image was attached named "' + (attachment.name || 'image') + '" but local vision models failed. Search the web for the likely answer. Be honest if you cannot see the pixels. Answer completely.)';
        var webGen = await tryGenerateAnswer(webPrompt, history, prefs, null, { web: true });
        if (webGen && webGen.text) {
          return {
            text: webGen.text + '\n\n_Vision OCR was unavailable; this answer used web search on your question._',
            model: (webGen.model || 'web') + ' · vision-fallback',
            provider: webGen.provider || 'web',
            attempts: attempts.concat(webGen.attempts || []),
            thinking: thinkingLines.join('\n'),
            server_executed: true,
            web: true
          };
        }
        if (webGen && webGen.attempts) attempts = attempts.concat(webGen.attempts);
      } catch (e) {
        attempts.push({ endpoint: 'web-fallback', error: e.message });
      }
    }
    return {
      text: 'Could not analyze the image with available vision models, and web search did not return a usable answer.\n\nAttempts: ' + attempts.map(function (a) { return a.endpoint + ': ' + a.error; }).join('; '),
      model: null, provider: null, attempts: attempts, thinking: thinkingLines.join('\n'), server_executed: true
    };
  }

  return {
    text: 'This file type (' + (attachment.type || attachment.kind) + ') is not fully supported. Prefer images or text files.',
    model: null, provider: null, attempts: attempts, thinking: thinkingLines.join('\n'), server_executed: true
  };
}

module.exports = { analyzeAttachment: analyzeAttachment, wantsFileEdit: wantsFileEdit };
