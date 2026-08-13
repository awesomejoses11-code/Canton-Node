/* =========================================================================
 * api/video.js — Video generation with fallback chain
 *
 * Chain: Prexzy → Pixazo LTX (free) → Pyramid Flow (HF) → clean error
 *
 * POST /api/video
 * Body: { prompt, duration?, resolution?, imageUrl?, poll?: true }
 *
 * When poll=true (default) and Pixazo returns a task_id, this function
 * polls until COMPLETED/FAILED or timeout, then returns the final URL.
 * Vercel maxDuration is set via the export config below (Pro plan recommended).
 * ========================================================================= */

const PREXZY_BASE = 'https://prexzyapis.com';

/**
 * Poll Pixazo until the video is ready (or fails / times out).
 * Returns { url, status, source: 'pixazo-ltx', raw } or throws.
 */
async function pollPixazo(taskId, apiKey, {
  intervalMs = 5000,
  timeoutMs  = 4 * 60 * 1000   // 4 min
} = {}) {
  const started = Date.now();
  const url = `https://gateway.pixazo.ai/v2/requests/status/${encodeURIComponent(taskId)}`;

  while (true) {
    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey }
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Pixazo status ${res.status}: ${text.slice(0, 200)}`);
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
      throw new Error(data.error || `Pixazo ${status}`);
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error('Pixazo polling timed out');
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }
}

/**
 * Video generation with fallback chain:
 * Prexzy → Pixazo LTX (free) → Pyramid Flow (HF) → clean error
 */
async function generateVideoWithFallback(prompt, options = {}) {
  const {
    duration = 5,
    resolution = '720p',
    imageUrl = null,          // optional for image-to-video
    poll = true               // if true, wait for Pixazo result server-side
  } = options;

  // -------------------------------------------------
  // 1. Try Prexzy first
  // -------------------------------------------------
  try {
    const usp = new URLSearchParams({ prompt });
    if (imageUrl) usp.set('image', imageUrl);
    if (options.style) usp.set('style', options.style);

    const res = await fetch(`${PREXZY_BASE}/ai/aiart-video?${usp.toString()}`, {
      method: 'GET',
      signal: AbortSignal.timeout(25000)
    });

    if (res.ok) {
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (ctype.startsWith('video/') || ctype.includes('octet-stream')) {
        // Rare: direct binary — we can't easily return a blob from serverless
        // without uploading somewhere. Fall through to JSON path.
      } else {
        const data = await res.json().catch(() => null);
        if (data && (data.url || data.video_url || data.video || data.task_id || data.image_url)) {
          return {
            ...data,
            url: data.url || data.video_url || data.video || data.image_url || null,
            source: 'prexzy'
          };
        }
      }
    }
  } catch (err) {
    console.warn('[Video] Prexzy failed → trying Pixazo LTX', err.message);
  }

  // -------------------------------------------------
  // 2. Fallback to Pixazo LTX (free tier)
  // -------------------------------------------------
  try {
    const pixazoKey = process.env.PIXAZO_API_KEY;
    if (!pixazoKey) throw new Error('PIXAZO_API_KEY not set');

    const body = {
      prompt,
      model: 'ltx-v2-3-free',          // free tier variant — adjust if your key uses another model id
      duration,
      resolution,
      ...(imageUrl && { image_url: imageUrl })
    };

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
      throw new Error(`Pixazo ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    const taskId = data.request_id || data.id || data.job_id;

    if (!taskId) {
      // Some responses may already contain a media url
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

    if (!poll) {
      return {
        task_id: taskId,
        status: data.status || 'QUEUED',
        poll_url: data.polling_url || null,
        source: 'pixazo-ltx'
      };
    }

    // Wait for completion server-side
    return await pollPixazo(taskId, pixazoKey);
  } catch (err) {
    console.warn('[Video] Pixazo LTX failed → trying Pyramid Flow', err.message);
  }

  // -------------------------------------------------
  // 3. Fallback to Pyramid Flow (Hugging Face)
  // -------------------------------------------------
  try {
    const hfToken = process.env.HF_TOKEN;
    if (!hfToken) throw new Error('HF_TOKEN not set');

    // Best-effort call. Pyramid Flow public Inference API support varies;
    // many deployments are Spaces. Adjust model id if you have a dedicated endpoint.
    const res = await fetch(
      'https://api-inference.huggingface.co/models/rain1011/pyramid-flow-miniflux',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${hfToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            num_frames: Math.round(duration * 24),
            height: 384,
            width: 640
          }
        }),
        signal: AbortSignal.timeout(90000)
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Pyramid Flow ${res.status}: ${text.slice(0, 300)}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('video') || contentType.includes('octet-stream')) {
      // Binary video — cannot return a durable URL without storage.
      // Signal the client that HF returned binary (rare path).
      return {
        source: 'pyramid-flow',
        status: 'binary',
        note: 'HF returned binary video; client should use a storage-backed path or prefer Pixazo/Prexzy.'
      };
    }

    const data = await res.json();
    return {
      ...data,
      source: 'pyramid-flow'
    };
  } catch (err) {
    console.warn('[Video] Pyramid Flow also failed', err.message);
  }

  // -------------------------------------------------
  // 4. All failed → clean message
  // -------------------------------------------------
  throw new Error(
    'Video generation is temporarily unavailable. Please try again later or generate an image instead.'
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

  const duration = Math.min(Math.max(Number(body.duration) || 5, 2), 10);
  const resolution = body.resolution || '720p';
  const imageUrl = body.imageUrl || body.image || null;
  const poll = body.poll !== false; // default true

  try {
    const result = await generateVideoWithFallback(prompt, {
      duration,
      resolution,
      imageUrl,
      poll,
      style: body.style
    });
    res.status(200).json(result);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Video generation failed' });
  }
};

// Allow longer execution when the platform plan supports it (Pro).
module.exports.config = {
  maxDuration: 300
};
