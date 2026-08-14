/* lib/kernel-lib.js — Kernel browsers via REST */
function authHeaders(apiKey) {
  return {
    Authorization: 'Bearer ' + apiKey,
    'Content-Type': 'application/json'
  };
}

function extractUrl(text) {
  var m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0] : null;
}

async function tryBrowsePage(opts) {
  opts = opts || {};
  var apiKey = process.env.KERNEL_API_KEY || process.env.KERNEL_KEY;
  if (!apiKey) return { ok: false, error: 'KERNEL_API_KEY not set' };
  var prompt = String(opts.prompt || opts.url || '');
  var url = opts.url || extractUrl(prompt);
  if (!url) return { ok: false, error: 'No URL found in prompt' };
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
      result: result
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

async function tryKernelBrowse(prompt) {
  return tryBrowsePage({ prompt: prompt });
}

module.exports = {
  tryBrowsePage: tryBrowsePage,
  tryKernelBrowse: tryKernelBrowse,
  extractUrl: extractUrl
};
