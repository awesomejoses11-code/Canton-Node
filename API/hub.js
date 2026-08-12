/* =========================================================================
 * hub.js — Renders the quota dashboard + tool picker on index.html.
 *
 * This is the ONLY file that touches the hub DOM. Individual specialist
 * agents (added in step 3+) mount into #workspace-body via window.PlatformUI.
 * ========================================================================= */

(function () {
  'use strict';

  // ---- Tool catalog (a placeholder until skills.json lands in step 5) -----
  //
  // Each entry becomes a card in the picker. `handler` is either:
  //   - a string 'coming-soon' — renders a stub in the workspace, OR
  //   - a function(mount)     — the specialist agent (populated in step 3+).
  const TOOLS = [
    { id: 'image',      icon: '🎨', title: 'Image Generation',   desc: 'Text → image via Prexzy models',                feature: 'image',      handler: 'coming-soon' },
    { id: 'music',      icon: '🎵', title: 'Music Generation',   desc: 'Lyrics/prompt → audio',                          feature: 'music',      handler: 'coming-soon' },
    { id: 'video',      icon: '🎬', title: 'Video Generation',   desc: 'Text/image → short video',                       feature: 'video',      handler: 'coming-soon' },
    { id: 'image2html', icon: '🖼️', title: 'Image → HTML',       desc: 'Vision + HTML gen composed',                     feature: 'image2html', handler: 'coming-soon' },
    { id: 'html2image', icon: '🧾', title: 'HTML → Image',       desc: 'Render HTML snippet to an image',                feature: 'html2image', handler: 'coming-soon' },
    { id: 'tts',        icon: '🗣️', title: 'Text-to-Speech',     desc: 'Turn text into audio',                           feature: 'tts',        handler: 'coming-soon' },
    { id: 'code',       icon: '💻', title: 'Code Agent',         desc: 'Compile & convert code across languages',        feature: 'code',       handler: 'coming-soon' },
    { id: 'web',        icon: '🌐', title: 'Web / Internet',     desc: 'Ask GPT-5 / Mistral with web search + x402',     feature: 'web',        handler: 'coming-soon' },
    { id: 'chat',       icon: '💬', title: 'AI Chat / Writer',   desc: 'General text tasks',                             feature: 'text',       handler: 'coming-soon' }
  ];

  // ---- Quota dashboard ----------------------------------------------------

  function renderQuota() {
    const grid = document.getElementById('quota-grid');
    const dateEl = document.getElementById('quota-date');
    if (!grid) return;

    const snap = window.Quota.snapshot();
    if (snap[0]) dateEl.textContent = snap[0].date;

    grid.innerHTML = snap.map(row => {
      const pct = row.limit ? Math.min(100, (row.used / row.limit) * 100) : 0;
      const barColor = row.remaining === 0
        ? 'bg-rose-500'
        : row.remaining <= Math.ceil(row.limit * 0.2) ? 'bg-amber-500' : 'bg-emerald-500';
      return `
        <div class="rounded-xl border border-slate-200 p-3 bg-slate-50/40">
          <div class="flex items-center justify-between text-xs text-slate-500">
            <span>${escapeHtml(row.label)}</span>
            <span><b class="text-slate-700">${row.used}</b> / ${row.limit}</span>
          </div>
          <div class="mt-2 h-1.5 w-full bg-slate-200 rounded overflow-hidden">
            <div class="quota-bar h-full ${barColor}" style="width:${pct}%"></div>
          </div>
        </div>`;
    }).join('');
  }

  // ---- Tool picker --------------------------------------------------------

  function renderTools() {
    const grid = document.getElementById('tool-grid');
    if (!grid) return;

    grid.innerHTML = TOOLS.map(t => {
      const remaining = window.Quota.remaining(t.feature);
      const limit     = window.Quota.limit(t.feature);
      const disabled  = remaining === 0;
      return `
        <button
          data-tool-id="${t.id}"
          ${disabled ? 'disabled' : ''}
          class="tool-card text-left rounded-2xl border border-slate-200 bg-white p-4
                 hover:shadow-md disabled:opacity-60 disabled:cursor-not-allowed">
          <div class="flex items-center justify-between">
            <div class="text-2xl">${t.icon}</div>
            <div class="text-[10px] uppercase tracking-wide text-slate-400">
              ${remaining}/${limit} left
            </div>
          </div>
          <div class="mt-2 font-semibold text-sm">${escapeHtml(t.title)}</div>
          <div class="text-xs text-slate-500 mt-0.5">${escapeHtml(t.desc)}</div>
        </button>`;
    }).join('');

    grid.querySelectorAll('button[data-tool-id]').forEach(btn => {
      btn.addEventListener('click', () => openTool(btn.getAttribute('data-tool-id')));
    });
  }

  // ---- Workspace (mount point for specialist agents) ----------------------

  function openTool(id) {
    const tool = TOOLS.find(t => t.id === id);
    if (!tool) return;

    document.getElementById('workspace-title').textContent = tool.title;
    document.getElementById('workspace-desc').textContent  = tool.desc;
    const body = document.getElementById('workspace-body');
    body.innerHTML = '';

    if (typeof tool.handler === 'function') {
      tool.handler(body);
    } else {
      // Stub for tools not yet implemented — will be filled from step 3 on.
      body.innerHTML = `
        <div class="text-sm text-slate-500 border border-dashed border-slate-300 rounded-xl p-6 text-center">
          <div class="text-3xl mb-2">${tool.icon}</div>
          <div class="font-medium text-slate-700">${escapeHtml(tool.title)}</div>
          <div class="mt-1">This specialist agent will be wired up in a later build step.</div>
        </div>`;
    }

    const ws = document.getElementById('agent-workspace');
    ws.classList.remove('hidden');
    ws.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeWorkspace() {
    document.getElementById('agent-workspace').classList.add('hidden');
    document.getElementById('workspace-body').innerHTML = '';
  }

  // ---- Small helpers ------------------------------------------------------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  // Expose a tiny UI helper for future specialist agents to use.
  window.PlatformUI = {
    registerTool(tool) {
      // tool = { id, icon, title, desc, feature, handler }
      const idx = TOOLS.findIndex(t => t.id === tool.id);
      if (idx >= 0) TOOLS[idx] = tool; else TOOLS.push(tool);
      renderTools();
    },
    escapeHtml
  };

  // ---- Wire up ------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', () => {
    renderQuota();
    renderTools();

    document.getElementById('workspace-close').addEventListener('click', closeWorkspace);
    document.getElementById('btn-reset-quota').addEventListener('click', () => {
      if (confirm("Reset today's local quota counters?")) window.Quota.resetAll();
    });

    // Keep the dashboard + picker in sync whenever a quota changes.
    window.Quota.onChange(() => { renderQuota(); renderTools(); });
  });

})();
