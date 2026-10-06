# ChatGPT Plan Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separately authenticated ChatGPT plan Responses API and model catalog under `/chatgpt/v1`, with a local sign-in flow and no change to Claude inference.

**Architecture:** The existing provider registry owns ChatGPT status and route registration; a ChatGPT credential manager owns OAuth registration, selected account, refresh, and protected persistence. A dedicated Responses adapter validates the documented plan-use subset, sends requests only to OpenAI's public API endpoint, and streams provider events while auditing ChatGPT usage. The dashboard starts OAuth and shows the active account and supported URL.

**Tech Stack:** Node >=22.5, TypeScript ESM, Fastify 5, Zod 4, `node:sqlite` for existing audit only, `jose` for OIDC ID-token verification, Vitest 3, built-in `fetch` and Web Streams.

**Spec:** `docs/superpowers/specs/2026-10-06-chatgpt-plan-separate-api-design.md`, within `docs/superpowers/specs/2026-10-06-multi-provider-gateway-design.md`.

## Global Constraints

- Keep legacy and prefixed Claude routes, models, sessions, auth, and default behavior intact. ChatGPT never falls back to Claude.
- `POST /chatgpt/v1/responses` is Responses API SSE only; `GET /chatgpt/v1/models` returns the selected account's model catalog as a `models` array. Do not advertise Chat Completions or Anthropic Messages for ChatGPT.
- HTTP inference requires `store: false`, `stream: true`, and an `input` array containing full context. Reject unsupported preview fields before upstream work; never silently drop them.
- OAuth uses `dynamic_agent_client` only for first registration; persist the issued client ID and a stable `ext_agent_host_id`. Use exact `http://127.0.0.1:<PORT>/auth/callback`, `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, and resource `https://api.openai.com/v1`.
- Validate state, nonce, PKCE, callback client ID, signed ID token (issuer, audience, expiry, subject), and granted plan-use scope before selecting an account. A failed new sign-in leaves the previous selection intact.
- Store access, refresh, and retained ID tokens in owner-protected runtime storage outside browser storage, source control, URLs, logs, and API responses. The authorization URL may carry `id_token_hint` only if redacted from logs; this plan omits the hint initially.
- Suppress request URL logging on the OAuth callback because its query string contains a short-lived authorization code. Redirect away from that URL after consuming it.
- Refresh near expiry with one serialized refresh per selected account; persist rotated tokens atomically. A revoked grant disconnects ChatGPT only.
- Restrict upstream requests to `https://auth.openai.com` OAuth/OIDC endpoints and `https://api.openai.com/v1/{models,responses}`. Never forward client-supplied authorization headers.
- Preserve loopback bind default. Docker setup must persist protected ChatGPT credentials; remote VM setup follows OpenAI's local authorization and protected transfer guidance.

## Review Focus

1. Callback with mismatched or reused state, changed client ID, wrong nonce, or wrong signed subject: reject it without replacing the selected account (Task 2 tests).
2. Two concurrent requests during token rotation: one refresh request, one saved replacement, both use the new access token (Task 3 test).
3. Unsupported Responses field or system message and a caller Authorization header: reject before upstream or replace the header with the selected OAuth token (Task 5 tests).
4. Upstream SSE ends without `response.completed`, reports `response.failed`, or breaks mid-event: audit an error and close the stream without claiming success (Task 5 tests).
5. Missing/revoked ChatGPT credentials while Claude remains connected: ChatGPT status and routes fail independently, with no Claude call or token leak (Tasks 3 and 5 tests).

---

## File map

- `src/chatgpt/credential-store.ts`: protected, atomic account records, stable host ID, and selected registration; `src/config/config.ts` supplies the path.
- `src/chatgpt/oauth.ts`: pending authorization transactions, PKCE/state/nonce, OIDC discovery and ID-token verification, token exchange and refresh.
- `src/chatgpt/connection.ts`: selected-account lifecycle, serialized refresh, revoke/disconnect, and safe status.
- `src/chatgpt/upstream.ts`: fixed OpenAI hosts/paths, bounded responses, error classification, and no caller headers.
- `src/chatgpt/responses.ts`: request schema, SSE validation/forwarding, audit, and per-provider concurrency budget.
- `src/routes/chatgpt-auth.ts`, `src/routes/chatgpt-models.ts`, `src/routes/chatgpt-responses.ts`: authenticated setup/model/inference and state-validated loopback callback.
- `src/providers/builtin-adapters.ts`, `src/app.ts`, `src/providers/registry.ts`: replace ChatGPT placeholder with live adapter and close its resources.
- `src/routes/dashboard.ts`: Continue with ChatGPT, selected account, and ready-only Responses Base URL.
- `README.md`, `docs/USER_GUIDE.md`, `docs/api.md`, `docs/architecture.md`, `openapi.yaml`, `docker-compose.yml`, `docker-start.bat`, `.gitignore`: contract and persistence.

