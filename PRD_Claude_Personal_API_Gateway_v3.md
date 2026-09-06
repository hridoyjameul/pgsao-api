# Product Requirements Document
## Claude Personal API Gateway

**Document Status:** Draft
**Version:** 3.0
**Project Type:** Personal / Experimental Developer Tool
**Target User:** Project owner / individual developer
**Primary Goal:** Expose Claude, via the user's supported Claude plan/Agent SDK environment, behind an HTTP gateway that is **drop-in compatible with both the OpenAI Chat Completions API and the Anthropic Messages API**, so any existing tool built against either convention — n8n included — can use it by changing only a base URL.

**Changelog (v2.0 → v3.0):** v2.0 treated n8n as the API's primary shape target ("conceptually close to Anthropic's Messages API"). That was a scope error. v3.0 corrects it: the gateway now exposes two real, spec-accurate compatibility surfaces, n8n becomes one of several possible consumers (and gets a *better* integration path as a result — see §10), and the session design is reconciled with the fact that neither real API has a session concept. This revision keeps everything from v2.0 that isn't affected (policy/usage-pool risk, concurrency manager, credential monitor, Docker networking) and updates what is.

---

## 1. Product Overview

### 1.1 Problem

The user already has access to Claude through a paid Claude subscription and wants Claude reachable from n8n **and other tools that already speak either the OpenAI or Anthropic HTTP API conventions**, without manually interacting with the Claude web application and without each tool needing bespoke integration work.

```text
Claude subscription
       ↓
Claude Agent SDK / supported Claude account authentication
       ↓
Personal Claude Gateway
       ↓
OpenAI-compatible HTTP API  ──┐
Anthropic-compatible HTTP API ─┤→ n8n, chat UIs, IDE plugins, scripts, ...
```

### 1.2 Product Vision

Build a lightweight personal gateway that exposes Claude behind **two standard, drop-in-compatible HTTP surfaces**:

```http
POST /v1/chat/completions      (OpenAI Chat Completions shape)
POST /v1/messages              (Anthropic Messages shape)
```

Any tool already built to call OpenAI or Anthropic — with no gateway-specific knowledge — should work by pointing its base URL and API key field at this gateway. n8n is one such tool, not the design target; it happens to benefit twice, since it can hit either route with a generic HTTP Request node, or (more naturally) point its native "OpenAI Chat Model" node straight at the OpenAI-compatible route (§10).

Internally, both routes converge on the same pipeline and the same Agent SDK invocation — the compatibility surface is purely at the edges.

### 1.3 Important Product Constraint

This project is **not intended to turn a Claude Pro subscription into a generally available commercial Anthropic or OpenAI-shaped API**.

The gateway is for the owner's own tools and experimentation, run locally or on a private machine the owner controls. Presenting a familiar API shape makes it easier for *the owner's own* clients to integrate — it is not an invitation to expose this beyond that.

Anthropic currently describes Claude Pro as a subscription for its Claude experience and explicitly says Pro does not include Claude Console API usage. The implementation must depend only on documented/supported access mechanisms and must not extract private Claude.ai session credentials or bypass Anthropic's API/account controls.

### 1.4 Policy & Cost Considerations

Anthropic's rules for subscription-based Agent SDK usage have moved multiple times in 2026 (restricted for third-party harnesses, reopened, a separate "Agent SDK credit" announced for June 15, then paused the same day with an update still pending). As of this writing, `claude -p`/Agent SDK/third-party-app usage still draws from the subscription's normal usage limits — there is no separate credit pool. This gateway shares that same allowance with your interactive Claude Code/Claude.ai use.

Presenting two full compatibility surfaces makes it *easier* to point more tools at the gateway than a bespoke API would have — which is the point, but it also means usage-pool contention (§27 R2) is more likely to matter in practice, not less. The concurrency defaults in §6.6 stay conservative for this reason.

**Action item before Phase 0:** re-read `https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan` for the current state of this policy.

### 1.5 Two Compatibility Surfaces, One Backend (NEW)

Both real OpenAI and Anthropic APIs are **stateless**: the caller resends the full message history on every call; neither API has a `session_id` concept. This matters because v2.0's session design assumed a `session_id` field the caller would always send — that's a gateway-specific convenience, not something a real OpenAI/Anthropic client will ever include.

