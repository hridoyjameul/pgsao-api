import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';
import { GATEWAY_VERSION } from '../utils/version.js';
import { APP_ICON_BASE64 } from '../utils/icon.js';

/**
 * GET /dashboard — self-contained HTML control panel (no external assets/deps).
 * Unauthenticated shell: the page itself needs no key up front (it fetches
 * one for itself from /v1/setup/key, loopback-only — see routes/setup.ts).
 * Every other data call it makes (usage, sessions) goes through the existing
 * authed routes from the browser, using that key kept in localStorage —
 * never sent anywhere but this gateway's own API.
 */
export function registerDashboardRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  app.get('/', async (_request, reply) => {
    reply.redirect('/dashboard');
  });
  app.get('/dashboard', async (request, reply) => {
    reply.type('text/html').send(renderDashboard(gateway, request.headers.host));
  });
}

function renderDashboard(gateway: GatewayDeps, requestHost?: string): string {
  const { config } = gateway;
  // Prefer the Host header the browser actually used (e.g. "localhost:8787")
  // over config.HOST — under Docker, config.HOST is "0.0.0.0" (the bind
  // address inside the container), which isn't something you can paste into
  // another app's Base URL field.
  const safeHost = requestHost && /^[a-zA-Z0-9.:[\]-]+$/.test(requestHost)
    ? requestHost : `127.0.0.1:${config.PORT}`;
  const baseUrl = `http://${safeHost}`;

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
<link rel="icon" type="image/png" href="data:image/png;base64,${APP_ICON_BASE64}">
<link rel="apple-touch-icon" href="data:image/png;base64,${APP_ICON_BASE64}">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, Segoe UI, sans-serif; max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; background: light-dark(#fafafa, #111); color: light-dark(#111, #eee); }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13.5px; margin-bottom: 24px; }
  .card { border: 1px solid light-dark(#ddd, #333); border-radius: 8px; padding: 16px; margin-bottom: 16px; background: light-dark(#fff, #1a1a1a); }
  .card h2 { font-size: 14px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: .04em; color: #888; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 6px; flex: none; }
  .dot.ok { background: #2ea043; } .dot.err { background: #d1242f; } .dot.warn { background: #bf8700; }
  input, select { font: inherit; padding: 6px 8px; border: 1px solid light-dark(#ccc, #444); border-radius: 6px; background: light-dark(#fff, #222); color: inherit; }
  input[type=text], input[type=password] { flex: 1; min-width: 200px; }
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
  .step { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid light-dark(#eee, #2a2a2a); }
  .step:last-child { border-bottom: none; }
  .stepnum { flex: none; width: 22px; height: 22px; border-radius: 50%; background: light-dark(#eee, #2a2a2a); color: inherit; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-top: 1px; }
  .stepbody { flex: 1; min-width: 0; }
  .steptitle { font-weight: 600; margin-bottom: 4px; }
  .check { color: #2ea043; font-weight: 700; }
  summary { cursor: pointer; font-size: 14px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: .04em; padding: 4px 0; }
  details[open] summary { margin-bottom: 12px; }
  .field-label { font-size: 12px; color: #888; margin-bottom: 4px; }
  .keybox { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .provider-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 12px; }
  .provider-card { border: 1px solid light-dark(#ddd, #333); border-radius: 8px; padding: 14px; min-width: 0; }
  .provider-card h3 { margin: 0 0 8px; font-size: 16px; }
  .provider-state { margin: 4px 0; font-size: 13px; }
  .provider-details { margin-top: 12px; border-top: 1px solid light-dark(#eee, #333); padding-top: 10px; }
  .provider-details input { min-width: 0; }
</style>
</head>
<body>

<h1>PGSAO API</h1>
<div class="sub">Your personal AI gateway &middot; running on this computer &middot; v${GATEWAY_VERSION}</div>

<div class="card">
  <h2>Setup</h2>

  <div class="step">
    <span class="stepnum">1</span>
    <div class="stepbody">
      <div class="steptitle">App installed and running <span class="check">&check;</span></div>
      <div class="muted">You're looking at it — if this page loaded, the app is running.</div>
    </div>
  </div>

  <div class="step">
    <span class="stepnum">2</span>
    <div class="stepbody">
      <div class="steptitle">Claude account</div>
      <div id="claudeStatus" class="muted">Checking&hellip;</div>
    </div>
  </div>

  <div class="step">
    <span class="stepnum">3</span>
    <div class="stepbody">
      <div class="steptitle">Your API key</div>
      <div class="muted" style="margin-bottom:8px">Created automatically. Copy it into any app that asks for an API key.</div>
      <div class="row">
        <input type="password" id="apiKey" class="keybox" readonly>
        <button id="toggleKey">show</button>
        <button id="copyKey" class="primary">copy</button>
      </div>
      <div id="keyMsg" class="muted" style="margin-top:6px"></div>
    </div>
  </div>
</div>

<div class="card">
  <h2>Gateway inference</h2>
  <div class="row"><span id="servingStatus" class="muted">Checking&hellip;</span><button id="startServing">Start</button><button id="stopServing">Stop</button></div>
</div>

<div class="card">
  <h2>AI providers</h2>
  <div class="muted" style="margin-bottom:12px">Each ready provider has its own Base URL. The gateway API key above works with every ready route.</div>
  <div id="chatgptNotice" class="muted"></div>
  <div id="providerCards" class="provider-grid"><div class="muted">Loading providers&hellip;</div></div>
</div>

<details>
  <summary>Advanced (for developers)</summary>

  <div class="card">
    <h2>Usage</h2>
    <div id="usageBody"><div class="muted">Loading&hellip;</div></div>
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

  <div class="card" id="snippetCard" hidden>
    <h2>Code snippets</h2>
    <div class="tabs">
      <button class="tab-btn active" data-tab="curl-openai">curl (OpenAI shape)</button>
      <button class="tab-btn" data-tab="curl-anthropic">curl (Anthropic shape)</button>
      <button class="tab-btn" data-tab="sdk-openai">openai SDK</button>
      <button class="tab-btn" data-tab="sdk-anthropic">anthropic SDK</button>
    </div>
    <pre id="snippet"></pre>
  </div>
</details>

<script id="snippets-data" type="application/json">${JSON.stringify(snippets).replace(/</g, '\\u003c')}</script>
<script>
(function () {
  var snippets = JSON.parse(document.getElementById('snippets-data').textContent);
  var STORAGE_KEY = 'pgsao_gateway_api_key';

  function getKey() { try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; } }
  function setKey(v) { try { localStorage.setItem(STORAGE_KEY, v); } catch (e) {} }

  var keyInput = document.getElementById('apiKey');
  var keyMsg = document.getElementById('keyMsg');

  function applyKey(v) {
    keyInput.value = v;
  }

  document.getElementById('toggleKey').onclick = function () {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    this.textContent = keyInput.type === 'password' ? 'show' : 'hide';
  };

  function copyToClipboard(text, btn) {
    var done = function () { var orig = btn.textContent; btn.textContent = 'copied!'; setTimeout(function () { btn.textContent = orig; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {});
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
        done();
      } catch (e) {}
    }
  }

  document.getElementById('copyKey').onclick = function () { copyToClipboard(keyInput.value, this); };
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy-target]'), function (btn) {
    btn.onclick = function () {
      var target = document.getElementById(btn.getAttribute('data-copy-target'));
      copyToClipboard(target.value, btn);
    };
  });

  function fmtClaudeStatus(dot, text) {
    document.getElementById('claudeStatus').innerHTML = '<span class="dot ' + dot + '"></span> ' + text;
  }

  function loadHealth() {
    fetch('/health').then(function (r) { return r.json(); }).then(function (h) {
      if (h.claude_auth_status === 'ok') {
        fmtClaudeStatus('ok', 'Connected <span class="check">&check;</span>');
      } else {
        fmtClaudeStatus('err', 'Not connected — log in to Claude Code on this computer, then reload this page.');
      }
    }).catch(function () { fmtClaudeStatus('err', 'Could not reach the app.'); });
  }

  function authHeaders() {
    var k = getKey();
    return k ? { 'Authorization': 'Bearer ' + k } : {};
  }

  function providerLine(parent, label, state, detail) {
    var line = document.createElement('div');
    line.className = 'provider-state';
    line.textContent = label + ': ' + state + (detail ? ' — ' + detail : '');
    parent.appendChild(line);
  }

  function loadProviders() {
    var cards = document.getElementById('providerCards');
    if (!getKey()) { cards.textContent = 'Waiting for your API key…'; return; }
    fetch('/v1/providers', { headers: authHeaders() }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      cards.replaceChildren();
      var claudeReady = false;
      (data.providers || []).forEach(function (provider) {
        var card = document.createElement('section');
        card.className = 'provider-card';
        var title = document.createElement('h3');
        title.textContent = provider.displayName;
        card.appendChild(title);
        providerLine(card, 'Client detected', provider.client.state, provider.client.method);
        providerLine(card, 'Account connected', provider.connection.state, provider.connection.detail);
        providerLine(card, 'Gateway API ready', provider.api.ready ? 'yes' : 'no');
        if (provider.id === 'chatgpt') {
          var accountPicker = document.createElement('select');
          var newAccount = document.createElement('option');
          newAccount.value = ''; newAccount.textContent = 'Add a ChatGPT account';
          accountPicker.appendChild(newAccount);
          (provider.connection.registrations || []).forEach(function (registration) {
            var option = document.createElement('option');
            option.value = registration.registrationId;
            option.textContent = registration.label + (registration.selected ? ' (active)' : '');
            accountPicker.appendChild(option);
            if (registration.selected) accountPicker.value = registration.registrationId;
          });
          var connectButton = document.createElement('button');
          connectButton.textContent = 'Continue with ChatGPT';
          connectButton.onclick = function () {
            connectButton.disabled = true;
            fetch('/v1/providers/chatgpt/connect', {
              method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
              body: JSON.stringify(accountPicker.value ? { registrationId: accountPicker.value } : {}),
            }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
              .then(function (result) { window.location.assign(result.authorizationUrl); })
              .catch(function () { connectButton.disabled = false; connectButton.textContent = 'Sign-in failed; retry'; });
          };
          var connectRow = document.createElement('div');
          connectRow.className = 'row';
          connectRow.appendChild(accountPicker); connectRow.appendChild(connectButton);
          card.appendChild(connectRow);
          if (provider.connection.state === 'connected') {
            var disconnectButton = document.createElement('button');
            disconnectButton.textContent = 'Disconnect ChatGPT';
            disconnectButton.onclick = function () {
              disconnectButton.disabled = true;
              fetch('/v1/providers/chatgpt/disconnect', { method: 'POST', headers: authHeaders() })
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function (result) {
                  document.getElementById('chatgptNotice').textContent = result.remoteRevocationConfirmed
                    ? 'ChatGPT disconnected.'
                    : 'ChatGPT disconnected locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.';
                  loadProviders();
                })
                .catch(function () { disconnectButton.disabled = false; });
            };
            card.appendChild(disconnectButton);
          }
        }
        if (provider.api.ready) {
          if (provider.id === 'claude') claudeReady = true;
          var details = document.createElement('div');
          details.className = 'provider-details';
          provider.api.capabilities.forEach(function (capability) {
            var label = document.createElement('div');
            label.className = 'field-label';
            label.textContent = capability.shape.replace(/_/g, ' ') + (capability.legacy ? ' (legacy)' : '') + ' Base URL';
            details.appendChild(label);
            var row = document.createElement('div');
            row.className = 'row';
            var input = document.createElement('input');
            input.type = 'text'; input.readOnly = true; input.className = 'keybox';
            input.value = window.location.origin + capability.basePath;
            var copy = document.createElement('button');
            copy.textContent = 'copy';
            copy.onclick = function () { copyToClipboard(input.value, copy); };
            row.appendChild(input); row.appendChild(copy); details.appendChild(row);
          });
          card.appendChild(details);
          if (provider.id === 'claude') {
            fetch('/claude/v1/models', { headers: authHeaders() }).then(function (r) { return r.json(); }).then(function (models) {
              var modelLine = document.createElement('div');
              modelLine.className = 'muted';
              modelLine.textContent = 'Models: ' + (models.data || []).map(function (m) { return m.id; }).join(', ');
              details.appendChild(modelLine);
            }).catch(function () {});
          } else if (provider.id === 'chatgpt') {
            fetch('/chatgpt/v1/models', { headers: authHeaders() }).then(function (r) { if (!r.ok) throw new Error('Models unavailable'); return r.json(); }).then(function (catalog) {
              var modelLine = document.createElement('div');
              modelLine.className = 'muted';
              modelLine.textContent = 'Models: ' + (catalog.models || []).map(function (m) { return m.display_name + ' (' + m.slug + ')'; }).join(', ');
              details.appendChild(modelLine);
            }).catch(function () {});
          }
        } else {
          var action = document.createElement('div');
          action.className = 'muted';
          action.textContent = provider.setupAction === 'coming_soon' ? 'Coming soon'
            : provider.setupAction === 'enable_route' ? 'Enable a Claude compatibility route in .env, then restart.'
              : 'Action needed: ' + provider.setupAction.replace(/_/g, ' ');
          card.appendChild(action);
        }
        cards.appendChild(card);
      });
      document.getElementById('snippetCard').hidden = !claudeReady;
      var claude = (data.providers || []).find(function (p) { return p.id === 'claude'; });
      var shapes = claude && claude.api.ready ? claude.api.capabilities.map(function (c) { return c.shape; }) : [];
      Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (btn) {
        btn.hidden = btn.getAttribute('data-tab').indexOf('anthropic') >= 0
          ? shapes.indexOf('anthropic_messages') < 0 : shapes.indexOf('openai_chat') < 0;
      });
      var activeButton = document.querySelector('.tab-btn[data-tab="' + activeTab + '"]');
      if (activeButton && activeButton.hidden) {
        activeButton.classList.remove('active');
        var firstVisible = document.querySelector('.tab-btn:not([hidden])');
        if (firstVisible) {
          firstVisible.classList.add('active');
          activeTab = firstVisible.getAttribute('data-tab');
          renderSnippet();
        }
      }
    }).catch(function (e) { cards.textContent = 'Could not load provider status: ' + e.message; });
  }

  function loadServing() {
    if (!getKey()) return;
    fetch('/v1/control/serving', { headers: authHeaders() }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      document.getElementById('servingStatus').textContent = data.enabled ? 'Serving new requests' : 'Paused; active requests can finish';
      document.getElementById('startServing').disabled = data.enabled;
      document.getElementById('stopServing').disabled = !data.enabled;
    }).catch(function (e) { document.getElementById('servingStatus').textContent = 'Could not load serving state: ' + e.message; });
  }

  function setServing(enabled) {
    fetch('/v1/control/serving', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ enabled: enabled }) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function () { loadServing(); }).catch(function (e) { document.getElementById('servingStatus').textContent = 'Could not change serving state: ' + e.message; });
  }
  document.getElementById('startServing').onclick = function () { setServing(true); };
  document.getElementById('stopServing').onclick = function () { setServing(false); };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; });
  }

  function loadUsage() {
    var k = getKey();
    var el = document.getElementById('usageBody');
    if (!k) { el.innerHTML = '<div class="muted">Waiting for your API key&hellip;</div>'; return; }
    fetch('/v1/usage', { headers: authHeaders() }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (u) {
      var rows = Object.keys(u.byRoute || {}).map(function (route) {
        var s = u.byRoute[route];
        return '<tr><td>' + escapeHtml(route) + '</td><td>' + s.total + '</td><td>' + s.ok + '</td><td>' + s.error + '</td><td>' + (s.avgQueueWaitMs == null ? '\u2013' : s.avgQueueWaitMs + 'ms') + '</td></tr>';
      }).join('');
      var providerRows = Object.keys(u.byProvider || {}).map(function (provider) {
        var s = u.byProvider[provider];
        return '<tr><td>' + escapeHtml(provider) + '</td><td>' + s.total + '</td><td>' + s.ok + '</td><td>' + s.error + '</td></tr>';
      }).join('');
      var errRows = Object.keys(u.errorsByType || {}).map(function (t) {
        return '<tr><td>' + escapeHtml(t) + '</td><td>' + u.errorsByType[t] + '</td></tr>';
      }).join('');
      el.innerHTML =
        '<div class="stats-grid"><div><div class="stat">' + u.total + '</div><div class="stat-label">total requests</div></div></div>' +
        '<table><thead><tr><th>provider</th><th>total</th><th>ok</th><th>error</th></tr></thead><tbody>' + (providerRows || '<tr><td colspan="4" class="muted">no requests yet</td></tr>') + '</tbody></table>' +
        '<table><thead><tr><th>route</th><th>total</th><th>ok</th><th>error</th><th>avg queue wait</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5" class="muted">no requests yet</td></tr>') + '</tbody></table>' +
        (errRows ? '<h3 style="font-size:12px;color:#888;margin:16px 0 4px">errors by type</h3><table><tbody>' + errRows + '</tbody></table>' : '');
    }).catch(function (e) {
      el.innerHTML = '<div class="muted">could not load usage (' + e.message + ')</div>';
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

  function init() {
    var stored = getKey();
    if (stored) {
      applyKey(stored);
      loadUsage();
      loadProviders();
      loadServing();
      return;
    }
    // First run: no key saved yet in this browser — fetch the one the app
    // generated for itself instead of making the user go find it in a file.
    keyMsg.textContent = 'Fetching your key\u2026';
    fetch('/v1/setup/key').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      setKey(d.apiKey);
      applyKey(d.apiKey);
      keyMsg.textContent = 'Found automatically \u2014 ready to use.';
      loadUsage();
      loadProviders();
      loadServing();
    }).catch(function () {
      keyMsg.textContent = 'Could not fetch it automatically. It is in the .env file in the app folder, on the GATEWAY_API_KEY= line.';
    });
  }

  loadHealth();
  renderSnippet();
  init();
  setInterval(function () { loadHealth(); loadProviders(); loadServing(); }, 5000);
})();
</script>
</body>
</html>`;
}