### Task 1: Protected account store and registry status

**Files:** Create `src/chatgpt/credential-store.ts`, `tests/chatgpt-store.test.ts`; modify `src/config/config.ts`, `.gitignore`, `src/providers/builtin-adapters.ts`, `src/app.ts`.

**Interfaces:**
- `ChatGptAccount = { registrationId: string; clientId: string; issuer: string; subject: string; email?: string; scopes: string[]; accessToken: string; refreshToken: string; idToken: string; expiresAt: number }`. `ChatGptStoreState = { hostId: string; selectedRegistrationId?: string; accounts: ChatGptAccount[] }`.
- `ChatGptCredentialStore(path: string)` provides `load(): Promise<ChatGptStoreState>`, `save(state: ChatGptStoreState): Promise<void>`, and `getOrCreateHostId(): Promise<string>`. Default path is `%LOCALAPPDATA%/PGSAO API/chatgpt.json` on Windows and `$XDG_CONFIG_HOME/pgsao-api/chatgpt.json` (or `~/.config/pgsao-api/chatgpt.json`) elsewhere. `CHATGPT_CREDENTIALS_PATH` overrides it for Docker and tests. Use 0700 directories and 0600 files on Unix; on Windows restrict and verify the file/directory ACL for the current user, SYSTEM, and Administrators without placing token text in a command argument. Replace via write-temp-and-rename and fail closed if protection cannot be applied.
- ChatGPT status reports `not_configured` and no capabilities without a selected valid account; the existing Claude status remains independent. Do not add ChatGPT inference routes yet.

- [ ] **Step 1: Write failing tests** for stable `urn:uuid:` host ID across reload, atomic save/reload of two registration records, selected registration preservation, secret absence from `/v1/providers`, and rejection of an insecure credential path.
- [ ] **Step 2: Run `npm test -- tests/chatgpt-store.test.ts`**; expect store/status failures.
- [ ] **Step 3: Implement** `ChatGptCredentialStore`, config path, ignored local credentials, and injected store in `buildApp`/ChatGPT adapter status. Do not put secrets in status detail.
- [ ] **Step 4: Run `npm test -- tests/chatgpt-store.test.ts`**; expect the focused tests to pass.
- [ ] **Step 5: Commit** Task 1 files with `feat: store ChatGPT account registrations privately`.

### Task 2: OAuth start, callback, and account validation

**Files:** Create `src/chatgpt/oauth.ts`, `src/routes/chatgpt-auth.ts`, `tests/chatgpt-oauth.test.ts`; modify `src/app.ts`, `src/providers/builtin-adapters.ts`, `package.json`, `package-lock.json` (add `jose`).

**Interfaces:**
- Authenticated `POST /v1/providers/chatgpt/connect` accepts `{ registrationId?: string }`; returns `{ authorizationUrl: string }` with no token. First registration uses `dynamic_agent_client` and `agent_name_hint=PGSAO API`; returning registration uses its issued `clientId`. The URL carries exact 127.0.0.1 callback, stable host ID, state, nonce, PKCE S256, required scopes/resource. A pending attempt expires after 10 minutes and is consumed once.
- `GET /auth/callback` has request logging disabled, validates state and OAuth error, then callback-issued client ID for a new attempt or exact saved ID for a return. Exchange form-encoded code with the issued ID and same redirect URI and verifier. Use `jose` with OpenAI discovery/JWKS to validate signature, issuer, audience, exp, nonce, and nonempty `sub`. Require token response scope `chatgpt.tokens.use.direct`. Return a 303 redirect to `/dashboard` with only a nonsecret result flag, clearing the code from the address bar.
- Keep separate records by registration ID, not email. A returning sign-in must match its previously validated issuer/subject; only after all checks save and select the new account. The callback returns a small local success/failure page and never includes code or tokens.

