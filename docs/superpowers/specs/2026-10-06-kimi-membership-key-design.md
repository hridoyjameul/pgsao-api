# Kimi Code membership-key provider

Date: 2026-10-06

This focused design is the Kimi adapter within the [multi-provider gateway design](2026-10-06-multi-provider-gateway-design.md).

## Intent and scope

Let the owner of a paid Kimi membership call Kimi Code through the gateway with one local base URL and gateway key, the same way ChatGPT and Claude work. The adapter is built before it can be tested with a real account, so every external behavior comes from Kimi's official [membership guide](https://www.kimi.com/en/help/kimi-code/membership-guide) and is covered by tests against a fake upstream.

Out of scope: reusing the Kimi desktop app or CLI login (the spec forbids it), the separately billed Kimi Open Platform, tool execution on the host, and any claim of full OpenAI or Anthropic parity.

## External API

| Route | Upstream | Contract |
| --- | --- | --- |
| `POST /kimi/v1/chat/completions` | `https://api.kimi.com/coding/v1/chat/completions` | OpenAI-compatible body forwarded as sent; `model` required; streaming passes through |
| `POST /kimi/v1/messages` | `https://api.kimi.com/coding/v1/messages` | Anthropic-compatible body forwarded as sent; `model` required; streaming passes through |
| `GET /kimi/v1/models` | none | Fixed list: `kimi-for-coding`, `kimi-for-coding-highspeed` |
| `POST /v1/providers/kimi/credentials` | `GET /coding/v1/models` | Save and validate a membership key (gateway key required) |
| `DELETE /v1/providers/kimi/credentials` | none | Remove the saved key |

Callers authenticate with the Kimi provider's gateway key. The gateway replaces it with the saved membership key; client headers cannot override upstream authorization. The gateway always sends its own `User-Agent: PGSAO-API/<version>` and never rewrites or hides it, because Kimi treats a tampered client identifier as a violation.

## Credential and connection lifecycle

The key is entered once in the dashboard, validated with a model-list call, and stored in protected local runtime storage (same directory and protection as the ChatGPT credential file; default `kimi.json` beside it, overridable with `KIMI_KEY_PATH`). It never enters `.env`, browser storage, logs, or any API response; status shows only the last four characters. A 401 or 403 from Kimi marks the connection as needing a new key. If the validation call returns 404 or 405 the key is saved unverified, since only a real rejection proves the key bad.

## Limits and errors

A 429 becomes `usage_limit_error` with `Retry-After` when sent; the connection records a "limit reached until" time (default five minutes when no header) and the dashboard shows it. Other 400-class upstream rejections become `invalid_request_error`, 401/403 `credential_error`, and everything else `provider_error`. Requests never fall back to another provider. Kimi's documented ceiling is 30 concurrent requests; the gateway queues at its existing configured concurrency.

## Dashboard

The Kimi card moves from "Coming soon" to a key-entry setup flow: a password field, **Save key**, **Remove key**, a link to the Kimi Code console, and the note "Paid Kimi membership key required. Free accounts don't work." Once connected it shows base URLs for the OpenAI-style and Anthropic-style shapes, snippets, and usage.

## Verification criteria

- Claude and ChatGPT routes and behavior are unchanged.
- Disconnected, paused, rejected-key, rate-limited, and upstream-failure states produce the right error on each route shape without calling any other provider.
- The upstream URL, `Authorization`, `x-api-key`, and `User-Agent` are fixed by the gateway; caller-supplied versions are ignored.
- The saved key is absent from `/v1/providers`, logs, and error bodies.
- Usage audit records `provider: kimi` with route `openai` or `anthropic`.
- Real-account behavior (actual endpoints, models, limits) is verified later by the owner with a paid membership.
