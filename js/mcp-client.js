/* =========================================================================
 * js/mcp-client.js — Generic MCP client for Canton Node
 *
 * Users add remote MCP servers in Settings. Config is stored per account
 * in localStorage. Tool list / tool call go through /api/mcp (server-side
 * proxy) so secrets never leave a controlled path and CORS is avoided.
 *
 * Public API:
 *   MCPClient.listServers(email)
 *   MCPClient.saveServers(email, servers)
 *   MCPClient.addServer(email, server)
 *   MCPClient.removeServer(email, id)
 *   MCPClient.testServer(server)      → { ok, tools?, error? }
 *   MCPClient.listTools(server)       → { ok, tools, error? }
 *   MCPClient.callTool(server, name, args)
 *   MCPClient.getEnabledTools(email)  → flat list for Master Agent
 * ========================================================================= */

(function (global) {
  'use strict';

  const STORAGE_PREFIX = 'prexzy.mcp.v1';
  const API = '/api/mcp';

  function storageKey(email) {
    return STORAGE_PREFIX + '.' + String(email || 'anon').toLowerCase();
  }

  function uid() {
    return 'mcp_' + Math.random().toString(36).slice(2, 10);
  }

  function loadRaw(email) {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey(email)) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function saveRaw(email, servers) {
    try {
      localStorage.setItem(storageKey(email), JSON.stringify(servers));
    } catch (_) {}
  }

  async function post(body) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let data;
    try {
      data = await res.json();
    } catch (_) {
      data = { ok: false, error: 'Invalid JSON from /api/mcp' };
    }
    if (!res.ok && !data.error) data.error = 'HTTP ' + res.status;
    return data;
  }

  function normalizeServer(s) {
    return {
      id: s.id || uid(),
      name: String(s.name || 'MCP Server').slice(0, 80),
      url: String(s.url || '').trim(),
      headers: s.headers && typeof s.headers === 'object' ? s.headers : {},
      enabled: s.enabled !== false,
      lastTools: Array.isArray(s.lastTools) ? s.lastTools : [],
      lastError: s.lastError || null,
      lastChecked: s.lastChecked || null
    };
  }

  const MCPClient = {
    listServers: function (email) {
      return loadRaw(email).map(normalizeServer);
    },

    saveServers: function (email, servers) {
      saveRaw(email, (servers || []).map(normalizeServer));
    },

    addServer: function (email, server) {
      const list = this.listServers(email);
      const entry = normalizeServer(server);
      list.push(entry);
      this.saveServers(email, list);
      return entry;
    },

    updateServer: function (email, id, patch) {
      const list = this.listServers(email);
      const i = list.findIndex(function (s) { return s.id === id; });
      if (i === -1) return null;
      list[i] = normalizeServer(Object.assign({}, list[i], patch, { id: list[i].id }));
      this.saveServers(email, list);
      return list[i];
    },

    removeServer: function (email, id) {
      const list = this.listServers(email).filter(function (s) { return s.id !== id; });
      this.saveServers(email, list);
    },

    testServer: async function (server) {
      const data = await post({
        action: 'listTools',
        url: server.url,
        headers: server.headers || {}
      });
      return data;
    },

    listTools: async function (server) {
      return this.testServer(server);
    },

    callTool: async function (server, toolName, args) {
      return post({
        action: 'callTool',
        url: server.url,
        headers: server.headers || {},
        tool: toolName,
        arguments: args || {}
      });
    },

    /** Flat tool list for Master Agent prompt injection */
    getEnabledTools: async function (email) {
      const servers = this.listServers(email).filter(function (s) {
        return s.enabled && s.url;
      });
      const out = [];

      for (let i = 0; i < servers.length; i++) {
        const s = servers[i];
        let tools = s.lastTools;
        if (!tools || !tools.length) {
          const res = await this.listTools(s);
          if (res.ok && res.tools) {
            tools = res.tools;
            this.updateServer(email, s.id, {
              lastTools: tools,
              lastError: null,
              lastChecked: new Date().toISOString()
            });
          } else {
            this.updateServer(email, s.id, {
              lastError: res.error || 'listTools failed',
              lastChecked: new Date().toISOString()
            });
            continue;
          }
        }
        tools.forEach(function (t) {
          out.push({
            serverId: s.id,
            serverName: s.name,
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema || { type: 'object' },
            // Qualified name so Master can route uniquely
            qualified: 'mcp:' + s.id + ':' + t.name
          });
        });
      }

      return out;
    }
  };

  global.MCPClient = MCPClient;

})(window);