- [ ] **Step 1: Write failing tests** with a local signed JWKS and fake token endpoint: URL parameters, callback state replay/mismatch, declined consent, changed client ID, wrong nonce/audience/signature/subject, absent plan scope, invalid-grant exchange, callback redirection/log redaction, and successful first/returning sign-in that preserves the prior selection until validation.
- [ ] **Step 2: Run `npm test -- tests/chatgpt-oauth.test.ts`**; expect missing flow/validation failures.
- [ ] **Step 3: Implement** OAuth transaction and routes with injectable fixed-host HTTP and JWKS test seams; install `jose`. Never log the authorization URL or token response.
- [ ] **Step 4: Run `npm test -- tests/chatgpt-oauth.test.ts`**; expect all focused cases to pass.
- [ ] **Step 5: Commit** Task 2 files with `feat: connect ChatGPT with validated local OAuth`.

### Task 3: Refresh, disconnect, and independent connection state

**Files:** Create `src/chatgpt/connection.ts`, `tests/chatgpt-connection.test.ts`; modify `src/chatgpt/oauth.ts`, `src/routes/chatgpt-auth.ts`, `src/providers/builtin-adapters.ts`, `src/app.ts`.

**Interfaces:**
- `ChatGptConnection.getAccessToken(): Promise<string>` refreshes before expiry (60-second margin), serializing concurrent callers for the selected registration. Refresh uses `grant_type=refresh_token`, issued `client_id`, saved refresh token, and `resource=https://api.openai.com/v1`; omit `scope`. Atomically save all rotated fields before returning the new access token.
- Authenticated `POST /v1/providers/chatgpt/disconnect` revokes the selected refresh token through OpenAI's discovery revocation endpoint where available, clears its tokens locally, retains registration/host ID, and leaves Claude unaffected. A transient revocation failure gets bounded backoff while the token remains available; if the user finishes local sign-out without remote confirmation, report that fact without leaking the token. On `invalid_grant` or revoked refresh, mark only ChatGPT disconnected and require reconnection. Connection status exposes no tokens.

- [ ] **Step 1: Write failing tests** for near-expiry refresh, two simultaneous callers sharing one refresh, persisted rotation, revoked grant, disconnect/revoke, and Claude route success after ChatGPT disconnect.
- [ ] **Step 2: Run `npm test -- tests/chatgpt-connection.test.ts`**; expect missing lifecycle behavior.
- [ ] **Step 3: Implement** `ChatGptConnection`, refresh/revoke transport, disconnect route, and registry connection status.
- [ ] **Step 4: Run `npm test -- tests/chatgpt-connection.test.ts`**; expect all focused cases to pass.
- [ ] **Step 5: Commit** Task 3 files with `feat: refresh and disconnect ChatGPT independently`.

### Task 4: Account model catalog

**Files:** Create `src/chatgpt/upstream.ts`, `src/routes/chatgpt-models.ts`, `tests/chatgpt-models.test.ts`; modify `src/providers/builtin-adapters.ts`.

**Interfaces:**
- Authenticated `GET /chatgpt/v1/models` calls only `https://api.openai.com/v1/models` with the selected OAuth token, filters `models` by `visibility === 'list'`, preserves order, and returns `{ models: [{ slug: string, display_name: string }] }`. Disconnected returns a ChatGPT-specific 503. Do not return a Claude alias or use a caller Authorization header upstream.
- ChatGPT adapter declares model discovery but does not advertise `openai_responses` capability until Task 5 registers inference. Bound upstream time and response size; map 401/403/429/5xx without exposing token text.

- [ ] **Step 1: Write failing tests** for selected-account model list/order, disconnected and upstream errors, and captured upstream URL/Authorization proving the gateway key never goes upstream.
- [ ] **Step 2: Run `npm test -- tests/chatgpt-models.test.ts`**; expect the missing model route.
- [ ] **Step 3: Implement** fixed-host upstream client and ChatGPT model route; register it through the adapter.
- [ ] **Step 4: Run `npm test -- tests/chatgpt-models.test.ts`**; expect all focused cases to pass.
- [ ] **Step 5: Commit** Task 4 files with `feat: list selected ChatGPT plan models`.

### Task 5: Validated Responses SSE route

