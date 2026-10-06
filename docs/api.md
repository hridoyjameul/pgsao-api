# API Reference

Full machine-readable spec: `openapi.yaml`. This is the human-readable summary. Claude, ChatGPT and Kimi have separate inference routes; Gemini and Qwen retain status cards.

## Auth

Every route below except `GET /health`, the dashboard shell, and the one-time OAuth callback requires the gateway API key, via **either**:

```http
Authorization: Bearer <GATEWAY_API_KEY>
```
```http
x-api-key: <GATEWAY_API_KEY>
```

Both headers work on both compat routes regardless of which one "naturally" goes with which API. `anthropic-version` is accepted and ignored. Missing/invalid key → `401` with an `authentication_error`-shaped body (route-native rendering, see below).

## `POST /v1/chat/completions` — OpenAI-compatible

Alias: `POST /claude/v1/chat/completions`. The OpenAI SDK base URLs are `/v1` (legacy) and `/claude/v1` (Claude-specific). Both use the same handler and session store. Both are omitted when `ENABLE_OPENAI_COMPAT_ROUTE=false`.

Required: `model`, `messages`. Optional: `max_tokens` (server picks a default if omitted), `temperature`, `stream`, `session_id` (extension), `tools`/`tool_choice` (Phase 3 — see below). Rejects the deprecated `functions`/`function_call` fields with `invalid_request_error`.

Error shape (no top-level wrapper):
```json
{ "error": { "message": "...", "type": "invalid_request_error", "param": null, "code": null } }
```

## `POST /v1/messages` — Anthropic-compatible

Alias: `POST /claude/v1/messages`. The Anthropic SDK base URLs are the server root (legacy) and `/claude` (Claude-specific). Both are omitted when `ENABLE_ANTHROPIC_COMPAT_ROUTE=false`.

Required: `model`, `max_tokens`, `messages`. Optional: `system`, `stream`, `session_id` (extension), `tools`/`tool_choice` (Phase 3 — see below).

Error shape (top-level wrapper required):
```json
{ "type": "error", "error": { "type": "invalid_request_error", "message": "..." } }
```

## `GET /v1/models`

Alias: `GET /claude/v1/models`. Both list the Claude model alias allow-list (`src/config/models.ts`) — not an open passthrough. Models remain available when inference is paused.

## ChatGPT sign-in and inference

`POST /v1/providers/chatgpt/connect` accepts `{}` for a new registration or `{ "registrationId": "..." }` for a saved one and returns only `{ "authorizationUrl": "..." }`. Open that URL in the local browser. OpenAI returns to `GET /auth/callback`; the gateway consumes the one-time state and redirects to the dashboard with a nonsecret result flag. `POST /v1/providers/chatgpt/disconnect` attempts remote refresh-token revocation, then clears local tokens and returns `{ "remoteRevocationConfirmed": true|false }`.

`GET /chatgpt/v1/models` calls the selected account's OpenAI catalog and returns `{ "models": [{ "slug": "...", "display_name": "..." }] }` for visible models only. `POST /chatgpt/v1/responses` returns SSE. Its exact accepted JSON shape is `{ "model": "slug", "input": [{ "role": "user|assistant|developer", "content": "text" }], "instructions": "optional text", "store": false, "stream": true }`. `input` must be nonempty. Extra fields, system roles, tools, images, and `previous_response_id` return 400. Send full context on each request. A successful stream must contain `response.completed`; failed, incomplete, or interrupted streams are audited as errors. These routes never fall back to Claude.

## `GET /v1/providers`

Returns five ordered provider cards: `claude`, `chatgpt`, `gemini`, `kimi`, `qwen`. Each has a `client` detection state, `connection` state, `api.ready` flag and supported `api.capabilities`, plus `setupAction`. Capabilities are empty until a connection is ready. ChatGPT also lists safe registration IDs and labels for account selection. Gemini, Kimi, and Qwen return `coming_soon`. If both Claude compatibility routes are disabled by configuration, Claude returns `enable_route`. This route never returns the gateway key or provider tokens.

## `GET /v1/control/serving`, `POST /v1/control/serving`

GET returns `{ "enabled": true }` or `false`. POST accepts exactly `{ "enabled": <boolean> }` and returns the new state. Both require gateway key auth. When disabled, new inference requests return HTTP 503 with `service_paused` in the route's native error shape. Existing streams can finish. Status, models, usage, health, dashboard, and control stay available. The setting is process-local and defaults to enabled after restart.

