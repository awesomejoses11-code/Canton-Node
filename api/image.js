/* =========================================================================
 * api/image.js — Image generation: Hugging Face first, Prexzy backup
 *
 * POST /api/image
 * Body: { prompt, size? }
 *
 * Primary: black-forest-labs/FLUX.1-schnell (HF Inference API)
 * Backup:  Prexzy image endpoints (genimage → txt2img → dalle)
 * ========================================================================= */

const PREXZY_BASE = 'https://prexzyapis.com';
const HF_IMAGE_MODEL = 'black-forest-labs/FLUX.1-schnell';

async function tryHF(prompt, hfToken) {
  const res = await fetch(
    'https://api-inference.huggingface.co/models/' + HF_IMAGE_MODEL,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + hfToken,
        'Content-Type': 'application/json',
        Accept: 'image/png'
      },
      body: JSON.stringify({ inputs: prompt }),
      signal: AbortSignal.timeout(90000)
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error('HF ' + res.status + ': ' + text.slice(0, 250));
  }

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('application/json')) {
    const data = await res.json();
    // Some HF responses return error JSON even with 200
    if (data.error) throw new Error(data.error);
    throw new Error('HF returned JSON instead of image');
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const b64 = buf.toString('base64');
  const mime = ctype.includes('jpeg') ? 'image/jpeg' : 'image/png';
  return {
    url: 'data:' + mime + ';base64,' + b64,
    source: 'huggingface',
    model: HF_IMAGE_MODEL
  };
}

async function tryPrexzy(prompt, size) {
  const endpoints = [
    { path: '/ai/genimage', qs: { prompt, size: size || '1024x1024' } },
    { path: '/ai/txt2img', qs: { prompt } },
    { path: '/ai/dalle', qs: { prompt } },
    { path: '/ai/aiwriter-image', qs: { prompt, size: size || '1024x1024' } }
  ];

  let lastErr = null;
  for (const ep of endpoints) {
    try {
      const usp = new URLSearchParams();
      Object.entries(ep.qs).forEach(([k, v]) => {
        if (v != null && v !== '') usp.set(k, String(v));
      });
      const res = await fetch(PREXZY_BASE + ep.path + '?' + usp.toString(), {
        method: 'GET',
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) {
        lastErr = new Error('Prexzy ' + ep.path + ' HTTP ' + res.status);
        continue;
      }
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (ctype.startsWith('image/')) {
        const buf = Buffer.from(await res.arrayBuffer());
        return {
          url: 'data:' + ctype.split(';')[0] + ';base64,' + buf.toString('base64'),
          source: 'prexzy',
          endpoint: ep.path
        };
      }
      const data = await res.json().catch(() => null);
      if (!data) {
        lastErr = new Error('Prexzy empty body');
        continue;
      }
      // Nested Prexzy shapes (DALL·E etc.)
      const url = extractImageUrl(data);
      if (url) {
        return { url, source: 'prexzy', endpoint: ep.path, raw: data };
      }
      lastErr = new Error('Prexzy ' + ep.path + ' no image url');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All Prexzy image endpoints failed');
}

function extractImageUrl(obj, depth) {
  if (depth === undefined) depth = 0;
  if (!obj || depth > 6) return null;
  if (typeof obj === 'string' && /^https?:\/\//i.test(obj)) return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const u = extractImageUrl(item, depth + 1);
      if (u) return u;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const k of ['url', 'image_url', 'img_url', 'imageUrl', 'src', 'path']) {
      if (typeof obj[k] === 'string' && /^https?:\/\//i.test(obj[k])) return obj[k];
    }
    for (const v of Object.values(obj)) {
      const u = extractImageUrl(v, depth + 1);
      if (u) return u;
    }
  }
  return null;
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
  if (prompt.length > 1500) {
    res.status(400).json({ error: 'Prompt too long (max 1500 characters).' });
    return;
  }

  const size = body.size || '1024x1024';
  const errors = [];

  // 1) Hugging Face FLUX.1-schnell
  const hfToken = process.env.HF_TOKEN;
  if (hfToken) {
    try {
      const result = await tryHF(prompt, hfToken);
      res.status(200).json(result);
      return;
    } catch (e) {
      console.warn('[Image] HF failed → Prexzy', e.message);
      errors.push('HF: ' + e.message);
    }
  } else {
    errors.push('HF: HF_TOKEN not set');
  }

  // 2) Prexzy backup
  try {
    const result = await tryPrexzy(prompt, size);
    res.status(200).json(result);
    return;
  } catch (e) {
    errors.push('Prexzy: ' + e.message);
  }

  res.status(502).json({
    error: 'Image generation unavailable from HF and Prexzy.',
    detail: errors.join(' | ')
  });
};

module.exports.config = {
  maxDuration: 90
};
