/* image-gen-addon.js — extends PrexzyAPI with generateImage (HF → Prexzy) */
(function (global) {
  'use strict';
  if (!global.PrexzyAPI) return;
  var PrexzyError = global.PrexzyAPI.PrexzyError;
  global.PrexzyAPI.generateImage = async function (params, opts) {
    opts = opts || {};
    var prompt = (params && params.prompt) || '';
    if (!prompt) throw new PrexzyError('unknown', 'Missing prompt for image');
    var c = global.Quota.consume('image');
    if (!c.ok) {
      throw new PrexzyError('quota', 'Daily limit reached for "image". Try again tomorrow.', { feature: 'image' });
    }
    var loading = null;
    if (opts.loadingEl && global.PrexzyAPI.showLoading) {
      loading = global.PrexzyAPI.showLoading(opts.loadingEl, 'Generating image…');
    }
    var refunded = false;
    function refundOnce() {
      if (!refunded) { global.Quota.refund('image'); refunded = true; }
    }
    try {
      if (loading) loading.setMessage('Trying Hugging Face FLUX → Prexzy…');
      var res = await fetch('/api/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt, size: params.size || undefined }),
        signal: opts.signal
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        refundOnce();
        throw new PrexzyError('http', data.error || ('HTTP ' + res.status), { status: res.status });
      }
      if (loading) loading.clear();
      if (data.url && !data.image_url) data.image_url = data.url;
      return data;
    } catch (e) {
      refundOnce();
      if (loading) loading.clear();
      if (e instanceof PrexzyError) throw e;
      throw new PrexzyError('network', e.message || 'Image request failed');
    }
  };
})(window);
