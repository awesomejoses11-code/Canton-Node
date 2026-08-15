/* =========================================================================
 * api/pexels.js — Stock photo/video search (last-resort media backup)
 *
 * Env: PEXELS_API_KEY
 * Auth: Authorization: <raw key>  (no "Bearer " prefix)
 * ========================================================================= */

function getKey() {
  return process.env.PEXELS_API_KEY || process.env.PEXELS_KEY || '';
}

function hasPexels() {
  return !!getKey();
}

function toSearchQuery(prompt) {
  var q = String(prompt || '')
    .replace(/\b(generate|create|make|draw|render|produce|a |an |the |please|image of|video of|photo of|picture of|clip of)\b/gi, ' ')
    .replace(/[^\w\s\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return q || String(prompt || '').slice(0, 80);
}

async function searchPhotos(prompt, opts) {
  var key = getKey();
  if (!key) throw new Error('PEXELS_API_KEY not set');
  var query = toSearchQuery(prompt);
  var perPage = (opts && opts.per_page) || 3;
  var url =
    'https://api.pexels.com/v1/search?query=' +
    encodeURIComponent(query) +
    '&per_page=' +
    perPage +
    '&orientation=' +
    encodeURIComponent((opts && opts.orientation) || 'landscape');

  var res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: key, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) {
    var t = await res.text();
    throw new Error('Pexels photos ' + res.status + ': ' + t.slice(0, 200));
  }
  var data = await res.json();
  var photos = data && data.photos;
  if (!photos || !photos.length) throw new Error('Pexels: no photos for "' + query + '"');

  var pick = photos[0];
  var src = pick.src || {};
  var imageUrl = src.large2x || src.large || src.original || src.medium;
  if (!imageUrl) throw new Error('Pexels: photo missing URL');

  return {
    ok: true,
    url: imageUrl,
    source: 'pexels',
    kind: 'stock_photo',
    query: query,
    photographer: pick.photographer || null,
    photographer_url: pick.photographer_url || null,
    pexels_url: pick.url || null,
    attribution:
      'Photo by ' + (pick.photographer || 'Pexels') + ' on Pexels' +
      (pick.url ? ' (' + pick.url + ')' : ''),
    note: 'Stock fallback — not AI-generated. Generation routers were unavailable.'
  };
}

async function searchVideos(prompt, opts) {
  var key = getKey();
  if (!key) throw new Error('PEXELS_API_KEY not set');
  var query = toSearchQuery(prompt);
  var perPage = (opts && opts.per_page) || 3;
  var url =
    'https://api.pexels.com/videos/search?query=' +
    encodeURIComponent(query) +
    '&per_page=' +
    perPage;

  var res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: key, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) {
    var t = await res.text();
    throw new Error('Pexels videos ' + res.status + ': ' + t.slice(0, 200));
  }
  var data = await res.json();
  var videos = data && data.videos;
  if (!videos || !videos.length) throw new Error('Pexels: no videos for "' + query + '"');

  var pick = videos[0];
  var files = (pick.video_files || []).slice().sort(function (a, b) {
    return (b.width || 0) - (a.width || 0);
  });
  var mid = files.find(function (f) {
    return f.file_type === 'video/mp4' && (f.width || 0) <= 1280 && (f.width || 0) >= 640;
  }) || files.find(function (f) {
    return f.file_type === 'video/mp4';
  }) || files[0];
  if (!mid || !mid.link) throw new Error('Pexels: video missing file URL');

  return {
    ok: true,
    url: mid.link,
    video_url: mid.link,
    source: 'pexels',
    kind: 'stock_video',
    query: query,
    width: mid.width || null,
    height: mid.height || null,
    duration: pick.duration || null,
    user: (pick.user && pick.user.name) || null,
    pexels_url: pick.url || null,
    attribution:
      'Video by ' + ((pick.user && pick.user.name) || 'Pexels') + ' on Pexels' +
      (pick.url ? ' (' + pick.url + ')' : ''),
    note: 'Stock fallback — not AI-generated. Generation routers were unavailable.'
  };
}

module.exports = {
  hasPexels: hasPexels,
  toSearchQuery: toSearchQuery,
  searchPhotos: searchPhotos,
  searchVideos: searchVideos
};
