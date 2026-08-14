/* Inject favicon + Open Graph tags if missing */
(function () {
  if (document.querySelector('link[rel="icon"]')) return;
  var head = document.head;
  function add(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    head.appendChild(el);
  }
  add('link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' });
  add('link', { rel: 'apple-touch-icon', href: '/favicon.svg' });
  add('meta', { property: 'og:title', content: 'Canton Node' });
  add('meta', { property: 'og:description', content: 'Private multi-tool generative hub' });
  add('meta', { property: 'og:image', content: 'https://canton-node.vercel.app/favicon.svg' });
  add('meta', { name: 'twitter:card', content: 'summary' });
  add('meta', { name: 'twitter:image', content: 'https://canton-node.vercel.app/favicon.svg' });
})();