The gateway reconciles this as follows:

- **Default (compatibility) mode:** no `session_id` present → the gateway treats the request as self-contained, passes the full `messages` array through to a fresh Agent SDK call, and does not attempt to resume anything. This is what makes a genuinely unmodified OpenAI/Anthropic client work correctly with zero gateway-specific knowledge.
- **Extension (convenience) mode:** an optional `session_id` field, present on both routes as a gateway-specific addition (documented in §7.C), lets a caller that *does* know about it — like an n8n workflow you wrote yourself — avoid resending the whole history and instead resume the matching Agent SDK session explicitly (§6.3).

Both routes funnel into one internal pipeline:

```text
OpenAI-shaped request ──┐
                        ├─► Format Translator (§6.8) ─► internal call ─► Claude Adapter ─► Claude
Anthropic-shaped request┘                                                      │
                                                                                ▼
                        ◄── Format Translator converts the response back ──────┘
                            into whichever shape the caller used
```

---

# 2. Goals

## 2.1 Primary Goals

### G1 — Claude access through OpenAI- and Anthropic-shaped HTTP APIs (revised)

```http
POST /v1/chat/completions
POST /v1/messages
```

Both accept a structured prompt in their respective native shape and return Claude's response in that same shape.

### G2 — Broad client compatibility (revised — was "n8n integration")

Any OpenAI-API-compatible or Anthropic-API-compatible HTTP client can call the gateway by pointing its base URL (and, where relevant, API key field) at it, with no gateway-specific request shape required.

### G2a — n8n as one such client

n8n can integrate via a generic HTTP Request node against either route (as in v2.0), or natively via n8n's built-in "OpenAI Chat Model" node pointed at the OpenAI-compatible route (§10) — a strictly better integration than a hand-built HTTP Request node.

### G3 — Streaming support, in both native formats

Support OpenAI-style and Anthropic-style SSE streaming where the underlying Agent SDK allows it (§9).

### G4 — Simple, durable authentication

Protect the gateway with a locally generated API key, accepted via whichever header convention the calling client naturally sends (`Authorization: Bearer` or `x-api-key`, see §6.4) — and keep the gateway's own view of Claude-account auth validity current (§6.7).

### G5 — Session/conversation management as an optional extension

Support the stateless default both real APIs expect, plus an additive `session_id` extension for callers that want cheaper multi-turn continuation (§1.5, §6.3).

### G6 — Local-first operation, predictable resource use

The MVP works entirely on the developer's machine, with an explicit concurrency ceiling shared across both routes (§6.6).

---

# 3. Non-Goals

### NG1 — Commercial API service
Not initially public to third parties.

### NG2 — Reselling Claude access
Not intended to sell or redistribute the user's subscription access. Presenting familiar API shapes is for the owner's own tooling convenience, not for onboarding other users.

### NG3 — Bypassing Anthropic controls
No credential extraction, usage-limit bypass, auth circumvention, unsupported client impersonation, anti-abuse evasion, or reverse-engineering private endpoints.

### NG4 — Full API parity (revised)
The MVP covers chat/message completion only. Explicitly out of scope for MVP: OpenAI's embeddings, assistants, batch, and file-upload endpoints; Anthropic's batch and file endpoints; tool/function-calling on either surface (see NG6).

### NG5 — Multi-provider LLM platform
OpenAI, Gemini, local models, etc. are future possibilities, not MVP requirements — this gateway *mimics* OpenAI/Anthropic's shapes while running only Claude underneath.

### NG6 (NEW) — Tool/function-calling compatibility
Both real APIs support tool calling; translating that between the two shapes and the Agent SDK's own tool mechanics is real work and is deferred to Phase 3 (§23). MVP clients that require tool calling (e.g. n8n's AI Agent node driving tool use) will not work correctly until then — plain chat/messages will.

---

# 4. Target Architecture

