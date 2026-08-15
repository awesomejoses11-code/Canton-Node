/* api/video.js — CogVideoX -> Pixazo -> Pyramid -> Prexzy -> Pexels stock */
const PREXZY_BASE = 'https://prexzyapis.com';
const VIDEO_PROVIDER_IDS = ['cogvideox', 'pixazo', 'pyramid', 'prexzy', 'pexels'];

function normalizeVideoProvider(raw) {
  var p = String(raw || 'auto').toLowerCase().trim();
  var alias = { cog: 'cogvideox', cogvideo: 'cogvideox', zai: 'cogvideox', zhipu: 'cogvideox',
    pix: 'pixazo', hf: 'pyramid', pyramidflow: 'pyramid', stock: 'pexels', prexy: 'prexzy' };
  if (alias[p]) p = alias[p];
  if (p === 'auto' || !p) return 'auto';
  return VIDEO_PROVIDER_IDS.indexOf(p) >= 0 ? p : 'auto';
}
function orderVideoProviders(preferred) {
  var chain = VIDEO_PROVIDER_IDS.slice();
  var pref = normalizeVideoProvider(preferred);
  if (pref === 'auto') return chain;
  var idx = chain.indexOf(pref);
  if (idx > 0) { chain.splice(idx, 1); chain.unshift(pref); }
  return chain;
}

async function pollPixazo(taskId, apiKey) {
  var started = Date.now(), timeoutMs = 4 * 60 * 1000;
  while (true) {
    var res = await fetch('https://gateway.pixazo.ai/v2/requests/status/' + encodeURIComponent(taskId), {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey }
    });
    if (!res.ok) throw new Error('Pixazo status ' + res.status);
    var data = await res.json();
    var status = String(data.status || '').toUpperCase();
    if (status === 'COMPLETED') {
      var media = data.output && data.output.media_url;
      var url = Array.isArray(media) ? media[0] : media;
      if (!url) throw new Error('Pixazo completed but no media_url');
      return { url: url, status: 'COMPLETED', source: 'pixazo-ltx', raw: data };
    }
    if (status === 'FAILED' || status === 'ERROR') throw new Error(data.error || ('Pixazo ' + status));
    if (Date.now() - started > timeoutMs) throw new Error('Pixazo polling timed out');
    await new Promise(function (r) { setTimeout(r, 5000); });
  }
}

async function tryCogVideoX(prompt, options) {
  var apiKey = process.env.ZAI_API_KEY || process.env.ZHIPU_API_KEY || process.env.BIGMODEL_API_KEY;
  if (!apiKey) throw new Error('ZAI_API_KEY not set');
  var model = options.cogModel || process.env.COGVIDEO_MODEL || 'cogvideox-flash';
  var headers = { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
  var payload = { model: model, prompt: prompt };
  if (options.imageUrl) payload.image_url = options.imageUrl;
  var res = await fetch('https://open.bigmodel.cn/api/paas/v4/videos/generations', {
    method: 'POST', headers: headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error('CogVideoX submit ' + res.status + ': ' + (await res.text()).slice(0, 250));
  var data = await res.json();
  var taskId = data.id || data.task_id || data.request_id;
  if (!taskId) {
    var direct = data.video_result && data.video_result[0] && data.video_result[0].url;
    if (direct) return { url: direct, status: 'COMPLETED', source: 'cogvideox-flash', model: model, raw: data };
    throw new Error('CogVideoX: no task id');
  }
  if (options.poll === false) return { task_id: taskId, status: 'PENDING', source: 'cogvideox-flash', model: model };
  var started = Date.now();
  while (true) {
    var poll = await fetch('https://open.bigmodel.cn/api/paas/v4/async-result/' + encodeURIComponent(taskId), {
      method: 'GET', headers: headers, signal: AbortSignal.timeout(20000)
    });
    if (!poll.ok) throw new Error('CogVideoX poll ' + poll.status);
    var pd = await poll.json();
    var status = String(pd.task_status || pd.status || '').toUpperCase();
    if (status === 'SUCCESS' || status === 'COMPLETED' || status === 'SUCCEEDED') {
      var list = pd.video_result || pd.video_results || [];
      var url = (list[0] && (list[0].url || list[0].video_url)) || pd.url || pd.video_url || null;
      if (!url) throw new Error('CogVideoX SUCCESS but no video URL');
      return { url: url, status: 'COMPLETED', source: 'cogvideox-flash', model: model, task_id: taskId, raw: pd };
    }
    if (status === 'FAIL' || status === 'FAILED' || status === 'ERROR') throw new Error(pd.error || pd.message || status);
    if (Date.now() - started > 5 * 60 * 1000) throw new Error('CogVideoX polling timed out');
    await new Promise(function (r) { setTimeout(r, 10000); });
  }
}

async function tryPixazo(prompt, options) {
  var pixazoKey = process.env.PIXAZO_API_KEY;
  if (!pixazoKey) throw new Error('PIXAZO_API_KEY not set');
  var body = { prompt: prompt, model: 'ltx-v2-3-free', duration: options.duration, resolution: options.resolution };
  if (options.imageUrl) body.image_url = options.imageUrl;
  var res = await fetch('https://gateway.pixazo.ai/ltx-video/v1/text-to-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': pixazoKey },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error('Pixazo ' + res.status + ': ' + (await res.text()).slice(0, 300));
  var data = await res.json();
  var taskId = data.task_id || data.id || data.request_id;
  if (!taskId) {
    var url = data.url || data.video_url || (data.output && data.output.media_url);
    if (url) return { url: Array.isArray(url) ? url[0] : url, source: 'pixazo-ltx', raw: data };
    throw new Error('Pixazo: no task_id');
  }
  if (options.poll === false) return { task_id: taskId, status: 'PENDING', source: 'pixazo-ltx' };
  return await pollPixazo(taskId, pixazoKey);
}

async function tryPyramid(prompt, options) {
  var hfToken = process.env.HF_TOKEN;
  if (!hfToken) throw new Error('HF_TOKEN not set');
  var res = await fetch('https://api-inference.huggingface.co/models/rain1011/pyramid-flow-miniflux', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + hfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: prompt, parameters: { num_frames: Math.round((options.duration || 5) * 24), height: 384, width: 640 } }),
    signal: AbortSignal.timeout(90000)
  });
  if (!res.ok) throw new Error('Pyramid Flow ' + res.status + ': ' + (await res.text()).slice(0, 300));
  var contentType = res.headers.get('content-type') || '';
  if (contentType.includes('video') || contentType.includes('octet-stream')) {
    var buf = Buffer.from(await res.arrayBuffer());
    return { url: 'data:video/mp4;base64,' + buf.toString('base64'), source: 'pyramid-flow', status: 'COMPLETED' };
  }
  return Object.assign({}, await res.json(), { source: 'pyramid-flow' });
}

