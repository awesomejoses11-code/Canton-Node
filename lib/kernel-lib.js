/* lib/kernel-lib.js — page browse (Kernel if keyed, else plain fetch) */

function extractUrl(text) {
  var m = String(text || '').match(/https?:\/\/[^\s<>"'\)]+/i);
  if (!m) return null;
  return m[0].replace(/[.,;:!?]+$/g, '');
}

function authHeaders(apiKey) {
  return {
    Authorization: 'Bearer ' + apiKey,
    'Content-Type': 'application/json'
  };
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
  return s.slice(0, 12000);
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
    return { ok: false, error: 'Page returned little readable text (may be JS-only).' };
  }
  return {
    ok: true,
    text: '**' + title + '**\n' + url + '\n\n' + text,
    result: { title: title, url: url, text: text },
    source: 'fetch'
  };
}

async function tryKernelBrowser(url) {
  var apiKey = process.env.KERNEL_API_KEY || process.env.KERNEL_KEY;
  if (!apiKey) return { ok: false, error: 'KERNEL_API_KEY not set' };
  var browserId = null;
  try {
    var createRes = await fetch('https://api.onkernel.com/v1/browsers', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30000)
    });
    if (!createRes.ok) {
      var t = await createRes.text();
      return { ok: false, error: 'Kernel create browser HTTP ' + createRes.status + ' ' + t.slice(0, 120) };
    }
    var created = await createRes.json();
    browserId = created.id || created.browser_id || (created.data && created.data.id);
    if (!browserId) return { ok: false, error: 'No browser id from Kernel' };

    var code =
      "async (page) => {\n" +
      "  await page.goto(" + JSON.stringify(url) + ", { waitUntil: 'domcontentloaded', timeout: 45000 });\n" +
      "  const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 12000) : '');\n" +
      "  const title = await page.title();\n" +
      "  return { title, text, url: location.href };\n" +
      "}";

    var execRes = await fetch('https://api.onkernel.com/v1/browsers/' + encodeURIComponent(browserId) + '/playwright/execute', {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ code: code }),
      signal: AbortSignal.timeout(60000)
    });
    var execText = await execRes.text();
    var execData = null;
    try { execData = JSON.parse(execText); } catch (_) { execData = { raw: execText }; }
    if (!execRes.ok) {
      return { ok: false, error: 'Kernel execute HTTP ' + execRes.status + ' ' + execText.slice(0, 160) };
    }
    var result = execData.result || execData.data || execData;
    var text = '';
    if (typeof result === 'string') text = result;
    else if (result && result.text) text = result.text;
    else text = JSON.stringify(result).slice(0, 8000);
    return {
      ok: true,
      text: '**' + (result && result.title ? result.title : 'Page') + '**\n' + url + '\n\n' + text,
      result: result,
      source: 'kernel'
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    if (browserId && apiKey) {
      try {
        await fetch('https://api.onkernel.com/v1/browsers/' + encodeURIComponent(browserId), {
          method: 'DELETE',
          headers: authHeaders(apiKey),
          signal: AbortSignal.timeout(10000)
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
      error: 'No URL found. Include a full https:// link in the message, e.g. "Browse https://example.com/docs".'
    };
  }
  var k = await tryKernelBrowser(url);
  if (k.ok) return k;
  try {
    var simple = await simpleFetchPage(url);
    if (simple.ok) {
      if (k.error) simple.note = 'Kernel unavailable (' + k.error + '); used plain fetch.';
      return simple;
    }
    return { ok: false, error: (k.error ? k.error + ' | ' : '') + (simple.error || 'browse failed') };
  } catch (e) {
    return { ok: false, error: (k.error ? k.error + ' | ' : '') + (e.message || 'browse failed') };
  }
}

async function tryKernelBrowse(prompt) {
  return tryBrowsePage({ prompt: prompt });
}

module.exports = {
  tryBrowsePage: tryBrowsePage,
  tryKernelBrowse: tryKernelBrowse,
  extractUrl: extractUrl
};