```text
                    ┌────────────┐        ┌──────────────────┐
                    │    n8n     │        │  Other clients:   │
                    │ (HTTP node │        │  chat UIs, IDE     │
                    │  OR native │        │  plugins, scripts  │
                    │  OpenAI    │        └─────────┬─────────┘
                    │  Chat node)│                   │
                    └─────┬──────┘                   │
                          │ OpenAI-shaped             │ Anthropic-shaped
                          ▼                           ▼
                 ┌──────────────────┐        ┌──────────────────┐
                 │ /v1/chat/         │        │ /v1/messages      │
                 │ completions       │        │                   │
                 └────────┬─────────┘        └────────┬──────────┘
                          └─────────────┬──────────────┘
                                        ▼
                          ┌───────────────────────────┐
                          │  Format Translator (§6.8)  │
                          └────────────┬──────────────┘
                                        ▼
                          ┌───────────────────────────┐
                          │  Auth · Validation          │
                          │  Concurrency manager (§6.6) │
                          │  Session manager (§6.3)     │
                          │  Credential monitor (§6.7)  │
                          └────────────┬──────────────┘
                                        ▼
                          ┌───────────────────────────┐
                          │   Claude Adapter (§6.2)     │
                          └────────────┬──────────────┘
                                        ▼
                                  Claude service
```

Everything below the Format Translator is shape-agnostic — it works with one internal request/response representation regardless of which external route was hit.

---

# 5. Technology Stack

**Runtime:** Node.js · **Language:** TypeScript · **HTTP framework:** Fastify
**Claude integration:** Claude Agent SDK, current stable `query()` API with the `resume` option — not the removed v2 preview session API.
**Type fidelity (NEW):** reference the official `openai` and `@anthropic-ai/sdk` npm packages' TypeScript types for the two external request/response shapes, even though neither package is used at runtime to talk to Claude — this reduces drift from the real specs versus hand-rolled types.
**Concurrency control:** in-process semaphore/queue (`p-limit` or hand-rolled) — sufficient for a single-machine personal tool.
**Validation:** Zod · **Logging:** Pino · **Persistence:** SQLite (MVP) · **Containerization:** Docker · **API documentation:** OpenAPI · **Testing:** Vitest + Supertest · **Automation client:** n8n

---

# 6. System Components

## 6.1 API Server

Routes:

```http
POST /v1/chat/completions   ← OpenAI-compatible
POST /v1/messages           ← Anthropic-compatible
GET  /health
GET  /v1/models
POST /v1/sessions
GET  /v1/sessions/:id
DELETE /v1/sessions/:id
```

`/v1/models` should list the model aliases valid on each route (§7).

## 6.2 Claude Adapter

Unchanged in shape from v2.0 — the one place that talks to the Agent SDK:

```ts
interface ClaudeProvider {
  sendMessage(request: InternalClaudeRequest): Promise<InternalClaudeResponse>;
  streamMessage(request: InternalClaudeRequest): AsyncIterable<InternalClaudeEvent>;
  checkCredentials(): Promise<CredentialStatus>;
}
```

Both route handlers call this same interface via the Format Translator (§6.8) — the adapter has no knowledge of OpenAI or Anthropic request shapes.

Build against the SDK's current `query()` function with explicit `resume`, not the removed v2 preview session objects.

## 6.3 Session Manager (revised for statelessness)

Default behavior (no `session_id` in the request): stateless. The full `messages` array from the request is passed straight through to a new Agent SDK invocation each time — exactly what an unmodified OpenAI/Anthropic client expects, since it will resend history itself.

Extension behavior (`session_id` present, §7.C): the manager maps the caller's `session_id` to the Agent SDK's own session ID (SQLite `sessions` table) and calls `resume()` with that explicit ID — never the SDK's "continue most recent" shortcut, which is documented as unsafe for multi-user/multi-workflow use and would leak context between unrelated callers.

```text
No session_id  → fresh call each time, caller supplies full history (default)
session_id set → gateway resumes that SPECIFIC Agent SDK session (extension)
```

## 6.4 Authentication Layer (revised — dual header support)

The gateway API key is the same fixed value regardless of route, but real OpenAI and Anthropic clients default to different header conventions:

| Client type | Header it sends by default |
|---|---|
| OpenAI SDK / OpenAI-compatible tools | `Authorization: Bearer <key>` |
| Anthropic SDK / Anthropic-compatible tools | `x-api-key: <key>` (often with `anthropic-version: <date>`) |

