/* lib/analyze-attachment.js — vision/OCR/text analysis + web fallback */
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
      var messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ];
      var resp = await fetch(ZHIPU_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + key
        },
        body: JSON.stringify({ model: model, messages: messages, max_tokens: 1500 }),
        signal: AbortSignal.timeout(60000)
      });
      if (!resp.ok) {
        var detail = await safeText(resp);
        attempts.push({ endpoint: model, error: 'HTTP ' + resp.status + ' — ' + detail.slice(0, 120) });
        continue;
      }
      var data = await resp.json();
      var msg = data && data.choices && data.choices[0] && data.choices[0].message;
      var text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text) {
        return { text: text, model: model, provider: 'zhipu' };
      }
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
          content:
            'You are a careful vision assistant. Describe the image, do OCR when text is present, ' +
            'and answer the user question. If it is a meme, name it and give origin when you know it.'
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
        body: JSON.stringify({ model: vm.model, messages: messages, max_tokens: 1500 }),
        signal: AbortSignal.timeout(55000)
      });
      if (!resp.ok) {
        var detail = await safeText(resp);
        attempts.push({ endpoint: vm.model, error: 'HTTP ' + resp.status + ' — ' + detail.slice(0, 140) });
        continue;
      }
      var data = await resp.json();
      var msg = data && data.choices && data.choices[0] && data.choices[0].message;
      var text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text) {
        return { text: text, model: vm.label, provider: 'openrouter' };
      }
      attempts.push({ endpoint: vm.model, error: 'empty' });
    } catch (e) {
      attempts.push({ endpoint: vm.model, error: e.message });
    }
  }
  return null;
}

async function analyzeAttachment(message, attachment, history, prefs, tryGenerateAnswer) {
  var attempts = [];
  if (!attachment) return { text: null, attempts: attempts };

  var thinkingLines = [
    '1. Read the user request and the attached file metadata.',
    '2. Attachment: ' + (attachment.name || 'file') + ' (' + (attachment.type || attachment.kind || 'unknown') + ').',
    '3. Choose path: image → vision/OCR; text → direct read; other → describe limits.',
    '4. If vision fails, fall back to web search on the user question.'
  ];

  if (attachment.kind === 'text' && attachment.text) {
    var clip = String(attachment.text).slice(0, 60000);
    var userContent =
      String(message || 'Summarize and analyze this file.') +
      '\n\n--- File: ' + (attachment.name || 'attachment') + ' ---\n' +
      clip;
    var gen = await tryGenerateAnswer(userContent, history, prefs, null, { web: false });
    return {
      text: gen.text,
      model: gen.model,
      provider: gen.provider,
      attempts: gen.attempts || attempts,
      thinking: thinkingLines.join('\n'),
      server_executed: true
    };
  }

  if (attachment.kind === 'image' && attachment.dataUrl) {
    var prompt = String(
      message || 'Analyze this image. Describe it, OCR any text, and note important details.'
    );

    var z = await tryZhipuVision(prompt, attachment.dataUrl, attempts);
    if (z && z.text) {
      return {
        text: z.text,
        model: z.model,
        provider: z.provider,
        attempts: attempts,
        thinking: thinkingLines.join('\n'),
        server_executed: true
      };
    }

    var or = await tryOpenRouterVision(prompt, attachment.dataUrl, attempts);
    if (or && or.text) {
      return {
        text: or.text,
        model: or.model,
        provider: or.provider,
        attempts: attempts,
        thinking: thinkingLines.join('\n'),
        server_executed: true
      };
    }

    thinkingLines.push('5. Vision models unavailable — using web search on the question.');
    if (typeof tryGenerateAnswer === 'function') {
      try {
        var webPrompt =
          prompt +
          '\n\n(Note: an image was attached named "' +
          (attachment.name || 'image') +
          '" but local vision models failed. ' +
          'Search the web for the likely answer — e.g. meme name and origin if this is a meme question. ' +
          'Be honest if you cannot see the pixels.)';
        var webGen = await tryGenerateAnswer(webPrompt, history, prefs, null, { web: true });
        if (webGen && webGen.text) {
          return {
            text:
              webGen.text +
              '\n\n_Vision OCR was unavailable; this answer used web search on your question._',
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
      text:
        'Could not analyze the image with available vision models, and web search did not return a usable answer.\n\nAttempts: ' +
        attempts
          .map(function (a) {
            return a.endpoint + ': ' + a.error;
          })
          .join('; '),
      model: null,
      provider: null,
      attempts: attempts,
      thinking: thinkingLines.join('\n'),
      server_executed: true
    };
  }

  return {
    text:
      'This file type (' +
      (attachment.type || attachment.kind) +
      ') is not fully supported. Prefer images or text files.',
    model: null,
    provider: null,
    attempts: attempts,
    thinking: thinkingLines.join('\n'),
    server_executed: true
  };
}

module.exports = { analyzeAttachment: analyzeAttachment };
