/* =========================================================================
 * api/video.js — Video generation with fallback chain
 *
 * Chain (confirmed 2026-08-14):
 *   1. Pixazo LTX (primary)
 *   2. Prexzy (backup)
 *   3. Pyramid Flow / HF (last resort)
 *
 * POST /api/video
 * Body: { prompt, duration?, resolution?, imageUrl?, poll?: true }
 * ========================================================================= */

const PREXZY_BASE = 'https://prexzyapis.com';

async function pollPixazo(taskId, apiKey, {
  intervalMs = 5000,
  timeoutMs  = 4 * 60 * 1000
} = {}) {
  const started = Date.now();
  const url = 'https://gateway.pixazo.ai/v2/requests/status/' + encodeURIComponent(taskId);

  while (true) {
    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey }
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error('Pixazo status ' + res.status + ': ' + text.slice(0, 200));
    }

    const data = await res.json();
    const status = String(data.status || '').toUpperCase();

    if (status === 'COMPLETED') {
      const media = data.output && data.output.media_url;
      const videoUrl = Array.isArray(media) ? media[0] : media;
      if (!videoUrl) throw new Error('Pixazo completed but no media_url');
      return { url: videoUrl, status: 'COMPLETED', source: 'pixazo-ltx', raw: data };
    }

    if (status === 'FAILED' || status === 'ERROR') {
      throw new Error(data.error || ('Pixazo ' + status));
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error('Pixazo polling timed out');
    }

    await new Promise(function (r) { setTimeout(r, intervalMs); });
  }
}

async function tryPixazo(prompt, options) {
  const pixazoKey = process.env.PIXAZO_API_KEY;
  if (!pixazoKey) throw new Error('PIXAZO_API_KEY not set');

  const body = {
    prompt: prompt,
    model: 'ltx-v2-3-free',
    duration: options.duration,
    resolution: options.resolution
  };
  if (options.imageUrl) body.image_url = options.imageUrl;

  const res = await fetch('https://gateway.pixazo.ai/ltx-video/v1/text-to-video', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': pixazoKey
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('Pixazo ' + res.status + ': ' + text.slice(0, 300));
  }

  const data = await res.json();
  const taskId = data.request_id || data.id || data.job_id;

  if (!taskId) {
    if (data.output && data.output.media_url) {
      const media = data.output.media_url;
      return {
        url: Array.isArray(media) ? media[0] : media,
        status: data.status || 'COMPLETED',
        source: 'pixazo-ltx',
        raw: data
      };
    }
    throw new Error('Pixazo response missing request_id');
  }

  if (!options.poll) {
    return {
      task_id: taskId,
      status: data.status || 'QUEUED',
      poll_url: data.polling_url || null,
      source: 'pixazo-ltx'
    };
  }

  return await pollPixazo(taskId, pixazoKey);
}

async function tryPrexzy(prompt, options) {
  const usp = new URLSearchParams({ prompt: prompt });
  if (options.imageUrl) usp.set('image', options.imageUrl);
  if (options.style) usp.set('style', options.style);

  const res = await fetch(PREXZY_BASE + '/ai/aiart-video?' + usp.toString(), {
    method: 'GET',
    signal: AbortSignal.timeout(25000)
  });

  if (!res.ok) throw new Error('Prexzy video HTTP ' + res.status);

  const data = await res.json().catch(function () { return null; });
  if (data && (data.url || data.video_url || data.video || data.task_id)) {
    return {
      url: data.url || data.video_url || data.video || null,
      task_id: data.task_id || null,
      source: 'prexzy',
      raw: data
    };
  }
  throw new Error('Prexzy video: no usable payload');
}

async function tryPyramid(prompt, options) {
  const hfToken = process.env.HF_TOKEN;
  if (!hfToken) throw new Error('HF_TOKEN not set');

  const res = await fetch(
    'https://api-inference.huggingface.co/models/rain1011/pyramid-flow-miniflux',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + hfToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          num_frames: Math.round(options.duration * 24),
          height: 384,
          width: 640
        }
      }),
      signal: AbortSignal.timeout(90000)
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error('Pyramid Flow ' + res.status + ': ' + text.slice(0, 300));
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('video') || contentType.includes('octet-stream')) {
    return {
      source: 'pyramid-flow',
      status: 'binary',
      note: 'HF returned binary video; prefer Pixazo/Prexzy for durable URLs.'
    };
  }

  const data = await res.json();
  return Object.assign({}, data, { source: 'pyramid-flow' });
}

async function generateVideoWithFallback(prompt, options) {
  const opts = {
    duration: options.duration || 5,
    resolution: options.resolution || '720p',
    imageUrl: options.imageUrl || null,
    poll: options.poll !== false,
    style: options.style
  };

  const errors = [];

  // 1) Pixazo primary
  try {
    return await tryPixazo(prompt, opts);
  } catch (err) {
    console.warn('[Video] Pixazo failed → Prexzy', err.message);
    errors.push('Pixazo: ' + err.message);
  }

  // 2) Prexzy backup
  try {
    return await tryPrexzy(prompt, opts);
  } catch (err) {
    console.warn('[Video] Prexzy failed → Pyramid', err.message);
    errors.push('Prexzy: ' + err.message);
  }

  // 3) Pyramid last resort
  try {
    return await tryPyramid(prompt, opts);
  } catch (err) {
    errors.push('Pyramid: ' + err.message);
  }

  throw new Error(
    'Video generation is temporarily unavailable. ' + errors.join(' | ')
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (_) {
    res.status(400).json({ error: 'Invalid JSON body.' });
    return;
  }

  const prompt = String(body.prompt || '').trim();
  if (!prompt) {
    res.status(400).json({ error: 'Missing "prompt".' });
    return;
  }
  if (prompt.length > 2000) {
    res.status(400).json({ error: 'Prompt too long (max 2000 characters).' });
    return;
  }

  try {
    const result = await generateVideoWithFallback(prompt, {
      duration: Math.min(Math.max(Number(body.duration) || 5, 2), 10),
      resolution: body.resolution || '720p',
      imageUrl: body.imageUrl || body.image || null,
      poll: body.poll !== false,
      style: body.style
    });
    res.status(200).json(result);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Video generation failed' });
  }
};

module.exports.config = {
  maxDuration: 300
};
