/* =========================================================================
 * master-client.js — Browser side of the Master Agent
 *
 * Sends the natural-language request to /api/master (which routes it with
 * Prexzy's most capable model — GPT-5.4 via Chatex), shows the routing
 * decision, and can execute the routed endpoint through PrexzyAPI so the
 * same quota/refund rules apply as everywhere else.
 *
 * Quota: routing consumes the `master` bucket; executing the routed call
 * consumes the target agent's bucket (handled inside PrexzyAPI.call).
 * ========================================================================= */

(function () {
  'use strict';

  let lastRoute = null; // last routing decision, used by "Execute on Prexzy"

  // Features that trigger the "confirm before heavy calls" setting.
  const HEAVY_FEATURES = new Set(['image', 'music', 'video']);

  async function runMasterAgent() {
    const input     = document.getElementById('master-input');
    const resultBox = document.getElementById('master-result');
    const actions   = document.getElementById('master-actions');
    const runBtn    = document.getElementById('master-run');
    const badge     = document.getElementById('master-model-badge');
    const message   = input.value.trim();
    if (!message) return;

    const settings = Settings.load((Auth.current() || {}).email);
    if (settings.routingMode === 'manual') {
      show(resultBox, 'Routing mode is set to "Manual selection only" in Settings — pick an agent card below instead.');
      actions.classList.add('hidden');
      return;
    }

    // Master routing consumes the `master` quota bucket.
    const c = Quota.consume('master');
    if (!c.ok) {
      show(resultBox, 'Daily Master Agent routing limit reached (' + Quota.limit('master') + '/day). Resets at midnight.');
      actions.classList.add('hidden');
      return;
    }

    runBtn.disabled = true;
    show(resultBox, 'Routing with GPT-5.4 (Prexzy Chatex)…');
    actions.classList.add('hidden');

    let refunded = false;
    const refundOnce = () => { if (!refunded) { Quota.refund('master'); refunded = true; } };

    try {
      const res = await fetch('/api/master', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message })
      });
      const data = await res.json();

      if (!res.ok) {
        refundOnce();
        show(resultBox, 'Error: ' + (data.error || res.status) + (data.detail ? '\n' + data.detail : ''));
        return;
      }

      lastRoute = data;
      badge.textContent = (data.model_used || 'router') + (data.fallback_used ? ' (fallback)' : '');
      show(resultBox,
        'agent: '     + data.agent_id + '\n' +
        'endpoint: '  + data.endpoint + '\n' +
        'params: '    + JSON.stringify(data.params, null, 2) + '\n' +
        'reasoning: ' + data.reasoning +
        (data.fallback_note ? '\n\n⚠ ' + data.fallback_note : ''));

      // Only offer execution when the routed endpoint exists in the wrapper.
      actions.classList.toggle('hidden', !PrexzyAPI.describe(data.endpoint));
    } catch (e) {
      refundOnce();
      show(resultBox, 'Request failed: ' + e.message);
    } finally {
      runBtn.disabled = false;
    }
  }

  async function executeRoute() {
    if (!lastRoute) return;
    const resultBox = document.getElementById('master-result');
    const endpoint  = PrexzyAPI.describe(lastRoute.endpoint);
    if (!endpoint) return;

    const settings = Settings.load((Auth.current() || {}).email);
    if (settings.confirmHeavy && endpoint.feature && HEAVY_FEATURES.has(endpoint.feature)) {
      const left = Quota.remaining(endpoint.feature);
      if (!confirm(`This will use 1 ${endpoint.feature} call (${left} left today). Continue?`)) return;
    }

    show(resultBox, 'Executing ' + lastRoute.endpoint + ' on Prexzy…');
    try {
      const data = await PrexzyAPI.call(lastRoute.endpoint, lastRoute.params);
      renderExecutionResult(resultBox, data);
    } catch (e) {
      show(resultBox, (e.kind ? '[' + e.kind + '] ' : '') + e.message);
    }
  }

  function renderExecutionResult(box, data) {
    // Binary media (image/audio/video) → inline preview + download link.
    if (data && data._binary) {
      const tag = data.contentType.startsWith('image/') ? 'img'
                : data.contentType.startsWith('audio/') ? 'audio' : 'video';
      box.innerHTML = '';
      const el = document.createElement(tag);
      el.src = data.url;
      if (tag !== 'img') el.controls = true;
      el.className = 'max-w-full rounded-lg';
      const link = document.createElement('a');
      link.href = data.url;
      link.download = 'prexzy-result';
      link.className = 'block mt-2 text-brand-600 underline';
      link.textContent = 'Download result';
      box.append(el, link);
      return;
    }
    // Text / JSON.
    const text = (data && data._text) ? data.text
      : (data && (data.result || data.response || data.answer)) || JSON.stringify(data, null, 2);
    show(box, String(text));
  }

  function show(el, text) {
    el.classList.remove('hidden');
    el.textContent = text;
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('master-run').addEventListener('click', runMasterAgent);
    document.getElementById('master-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runMasterAgent();
    });
    document.getElementById('master-execute').addEventListener('click', executeRoute);
  });

})();
