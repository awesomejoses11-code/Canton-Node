export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { event, user, data } = req.body || {};

    if (!event || typeof event !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid event' });
    }

    // Basic sanitisation – never log huge payloads
    const safeData = data && typeof data === 'object'
      ? JSON.parse(JSON.stringify(data).slice(0, 2000))
      : null;

    const entry = {
      timestamp: new Date().toISOString(),
      event: event.slice(0, 80),
      user: user ? String(user).slice(0, 120) : 'anonymous',
      data: safeData
    };

    // Visible in Vercel → Project → Logs
    console.log('[Canton Log]', JSON.stringify(entry));

    // Later you can swap this for:
    // - Vercel KV
    // - Upstash Redis
    // - Supabase / Neon
    // - Discord webhook, etc.

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Canton Log] error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