**Files:** Create `src/chatgpt/responses.ts`, `src/routes/chatgpt-responses.ts`, `tests/chatgpt-responses.test.ts`; modify `src/providers/builtin-adapters.ts`, `src/app.ts`, `src/sessions/session-manager.ts`, `src/errors/api-error.ts` as needed.

**Interfaces:**
- Authenticated `POST /chatgpt/v1/responses` accepts a documented text-only subset: `model: string`, nonempty `input: Array<{ role: 'user' | 'assistant' | 'developer'; content: string }>`, optional `instructions: string`, and exact `store: false`, `stream: true`. Reject all other fields and explicit system-role items before upstream work. This initial adapter does not claim tool or multimodal support; add those only in later verified revisions.
- Call only `POST https://api.openai.com/v1/responses`, setting `Authorization: Bearer <selected OAuth access token>` and `Content-Type: application/json` from gateway-owned values. Forward supported payload fields and SSE frames; success requires `response.completed`. Treat `response.failed`, `response.incomplete`, interrupted stream, oversized frame, and malformed SSE as ChatGPT audit errors. Before headers, return route-shaped disconnected, limit, and upstream errors; after headers, preserve any upstream failure event, close without inventing `response.completed`, and audit the error. Never invoke Claude. Use a ChatGPT-specific concurrency budget and `servingGate.assertEnabled()` after gateway-key auth.
- Record `provider: 'chatgpt'` and route `responses` in request audit; extend route type and usage without changing Claude `byRoute` labels. ChatGPT adapter advertises `openai_responses` at `/chatgpt/v1` only when connected.

- [ ] **Step 1: Write failing tests** for auth, exact supported-field validation, fixed upstream host/header/body, real SSE completion, failed/incomplete/interrupted streams, usage-limit and retry mapping, audit provider/route, pause behavior, and no Claude fallback.
- [ ] **Step 2: Run `npm test -- tests/chatgpt-responses.test.ts`**; expect missing route/contract failures.
- [ ] **Step 3: Implement** strict request schema, bounded SSE parser/forwarder, independent limiter, error mapping, audit, and adapter route/status registration.
- [ ] **Step 4: Run `npm test -- tests/chatgpt-responses.test.ts`**; expect all focused cases to pass.
- [ ] **Step 5: Commit** Task 5 files with `feat: serve ChatGPT plan Responses streams`.

### Task 6: Dashboard, deployment, and public contract

**Files:** Modify `src/routes/dashboard.ts`, `tests/dashboard-providers.test.ts`, `README.md`, `docs/USER_GUIDE.md`, `docs/api.md`, `docs/architecture.md`, `openapi.yaml`, `docker-compose.yml`, `docker-start.bat`, `.gitignore`.

**Interfaces:** Show Continue with ChatGPT, selected account and reconnection state, ChatGPT Responses Base URL and model choices only when ready, one gateway key, and no OAuth tokens in DOM or localStorage. Document preview fields, text-only subset, model list shape, usage limits, local callback, Docker protected credential mount, and remote VM local-authorization transfer. OpenAPI describes only implemented ChatGPT handlers and the narrow Responses schema.

- [ ] **Step 1: Write failing dashboard tests** that execute the inline browser script against connected/disconnected statuses and verify ready-only ChatGPT URL, connect action, active account label, and absence of tokens.
- [ ] **Step 2: Run `npm test -- tests/dashboard-providers.test.ts`**; expect ChatGPT dashboard assertions to fail.
- [ ] **Step 3: Implement** dashboard connection flow and documentation/deployment changes. Use OpenAI's approved Continue with ChatGPT label; keep token responses server-side.
- [ ] **Step 4: Run `npm test` and `npm run build`**; expect the whole suite and TypeScript build to pass.
- [ ] **Step 5: Parse `openapi.yaml`, check documented paths against route registration, run `git diff --check`, and inspect `git status --short`**; expect no speculative route or unrelated staged file.
- [ ] **Step 6: Commit** Task 6 files with `docs: describe ChatGPT plan adapter and setup`.

## Completion gate

Review the adapter against the focused spec and current [OpenAI registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [account lifecycle](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). Run fake-provider tests without real ChatGPT usage. Provide an optional live sign-in and one-model SSE check with the owner's account; do not silently consume the owner's plan allowance during automated tests. Then plan the Kimi Code, Qwen Coding Plan, and Gemini CLI adapters separately.
