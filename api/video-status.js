/* =========================================================================
 * api/video-status.js — Thin proxy for Pixazo status polling
 *
 * Keeps PIXAZO_API_KEY on the server. Client polls this endpoint instead of
 * calling Pixazo directly.
 *
 * GET /api/video-status?task_id=...
 * ========================================================================= */

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed. Use GET.' });
    return;
  }

  const taskId = (req.query && (req.query.task_id || req.query.request_id)) || null;
  if (!taskId || typeof taskId !== 'string') {
    res.status(400).json({ error: 'Missing task_id query parameter.' });
    return;
  }

  const apiKey = process.env.PIXAZO_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'PIXAZO_API_KEY is not set on the server.' });
    return;
  }

  try {
    const url = `https://gateway.pixazo.ai/v2/requests/status/${encodeURIComponent(taskId)}`;
    const upstream = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
      signal: AbortSignal.timeout(15000)
    });

    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { raw: text };
    }

    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Failed to reach Pixazo status endpoint' });
  }
};
