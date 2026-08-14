/* =========================================================================
 * api/analyze-attachment.js — vision/OCR/text analysis for Master attachments
 * ========================================================================= */

var OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

async function safeText(resp) {
  try { return await resp.text(); } catch (_) { return ''; }
}

/**
 * @param {string} message
 * @param {{name?:string,type?:string,kind?:string,text?:string,dataUrl?:string}} attachment
 * @param {Array} history
 * @param {object} prefs
 * @param {(msg:string, history:any, prefs:any, mcp:any) => Promise<{text:string,model:string,provider:string,attempts:any[]}>} tryGenerateAnswer
 */
async function analyzeAttachment(message, attachment, history, prefs, tryGenerateAnswer) {
  var attempts = [];
  if (!attachment) return { text: null, attempts: attempts };

  var thinkingLines = [
    '1. Read the user request and the attached file metadata.',
    '2. Attachment: ' + (attachment.name || 'file') + ' (' + (attachment.type || attachment.kind || 'unknown') + ').',
    '3. Choose path: image → vision/OCR; text → direct read; other → describe limits.',
    '4. Produce a clear, structured answer for the user.'
  ];

  if (attachment.kind === 'text' && attachment.text) {
    var clip = String(attachment.text).slice(0, 60000);
    var userContent = String(message || 'Summarize and analyze this file.') +
      '\n\n--- File: ' + (attachment.name || 'attachment') + ' ---\n' + clip;
    var gen = await tryGenerateAnswer(userContent, history, prefs, []);
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
    var prompt = String(message || 'Analyze this image. Describe it, read any visible text (OCR), and note important details. If asked for HTML/website from the image, output clean semantic HTML.');
    var visionModels = [
      { model: 'google/gemma-3-27b-it:free', label: 'Gemma 3 27B free' },
      { model: 'nvidia/nemotron-nano-12b-v2-vl:free', label: 'Nemotron VL free' },
      { model: 'meta-llama/llama-4-scout:free', label: 'Llama 4 Scout free' }
    ];
    var key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      return {
        text: 'OPENROUTER_API_KEY is not set — cannot run vision/OCR. Add the key in Vercel env and redeploy.',
        model: null,
        provider: null,
        attempts: [{ endpoint: 'openrouter', error: 'OPENROUTER_API_KEY not set' }],
        thinking: thinkingLines.join('\n'),
        server_executed: true
      };
    }
    for (var i = 0; i < visionModels.length; i++) {
      var vm = visionModels[i];
      try {
        var messages = [
          {
            role: 'system',
            content: 'You are a careful vision assistant. Do OCR when text is present. Describe layout, objects, and anything relevant. If the user wants HTML/website from the image, output clean semantic HTML only when asked.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: attachment.dataUrl } }
            ]
          }
        ];
        var resp = await fetch(OPENROUTER_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + key,
            'HTTP-Referer': 'https://canton-node.vercel.app',
            'X-Title': 'Canton Node'
          },
          body: JSON.stringify({ model: vm.model, messages: messages, max_tokens: 1200 }),
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
          return {
            text: text,
            model: vm.label,
            provider: 'openrouter',
            attempts: attempts,
            thinking: thinkingLines.join('\n'),
            server_executed: true
          };
        }
        attempts.push({ endpoint: vm.model, error: 'empty' });
      } catch (e) {
        attempts.push({ endpoint: vm.model, error: e.message });
      }
    }
    return {
      text: 'Could not analyze the image with available vision models. Try a smaller/clearer image.\n\nAttempts: ' +
        attempts.map(function (a) { return a.endpoint + ': ' + a.error; }).join('; '),
      model: null,
      provider: null,
      attempts: attempts,
      thinking: thinkingLines.join('\n'),
      server_executed: true
    };
  }

  return {
    text: 'This file type is attached (' + (attachment.type || attachment.kind) + ') but full binary analysis is not enabled yet. Prefer images or text files (.txt, .md, .json, .csv, code).',
    model: null,
    provider: null,
    attempts: attempts,
    thinking: thinkingLines.join('\n'),
    server_executed: true
  };
}

module.exports = { analyzeAttachment: analyzeAttachment };