## `GET /health` — unauthenticated

```json
{
  "status": "ok", "service": "pgsao-api", "version": "0.0.2",
  "claude_auth_status": "ok",
  "active_requests": 0, "queued_requests": 0,
  "routes": { "openai_compatible": "enabled", "anthropic_compatible": "enabled" }
}
```

## `GET /v1/usage`

Usage data split by route and provider — request counts (ok/error), average concurrency-queue wait, and error counts by category. Pulled from the `requests` audit log every call already writes to (`sessions/session-manager.ts`). Old rows migrate to provider `claude`.

```json
{ "total": 42, "byRoute": { "openai": { "total": 30, "ok": 28, "error": 2, "avgQueueWaitMs": 4 }, "anthropic": { "total": 12, "ok": 12, "error": 0, "avgQueueWaitMs": 0 } }, "byProvider": { "claude": { "total": 42, "ok": 40, "error": 2, "avgQueueWaitMs": 3 } }, "errorsByType": { "invalid_request_error": 2 } }
```

## `POST /v1/sessions`, `GET /v1/sessions/:id`, `DELETE /v1/sessions/:id`

Explicit lifecycle management for the `session_id` extension. Not a required precondition — passing an unseen `session_id` directly to either compat route auto-creates it.

## Tool/function-calling (Phase 3, PRD §23/NG6)

Standard, unmodified real-API behavior — the model proposes a call, execution is entirely the caller's job, and the caller reports the result back on its next request. No gateway-specific extension. `stop_reason`/`finish_reason` becomes `tool_use`/`tool_calls` when the model wants to call a tool. `tool_choice` supports only `"auto"` (default) and `"none"` — forcing a specific named tool is rejected with `invalid_request_error`. See `README.md`'s Tool/function-calling section for a worked curl example and known limitations (no mixing with `session_id`/resume, parallel calls untested, tool parameter schemas support a realistic JSON Schema subset).

## Streaming

`"stream": true` on either route. OpenAI-shaped: `chat.completion.chunk` frames terminated by the literal `data: [DONE]`. Anthropic-shaped: named SSE events (`message_start`, `content_block_delta`, `message_stop`, ...). A stream holds one concurrency slot for its full duration.

## Errors, by category

| category | HTTP | meaning |
|---|---|---|
| `authentication_error` | 401 | gateway API key missing/invalid |
| `invalid_request_error` | 400 | bad request shape, unsupported field, unknown model |
| `rate_limit_error` | 429 | gateway's own concurrency queue is full — retry shortly |
| `usage_limit_error` | 429 | Claude account's subscription usage window is exhausted |
| `credential_error` | 503 | the Claude account's own auth is stale/invalid |
| `service_paused` | 503 | the dashboard has stopped admission of new inference requests |
| `provider_error` | 502 | Claude itself errored (overloaded, server error, ...) |
| (unexpected) | 500 | anything else |

## Kimi (paid Kimi Code membership key required)

Free Kimi accounts do not work. Create a key in the Kimi Code console and save it on the dashboard (or call the credentials route below). Callers use the Kimi provider's gateway key, never the membership key.

| Route | Notes |
| --- | --- |
| `POST /kimi/v1/chat/completions` | OpenAI-compatible body forwarded to `https://api.kimi.com/coding/v1/chat/completions`. `model` is required. Streaming passes through. |
| `POST /kimi/v1/messages` | Anthropic-compatible body forwarded to `https://api.kimi.com/coding/v1/messages`. `model` is required. Streaming passes through. |
| `GET /kimi/v1/models` | Fixed list: `kimi-for-coding`, `kimi-for-coding-highspeed` (HighSpeed needs the Allegretto plan or above). |
| `POST /v1/providers/kimi/credentials` | Body `{"apiKey":"..."}`. Validates with a model-list call, then stores the key privately. Needs the master gateway key. |
| `DELETE /v1/providers/kimi/credentials` | Removes the saved key. Needs the master gateway key. |

Errors: 429 `usage_limit_error` with `Retry-After` when Kimi's plan limit is reached, 503 `credential_error` when no key is saved or Kimi rejects it, 400 `invalid_request_error` for a missing `model` or a Kimi 400-class rejection, 502 `provider_error` otherwise. The gateway always sends its own `User-Agent: PGSAO-API/<version>`; Kimi treats a tampered client identifier as a violation. The key file defaults to `kimi.json` beside the ChatGPT credential file and can be moved with `KIMI_KEY_PATH`.
