/* =========================================================================
 * lib/embed.js — HF sentence embeddings (all-MiniLM-L6-v2, 384-d)
 * ========================================================================= */

var MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
var DIM = 384;

function meanPool(mat) {
  if (!Array.isArray(mat) || !mat.length) return null;
  if (typeof mat[0] === 'number') return mat;
  if (!Array.isArray(mat[0])) return null;
  if (typeof mat[0][0] === 'number') {
    var dim = mat[0].length;
    var acc = new Array(dim);
    for (var d = 0; d < dim; d++) acc[d] = 0;
    for (var i = 0; i < mat.length; i++) {
      for (var d2 = 0; d2 < dim; d2++) acc[d2] += mat[i][d2] || 0;
    }
    for (var d3 = 0; d3 < dim; d3++) acc[d3] /= mat.length;
    return acc;
  }
  return meanPool(mat[0]);
}

async function embedTexts(texts) {
  var token = process.env.HF_TOKEN;
  if (!token) throw new Error('HF_TOKEN missing for embeddings');
  var inputs = Array.isArray(texts) ? texts : [texts];
  if (!inputs.length) return [];

  var res = await fetch(
    'https://api-inference.huggingface.co/pipeline/feature-extraction/' + MODEL,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: inputs.length === 1 ? inputs[0] : inputs,
        options: { wait_for_model: true }
      }),
      signal: AbortSignal.timeout(60000)
    }
  );
  if (!res.ok) {
    var errBody = await res.text().catch(function () { return ''; });
    throw new Error('embed HTTP ' + res.status + ' ' + String(errBody).slice(0, 200));
  }
  var data = await res.json();

  if (inputs.length === 1) {
    return [meanPool(data)];
  }
  if (!Array.isArray(data)) return [meanPool(data)];
  return data.map(function (row) { return meanPool(row); });
}

function toPgVector(arr) {
  if (!arr || !arr.length) return null;
  var a = arr.slice(0, DIM);
  while (a.length < DIM) a.push(0);
  return '[' + a.map(function (x) {
    var n = Number(x);
    if (!isFinite(n)) n = 0;
    return n.toFixed(8);
  }).join(',') + ']';
}

module.exports = {
  embedTexts: embedTexts,
  toPgVector: toPgVector,
  MODEL: MODEL,
  DIM: DIM
};
