/* app-settings-boot.js - loaded by index.html */
const TAB_ACTIVE = 'tab-btn px-3 py-1.5 rounded-lg bg-white dark:bg-slate-700 shadow-sm text-slate-800 dark:text-slate-100 font-semibold';
const TAB_INACTIVE = 'tab-btn px-3 py-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100';
function switchTab(activeTab) {
  ['models', 'limits', 'settings'].forEach(tab => {
    document.getElementById('tab-btn-' + tab).className = tab === activeTab ? TAB_ACTIVE : TAB_INACTIVE;
    document.getElementById('tab-content-' + tab).classList.toggle('hidden', tab !== activeTab);
  });
  const historyToggle = document.getElementById('btn-history-toggle');
  if (historyToggle) historyToggle.classList.toggle('hidden', activeTab !== 'models');
  if (activeTab !== 'models' && window.MasterChat) window.MasterChat.closeDrawer();
  if (activeTab === 'limits' && window.Hub && Hub.refresh) Hub.refresh();
  if (activeTab === 'settings') {
    if (window.renderMcpList) window.renderMcpList();
  }
}
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
let isSignUp = false;
function toggleAuthMode() {
  isSignUp = !isSignUp;
  document.getElementById('auth-title').textContent = isSignUp ? 'Create Account' : 'Sign In';
  document.getElementById('auth-toggle').textContent = isSignUp ? 'Already have an account? Sign In' : 'Need an account? Register';
  document.getElementById('username-field').classList.toggle('hidden', !isSignUp);
  document.getElementById('auth-username').toggleAttribute('required', isSignUp);
  showAuthError('');
}
document.getElementById('auth-toggle').addEventListener('click', toggleAuthMode);
function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}
function populateSettingsForm(user, s) {
  document.getElementById('set-display-name').value = s.displayName || user.username;
  document.getElementById('set-tone').value = s.tone || 'friendly';
  document.getElementById('set-theme').value = s.theme;
  document.getElementById('set-accent').value = s.accent;
  document.getElementById('set-code-lang').value = s.codeLang;
  document.getElementById('set-image-size').value = s.imageSize;
  document.getElementById('set-tts-voice').value = s.ttsVoice;
  document.getElementById('set-routing-mode').value = s.routingMode;
  var llmEl = document.getElementById('set-llm-provider');
  if (llmEl) llmEl.value = s.llmProvider || 'auto';
  var imgP = document.getElementById('set-image-provider');
  if (imgP) imgP.value = s.imageProvider || 'auto';
  var vidP = document.getElementById('set-video-provider');
  if (vidP) vidP.value = s.videoProvider || 'auto';
  document.getElementById('set-confirm-heavy').checked = s.confirmHeavy;
  document.getElementById('set-compact-cards').checked = s.compactCards;
  var memEl = document.getElementById('set-memory-enabled');
  if (memEl) memEl.checked = s.memoryEnabled !== false;
}
async function enterApp(user) {
  Quota.setScope(user.email);
  var settings = Settings.load(user.email);
  try { if (user.token && Settings.syncFromServer) settings = await Settings.syncFromServer(user.email); } catch (_) {}
  try { if (user.token && window.History && History.syncFromServer) await History.syncFromServer(user.email); } catch (_) {}
  Settings.applyAll(settings);
  populateSettingsForm(user, settings);
  if (window.Hub && Hub.refresh) Hub.refresh();
  if (window.MasterChat) window.MasterChat.reset();
  if (window.renderMcpList) window.renderMcpList();
  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  switchTab('models');
}
document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    let user;
    if (isSignUp) user = await Auth.register(document.getElementById('auth-email').value.trim(), document.getElementById('auth-username').value.trim(), document.getElementById('auth-password').value, document.getElementById('auth-remember').checked);
    else user = await Auth.login(document.getElementById('auth-email').value.trim(), document.getElementById('auth-password').value, document.getElementById('auth-remember').checked);
    await enterApp(user);
  } catch (err) { showAuthError(err.message); }
});
document.getElementById('btn-logout').addEventListener('click', () => {
  Auth.logout(); Quota.setScope('anon');
  if (window.MasterChat) window.MasterChat.reset();
  document.getElementById('app-view').classList.add('hidden');
  document.getElementById('auth-view').classList.remove('hidden');
});
document.getElementById('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const user = Auth.current(); if (!user) return;
  const s = {
    displayName: document.getElementById('set-display-name').value.trim(),
    tone: document.getElementById('set-tone').value,
    theme: document.getElementById('set-theme').value,
    accent: document.getElementById('set-accent').value,
    codeLang: document.getElementById('set-code-lang').value,
    imageSize: document.getElementById('set-image-size').value,
    ttsVoice: document.getElementById('set-tts-voice').value,
    routingMode: document.getElementById('set-routing-mode').value,
    llmProvider: document.getElementById('set-llm-provider') ? document.getElementById('set-llm-provider').value : 'auto',
    imageProvider: document.getElementById('set-image-provider') ? document.getElementById('set-image-provider').value : 'auto',
    videoProvider: document.getElementById('set-video-provider') ? document.getElementById('set-video-provider').value : 'auto',
    confirmHeavy: document.getElementById('set-confirm-heavy').checked,
    compactCards: document.getElementById('set-compact-cards').checked,
    memoryEnabled: document.getElementById('set-memory-enabled') ? document.getElementById('set-memory-enabled').checked : true
  };
  Settings.save(user.email, s); Settings.applyAll(s);
  if (window.Hub && Hub.refresh) Hub.refresh();
  const ok = document.getElementById('settings-saved'); ok.classList.remove('hidden'); setTimeout(() => ok.classList.add('hidden'), 2000);
});
function mcpCurrentEmail() { const u = Auth.current(); return u ? u.email : 'anon'; }
function renderMcpList() {
  if (!window.MCPClient) return;
  const listEl = document.getElementById('mcp-list'); const emptyEl = document.getElementById('mcp-empty');
  const servers = MCPClient.listServers(mcpCurrentEmail());
  listEl.innerHTML = ''; emptyEl.classList.toggle('hidden', servers.length > 0);
  servers.forEach(function (s) {
    const card = document.createElement('div');
    card.className = 'flex flex-col sm:flex-row sm:items-center gap-2 p-3 rounded-xl border border-slate-200 dark:border-slate-600';
    card.innerHTML = '<div class="flex-1 min-w-0"><div class="flex items-center gap-2"><span class="text-sm font-medium truncate">' + escapeHtml(s.name) + '</span>' + (s.enabled ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">on</span>' : '<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">off</span>') + '</div><p class="text-[11px] text-slate-400 font-mono truncate">' + escapeHtml(s.url) + '</p></div><div class="flex flex-wrap gap-1.5"><button type="button" data-mcp-action="toggle" data-id="' + s.id + '" class="text-xs px-2 py-1 rounded-lg border">' + (s.enabled ? 'Disable' : 'Enable') + '</button><button type="button" data-mcp-action="refresh" data-id="' + s.id + '" class="text-xs px-2 py-1 rounded-lg border">Refresh</button><button type="button" data-mcp-action="remove" data-id="' + s.id + '" class="text-xs px-2 py-1 rounded-lg border text-rose-600">Remove</button></div>';
    listEl.appendChild(card);
  });
  listEl.querySelectorAll('[data-mcp-action]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      const id = btn.getAttribute('data-id'); const action = btn.getAttribute('data-mcp-action'); const email = mcpCurrentEmail();
      if (action === 'remove') { MCPClient.removeServer(email, id); renderMcpList(); return; }
      if (action === 'toggle') { const s = MCPClient.listServers(email).find(x => x.id === id); if (s) MCPClient.updateServer(email, id, { enabled: !s.enabled }); renderMcpList(); return; }
      if (action === 'refresh') {
        btn.disabled = true; btn.textContent = '…';
        const s = MCPClient.listServers(email).find(x => x.id === id);
        if (s) { const res = await MCPClient.listTools(s); MCPClient.updateServer(email, id, { lastTools: res.ok ? (res.tools || []) : [], lastError: res.ok ? null : (res.error || 'Failed'), lastChecked: new Date().toISOString() }); }
        renderMcpList();
      }
    });
  });
}
window.renderMcpList = renderMcpList;
function escapeHtml(str) { return String(str || '').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"'); }
function mcpBuildHeaders() {
  const raw = document.getElementById('mcp-auth').value.trim();
  if (!raw) return {};
  if (/^bearer\s+/i.test(raw)) return { Authorization: raw };
  return { Authorization: 'Bearer ' + raw };
}
document.getElementById('mcp-add-btn').addEventListener('click', function () { document.getElementById('mcp-form').classList.remove('hidden'); document.getElementById('mcp-form-status').textContent = ''; });
document.getElementById('mcp-cancel-btn').addEventListener('click', function () { document.getElementById('mcp-form').classList.add('hidden'); document.getElementById('mcp-name').value = ''; document.getElementById('mcp-url').value = ''; document.getElementById('mcp-auth').value = ''; });
document.getElementById('mcp-test-btn').addEventListener('click', async function () {
  const status = document.getElementById('mcp-form-status'); const url = document.getElementById('mcp-url').value.trim();
  if (!url) { status.textContent = 'URL required'; status.className = 'text-xs text-rose-500'; return; }
  status.textContent = 'Testing…'; const res = await MCPClient.testServer({ url: url, headers: mcpBuildHeaders() });
  status.textContent = res.ok ? ('OK — ' + (res.tools || []).length + ' tool(s)') : (res.error || 'Failed');
  status.className = res.ok ? 'text-xs text-emerald-600' : 'text-xs text-rose-500';
});
document.getElementById('mcp-save-btn').addEventListener('click', async function () {
  const status = document.getElementById('mcp-form-status');
  const name = document.getElementById('mcp-name').value.trim() || 'MCP Server';
  const url = document.getElementById('mcp-url').value.trim();
  if (!url) { status.textContent = 'URL required'; status.className = 'text-xs text-rose-500'; return; }
  const headers = mcpBuildHeaders();
  const res = await MCPClient.testServer({ url: url, headers: headers });
  MCPClient.addServer(mcpCurrentEmail(), { name: name, url: url, headers: headers, enabled: true, lastTools: res.ok ? (res.tools || []) : [], lastError: res.ok ? null : (res.error || 'Could not list tools'), lastChecked: new Date().toISOString() });
  document.getElementById('mcp-form').classList.add('hidden');
  document.getElementById('mcp-name').value = ''; document.getElementById('mcp-url').value = ''; document.getElementById('mcp-auth').value = '';
  renderMcpList();
});
document.addEventListener('DOMContentLoaded', async () => {
  try { if (Auth.refresh) await Auth.refresh(); } catch (_) {}
  const user = Auth.current();
  Settings.applyAll(Settings.load((user || {}).email));
  if (user) await enterApp(user);
  switchTab('models');
});
