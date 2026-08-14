/* =========================================================================
 * api/kernel-browse.js — POST { url?, prompt?, query? }
 * Uses Kernel cloud browser; returns plain-text extraction.
 * ========================================================================= */

var kernelLib = require('./kernel-lib');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
      return;
    }

    var body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    var out = await kernelLib.tryBrowsePage({
      url: body.url,
      prompt: body.prompt || body.query || body.message,
      query: body.query
    });

    if (!out.ok) {
      var status = out.code === 'no_key' ? 503 : out.code === 'bad_request' ? 400 : 502;
      res.status(status).json(out);
      return;
    }

    res.status(200).json(out);
  } catch (err) {
    console.error('[kernel-browse]', err);
    res.status(500).json({
      ok: false,
      error: String(err && err.message ? err.message : err).slice(0, 300),
      code: 'crash'
    });
  }
};

module.exports.config = { maxDuration: 60 };