The gateway must accept **both** header conventions on **both** routes, so a real Anthropic SDK client pointed at `/v1/messages` works with zero configuration workaround, and likewise for an OpenAI SDK client on `/v1/chat/completions`. `anthropic-version` should be accepted and ignored (single internal Claude version regardless) rather than rejected as unknown.

```http
401 Unauthorized   -- if neither header carries a valid key
```

## 6.5 Request Validator (revised — per-route rules)

**Anthropic route (`/v1/messages`):** `max_tokens` is **required**, matching the real API — this was missing from v1.0/v2.0's examples and would reject valid-looking requests from a real Anthropic client if left unenforced. `content` may be a string or an array of content blocks.

**OpenAI route (`/v1/chat/completions`):** `model` and `messages` required; `max_tokens` optional (server picks a default if omitted, matching OpenAI's own behavior).

Both: validate `model` against the route's allow-list (§7), roles, content, optional `session_id`, `stream` flag.

```json
{
  "error": { "type": "invalid_request_error", "message": "max_tokens is required" }
}
```
(Anthropic-shaped error — see §13 for the OpenAI-shaped equivalent.)

## 6.6 Concurrency / Process Manager

Unchanged from v2.0 in concept — now explicitly shared across both routes, since they both ultimately drive the same underlying Claude invocations:

```text
MAX_CONCURRENT_REQUESTS=2   (default, conservative pending Phase 0 testing)
QUEUE_MAX_SIZE=10
REQUEST_TIMEOUT_MS=120000
```

Queue-full → `rate_limit_error` in the caller's native shape (§13).

## 6.7 Credential Lifecycle Manager

Unchanged from v2.0: periodic + on-demand checks of Agent SDK auth validity, surfaced via `/health` and `doctor`, fails new requests fast with a route-appropriate 503 rather than hanging.

## 6.8 Format Translator (NEW)

The component that makes compatibility real rather than approximate. Two responsibilities:

**Inbound:** convert an OpenAI-shaped or Anthropic-shaped request into one internal representation (`InternalClaudeRequest`) that the Claude Adapter understands, applying each route's own validation rules (§6.5) first.

**Outbound:** convert the Claude Adapter's response, streaming events, or error back into the shape the specific route promises — OpenAI `chat.completion`/`chat.completion.chunk`/OpenAI-style error, or Anthropic `message`/named SSE events/Anthropic-style error (§7, §8, §9, §13).

This isolates "what Claude actually returned" from "what shape we promised the caller" — if either upstream spec changes, only this layer needs updating.

---

# 7. API Design

## 7.A OpenAI-Compatible Route

### `POST /v1/chat/completions`

**Auth:** `Authorization: Bearer <gateway-key>` (or `x-api-key`, §6.4)

**Request:**

```json
{
  "model": "claude-via-gateway",
  "messages": [
    { "role": "system", "content": "You are a helpful engineering assistant." },
    { "role": "user", "content": "Explain how Docker networking works." }
  ],
  "stream": false,
  "temperature": 1.0
}
```

`model` is an alias resolved against a gateway-configured allow-list (e.g. `claude-via-gateway` → the actual Agent SDK model configured for this deployment) — not an open passthrough, since actual model availability depends on the authenticated plan/config.

## 7.B Anthropic-Compatible Route

### `POST /v1/messages`

**Auth:** `x-api-key: <gateway-key>` and `anthropic-version: <date>` (or `Authorization: Bearer`, §6.4)

**Request:**

```json
{
  "model": "claude-via-gateway",
  "max_tokens": 1024,
  "system": "You are a helpful engineering assistant.",
  "messages": [
    { "role": "user", "content": "Explain how Docker networking works." }
  ],
  "stream": false
}
```

`max_tokens` is required, matching the real Anthropic API (§6.5). `model` is resolved against the same kind of allow-list as §7.A, potentially with different alias names appropriate to Anthropic-style callers (e.g. `claude-sonnet-4-5`-shaped names some tools expect).

## 7.C Gateway Extension Fields (both routes)

```json
{
  "session_id": "session_123"
}
```

Optional on both routes. Ignored-safe: a strict OpenAI or Anthropic client that has never heard of it simply won't send it, and the gateway falls back to the stateless default (§1.5, §6.3). Present, it triggers explicit session resume.

---

# 8. Response Design

## 8.A OpenAI-shaped response

```json
{
  "id": "chatcmpl-local-123",
  "object": "chat.completion",
  "created": 1735689600,
  "model": "claude-via-gateway",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Docker networking allows containers to communicate..." },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

(Token counts populated from whatever the Agent SDK reports; if it doesn't report them, this is a known limitation to flag in docs rather than fabricate numbers.)

## 8.B Anthropic-shaped response

```json
{
  "id": "msg_local_123",
  "type": "message",
  "role": "assistant",
  "model": "claude-via-gateway",
  "content": [ { "type": "text", "text": "Docker networking allows containers to communicate..." } ],
  "stop_reason": "end_turn",
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

Both are produced by the Format Translator (§6.8) from the same internal response — the caller never sees the internal shape.

---

# 9. Streaming

Both routes support `"stream": true` via SSE, each in its own native event format. A stream occupies a concurrency slot (§6.6) for its full duration.

**OpenAI-shaped stream:**

```text
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

**Anthropic-shaped stream:**

```text
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}

event: message_stop
data: {"type":"message_stop"}
```

Getting these exact event names/sentinels right is what makes real OpenAI/Anthropic streaming clients (which parse for `[DONE]` or `message_stop` specifically) work unmodified — an approximate SSE format would silently break those clients' stream-termination logic.

---

# 10. n8n Integration (revised — two paths, native path now preferred)

## 10.1 Native path (NEW, preferred) — n8n's built-in OpenAI Chat Model node

n8n's AI/LangChain nodes include an "OpenAI Chat Model" sub-node that accepts a custom Base URL. Point it at:

```text
Base URL: http://localhost:8787/v1
API Key:  <gateway API key>
```

This gets you Claude inside n8n's native AI Agent/Chain nodes with no manual HTTP Request node or response-parsing step — the trade-off is that n8n's AI Agent node may attempt tool/function calls, which are out of scope until Phase 3 (§23, NG6); plain chat/completion use works today.

## 10.2 Generic HTTP Request node (fallback, either route)

```text
Method: POST
URL: http://localhost:8787/v1/chat/completions   (or /v1/messages)
Headers: Authorization: Bearer cg_local_xxxxx
```

```json
{
  "model": "claude-via-gateway",
  "messages": [ { "role": "user", "content": "{{$json.prompt}}" } ]
}
```

## 10.3 n8n in its own container

Same networking guidance as v2.0 (§19): use `host.docker.internal` or a shared docker-compose network with the gateway's service name, not `localhost`, when n8n runs in Docker and the gateway doesn't.

---

# 11. Example n8n Workflow

```text
┌──────────────┐
│ Webhook      │
└──────┬───────┘
       ▼
┌──────────────┐
│ Set Prompt   │
└──────┬───────┘
       ▼
┌────────────────────────────┐
│ OpenAI Chat Model node      │
│ (Base URL → gateway) OR     │
│ HTTP Request → either route │
└─────────────┬──────────────┘
              ▼
┌────────────────────┐
│ Continue Workflow  │
└────────────────────┘
```

---

# 12. Health Monitoring

```http
GET /health
```

```json
{
  "status": "ok",
  "service": "claude-gateway",
  "version": "0.1.0",
  "claude_auth_status": "ok",
  "active_requests": 1,
  "queued_requests": 0,
  "routes": { "openai_compatible": "enabled", "anthropic_compatible": "enabled" }
}
```

---

# 13. Error Handling (both shapes, per route)

Internally there are still six error categories (unchanged from v2.0): `invalid_request_error`, `rate_limit_error`, `usage_limit_error`, `credential_error`, `provider_error`, unexpected `500`. The Format Translator (§6.8) renders whichever one occurred into the calling route's native error shape.

**OpenAI-shaped error:**

```json
{
  "error": { "message": "Gateway concurrency queue is full, retry shortly", "type": "rate_limit_error", "param": null, "code": null }
}
```

**Anthropic-shaped error:**

```json
{
  "type": "error",
  "error": { "type": "rate_limit_error", "message": "Gateway concurrency queue is full, retry shortly" }
}
```

Note the Anthropic shape's required top-level `"type": "error"` wrapper — easy to miss (v1.0/v2.0's examples did) and it will break strict Anthropic-SDK error parsing if omitted.

`rate_limit_error` (gateway-side, retry in seconds) vs. `usage_limit_error` (account/subscription limit, retry after the plan's usage window) stay distinct as in v2.0, now expressed correctly in both shapes.

---

# 14. Logging

Unchanged from v2.0: request ID, timestamp, endpoint (now including which route/shape), duration, session ID if present, success/failure, error category, credential-refresh events, concurrency-queue wait time. Never log API keys, tokens, full prompts/responses by default.

---

# 15. Configuration

```env
PORT=8787
HOST=127.0.0.1

GATEWAY_API_KEY=...

LOG_LEVEL=info
DATABASE_URL=./data/gateway.db

MAX_CONCURRENT_REQUESTS=2
QUEUE_MAX_SIZE=10
REQUEST_TIMEOUT_MS=120000

CREDENTIAL_CHECK_INTERVAL_MS=60000

# NEW — allow disabling a surface you don't use
ENABLE_OPENAI_COMPAT_ROUTE=true
ENABLE_ANTHROPIC_COMPAT_ROUTE=true
```

---

# 16. Security Requirements

Unchanged from v2.0 (S1 local-binding-with-Docker-nuance, S2 API auth, S3 secret protection, S4 input limits, S5 rate limiting, S6 no credential extraction, S7 credential rotation reminder) — S2 now explicitly covers checking both header conventions (§6.4) as equally valid presentations of the same one gateway key, not two separate secrets to manage.

---

# 17. Persistence

```text
sessions: id, provider_session_id, created_at, updated_at, metadata
requests: id, session_id (nullable — absent for stateless calls), route (openai|anthropic),
          status, started_at, completed_at, error_type, queue_wait_ms
```

`route` is new — useful later for seeing which compatibility surface is actually getting used.

---

# 18. CLI

```bash
claude-gateway start
claude-gateway status
claude-gateway doctor
claude-gateway key generate
```

`doctor` now also confirms both routes respond:

```text
✓ Node.js
✓ Agent SDK installed
✓ Authentication available (checked just now, valid)
✓ Gateway configuration valid
✓ Port 8787 available
✓ Concurrency limit configured (MAX_CONCURRENT_REQUESTS=2)
✓ /v1/chat/completions responding
✓ /v1/messages responding

Ready.
```

---

# 19. Docker

Unchanged from v2.0's two modes (host-based gateway vs. shared docker-compose network) — see that revision's guidance on never publishing a bare `8787:8787` port.

---

# 20. MVP Scope

### M1–M4, M8, M10–M13 — unchanged from v2.0 (install, auth, health w/ credential status, invalid-client rejection, concurrency enforcement, credential-expiry detection, session isolation).

### M5 (revised) — Both `POST /v1/chat/completions` and `POST /v1/messages` succeed with correctly-shaped requests.

### M6 (revised) — An authenticated request to *either* route produces a response in that route's native shape, verified against the real OpenAI/Anthropic SDKs pointed at the gateway (not just curl) as the acceptance test.

### M7 (revised) — n8n can invoke Claude via both the native OpenAI Chat Model node (§10.1) and a generic HTTP Request node (§10.2), from host and Docker n8n setups.

### M9 (revised) — Errors are normalized per-route into each API's native error shape (§13), with `rate_limit_error`/`usage_limit_error` distinguished in both.

### M14 (NEW) — A stateless request (no `session_id`) from an unmodified OpenAI or Anthropic SDK client works correctly with zero gateway-specific configuration.

---

# 21. MVP User Journey

```text
1.  Clone repository
2.  Install dependencies
3.  Configure supported Claude authentication
4.  Re-check current Agent SDK usage-pool policy (§1.4)
5.  Run doctor
6.  Start gateway
7.  Receive local API key
8.  Test /v1/chat/completions with curl AND the real openai SDK pointed at the gateway
9.  Test /v1/messages with curl AND the real @anthropic-ai/sdk pointed at the gateway
10. Configure n8n (native OpenAI Chat Model node, or HTTP Request node — host or Docker mode)
11. Execute workflow
```

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"claude-via-gateway","messages":[{"role":"user","content":"Hello."}]}'

curl http://localhost:8787/v1/messages \
  -H "x-api-key: $GATEWAY_API_KEY" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" \
  -d '{"model":"claude-via-gateway","max_tokens":256,"messages":[{"role":"user","content":"Hello."}]}'
```

---

# 22. Phase 2 Features

P2.1 Conversation persistence · P2.2 Full SSE streaming polish for both shapes · P2.3 Expand model alias allow-lists per route · P2.4 Usage dashboard (incl. usage-pool consumption, and split by route) · P2.5 Request tracing incl. which route/shape was used · P2.6 OpenAPI spec covering both routes.

---

# 23. Phase 3 — Tool/Agent Capabilities and Function Calling (expanded)

Both real APIs support tool/function calling (OpenAI's `tools`/`tool_calls`, Anthropic's `tools`). Bridging either shape's tool-calling convention to the Agent SDK's own tool mechanics — and translating between the two shapes' *different* tool-calling conventions — is nontrivial and is explicitly deferred here (NG6). This is also what unlocks n8n's AI Agent node driving real tool use through the gateway, not just plain chat.

Additional Agent SDK capabilities (file operations, project context, structured workflows) remain a later, separate surface from these two chat/message endpoints so the compatibility contract stays clean.

---

# 24. Future Architecture

```text
        n8n / chat UIs / IDE plugins / scripts
                        │
        ┌───────────────┴───────────────┐
        │   /v1/chat/completions          │
        │   /v1/messages                  │
        │   Format Translator             │
        │   Auth · Sessions · Rate limit  │
        └───────────────┬───────────────┘
             ┌───────────┼───────────┐
             ▼           ▼           ▼
        Agent SDK   Future API   Future local
        Provider    Provider     models
             │
             ▼
           Claude
```

---

# 25. Repository Structure

```text
claude-personal-gateway/
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── config/config.ts
│   ├── routes/
│   │   ├── health.ts
│   │   ├── openai-compat.ts        ← NEW: /v1/chat/completions
│   │   ├── anthropic-compat.ts     ← renamed from messages.ts
│   │   └── sessions.ts
│   ├── translator/
│   │   ├── openai.ts               ← NEW (§6.8)
│   │   └── anthropic.ts            ← NEW (§6.8)
│   ├── providers/{claude.ts,types.ts}
│   ├── auth/{api-key.ts,credential-monitor.ts}
│   ├── concurrency/queue.ts
│   ├── sessions/session-manager.ts
│   ├── schemas/{openai-messages.ts,anthropic-messages.ts}
│   ├── errors/api-error.ts
│   └── utils/
├── tests/
│   ├── health.test.ts
│   ├── auth.test.ts
│   ├── openai-compat.test.ts       ← NEW
│   ├── anthropic-compat.test.ts    ← NEW
│   ├── concurrency.test.ts
│   └── session-isolation.test.ts
├── docs/{architecture.md,api.md,n8n.md}
├── docker/ · openapi.yaml · Dockerfile · docker-compose.yml
├── package.json · tsconfig.json · .env.example · README.md
```

---

# 26. Acceptance Criteria

All v2.0 items, plus:

```text
[✓] POST /v1/chat/completions matches real OpenAI SDK expectations (verified with the actual `openai` package pointed at the gateway)
[✓] POST /v1/messages matches real Anthropic SDK expectations (verified with the actual `@anthropic-ai/sdk` package), including required max_tokens and x-api-key auth
[✓] Errors render in each route's native shape, including Anthropic's top-level "type":"error" wrapper
[✓] Streaming terminates correctly for both shapes ([DONE] / message_stop)
[✓] A stateless request with no session_id works correctly on both routes
[✓] n8n's native OpenAI Chat Model node works against the gateway for plain chat (tool-calling explicitly out of scope, NG6)
```

---

# 27. Risks

## R1 — Subscription/Agent SDK policy changes (unchanged, still top risk — §1.4)
## R2 — Shared usage limits, now more likely to bind given broader client reach (§1.4)
## R3 — Agent SDK API surface changes (unchanged)
## R4 — n8n streaming compatibility (unchanged)
## R5 — Accidental network exposure (unchanged, incl. Docker port-publish nuance)
## R6 — Concurrency ceiling unknown, verify in Phase 0 (unchanged)
## R7 — Session-resume misuse if the "continue most recent" shortcut is used instead of explicit resume (unchanged)

## R8 (NEW) — Dual-spec maintenance drift

OpenAI's and Anthropic's real APIs each evolve independently over time. A translator that's accurate today can silently drift out of spec as either upstream API changes shape. **Mitigation:** keep the Format Translator (§6.8) as the single place either spec's changes get absorbed; periodically re-diff against the current `openai`/`@anthropic-ai/sdk` package types (§5) rather than assuming the initial implementation stays correct indefinitely.

## R9 (NEW) — False sense of full compatibility

"OpenAI/Anthropic-compatible" can quietly come to mean "compatible for the features I tested," while a client that reaches for tool-calling, vision inputs, or other unimplemented fields (NG4/NG6) gets a confusing failure instead of a clear "not supported" response. **Mitigation:** have the Request Validator (§6.5) explicitly reject known-unsupported fields (e.g. `tools`, `tool_choice`) with a clear `invalid_request_error` rather than silently ignoring them, until Phase 3 implements them for real.

---

# 28. Development Roadmap

## Phase 0 — Feasibility (exit criteria)

```text
✓ Node.js → Agent SDK → Claude works reliably for a single request
✓ Explicit resume(sessionId) correctly isolates two concurrent sessions (closes R7)
✓ Concurrency ceiling tested to establish a safe MAX_CONCURRENT_REQUESTS default (closes R6)
✓ Credential-expiry behavior observed and confirmed detectable, not just assumed
✓ Round-trip test: a request built with the real `openai` package AND one built with
  the real `@anthropic-ai/sdk` package both produce correctly-shaped responses through
  a minimal version of the Format Translator (closes R8/R9 early, before full build-out)
✓ Current Agent SDK usage-pool policy re-confirmed against support.claude.com
```

## Phase 1 — Gateway MVP
Fastify server, both routes, Format Translator, API-key auth (dual header), request validation (per-route rules), concurrency manager, credential monitor, Claude provider adapter, six-category error handling rendered per-route, logging.

## Phase 2 — n8n
Native OpenAI Chat Model node integration + generic HTTP Request fallback, both host and Docker n8n setups, documentation.

## Phase 3 — Sessions + Streaming + Tool Calling
Durable sessions, concurrency-aware SSE for both shapes, tool/function-calling translation (§23, closes NG6).

## Phase 4 — Developer Experience
CLI, `doctor` (checks both routes), Docker, OpenAPI covering both routes, basic dashboard split by route.

---

# 29. Definition of Done

v2.0's 11 items, plus:

12. Both compatibility routes have been verified against the real upstream SDKs, not just hand-written curl requests.
13. Fields the gateway doesn't yet support (tools, vision, etc.) fail clearly rather than being silently dropped.

---

# 30. Product Success Metric

> **Can an unmodified OpenAI-SDK client and an unmodified Anthropic-SDK client both be pointed at this gateway — with just a base URL and key change — and get correct, correctly-shaped answers from Claude, without the developer opening Claude manually or burning through their interactive usage allowance?**

n8n satisfying this via either integration path (§10) is a specific instance of the metric, not the metric itself.

---

# 31. Open Questions to Resolve in Phase 0

1. Exact safe concurrency ceiling for Agent SDK invocations on one account/machine (§6.6, R6).
2. Whether the Agent SDK/CLI imposes its own throttling beyond the plan-level usage limit (may need a third error category).
3. Whether Anthropic's paused Agent SDK credit program (§1.4) has changed by the time Phase 0 starts.
4. Which model alias names make sense per route (§7) given the developer's actual plan/config.
5. **(NEW)** Build-order preference: both routes in parallel for Phase 1 as scoped here, or one first? Anthropic-compat is the lower-impedance option to build first, since the backend already speaks a very similar shape natively — OpenAI-compat requires translation in both directions. Worth deciding before Phase 1 starts if time is tight.
6. **(NEW)** Priority of Phase 3 tool-calling — if the main motivation for OpenAI-compat is n8n's AI Agent node specifically (which leans on tool calling), NG6 being deferred may be worth reconsidering earlier.
