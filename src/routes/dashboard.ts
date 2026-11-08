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
  // (never a real key) — this text is meant to be copy-pasted or screenshotted.
  const snippets: Record<string, Record<string, { label: string; code: string }>> = {
    claude: {
      'curl-openai': { label: 'cURL (OpenAI shape)', code: [
        `curl ${baseUrl}/claude/v1/chat/completions \\`,
        `  -H "Authorization: Bearer YOUR_CLAUDE_API_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"claude-via-gateway","messages":[{"role":"user","content":"Hello."}]}'`,
      ].join('\n') },
      'curl-anthropic': { label: 'cURL (Anthropic shape)', code: [
        `curl ${baseUrl}/claude/v1/messages \\`,
        `  -H "x-api-key: YOUR_CLAUDE_API_KEY" \\`,
        `  -H "anthropic-version: 2023-06-01" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"claude-via-gateway","max_tokens":256,"messages":[{"role":"user","content":"Hello."}]}'`,
      ].join('\n') },
      'sdk-openai': { label: 'OpenAI SDK', code: [
        `import OpenAI from "openai";`,
        ``,
        `const client = new OpenAI({`,
        `  apiKey: "YOUR_CLAUDE_API_KEY",`,
        `  baseURL: "${baseUrl}/claude/v1",`,
        `});`,
        ``,
        `const res = await client.chat.completions.create({`,
        `  model: "claude-via-gateway",`,
        `  messages: [{ role: "user", content: "Hello." }],`,
        `});`,
      ].join('\n') },
      'sdk-anthropic': { label: 'Anthropic SDK', code: [
        `import Anthropic from "@anthropic-ai/sdk";`,
        ``,
        `const client = new Anthropic({`,
        `  apiKey: "YOUR_CLAUDE_API_KEY",`,
        `  baseURL: "${baseUrl}/claude",`,
        `});`,
        ``,
        `const res = await client.messages.create({`,
        `  model: "claude-via-gateway",`,
        `  max_tokens: 256,`,
        `  messages: [{ role: "user", content: "Hello." }],`,
        `});`,
      ].join('\n') },
    },
    chatgpt: {
      'curl-responses': { label: 'cURL (Responses)', code: [
        `# List model slugs: curl ${baseUrl}/chatgpt/v1/models -H "Authorization: Bearer YOUR_CHATGPT_API_KEY"`,
        `curl ${baseUrl}/chatgpt/v1/responses \\`,
        `  -H "Authorization: Bearer YOUR_CHATGPT_API_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"YOUR_MODEL_SLUG","input":[{"role":"user","content":"Hello."}],"store":false,"stream":true}'`,
      ].join('\n') },
      'sdk-openai': { label: 'OpenAI SDK', code: [
        `import OpenAI from "openai";`,
        ``,
        `const client = new OpenAI({`,
        `  apiKey: "YOUR_CHATGPT_API_KEY",`,
        `  baseURL: "${baseUrl}/chatgpt/v1",`,
        `});`,
        ``,
        `const stream = await client.responses.create({`,
        `  model: "YOUR_MODEL_SLUG",`,
        `  input: [{ role: "user", content: "Hello." }],`,
        `  store: false,`,
        `  stream: true,`,
        `});`,
      ].join('\n') },
    },
    kimi: {
      'curl-openai': { label: 'cURL (OpenAI shape)', code: [
        `curl ${baseUrl}/kimi/v1/chat/completions \\`,
        `  -H "Authorization: Bearer YOUR_KIMI_API_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"kimi-for-coding","messages":[{"role":"user","content":"Hello."}]}'`,
      ].join('\n') },
      'curl-anthropic': { label: 'cURL (Anthropic shape)', code: [
        `curl ${baseUrl}/kimi/v1/messages \\`,
        `  -H "x-api-key: YOUR_KIMI_API_KEY" \\`,
        `  -H "anthropic-version: 2023-06-01" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"kimi-for-coding","max_tokens":256,"messages":[{"role":"user","content":"Hello."}]}'`,
      ].join('\n') },
      'sdk-openai': { label: 'OpenAI SDK', code: [
        `import OpenAI from "openai";`,
        ``,
        `const client = new OpenAI({`,
        `  apiKey: "YOUR_KIMI_API_KEY",`,
        `  baseURL: "${baseUrl}/kimi/v1",`,
        `});`,
        ``,
        `const res = await client.chat.completions.create({`,
        `  model: "kimi-for-coding",`,
        `  messages: [{ role: "user", content: "Hello." }],`,
        `});`,
      ].join('\n') },
    },
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
  :root { color-scheme: light dark; --accent: #2563eb; --line: light-dark(#e4e7ee, #2e323b); --card: light-dark(#fff, #181a20); --soft: light-dark(#f3f5f9, #22252d); --muted: light-dark(#6b7280, #9aa1ae); --ok: #16a34a; --bad: #dc2626; --warn: #d97706; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", Inter, sans-serif; background: light-dark(#eef1f7, #0e0f13); color: light-dark(#111827, #e8eaf0); }
  .shell { display: flex; min-height: 100vh; }
  .side { width: 200px; flex: none; padding: 20px 14px; border-right: 1px solid var(--line); background: light-dark(rgba(255,255,255,.6), rgba(24,26,32,.6)); }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 16px; margin: 0 6px 22px; }
  .brand svg { width: 22px; height: 22px; }
  .nav { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 9px; background: light-dark(#e0e9ff, #1d2a4d); color: var(--accent); font-weight: 600; }
  main { flex: 1; min-width: 0; padding: 20px 24px 56px; max-width: 1080px; }
  .card { border: 1px solid var(--line); border-radius: 14px; padding: 18px; margin-bottom: 16px; background: var(--card); }
  .card h2 { font-size: 15px; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
  .card h2 svg { width: 18px; height: 18px; color: var(--accent); }
  .head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
  .head h1 { font-size: 21px; margin: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .head h1 .state { font-size: 14px; font-weight: 500; }
  .sub { color: var(--muted); margin-top: 2px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; background: light-dark(#dcfce7, #123420); color: var(--ok); }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: none; background: var(--muted); }
  .dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); } .dot.warn { background: var(--warn); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .tile { border: 1.5px solid var(--line); border-radius: 12px; padding: 14px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; background: var(--card); }
  .tile:hover { border-color: light-dark(#b8c4e0, #46506a); }
  .tile.selected { border-color: var(--accent); box-shadow: 0 0 0 3px light-dark(#dbe6ff, #1b2a52); }
  .tile .icon { width: 40px; height: 40px; }
  .tile .name { font-weight: 700; font-size: 15px; }
  .tile .badge { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; min-height: 20px; }
  .tile-action { margin-top: 6px; width: 100%; }
  button { font: inherit; padding: 7px 14px; border: 1px solid var(--line); border-radius: 9px; background: var(--soft); color: inherit; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .55; cursor: not-allowed; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.outline { background: transparent; border-color: var(--accent); color: var(--accent); }
  input[type=text], input[type=password], select { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--soft); color: inherit; min-width: 0; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row input { flex: 1; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } .side { display: none; } main { padding: 16px; } }
  .tabs { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 10px; border-bottom: 1px solid var(--line); }
  .tabs button { background: none; border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 6px 2px; color: var(--muted); font-size: 13px; }
  .tabs button.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
  .label { font-weight: 600; margin: 12px 0 6px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .muted { color: var(--muted); font-size: 13px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px; }
  .stat { font-size: 24px; font-weight: 700; line-height: 1.2; }
  .stat.ok { color: var(--ok); } .stat.bad { color: var(--bad); }
  .stat-label { color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 8px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; }
  pre { background: #0f1420; color: #e6e9f2; padding: 14px; border-radius: 10px; overflow-x: auto; font-size: 12.5px; margin: 0; }
  details.card > summary { cursor: pointer; font-weight: 700; font-size: 15px; }
  details.card[open] > summary { margin-bottom: 12px; }
  .kv { display: grid; grid-template-columns: 170px 1fr; gap: 6px 12px; font-size: 13px; }
  .kv dt { color: var(--muted); } .kv dd { margin: 0; word-break: break-word; }
  .notice { margin-top: 8px; color: var(--muted); font-size: 13px; }
  #sessionsCard[hidden] + #snippetCard { grid-column: 1 / -1; }
  .tile .acct { font-size: 11.5px; color: var(--muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-height: 17px; }
  .acctline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; font-size: 13px; }
  .keyset { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px 12px; margin-top: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--soft); align-items: end; }
  .keyset label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  .keyset input, .keyset select { background: var(--card); }
  td.actions { text-align: right; white-space: nowrap; }
  td.actions button { padding: 4px 10px; font-size: 12.5px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: var(--soft); padding: 1px 5px; border-radius: 5px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="shell">
<aside class="side">
  <div class="brand"><svg viewBox="0 0 24 24" fill="#2563eb"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg> PGSAO API</div>
  <div class="nav"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 11 12 3l9 8v10h-6v-6H9v6H3z"/></svg> Overview</div>
</aside>
<main>
  <section class="card head">
    <div>
      <h1>Setup <span class="state"><span class="dot ok"></span> App is installed and running</span></h1>
      <div class="sub">Manage your AI providers and access them through your local API. &middot; v${GATEWAY_VERSION}</div>
    </div>
    <span class="pill"><span class="dot ok"></span> Running</span>
  </section>

  <section class="card">
    <h2>Available AI Providers</h2>
    <div id="providerTiles" class="tiles"><div class="muted">Loading providers&hellip;</div></div>
    <div id="notice" class="notice"></div>
  </section>

  <section class="card" id="accountsCard" hidden>
    <h2 id="accountsTitle">Accounts</h2>
    <div id="accountsBody"></div>
  </section>

  <div class="grid2">
    <section class="card" id="apiAccess">
      <h2 id="apiAccessTitle">API Access</h2>
      <div id="apiAccessBody"></div>
    </section>
    <section class="card">
      <h2 id="usageTitle">Usage</h2>
      <div id="usageBody"><div class="muted">Loading&hellip;</div></div>
    </section>
  </div>

  <div class="grid2">
    <section class="card" id="sessionsCard" hidden>
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">Sessions</h2><button id="createSession" class="primary">+ New Session</button></div>
      <div class="row" style="margin-top:12px">
        <input type="text" id="sessionLookup" placeholder="session id to look up / delete">
        <button id="getSession">Get</button>
        <button id="deleteSession">Delete</button>
      </div>
      <pre id="sessionOut" style="margin-top:10px">no session looked up yet</pre>
    </section>
    <section class="card" id="snippetCard" hidden>
      <h2>Code Snippets</h2>
      <div id="snippetTabs" class="tabs"></div>
      <pre id="snippet"></pre>
    </section>
  </div>

  <details class="card" id="advanced">
    <summary id="advancedTitle">Advanced</summary>
    <div id="advancedBody"></div>
  </details>
</main>
</div>

<script id="snippets-data" type="application/json">${JSON.stringify(snippets).replace(/</g, '\\u003c')}</script>
<script>
(function () {
  var snippets = JSON.parse(document.getElementById('snippets-data').textContent);
  var STORAGE_KEY = 'pgsao_gateway_api_key';
  var SELECTED_KEY = 'pgsao_selected_provider';
  var ICONS = {
    claude: '<svg class="icon" viewBox="0 0 40 40"><g stroke="#d97757" stroke-width="3.2" stroke-linecap="round"><path d="M20 4v32M4 20h32M9 9l22 22M31 9 9 31M13 5l14 30M27 5 13 35M5 13l30 14M5 27l30-14"/></g></svg>',
    chatgpt: '<svg class="icon" viewBox="0 0 40 40"><g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"><path d="M20 5l11 6.4v12.8L20 30.6 9 24.2V11.4z"/><path d="M20 12l5 2.9v5.8L20 23.6l-5-2.9v-5.8z"/><path d="M31 11.4 20 17.8 9 11.4M20 30.6V17.8"/></g></svg>',
    gemini: '<svg class="icon" viewBox="0 0 40 40"><path d="M20 3C21.5 14 26 18.5 37 20 26 21.5 21.5 26 20 37 18.5 26 14 21.5 3 20 14 18.5 18.5 14 20 3z" fill="#4f7cff"/></svg>',
    kimi: '<svg class="icon" viewBox="0 0 40 40"><rect x="4" y="4" width="32" height="32" rx="6" fill="#111"/><path d="M13 11v18M13 20l10-9M16 18l9 11" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none"/></svg>',
    qwen: '<svg class="icon" viewBox="0 0 40 40"><path d="M20 4l14 8v16l-14 8-14-8V12z" fill="#6c4de6"/><path d="M14 19l6-5 6 5-6 8z" fill="#fff"/></svg>'
  };
  var providers = [];
  var selected = null;
  var profiles = {};
  var selectedKey = {};
  var models = {};
  var keyVisible = false;
  var urlShape = {};
  var snippetTab = {};
  var renderedSig = '';
  var usageSeq = 0;

  function getKey() { try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; } }
  function setKey(v) { try { localStorage.setItem(STORAGE_KEY, v); } catch (e) {} }
  function authHeaders(extra) {
    var h = extra || {};
    var k = getKey();
    if (k) h['Authorization'] = 'Bearer ' + k;
    return h;
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; });
  }
  function $(id) { return document.getElementById(id); }
  function find(id) { for (var i = 0; i < providers.length; i++) if (providers[i].id === id) return providers[i]; return null; }
  function api(path, method, body) {
    var init = { headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}) };
    if (method) init.method = method;
    if (body) init.body = JSON.stringify(body);
    return fetch(path, init).then(function (r) {
      if (!r.ok) {
        // Prefer the gateway's own error message over a bare status code.
        return r.json().catch(function () { return {}; }).then(function (b) { throw new Error((b && b.error && b.error.message) || ('HTTP ' + r.status)); });
      }
      return r.json();
    });
  }
  function copyToClipboard(text, btn) {
    var done = function () { var orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(function () { btn.textContent = orig; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(function () {});
  }

  // ---- provider tiles -------------------------------------------------
  function tileState(p) {
    if (p.setupAction === 'coming_soon') return { dot: '', badge: 'Coming soon', action: 'Coming soon', disabled: true };
    if (p.api.ready) return p.serving ? { dot: 'ok', badge: 'Running', action: 'Stop', outline: true } : { dot: 'warn', badge: 'Stopped', action: 'Start' };
    if (p.setupAction === 'sign_in') return { dot: 'bad', badge: 'Not connected', action: 'Connect', primary: true, connect: true };
    if (p.setupAction === 'reconnect' && p.id === 'chatgpt') return { dot: 'bad', badge: 'Reconnect needed', action: 'Reconnect', primary: true, connect: true };
    if (p.setupAction === 'enable_route') return { dot: 'bad', badge: 'Route disabled', action: 'Set up' };
    return { dot: 'bad', badge: p.client && p.client.state === 'not_detected' ? 'Not installed' : 'Not connected', action: 'Set up' };
  }

  function renderTiles() {
    var box = $('providerTiles');
    box.innerHTML = providers.map(function (p) {
      var s = tileState(p);
      return '<div class="tile' + (p.id === selected ? ' selected' : '') + '" data-provider="' + esc(p.id) + '">' +
        (ICONS[p.id] || '') + '<div class="name">' + esc(p.displayName) + '</div>' +
        '<div class="badge"><span class="dot ' + s.dot + '"></span>' + esc(s.badge) + '</div>' +
        '<div class="acct" title="Active account">' + esc(activeAccount(p) ? activeAccount(p).label : '') + '</div>' +
        '<button class="tile-action ' + (s.primary ? 'primary' : s.outline ? 'outline' : '') + '"' + (s.disabled ? ' disabled' : '') + '>' + esc(s.action) + '</button></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.tile'), function (tile) {
      var id = tile.getAttribute('data-provider');
      tile.onclick = function () { select(id); };
      tile.querySelector('.tile-action').onclick = function (ev) {
        ev.stopPropagation();
        select(id);
        var p = find(id), s = tileState(p);
        if (s.disabled) return;
        if (p.setupAction === 'enter_key') { var ac = $('accountsCard'); if (ac.scrollIntoView) ac.scrollIntoView({ behavior: 'smooth' }); }
        else if (s.connect) startConnect(null);
        else if (p.api.ready) setServing(id, !p.serving);
      };
    });
  }

  function startConnect(registrationId) {
    api('/v1/providers/chatgpt/connect', 'POST', registrationId ? { registrationId: registrationId } : {})
      .then(function (r) { window.location.assign(r.authorizationUrl); })
      .catch(function () { $('notice').textContent = 'ChatGPT sign-in failed; try again.'; });
  }
  function setServing(id, enabled) {
    api('/v1/providers/' + id + '/serving', 'POST', { enabled: enabled })
      .then(loadProviders).catch(function (e) { $('notice').textContent = 'Could not change state: ' + e.message; });
  }

  // ---- selected provider panels ---------------------------------------
  function select(id) {
    if (!find(id)) return;
    selected = id;
    try { localStorage.setItem(SELECTED_KEY, id); } catch (e) {}
    renderedSig = '';
    renderTiles();
    renderSelected();
    loadUsage();
  }

  function capabilityTabs(p) {
    var main = p.api.capabilities.filter(function (c) { return !c.legacy; });
    return main.map(function (c) {
      var label = c.shape === 'openai_chat' ? 'OpenAI-style apps' : c.shape === 'anthropic_messages' ? 'Anthropic/Claude-style apps' : 'Responses API apps';
      return { shape: c.shape, label: label, url: window.location.origin + (c.basePath === '/' ? '' : c.basePath) };
    });
  }

  function activeAccount(p) { return (p.accounts || []).filter(function (a) { return a.active; })[0] || null; }
  function accountName(p, id) {
    var a = (p.accounts || []).filter(function (x) { return x.id === id; })[0];
    return a ? a.label : 'removed account';
  }
  function chooseAccount(p, accountId) {
    api('/v1/providers/' + p.id + '/accounts/' + encodeURIComponent(accountId) + '/select', 'POST')
      .then(function () { $('notice').textContent = p.displayName + ' now uses ' + accountName(p, accountId) + '.'; loadProviders(); })
      .catch(function (e) { $('notice').textContent = 'Could not switch account: ' + e.message; });
  }

  function renderApiAccess(p) {
    $('apiAccessTitle').textContent = 'API Access (' + p.displayName + ')';
    var body = $('apiAccessBody');
    if (!p.api.ready) {
      var why = p.setupAction === 'coming_soon' ? 'Coming soon. ' + p.displayName + ' is not available in this version yet.'
        : p.id === 'chatgpt' ? 'Connect a paid ChatGPT subscription account (free accounts do not work) under Accounts to get a ChatGPT Base URL and API key.'
        : p.id === 'kimi' ? 'Add a paid Kimi Code membership API key under Accounts to get a Kimi Base URL and API key. Free accounts do not work.'
        : p.setupAction === 'enable_route' ? 'Enable a Claude compatibility route in .env, then restart.'
        : 'Log in to ' + p.displayName + ' on this computer (or add an account under Accounts), then reload this page.';
      body.innerHTML = '<div class="muted">' + esc(why) + '</div>';
      return;
    }
    var tabs = capabilityTabs(p);
    var active = urlShape[p.id];
    if (!tabs.some(function (t) { return t.shape === active; })) active = tabs[0] && tabs[0].shape;
    urlShape[p.id] = active;
    var current = tabs.filter(function (t) { return t.shape === active; })[0];
    var acct = activeAccount(p);
    var accounts = p.accounts || [];
    var acctLine = acct ? '<div class="acctline"><span class="dot ' + (acct.connected ? 'ok' : 'bad') + '"></span> Connected account: <strong id="activeAccount">' + esc(acct.label) + '</strong>' +
      (accounts.length > 1 ? ' <select id="switchAccount" aria-label="Switch account">' + accounts.map(function (a) { return '<option value="' + esc(a.id) + '"' + (a.active ? ' selected' : '') + '>' + esc(a.label) + '</option>'; }).join('') + '</select>' : '') + '</div>' : '';
    body.innerHTML = acctLine +
      '<div id="urlTabs" class="tabs">' + tabs.map(function (t) { return '<button data-shape="' + esc(t.shape) + '" class="' + (t.shape === active ? 'active' : '') + '">' + esc(t.label) + '</button>'; }).join('') + '</div>' +
      '<div class="row"><input type="text" id="baseUrl" class="mono" readonly value="' + esc(current ? current.url : '') + '"><button id="copyUrl">Copy</button></div>' +
      '<div id="keySection"></div>';
    Array.prototype.forEach.call(body.querySelectorAll('#urlTabs button'), function (b) {
      b.onclick = function () { urlShape[p.id] = b.getAttribute('data-shape'); renderedSig = ''; renderSelected(); };
    });
    $('copyUrl').onclick = function () { copyToClipboard($('baseUrl').value, this); };
    var sw = $('switchAccount');
    if (sw) sw.onchange = function () { chooseAccount(p, sw.value); };
    renderKeySection(p);
    if (!profiles[p.id]) loadKeys(p.id);
  }

  function loadKeys(id, selectKeyId) {
    return api('/v1/providers/' + id + '/keys').then(function (r) {
      profiles[id] = r.keys || [];
      if (selectKeyId) selectedKey[id] = selectKeyId;
      var p = find(id);
      if (p && selected === id && p.api.ready) renderKeySection(p);
    }).catch(function () {});
  }

  function currentKey(p) {
    var list = profiles[p.id] || [];
    var k = list.filter(function (x) { return x.id === selectedKey[p.id]; })[0] || list[0] || null;
    if (k) selectedKey[p.id] = k.id;
    return k;
  }

  function keySummary(p, k) {
    var parts = [];
    if (k.accountId) parts.push(accountName(p, k.accountId));
    if (k.model) parts.push(k.model);
    if (k.effort) parts.push((p.tuning ? p.tuning.effortLabel.split(' ')[0].toLowerCase() : 'effort') + ' ' + k.effort);
    return parts.length ? parts.join(' / ') : 'app chooses model, active account';
  }

  function renderKeySection(p) {
    var box = $('keySection');
    if (!box) return;
    var list = profiles[p.id];
    if (!list) { box.innerHTML = '<div class="label">API Keys</div><div class="muted">Loading keys&hellip;</div>'; return; }
    var k = currentKey(p);
    if (!k) { box.innerHTML = ''; return; }
    var tuning = p.tuning;
    var acct = activeAccount(p);
    var html = '<div class="label">API Keys</div>' +
      '<div class="row"><select id="keyPicker" aria-label="API key">' + list.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === k.id ? ' selected' : '') + '>' + esc(x.name) + ' &mdash; ' + esc(keySummary(p, x)) + '</option>'; }).join('') + '</select>' +
      '<button id="newKey">+ New key</button></div>' +
      '<div class="row" style="margin-top:8px"><input type="password" id="apiKey" class="mono" readonly value="' + esc(k.key) + '"><button id="toggleKey">' + (keyVisible ? 'Hide' : 'Show') + '</button><button id="copyKey">Copy</button><button id="rotateKey">Regenerate</button>' +
      (list.length > 1 ? '<button id="deleteKey">Delete</button>' : '') + '</div>';
    if (tuning) {
      html += '<div class="keyset">' +
        '<label>Name<input type="text" id="keyName" value="' + esc(k.name) + '" maxlength="64"></label>' +
        ((p.accounts || []).length ? '<label>Account<select id="keyAccount"><option value="">Active account' + (acct ? ' (' + esc(acct.label) + ')' : '') + '</option>' +
          p.accounts.map(function (a) { return '<option value="' + esc(a.id) + '"' + (a.id === k.accountId ? ' selected' : '') + '>Always ' + esc(a.label) + '</option>'; }).join('') + '</select></label>' : '') +
        '<label>Model<input type="text" id="keyModel" class="mono" list="modelOptions" placeholder="App chooses" value="' + esc(k.model || '') + '"></label><datalist id="modelOptions">' +
          (models[p.id] || []).map(function (m) { return '<option value="' + esc(m) + '"></option>'; }).join('') + '</datalist>' +
        '<label>' + esc(tuning.effortLabel) + '<select id="keyEffort"><option value="">Default</option>' +
          tuning.efforts.map(function (e) { return '<option value="' + esc(e) + '"' + (e === k.effort ? ' selected' : '') + '>' + esc(e) + '</option>'; }).join('') + '</select></label>' +
        '<div><button id="saveKeySettings" class="primary">Save key settings</button></div></div>';
    }
    html += '<div class="muted" style="margin-top:6px">This key only works for ' + esc(p.displayName) + '. Its account, model and ' + esc(tuning ? tuning.effortLabel.toLowerCase() : 'effort') + ' apply to every request made with it; leave them on Default to let the app decide.</div>';
    box.innerHTML = html;
    $('apiKey').type = keyVisible ? 'text' : 'password';
    $('keyPicker').onchange = function () { selectedKey[p.id] = this.value; renderKeySection(p); };
    $('copyKey').onclick = function () { copyToClipboard($('apiKey').value, this); };
    $('toggleKey').onclick = function () { keyVisible = !keyVisible; $('apiKey').type = keyVisible ? 'text' : 'password'; this.textContent = keyVisible ? 'Hide' : 'Show'; };
    $('newKey').onclick = function () {
      api('/v1/providers/' + p.id + '/keys', 'POST', {}).then(function (r) { $('notice').textContent = 'New ' + p.displayName + ' key created.'; return loadKeys(p.id, r.key.id); })
        .catch(function (e) { $('notice').textContent = 'Could not create key: ' + e.message; });
    };
    $('rotateKey').onclick = function () {
      api('/v1/providers/' + p.id + '/keys/' + encodeURIComponent(k.id) + '/rotate', 'POST').then(function () { return loadKeys(p.id, k.id); })
        .catch(function (e) { $('notice').textContent = 'Could not regenerate key: ' + e.message; });
    };
    var del = $('deleteKey');
    if (del) del.onclick = function () {
      // Two clicks instead of a browser dialog: the first arms the button.
      if (del.getAttribute('data-armed') !== '1') { del.setAttribute('data-armed', '1'); del.textContent = 'Click again to delete'; return; }
      api('/v1/providers/' + p.id + '/keys/' + encodeURIComponent(k.id), 'DELETE').then(function () { selectedKey[p.id] = null; $('notice').textContent = 'Key "' + k.name + '" deleted; apps using it stop working.'; return loadKeys(p.id); })
        .catch(function (e) { $('notice').textContent = 'Could not delete key: ' + e.message; });
    };
    var save = $('saveKeySettings');
    if (save) save.onclick = function () {
      var patch = { name: $('keyName').value, model: $('keyModel').value.trim() || null, effort: $('keyEffort').value || null };
      if ($('keyAccount')) patch.accountId = $('keyAccount').value || null;
      save.disabled = true;
      api('/v1/providers/' + p.id + '/keys/' + encodeURIComponent(k.id), 'PATCH', patch)
        .then(function () { $('notice').textContent = 'Key settings saved.'; return loadKeys(p.id, k.id); })
        .catch(function (e) { save.disabled = false; $('notice').textContent = 'Could not save key settings (' + e.message + ').'; });
    };
  }

  // ---- accounts -------------------------------------------------------
  var ACCOUNT_PROVIDERS = { claude: true, chatgpt: true, kimi: true };
  function renderAccounts(p) {
    var card = $('accountsCard');
    card.hidden = !ACCOUNT_PROVIDERS[p.id];
    if (card.hidden) return;
    $('accountsTitle').textContent = 'Accounts (' + p.displayName + ')';
    var accounts = p.accounts || [];
    var html = accounts.length ? '<table><thead><tr><th>Account</th><th>Status</th><th></th></tr></thead><tbody>' + accounts.map(function (a) {
      var actions = a.active ? '<span class="pill">Active</span>' : '<button data-use="' + esc(a.id) + '">Use this account</button>';
      if (p.id === 'chatgpt' && !a.connected) actions += ' <button data-reconnect="' + esc(a.id) + '" class="primary">Reconnect</button>';
      if (!(p.id === 'claude' && a.id === 'default')) actions += ' <button data-remove="' + esc(a.id) + '">Remove</button>';
      return '<tr data-account="' + esc(a.id) + '"><td><span class="dot ' + (a.connected ? 'ok' : 'bad') + '"></span> ' + esc(a.label) + '</td><td class="muted">' + esc(a.detail || (a.connected ? 'Connected' : 'Needs reconnecting')) + '</td><td class="actions">' + actions + '</td></tr>';
    }).join('') + '</tbody></table>' : '<div class="muted">No ' + esc(p.displayName) + ' account added yet.</div>';
    html += '<div class="muted">The active account answers requests. A key can also be pinned to one account under API Access, so apps can use different accounts at once.</div>';
    if (p.id === 'claude') {
      html += '<div class="label">Add a Claude account</div>' +
        '<div class="notice">Option 1: in a terminal run <code>claude setup-token</code>, sign in with the other account, and paste the token it prints. Option 2: run <code>CLAUDE_CONFIG_DIR=&lt;folder&gt; claude</code>, log in there, and enter that folder.</div>' +
        '<div class="row" style="margin-top:8px"><input type="text" id="claudeLabel" placeholder="Name (optional)" maxlength="64" style="flex:0 1 180px">' +
        '<select id="claudeKind"><option value="token">Token</option><option value="configDir">Folder</option></select>' +
        '<input type="password" id="claudeSecret" class="mono" autocomplete="off" placeholder="sk-ant-oat01-... or folder path">' +
        '<button id="addClaude" class="primary">Add account</button></div>';
    }
    if (p.id === 'chatgpt') {
      html += '<div class="label">Add a ChatGPT account</div><div class="notice"><strong>Subscription account only.</strong> Free ChatGPT accounts do not work with this API. To add another account, sign out of ChatGPT in the browser first or use a private window.</div>' +
        '<div class="row" style="margin-top:8px"><button id="addChatgpt" class="primary">Add ChatGPT account</button></div>';
    }
    if (p.id === 'kimi') {
      html += '<div class="label">Add a Kimi membership key</div><div class="notice"><strong>Paid Kimi membership key required.</strong> Free accounts do not work. Create a key in the <a href="https://www.kimi.com/code/console" target="_blank" rel="noopener noreferrer">Kimi Code console</a>; the desktop app login cannot be reused.</div>' +
        '<div class="row" style="margin-top:8px"><input type="text" id="kimiLabel" placeholder="Name (optional)" maxlength="64" style="flex:0 1 180px"><input type="password" id="kimiKeyInput" class="mono" autocomplete="off" placeholder="Paste Kimi Code API key"><button id="saveKimiKey" class="primary">Save key</button></div>';
    }
    var body = $('accountsBody');
    body.innerHTML = html;
    Array.prototype.forEach.call(body.querySelectorAll('[data-use]'), function (b) { b.onclick = function () { chooseAccount(p, b.getAttribute('data-use')); }; });
    Array.prototype.forEach.call(body.querySelectorAll('[data-reconnect]'), function (b) { b.onclick = function () { b.disabled = true; startConnect(b.getAttribute('data-reconnect')); }; });
    Array.prototype.forEach.call(body.querySelectorAll('[data-remove]'), function (b) {
      b.onclick = function () {
        if (b.getAttribute('data-armed') !== '1') { b.setAttribute('data-armed', '1'); b.textContent = 'Click again to remove'; return; }
        b.disabled = true;
        var id = b.getAttribute('data-remove'), name = accountName(p, id);
        api('/v1/providers/' + p.id + '/accounts/' + encodeURIComponent(id), 'DELETE')
          .then(function () { $('notice').textContent = name + ' removed.'; profiles[p.id] = null; loadProviders(); })
          .catch(function (e) { b.disabled = false; $('notice').textContent = 'Could not remove account: ' + e.message; });
      };
    });
    if (p.id === 'claude') $('addClaude').onclick = function () {
      var btn = this, secret = $('claudeSecret').value.trim();
      if (!secret) return;
      var payload = { label: $('claudeLabel').value.trim() };
      payload[$('claudeKind').value] = secret;
      btn.disabled = true;
      $('notice').textContent = 'Checking the Claude login...';
      api('/v1/providers/claude/accounts', 'POST', payload)
        .then(function () { $('notice').textContent = 'Claude account added and now active.'; loadProviders(); })
        .catch(function (e) { btn.disabled = false; $('notice').textContent = 'Could not add the Claude account (' + e.message + '). Check the token or folder.'; });
    };
    if (p.id === 'chatgpt') $('addChatgpt').onclick = function () { this.disabled = true; startConnect(null); };
    if (p.id === 'kimi') $('saveKimiKey').onclick = function () {
      var input = $('kimiKeyInput'), btn = this;
      if (!input.value) return;
      btn.disabled = true;
      api('/v1/providers/kimi/credentials', 'POST', { apiKey: input.value, label: $('kimiLabel').value.trim() })
        .then(function () { input.value = ''; $('notice').textContent = 'Kimi key saved and now active.'; loadProviders(); })
        .catch(function (e) { btn.disabled = false; $('notice').textContent = 'Could not save Kimi key (' + e.message + '). Check the key and your membership.'; });
    };
  }

  function renderSnippets(p) {
    var set = snippets[p.id];
    var card = $('snippetCard');
    card.hidden = !(p.api.ready && set);
    if (card.hidden) return;
    var names = Object.keys(set);
    if (!set[snippetTab[p.id]]) snippetTab[p.id] = names[0];
    $('snippetTabs').innerHTML = names.map(function (n) { return '<button data-tab="' + esc(n) + '" class="' + (n === snippetTab[p.id] ? 'active' : '') + '">' + esc(set[n].label) + '</button>'; }).join('');
    $('snippet').textContent = set[snippetTab[p.id]].code;
    Array.prototype.forEach.call($('snippetTabs').querySelectorAll('button'), function (b) {
      b.onclick = function () { snippetTab[p.id] = b.getAttribute('data-tab'); renderSnippets(p); };
    });
  }

  function renderAdvanced(p) {
    $('advancedTitle').textContent = 'Advanced (' + p.displayName + ')';
    var rows = [
      ['Client', esc(p.client.state.replace(/_/g, ' ')) + ' &mdash; ' + esc(p.client.method)],
      ['Account', esc(p.connection.state.replace(/_/g, ' ')) + (p.connection.detail ? ' &mdash; ' + esc(p.connection.detail) : '')],
      ['Gateway state', p.api.ready ? (p.serving ? 'Serving new requests' : 'Paused; active requests can finish') : 'Not ready']
    ];
    var html = '<dl class="kv">' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>';
    if (p.api.ready) {
      html += '<div class="label">All Base URLs</div><table><tbody>' + p.api.capabilities.map(function (c) {
        return '<tr><td>' + esc(c.shape.replace(/_/g, ' ')) + (c.legacy ? ' (legacy)' : '') + '</td><td class="mono">' + esc(window.location.origin + (c.basePath === '/' ? '' : c.basePath)) + '</td></tr>';
      }).join('') + '</tbody></table><div id="modelsLine" class="muted"></div>';
    }
    if (p.id === 'chatgpt' && p.connection.state === 'connected') {
      html += '<div class="row" style="margin-top:10px"><button id="disconnectChatgpt">Disconnect ChatGPT</button><span class="muted">Signs the active account out but keeps it listed for reconnecting.</span></div>';
    }
    $('advancedBody').innerHTML = html;
    if (p.id === 'chatgpt') {
      var d = $('disconnectChatgpt');
      if (d) d.onclick = function () {
        d.disabled = true;
        api('/v1/providers/chatgpt/disconnect', 'POST').then(function (r) {
          $('notice').textContent = r.remoteRevocationConfirmed ? 'ChatGPT disconnected.' : 'ChatGPT disconnected locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.';
          loadProviders();
        }).catch(function () { d.disabled = false; });
      };
    }
    if (p.api.ready) {
      var path = p.id === 'chatgpt' ? '/chatgpt/v1/models' : p.id === 'kimi' ? '/kimi/v1/models' : '/claude/v1/models';
      api(path).then(function (m) {
        var ids = p.id === 'chatgpt' ? (m.models || []).map(function (x) { return x.slug; }) : (m.data || []).map(function (x) { return x.id; });
        var names = p.id === 'chatgpt' ? (m.models || []).map(function (x) { return x.display_name + ' (' + x.slug + ')'; }) : ids;
        models[p.id] = ids;
        var list = $('modelOptions');
        if (list && selected === p.id) list.innerHTML = ids.map(function (id) { return '<option value="' + esc(id) + '"></option>'; }).join('');
        var line = $('modelsLine');
        if (line && selected === p.id) line.textContent = 'Models: ' + names.join(', ');
      }).catch(function () {});
    }
  }

  function renderSelected() {
    var p = find(selected);
    if (!p) return;
    var sig = JSON.stringify([selected, p.api, p.connection, p.serving, p.client, p.setupAction, p.accounts, keyVisible]);
    if (sig === renderedSig) return;
    renderedSig = sig;
    renderApiAccess(p);
    renderAccounts(p);
    renderSnippets(p);
    renderAdvanced(p);
    $('sessionsCard').hidden = !(p.id === 'claude' && p.api.ready);
    $('usageTitle').textContent = 'Usage (' + p.displayName + ')';
  }

  // ---- usage ------------------------------------------------------------
  function loadUsage() {
    var el = $('usageBody');
    var id = selected;
    if (!getKey() || !id) return;
    var seq = ++usageSeq;
    api('/v1/usage?provider=' + encodeURIComponent(id)).then(function (u) {
      if (seq !== usageSeq || id !== selected) return;
      var stat = u.byProvider && u.byProvider[id];
      var ok = stat ? stat.ok : 0, err = stat ? stat.error : 0, wait = stat && stat.avgQueueWaitMs != null ? stat.avgQueueWaitMs + 'ms' : '\u2013';
      var routes = Object.keys(u.byRoute || {}).map(function (route) {
        var s = u.byRoute[route];
        return '<tr><td>' + esc(route) + '</td><td>' + s.total + '</td><td>' + s.ok + '</td><td>' + s.error + '</td><td>' + (s.avgQueueWaitMs == null ? '\u2013' : s.avgQueueWaitMs + 'ms') + '</td></tr>';
      }).join('');
      var errs = Object.keys(u.errorsByType || {}).map(function (t) { return '<tr><td>' + esc(t) + '</td><td>' + u.errorsByType[t] + '</td></tr>'; }).join('');
      el.innerHTML = '<div class="stats">' +
        '<div><div class="stat">' + u.total + '</div><div class="stat-label">Total Requests</div></div>' +
        '<div><div class="stat ok">' + ok + '</div><div class="stat-label">Success</div></div>' +
        '<div><div class="stat bad">' + err + '</div><div class="stat-label">Errors</div></div>' +
        '<div><div class="stat">' + wait + '</div><div class="stat-label">Avg Queue Wait</div></div></div>' +
        '<table><thead><tr><th>Route</th><th>Total</th><th>OK</th><th>Error</th><th>Avg Queue Wait</th></tr></thead><tbody>' + (routes || '<tr><td colspan="5" class="muted">no requests yet</td></tr>') + '</tbody></table>' +
        (errs ? '<div class="label">Errors by Type</div><table><tbody>' + errs + '</tbody></table>' : '');
    }).catch(function (e) { el.innerHTML = '<div class="muted">Could not load usage (' + esc(e.message) + ')</div>'; });
  }

  // ---- sessions (Claude) ------------------------------------------------
  $('createSession').onclick = function () {
    api('/v1/sessions', 'POST').then(function (s) { $('sessionLookup').value = s.id || ''; $('sessionOut').textContent = JSON.stringify(s, null, 2); })
      .catch(function (e) { $('sessionOut').textContent = 'error: ' + e.message; });
  };
  $('getSession').onclick = function () {
    var id = $('sessionLookup').value.trim();
    if (!id) return;
    api('/v1/sessions/' + encodeURIComponent(id)).then(function (s) { $('sessionOut').textContent = JSON.stringify(s, null, 2); })
      .catch(function (e) { $('sessionOut').textContent = 'error: ' + e.message; });
  };
  $('deleteSession').onclick = function () {
    var id = $('sessionLookup').value.trim();
    if (!id) return;
    fetch('/v1/sessions/' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() }).then(function (r) {
      $('sessionOut').textContent = r.status === 204 ? 'deleted' : ('HTTP ' + r.status);
    }).catch(function (e) { $('sessionOut').textContent = 'error: ' + e.message; });
  };

  // ---- data loading -----------------------------------------------------
  function loadProviders() {
    if (!getKey()) return;
    api('/v1/providers').then(function (data) {
      providers = data.providers || [];
      if (!selected || !find(selected)) {
        var saved = ''; try { saved = localStorage.getItem(SELECTED_KEY) || ''; } catch (e) {}
        selected = find(saved) ? saved : providers.length ? providers[0].id : null;
        renderedSig = '';
        loadUsage();
      }
      renderTiles();
      renderSelected();
    }).catch(function (e) { $('providerTiles').textContent = 'Could not load providers: ' + e.message; });
  }

  function init() {
    var stored = getKey();
    if (stored) { loadProviders(); return; }
    // First run: fetch the master key the app generated for itself.
    fetch('/v1/setup/key').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) { setKey(d.apiKey); loadProviders(); })
      .catch(function () { $('providerTiles').textContent = 'Could not fetch your key automatically. It is in the .env file in the app folder, on the GATEWAY_API_KEY= line.'; });
  }

  init();
  setInterval(function () { loadProviders(); loadUsage(); }, 5000);
})();
</script>
</body>
</html>`;
}
