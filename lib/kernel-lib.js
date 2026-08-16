/* lib/kernel-lib.js — stealth page browse (Kernel) with plain-fetch fallback
 *
 * Stealth browsers: static ISP proxy + automatic CAPTCHA solver (Kernel managed).
 * Only used when KERNEL_API_KEY (or KERNEL_KEY) is set.
 */

var KERNEL_BASE = 'https://api.onkernel.com';

function extractUrl(text) {
  var m = String(text || '').match(/https?:\/\/[^\s<>"'\)]+/i);
  if (!m) return null;
  return m[0].replace(/[.,;:!?]+$/g, '');
}

function extractUrls(text, max) {
  max = max || 3;
  var out = [];
  var re = /https?:\/\/[^\s<>"'\)]+/gi;
  var m;
  var seen = {};
  while ((m = re.exec(String(text || ''))) && out.length < max) {
    var u = m[0].replace(/[.,;:!?]+$/g, '');
    if (seen[u]) continue;
    seen[u] = true;
    out.push(u);
  }
  return out;
}

function authHeaders(apiKey) {
  return {
    Authorization: 'Bearer ' + apiKey,
    'Content-Type': 'application/json'
  };
}

function kernelKey() {
  return process.env.KERNEL_API_KEY || process.env.KERNEL_KEY || null;
}

function stripHtml(html) {
  var s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&/gi, '&').replace(/</gi, '<').replace(/>/gi, '>').replace(/"/gi, '"');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 14000);
}

async function simpleFetchPage(url) {
  var resp = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CantonNode/1.0; +https://canton-node.vercel.app)',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000)
  });
  if (!resp.ok) {
    return { ok: false, error: 'Fetch HTTP ' + resp.status + ' for ' + url };
  }
  var html = await resp.text();
  var titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  var title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : 'Page';
  var text = stripHtml(html);
  if (!text || text.length < 40) {
    return { ok: false, error: 'Page returned little readable text (may be JS-only or blocked).' };
  }
  return {
    ok: true,
    text: '**' + title + '**\n' + url + '\n\n' + text,
    result: { title: title, url: url, text: text },
    source: 'fetch'
  };
}

/**
 * Create stealth Kernel browser, run Playwright extract, always delete session.
 * Playwright code runs in the browser VM with `page` in scope.
 */
async function tryKernelBrowser(url, opts) {
  opts = opts || {};
  var apiKey = kernelKey();
  if (!apiKey) return { ok: false, error: 'KERNEL_API_KEY not set' };

  var sessionId = null;
  try {
    var createBody = {
      stealth: true,
      headless: opts.headless === true,
      timeout_seconds: Math.min(Math.max(Number(opts.timeoutSeconds) || 120, 60), 300)
    };
    if (opts.startUrl) createBody.start_url = opts.startUrl;

    var createRes = await fetch(KERNEL_BASE + '/browsers', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(createBody),
      signal: AbortSignal.timeout(45000)
    });
    var createText = await createRes.text();
    var created = null;
    try { created = JSON.parse(createText); } catch (_) { created = null; }
    if (!createRes.ok) {
      return {
        ok: false,
        error: 'Kernel create HTTP ' + createRes.status + ' ' + String(createText).slice(0, 160)
      };
    }
    sessionId =
      (created && (created.session_id || created.id || created.browser_id)) ||
      (created && created.data && (created.data.session_id || created.data.id)) ||
      null;
    if (!sessionId) {
      return { ok: false, error: 'No session_id from Kernel create' };
    }

    // Playwright code: wait for DOM + short settle for CAPTCHA solver, then extract main text.
    var code =
      "await page.goto(" + JSON.stringify(url) + ", { waitUntil: 'domcontentloaded', timeout: 50000 });\n" +
      "await page.waitForTimeout(2500);\n" +
      "try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (_) {}\n" +
      "const title = await page.title();\n" +
      "const href = page.url();\n" +
      "const text = await page.evaluate(() => {\n" +
      "  const bad = /nav|footer|header|sidebar|menu|cookie|banner|ads?/i;\n" +
      "  const main = document.querySelector('main, article, [role=main], .content, #content') || document.body;\n" +
      "  if (!main) return '';\n" +
      "  const clone = main.cloneNode(true);\n" +
      "  clone.querySelectorAll('script, style, noscript, svg, nav, footer, header').forEach(n => n.remove());\n" +
      "  return (clone.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 14000);\n" +
      "});\n" +
      "return { title, text, url: href };";

    var execRes = await fetch(
      KERNEL_BASE + '/browsers/' + encodeURIComponent(sessionId) + '/playwright/execute',
      {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({ code: code, timeout_sec: 90 }),
        signal: AbortSignal.timeout(100000)
      }
    );
    var execText = await execRes.text();
    var execData = null;
    try { execData = JSON.parse(execText); } catch (_) { execData = { raw: execText }; }
    if (!execRes.ok) {
      return {
        ok: false,
        error: 'Kernel execute HTTP ' + execRes.status + ' ' + String(execText).slice(0, 180)
      };
    }

    var result = execData.result !== undefined ? execData.result : (execData.data || execData);
    var title = 'Page';
    var text = '';
    var finalUrl = url;
    if (typeof result === 'string') {
      text = result;
    } else if (result && typeof result === 'object') {
      title = result.title || title;
      text = result.text || '';
      finalUrl = result.url || url;
    } else {
      text = JSON.stringify(result).slice(0, 8000);
    }
    text = String(text || '').trim();
    if (!text || text.length < 30) {
      return { ok: false, error: 'Kernel returned little text (challenge or empty page).' };
    }

    return {
      ok: true,
      text: '**' + title + '**\n' + finalUrl + '\n\n' + text,
      result: { title: title, url: finalUrl, text: text },
      source: 'kernel-stealth',
      session_id: sessionId
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    if (sessionId && apiKey) {
      try {
        await fetch(KERNEL_BASE + '/browsers/' + encodeURIComponent(sessionId), {
          method: 'DELETE',
          headers: authHeaders(apiKey),
          signal: AbortSignal.timeout(12000)
        });
      } catch (_) {}
    }
  }
}

async function tryBrowsePage(opts) {
  opts = opts || {};
  var prompt = opts.prompt || '';
  var url = opts.url || extractUrl(prompt);
  if (!url) {
    return {
      ok: false,
      error: 'No URL found. Include a full https:// link, e.g. "Browse https://example.com/docs".'
    };
  }

  var k = await tryKernelBrowser(url, opts);
  if (k.ok) return k;

  try {
    var simple = await simpleFetchPage(url);
    if (simple.ok) {
      if (k.error) simple.note = 'Kernel unavailable (' + k.error + '); used plain fetch.';
      return simple;
    }
    return {
      ok: false,
      error: (k.error ? k.error + ' | ' : '') + (simple.error || 'browse failed')
    };
  } catch (e) {
    return {
      ok: false,
      error: (k.error ? k.error + ' | ' : '') + (e.message || 'browse failed')
    };
  }
}

/**
 * Deep-read up to `maxPages` URLs (stealth first). Used to enrich web search.
 * Cost-conscious: defaults to 1 page.
 */
async function deepReadUrls(urls, maxPages) {
  maxPages = Math.min(Math.max(Number(maxPages) || 1, 1), 2);
  var list = (urls || []).filter(Boolean).slice(0, maxPages);
  var blocks = [];
  for (var i = 0; i < list.length; i++) {
    try {
      var r = await tryBrowsePage({ url: list[i] });
      if (r && r.ok && r.text) {
        blocks.push('### Source ' + (i + 1) + '\n' + r.text.slice(0, 6000));
      }
    } catch (_) {}
  }
  if (!blocks.length) return null;
  return {
    ok: true,
    text: 'Live page extracts (stealth browser when available):\n\n' + blocks.join('\n\n---\n\n'),
    count: blocks.length
  };
}

async function tryKernelBrowse(prompt) {
  return tryBrowsePage({ prompt: prompt });
}

module.exports = {
  tryBrowsePage: tryBrowsePage,
  tryKernelBrowse: tryKernelBrowse,
  tryKernelBrowser: tryKernelBrowser,
  deepReadUrls: deepReadUrls,
  extractUrl: extractUrl,
  extractUrls: extractUrls,
  kernelKey: kernelKey
};
