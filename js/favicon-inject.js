/* Inject favicon + Open Graph tags if missing; load table-safe markdown CSS */
(function () {
  if (!document.querySelector('link[rel="icon"]')) {
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
  }

  // Markdown tables: horizontal scroll inside chat bubble, no layout breach
  if (!document.querySelector('script[data-cn="md-tables"]')) {
    var s = document.createElement('script');
    s.src = '/js/md-tables.js';
    s.defer = true;
    s.setAttribute('data-cn', 'md-tables');
    document.head.appendChild(s);
  }
})();
