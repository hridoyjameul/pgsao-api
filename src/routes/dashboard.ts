import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';
import { GATEWAY_VERSION } from '../utils/version.js';

/**
 * GET /dashboard — self-contained HTML control panel (no external assets/deps).
 * Unauthenticated shell: the page itself needs no key, but every data call it
 * makes (usage, sessions) goes through the existing authed routes from the
 * browser, using a key the user pastes in and that stays in localStorage —
 * never sent anywhere but this gateway's own API.
 */
export function registerDashboardRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  app.get('/dashboard', async (_request, reply) => {
    reply.type('text/html').send(renderDashboard(gateway));
  });
}

function renderDashboard(gateway: GatewayDeps): string {
  const { config } = gateway;
  const baseUrl = `http://${config.HOST}:${config.PORT}`;

  // Built server-side and handed to the page as JSON so no manual escaping
  // is needed across the TS -> HTML -> browser-JS layers. Placeholders only
  // (never the real key) — this text is meant to be copy-pasted or screenshotted.
  const snippets: Record<string, string> = {
    'curl-openai': [
      `curl ${baseUrl}/v1/chat/completions \\`,
      `  -H "Authorization: Bearer $GATEWAY_API_KEY" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"model":"claude-via-gateway","messages":[{"role":"user","content":"Hello."}]}'`,
    ].join('\n'),
    'curl-anthropic': [
      `curl ${baseUrl}/v1/messages \\`,
      `  -H "x-api-key: $GATEWAY_API_KEY" \\`,
      `  -H "anthropic-version: 2023-06-01" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"model":"claude-via-gateway","max_tokens":256,"messages":[{"role":"user","content":"Hello."}]}'`,
    ].join('\n'),
    'sdk-openai': [
      `import OpenAI from "openai";`,
      ``,
      `const client = new OpenAI({`,
      `  apiKey: "YOUR_GATEWAY_API_KEY",`,
      `  baseURL: "${baseUrl}/v1",`,
      `});`,
      ``,
      `const res = await client.chat.completions.create({`,
      `  model: "claude-via-gateway",`,
      `  messages: [{ role: "user", content: "Hello." }],`,
      `});`,
    ].join('\n'),
    'sdk-anthropic': [
      `import Anthropic from "@anthropic-ai/sdk";`,
      ``,
      `const client = new Anthropic({`,
      `  apiKey: "YOUR_GATEWAY_API_KEY",`,
      `  baseURL: "${baseUrl}",`,
      `});`,
      ``,
      `const res = await client.messages.create({`,
      `  model: "claude-via-gateway",`,
      `  max_tokens: 256,`,
      `  messages: [{ role: "user", content: "Hello." }],`,
      `});`,
    ].join('\n'),
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PGSAO API</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, Segoe UI, sans-serif; max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; background: light-dark(#fafafa, #111); color: light-dark(#111, #eee); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 24px; }
  .card { border: 1px solid light-dark(#ddd, #333); border-radius: 8px; padding: 16px; margin-bottom: 16px; background: light-dark(#fff, #1a1a1a); }
  .card h2 { font-size: 14px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: .04em; color: #888; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .dot.ok { background: #2ea043; } .dot.err { background: #d1242f; } .dot.warn { background: #bf8700; }
  input, select { font: inherit; padding: 6px 8px; border: 1px solid light-dark(#ccc, #444); border-radius: 6px; background: light-dark(#fff, #222); color: inherit; }
  input[type=text], input[type=password] { flex: 1; min-width: 220px; }
  button { font: inherit; padding: 6px 12px; border: 1px solid light-dark(#ccc, #444); border-radius: 6px; background: light-dark(#f0f0f0, #2a2a2a); color: inherit; cursor: pointer; }
  button:hover { background: light-dark(#e5e5e5, #333); }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid light-dark(#eee, #2a2a2a); }
  th { color: #888; font-weight: 500; }
  pre { background: light-dark(#f4f4f4, #0d0d0d); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12.5px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .stat { font-size: 24px; font-weight: 600; }
  .stat-label { color: #888; font-size: 12px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 12px; margin-bottom: 12px; }
  .muted { color: #888; font-size: 12px; }
  .tabs button { background: none; border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 8px 4px; margin-right: 16px; }
  .tabs button.active { border-bottom-color: #2563eb; font-weight: 600; }
</style>
</head>
<body>

<h1>PGSAO API</h1>
<div class="sub">Personal Gateway for Anthropic/OpenAI API &middot; v${GATEWAY_VERSION} &middot; <span id="baseUrl">${baseUrl}</span></div>

<div class="card">
  <h2>Status</h2>
  <div class="row" id="statusRow"><span class="dot warn"></span> checking&hellip;</div>
</div>

<div class="card">
  <h2>Gateway key</h2>
  <div class="row">
    <input type="password" id="apiKey" placeholder="paste your GATEWAY_API_KEY&hellip;">
    <button id="toggleKey">show</button>
    <button id="saveKey" class="primary">save</button>
  </div>
  <div class="muted" style="margin-top:8px">Stored only in this browser's localStorage. Never sent anywhere but this gateway. Generate one with <code>pgsao-api key generate</code> if you don't have one yet.</div>
</div>

<div class="card">
  <h2>Usage</h2>
  <div id="usageBody"><div class="muted">Save a key above to load usage stats.</div></div>
</div>

<div class="card">
  <h2>Sessions</h2>
  <div class="row">
    <button id="createSession" class="primary">+ new session</button>
    <input type="text" id="sessionLookup" placeholder="session id to look up / delete">
    <button id="getSession">get</button>
    <button id="deleteSession">delete</button>
  </div>
  <pre id="sessionOut" class="muted">no session looked up yet</pre>
</div>

<div class="card">
  <h2>Use it</h2>
  <div class="tabs">
    <button class="tab-btn active" data-tab="curl-openai">curl (OpenAI shape)</button>
    <button class="tab-btn" data-tab="curl-anthropic">curl (Anthropic shape)</button>
    <button class="tab-btn" data-tab="sdk-openai">openai SDK</button>
    <button class="tab-btn" data-tab="sdk-anthropic">anthropic SDK</button>
  </div>
  <pre id="snippet"></pre>
</div>

<script id="snippets-data" type="application/json">${JSON.stringify(snippets).replace(/</g, '\\u003c')}</script>
<script>
(function () {
  var snippets = JSON.parse(document.getElementById('snippets-data').textContent);
  var STORAGE_KEY = 'pgsao_gateway_api_key';

  function getKey() { try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; } }
  function setKey(v) { try { localStorage.setItem(STORAGE_KEY, v); } catch (e) {} }

  var keyInput = document.getElementById('apiKey');
  keyInput.value = getKey();

  document.getElementById('toggleKey').onclick = function () {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    this.textContent = keyInput.type === 'password' ? 'show' : 'hide';
  };
  document.getElementById('saveKey').onclick = function () {
    setKey(keyInput.value.trim());
    loadUsage();
  };

  function fmtStatus(dot, text) {
    document.getElementById('statusRow').innerHTML = '<span class="dot ' + dot + '"></span> ' + text;
  }

  function loadHealth() {
    fetch('/health').then(function (r) { return r.json(); }).then(function (h) {
      var dot = h.claude_auth_status === 'ok' ? 'ok' : 'err';
      fmtStatus(dot,
        'claude auth: <b>' + h.claude_auth_status + '</b> &middot; ' +
        h.active_requests + ' active / ' + h.queued_requests + ' queued &middot; ' +
        'openai route: ' + h.routes.openai_compatible + ' &middot; anthropic route: ' + h.routes.anthropic_compatible);
    }).catch(function () { fmtStatus('err', 'gateway unreachable'); });
  }

  function authHeaders() {
    var k = getKey();
    return k ? { 'Authorization': 'Bearer ' + k } : {};
  }

  function loadUsage() {
    var k = getKey();
    var el = document.getElementById('usageBody');
    if (!k) { el.innerHTML = '<div class="muted">Save a key above to load usage stats.</div>'; return; }
    fetch('/v1/usage', { headers: authHeaders() }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (u) {
      var rows = Object.keys(u.byRoute || {}).map(function (route) {
        var s = u.byRoute[route];
        return '<tr><td>' + route + '</td><td>' + s.total + '</td><td>' + s.ok + '</td><td>' + s.error + '</td><td>' + (s.avgQueueWaitMs == null ? '–' : s.avgQueueWaitMs + 'ms') + '</td></tr>';
      }).join('');
      var errRows = Object.keys(u.errorsByType || {}).map(function (t) {
        return '<tr><td>' + t + '</td><td>' + u.errorsByType[t] + '</td></tr>';
      }).join('');
      el.innerHTML =
        '<div class="stats-grid"><div><div class="stat">' + u.total + '</div><div class="stat-label">total requests</div></div></div>' +
        '<table><thead><tr><th>route</th><th>total</th><th>ok</th><th>error</th><th>avg queue wait</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5" class="muted">no requests yet</td></tr>') + '</tbody></table>' +
        (errRows ? '<h3 style="font-size:12px;color:#888;margin:16px 0 4px">errors by type</h3><table><tbody>' + errRows + '</tbody></table>' : '');
    }).catch(function (e) {
      el.innerHTML = '<div class="muted">could not load usage (' + e.message + ') — check the key is correct</div>';
    });
  }

  document.getElementById('createSession').onclick = function () {
    fetch('/v1/sessions', { method: 'POST', headers: authHeaders() }).then(function (r) { return r.json(); }).then(function (s) {
      document.getElementById('sessionLookup').value = s.id || '';
      document.getElementById('sessionOut').textContent = JSON.stringify(s, null, 2);
    }).catch(function (e) { document.getElementById('sessionOut').textContent = 'error: ' + e.message; });
  };
  document.getElementById('getSession').onclick = function () {
    var id = document.getElementById('sessionLookup').value.trim();
    if (!id) return;
    fetch('/v1/sessions/' + encodeURIComponent(id), { headers: authHeaders() }).then(function (r) { return r.json(); }).then(function (s) {
      document.getElementById('sessionOut').textContent = JSON.stringify(s, null, 2);
    }).catch(function (e) { document.getElementById('sessionOut').textContent = 'error: ' + e.message; });
  };
  document.getElementById('deleteSession').onclick = function () {
    var id = document.getElementById('sessionLookup').value.trim();
    if (!id) return;
    fetch('/v1/sessions/' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() }).then(function (r) {
      document.getElementById('sessionOut').textContent = r.status === 204 ? 'deleted' : ('HTTP ' + r.status);
    }).catch(function (e) { document.getElementById('sessionOut').textContent = 'error: ' + e.message; });
  };

  var activeTab = 'curl-openai';
  function renderSnippet() {
    document.getElementById('snippet').textContent = snippets[activeTab];
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (btn) {
    btn.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activeTab = btn.getAttribute('data-tab');
      renderSnippet();
    };
  });

  loadHealth();
  loadUsage();
  renderSnippet();
  setInterval(loadHealth, 5000);
})();
</script>
</body>
</html>`;
}