async function tryPrexzy(prompt, options) {
  var qs = new URLSearchParams({ prompt: prompt });
  if (options.imageUrl) qs.set('image', options.imageUrl);
  var res = await fetch(PREXZY_BASE + '/ai/aiart-video?' + qs.toString(), { method: 'GET', signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error('Prexzy video HTTP ' + res.status);
  var data = await res.json().catch(function () { return null; });
  if (data && (data.url || data.video_url || data.video || data.task_id)) {
    return { url: data.url || data.video_url || data.video || null, task_id: data.task_id || null, source: 'prexzy', raw: data };
  }
  throw new Error('Prexzy video: no usable payload');
}

async function tryPexelsVideo(prompt) {
  var key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error('PEXELS_API_KEY not set');
  var res = await fetch('https://api.pexels.com/videos/search?query=' + encodeURIComponent(String(prompt).slice(0, 100)) + '&per_page=5', {
    headers: { Authorization: key }, signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error('Pexels ' + res.status);
  var data = await res.json();
  var videos = data.videos || [];
  if (!videos.length) throw new Error('Pexels: no videos for query');
  var files = videos[0].video_files || [];
  var best = files.find(function (f) { return f.quality === 'hd' || f.quality === 'sd'; }) || files[0];
  if (!best || !best.link) throw new Error('Pexels: missing video file');
  return { url: best.link, video_url: best.link, source: 'pexels', status: 'COMPLETED', note: 'Stock video from Pexels (final fallback)' };
}

async function generateVideoWithFallback(prompt, options) {
  var opts = { duration: options.duration || 5, resolution: options.resolution || '720p', imageUrl: options.imageUrl || null, poll: options.poll !== false };
  var preferred = normalizeVideoProvider(options.provider || options.videoProvider || options.preferred);
  var chain = orderVideoProviders(preferred);
  var errors = [];
  for (var i = 0; i < chain.length; i++) {
    var provider = chain[i];
    try {
      if (provider === 'cogvideox') return Object.assign({}, await tryCogVideoX(prompt, opts), { preferred: preferred });
      if (provider === 'pixazo') return Object.assign({}, await tryPixazo(prompt, opts), { preferred: preferred });
      if (provider === 'pyramid') return Object.assign({}, await tryPyramid(prompt, opts), { preferred: preferred });
      if (provider === 'prexzy') return Object.assign({}, await tryPrexzy(prompt, opts), { preferred: preferred });
      if (provider === 'pexels') return Object.assign({}, await tryPexelsVideo(prompt), { preferred: preferred });
    } catch (err) {
      console.warn('[Video] ' + provider + ' failed', err.message);
      errors.push(provider + ': ' + err.message);
    }
  }
  throw new Error('Video generation unavailable (ordered: ' + chain.join(' -> ') + '). ' + errors.join(' | '));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed. Use POST.' }); return; }
  var body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch (_) { res.status(400).json({ error: 'Invalid JSON body.' }); return; }
  var prompt = String(body.prompt || '').trim();
  if (!prompt) { res.status(400).json({ error: 'Missing "prompt".' }); return; }
  if (prompt.length > 2000) { res.status(400).json({ error: 'Prompt too long (max 2000 characters).' }); return; }
  try {
    var result = await generateVideoWithFallback(prompt, {
      duration: Math.min(Math.max(Number(body.duration) || 5, 2), 10),
      resolution: body.resolution || '720p',
      imageUrl: body.imageUrl || body.image || null,
      poll: body.poll !== false,
      provider: body.provider || body.videoProvider || null
    });
    res.status(200).json(result);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Video generation failed' });
  }
};
module.exports.config = { maxDuration: 300 };
