/* lib/master-patches.js — applied by api/master.js at boot
 * 1) Expand fact-seeking detection (details of / what is / blockchain…)
 * 2) After tryGenerateAnswer, recover pure tool-narration replies
 */
var toolRecovery = null;
try { toolRecovery = require('./tool-recovery'); } catch (_) { toolRecovery = null; }

function expandWantsWeb(originalFn) {
  return function wantsWebPatched(message) {
    if (typeof originalFn === 'function' && originalFn(message)) return true;
    var m = String(message || '').toLowerCase();
    if (/\b(details? (of|on|about)|what is|what's|tell me about|overview of|explain|info on|information (on|about))\b/.test(m)) return true;
    if (/\b(blockchain|network|protocol|tokenomics|mainnet|testnet|airdrop|ecosystem)\b/.test(m)) return true;
    return false;
  };
}

function wrapTryGenerate(originalFn) {
  return async function tryGenerateAnswerPatched(message, history, prefs, memory, opts) {
    opts = opts || {};
    var result = await originalFn(message, history, prefs, memory, opts);
    if (!result || opts._noRecover) return result;
    if (!toolRecovery || typeof toolRecovery.recoverIfNeeded !== 'function') {
      if (result.text && toolRecovery && toolRecovery.clean) result.text = toolRecovery.clean(result.text);
      return result;
    }
    if (!toolRecovery.needsRecovery(result.text || '')) {
      if (result.text) result.text = toolRecovery.clean(result.text);
      return result;
    }
    // Second pass: forced search + synthesis (no recursive recovery)
    var recovered = await toolRecovery.recoverIfNeeded(
      message,
      history,
      prefs,
      memory,
      Object.assign({}, opts, { _noRecover: true, onDelta: opts.onDelta }),
      function (msg, hist, pr, mem, o) {
        return originalFn(msg, hist, pr, mem, Object.assign({}, o || {}, { _noRecover: true }));
      },
      result
    );
    return recovered || result;
  };
}

function apply(exportsObj) {
  // no-op shape for clarity
  return exportsObj;
}

module.exports = {
  expandWantsWeb: expandWantsWeb,
  wrapTryGenerate: wrapTryGenerate,
  apply: apply
};
