/* =========================================================================
 * api/kernel-lib.js — Kernel browsers via REST (no @onkernel/sdk dependency)
 * Env: KERNEL_API_KEY (from Vercel Marketplace integration)
 * ========================================================================= */

const KERNEL_BASE = 'https://api.onkernel.com';

function authHeaders(apiKey) {
  return {
    Authorization: 'Bearer ' + apiKey,
    'Content-Type': 'application/json'
  };
}

function extractUrl(text) {
  if (!text) return null;
  var m = String(text).match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[),.;]+$/, '') : null;
}

/**
 * Visit a URL (or start_url) in a Kernel browser, extract title + text.
 * Always attempts cleanup (delete session).
 */
async function tryBrowsePage(opts) {
  opts = opts || {};
  var apiKey = process.env.KERNEL_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: 'KERNEL_API_KEY is not set on this project. Install Kernel from the Vercel Marketplace and redeploy.',
      code: 'no_key'
    };
  }

  var targetUrl = opts.url || extractUrl(opts.prompt || opts.query || '');
  if (!targetUrl) {
    // No explicit URL — use a search page as a soft entry (DuckDuckGo HTML)
    var q = String(opts.prompt || opts.query || '').trim().slice(0, 200);
    if (!q) {
      return { ok: false, error: 'No URL or query provided.', code: 'bad_request' };
    }
    targetUrl = 'https://duckduckgo.com/?q=' + encodeURIComponent(q);
  }

  var sessionId = null;
  try {
    var createResp = await fetch(KERNEL_BASE + '/browsers', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        headless: true,
        stealth: true,
        start_url: targetUrl,
        timeout_seconds: 120
      }),
      signal: AbortSignal.timeout(60000)
    });
    var createText = await createResp.text();
    var createData = null;
    try {
      createData = JSON.parse(createText);
    } catch (_) {}
    if (!createResp.ok) {
      return {
        ok: false,
        error: 'Kernel create failed HTTP ' + createResp.status + ': ' + createText.slice(0, 240),
        code: 'create_failed'
      };
    }
    sessionId = createData && (createData.session_id || createData.id);
    if (!sessionId) {
      return { ok: false, error: 'Kernel create returned no session_id', code: 'create_failed' };
    }

    var safeUrl = JSON.stringify(targetUrl);
    var code =
      'await page.goto(' + safeUrl + ', { waitUntil: "domcontentloaded", timeout: 45000 });\n' +
      'const title = await page.title();\n' +
      'let text = "";\n' +
      'try { text = await page.innerText("body"); } catch (_) {}\n' +
      'if (text && text.length > 6000) text = text.slice(0, 6000) + "…";\n' +
      'return { title: title, url: page.url(), text: text };';

    var execResp = await fetch(
      KERNEL_BASE + '/browsers/' + encodeURIComponent(sessionId) + '/playwright/execute',
      {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({ code: code, timeout_sec: 90 }),
        signal: AbortSignal.timeout(120000)
      }
    );
    var execText = await execResp.text();
    var execData = null;
    try {
      execData = JSON.parse(execText);
    } catch (_) {}

    if (!execResp.ok || (execData && execData.success === false)) {
      return {
        ok: false,
        error:
          'Kernel execute failed: ' +
          (execData && execData.error ? execData.error : execText.slice(0, 240)),
        code: 'execute_failed',
        session_id: sessionId
      };
    }

    var result = execData && execData.result;
    var title = (result && result.title) || '';
    var finalUrl = (result && result.url) || targetUrl;
    var text = (result && result.text) || '';

    var human =
      '**Browsed with Kernel**\n\n' +
      (title ? '**Title:** ' + title + '\n' : '') +
      '**URL:** ' + finalUrl + '\n\n' +
      (text ? text : '_No text extracted._');

    return {
      ok: true,
      result: human,
      title: title,
      url: finalUrl,
      session_id: sessionId,
      live_view: createData && createData.browser_live_view_url
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err && err.message ? err.message : err).slice(0, 300),
      code: 'exception',
      session_id: sessionId
    };
  } finally {
    if (sessionId && apiKey) {
      try {
        await fetch(KERNEL_BASE + '/browsers/' + encodeURIComponent(sessionId), {
          method: 'DELETE',
          headers: authHeaders(apiKey),
          signal: AbortSignal.timeout(15000)
        });
      } catch (_) {}
    }
  }
}

module.exports = {
  tryBrowsePage: tryBrowsePage,
  extractUrl: extractUrl
};
