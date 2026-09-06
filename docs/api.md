# API Reference

Full machine-readable spec: `openapi.yaml`. This is the human-readable summary.

## Auth

Every route below except `GET /health` requires the gateway API key, via **either**:

```http
Authorization: Bearer <GATEWAY_API_KEY>
```
```http
x-api-key: <GATEWAY_API_KEY>
```

Both headers work on both compat routes regardless of which one "naturally" goes with which API. `anthropic-version` is accepted and ignored. Missing/invalid key → `401` with an `authentication_error`-shaped body (route-native rendering, see below).

## `POST /v1/chat/completions` — OpenAI-compatible

Required: `model`, `messages`. Optional: `max_tokens` (server picks a default if omitted), `temperature`, `stream`, `session_id` (extension). Rejects `tools`/`tool_choice`/`functions`/`function_call` with `invalid_request_error`.

Error shape (no top-level wrapper):
```json
{ "error": { "message": "...", "type": "invalid_request_error", "param": null, "code": null } }
```

## `POST /v1/messages` — Anthropic-compatible

Required: `model`, `max_tokens`, `messages`. Optional: `system`, `stream`, `session_id` (extension). Rejects `tools`/`tool_choice` the same way.

Error shape (top-level wrapper required):
```json
{ "type": "error", "error": { "type": "invalid_request_error", "message": "..." } }
```

## `GET /v1/models`

Lists the model alias allow-list (`src/config/models.ts`) — not an open passthrough.

## `GET /health` — unauthenticated

```json
{
  "status": "ok", "service": "pgsao-api", "version": "0.0.1",
  "claude_auth_status": "ok",
  "active_requests": 0, "queued_requests": 0,
  "routes": { "openai_compatible": "enabled", "anthropic_compatible": "enabled" }
}
```

## `POST /v1/sessions`, `GET /v1/sessions/:id`, `DELETE /v1/sessions/:id`

Explicit lifecycle management for the `session_id` extension. Not a required precondition — passing an unseen `session_id` directly to either compat route auto-creates it.

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
| `provider_error` | 502 | Claude itself errored (overloaded, server error, ...) |
| (unexpected) | 500 | anything else |
