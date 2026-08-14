/* =========================================================================
 * api/video.js — Video generation with fallback chain
 *
 * Chain:
 *   1. MuAPI  (primary when MUAPI_API_KEY is set)
 *   2. Pixazo LTX
 *   3. Pyramid Flow / HF
 *   4. Prexzy (final)
 *
 * POST /api/video
 * Body: { prompt, duration?, resolution?, imageUrl?, poll?: true, model? }
 * ========================================================================= */

const PREXZY_BASE = 'https://prexzyapis.com';
const MUAPI_BASE = 'https://api.muapi.ai/api/v1';
/** Default MuAPI endpoint — LTX is usually the cheapest T2V on MuAPI */
const MUAPI_DEFAULT_MODEL = process.env.MUAPI_VIDEO_MODEL || 'ltx-2.3-text-to-video';

async function pollMuapi(requestId, apiKey, {
  intervalMs = 5000,
  timeoutMs = 5 * 60 * 1000
} = {}) {
  const started = Date.now();
  const url = MUAPI_BASE + '/predictions/' + encodeURIComponent(requestId) + '/result';

  while (true) {
    const res = await fetch(url, {
      headers: { 'x-api-key': apiKey }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error('MuAPI status ' + res.status + ': ' + text.slice(0, 200));
    }
    const data = await res.json();
    const status = String(data.status || '').toLowerCase();

    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const out = data.outputs;
      const videoUrl = Array.isArray(out) ? out[0] : (data.url || (data.output && data.output.url) || null);
      if (!videoUrl) throw new Error('MuAPI completed but no video URL');
      return {
        url: videoUrl,
        status: 'COMPLETED',
        source: 'muapi',
        model: data.model || null,
        request_id: requestId,
        raw: data
      };
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(data.error || data.message || ('MuAPI ' + status));
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('MuAPI polling timed out after ' + Math.round(timeoutMs / 1000) + 's');
    }
    await new Promise(function (r) { setTimeout(r, intervalMs); });
  }
}

async function tryMuapi(prompt, options) {
  const apiKey = process.env.MUAPI_API_KEY;
  if (!apiKey) throw new Error('MUAPI_API_KEY not set');

  const endpoint = options.model || MUAPI_DEFAULT_MODEL;
  const body = { prompt: prompt };
  if (options.duration) body.duration = options.duration;
  if (options.resolution) body.resolution = options.resolution;
  if (options.aspect_ratio) body.aspect_ratio = options.aspect_ratio;
  if (options.imageUrl) body.image_url = options.imageUrl;

  const res = await fetch(MUAPI_BASE + '/' + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('MuAPI submit ' + res.status + ': ' + text.slice(0, 300));
  }

  const data = await res.json();
  const requestId = data.request_id || data.id;
  if (!requestId) {
    const url = (data.outputs && data.outputs[0]) || data.url;
    if (url) return { url: url, status: 'COMPLETED', source: 'muapi', model: endpoint, raw: data };
    throw new Error('MuAPI: no request_id in response');
  }

  if (options.poll === false) {
    return { request_id: requestId, status: 'PENDING', source: 'muapi', model: endpoint };
  }

  return await pollMuapi(requestId, apiKey);
}

async function pollPixazo(taskId, apiKey, {
  intervalMs = 5000,
  timeoutMs = 4 * 60 * 1000
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
  const taskId = data.task_id || data.id || data.request_id;
  if (!taskId) {
    const url = data.url || data.video_url || (data.output && data.output.media_url);
    if (url) return { url: Array.isArray(url) ? url[0] : url, source: 'pixazo-ltx', raw: data };
    throw new Error('Pixazo: no task_id — ' + JSON.stringify(data).slice(0, 200));
  }

  if (options.poll === false) {
    return { task_id: taskId, status: 'PENDING', source: 'pixazo-ltx' };
  }
  return await pollPixazo(taskId, pixazoKey);
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
          num_frames: Math.round((options.duration || 5) * 24),
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
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      url: 'data:video/mp4;base64,' + buf.toString('base64'),
      source: 'pyramid-flow',
      status: 'COMPLETED',
      note: 'Binary video from HF (ephemeral data URL).'
    };
  }

  const data = await res.json();
  return Object.assign({}, data, { source: 'pyramid-flow' });
}

async function tryPrexzy(prompt, options) {
  const qs = new URLSearchParams({ prompt: prompt });
  if (options.imageUrl) qs.set('image', options.imageUrl);
  const res = await fetch(PREXZY_BASE + '/ai/aiart-video?' + qs.toString(), {
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

async function generateVideoWithFallback(prompt, options) {
  const opts = {
    duration: options.duration || 5,
    resolution: options.resolution || '720p',
    aspect_ratio: options.aspect_ratio || '16:9',
    imageUrl: options.imageUrl || null,
    poll: options.poll !== false,
    model: options.model,
    style: options.style
  };

  const errors = [];

  try {
    return await tryMuapi(prompt, opts);
  } catch (err) {
    console.warn('[Video] MuAPI failed → Pixazo', err.message);
    errors.push('MuAPI: ' + err.message);
  }

  try {
    return await tryPixazo(prompt, opts);
  } catch (err) {
    console.warn('[Video] Pixazo failed → Pyramid', err.message);
    errors.push('Pixazo: ' + err.message);
  }

  try {
    return await tryPyramid(prompt, opts);
  } catch (err) {
    console.warn('[Video] Pyramid failed → Prexzy', err.message);
    errors.push('Pyramid: ' + err.message);
  }

  try {
    return await tryPrexzy(prompt, opts);
  } catch (err) {
    errors.push('Prexzy: ' + err.message);
  }

  throw new Error('Video generation unavailable. ' + errors.join(' | '));
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
      aspect_ratio: body.aspect_ratio || '16:9',
      imageUrl: body.imageUrl || body.image || null,
      poll: body.poll !== false,
      model: body.model || null,
      style: body.style
    });
    res.status(200).json(result);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Video generation failed' });
  }
};

module.exports.config = { maxDuration: 300 };
