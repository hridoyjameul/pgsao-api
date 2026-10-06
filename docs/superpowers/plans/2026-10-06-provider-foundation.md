# Provider Gateway Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Claude gateway into a five-provider control panel with explicit provider status, Claude-prefixed routes, provider-aware usage, and a pause control, ready for separate ChatGPT, Kimi, Qwen, and Gemini adapters.

**Architecture:** One `ProviderRegistry` owns metadata, status, and route registration for `claude`, `chatgpt`, `gemini`, `kimi`, and `qwen`. Only Claude has live inference in this stage. Existing Claude handlers are registered under both their legacy and provider-prefixed paths; shared gateway auth, logging, and control stay outside the Claude-specific request types.

**Tech Stack:** Node >=22.5, TypeScript ESM, Fastify 5, Zod 4, `node:sqlite`, Vitest 3, existing self-contained dashboard HTML.

**Spec:** `docs/superpowers/specs/2026-10-06-multi-provider-gateway-design.md` (foundation stage); the ChatGPT adapter has its own focused design and later plan.

## Global Constraints

- Initial provider IDs: `claude`, `chatgpt`, `gemini`, `kimi`, `qwen`.
- Keep `/v1/chat/completions`, `/v1/messages`, and `/v1/models` behavior and authentication intact.
- Use one generated `GATEWAY_API_KEY` for all enabled provider routes; never expose vendor credentials as that key.
- Show detected client, connected account, and API readiness as distinct states. A missing CLI does not block a future direct-key adapter.
- Show copyable URLs only for implemented handlers. Only Claude is API-ready in this stage.
- Stop/Start pauses new inference requests while `/dashboard`, `/health`, status, models, and control routes stay accessible.
- Keep the bind default `127.0.0.1`; do not read browser sessions or arbitrary app credential files.

## Review Focus

1. Missing CLI or Windows `.cmd`/`.exe` shim on `PATH`: detection reports accurately without executing it (Task 1 tests).
2. Claude route aliases with streaming and `session_id`: both paths use the same handler and preserve response framing and session isolation (Task 2 tests).
3. Stop during an active stream: only new inference calls are rejected; the active stream can finish (Task 3 test).
4. Existing SQLite `requests` table without a `provider` column: migration labels old rows `claude` and keeps `byRoute` unchanged (Task 4 test).
5. Host header containing HTML or script text: dashboard does not interpolate executable markup into base URLs or snippets (Task 5 test).

---

## File map

- `src/providers/registry.ts`: `ProviderId`, provider status/capability types, adapter interface, registry listing and route registration.
- `src/providers/detect-client.ts`: cross-platform, non-executing PATH lookup for known CLIs.
- `src/providers/builtin-adapters.ts`: five built-in descriptors; Claude's route registrar and live connection status, four pending adapters.
- `src/routes/providers.ts`: authenticated `GET /v1/providers` with no secrets.
- `src/control/serving-gate.ts` and `src/routes/control.ts`: in-memory inference pause state and authenticated control endpoints.
- `src/app.ts`: construct registry and serving gate; register provider, control, and provider-owned routes.
- `src/routes/openai-compat.ts`, `src/routes/anthropic-compat.ts`, `src/routes/models.ts`: support legacy and Claude-prefixed paths without duplicating handlers.
- `src/errors/api-error.ts`: explicit 503 `service_paused` category.
- `src/sessions/session-manager.ts`: provider ID on request audit records and `byProvider` aggregate; migrate existing DBs.
- `src/routes/dashboard.ts`: five provider cards, usable connection details, control buttons, and provider usage.
- `README.md`, `docs/USER_GUIDE.md`, `docs/api.md`, `docs/architecture.md`, `openapi.yaml`: foundation behavior and future-adapter states.

### Task 1: Registry, CLI detection, and provider status route

**Files:** Create `src/providers/registry.ts`, `src/providers/detect-client.ts`, `src/providers/builtin-adapters.ts`, `src/routes/providers.ts`, `tests/provider-registry.test.ts`; modify `src/app.ts`.

**Interfaces:**
- Produce `ProviderId = 'claude' | 'chatgpt' | 'gemini' | 'kimi' | 'qwen'`.
- Produce `ProviderCapability = { shape: 'openai_chat' | 'anthropic_messages' | 'openai_responses'; basePath: string; legacy?: boolean }` and `ProviderStatus` with `id`, `displayName`, `client: { state: 'detected' | 'not_detected' | 'not_required'; method: string }`, `connection: { state: 'connected' | 'disconnected' | 'not_configured'; detail?: string }`, `api: { ready: boolean; capabilities: ProviderCapability[] }`, and `setupAction: 'none' | 'sign_in' | 'enter_key' | 'install_cli' | 'reconnect' | 'coming_soon'`.
- Produce `ProviderAdapter` with `id`, `displayName`, `connectionMethod: 'existing_session' | 'oauth' | 'cli_login' | 'vendor_key'`, `detectClient(): Promise<ProviderStatus['client']>`, `getConnection(): Promise<ProviderStatus['connection']>`, `capabilities: readonly ProviderCapability[]`, optional `listModels?(): Promise<{ id: string; displayName?: string }[]>`, and `registerRoutes(app: FastifyInstance, gateway: GatewayDeps): void`. `ProviderRegistry` has `register(adapter)`, `listStatuses()`, and `registerRoutes(app, gateway)`; it derives `api.ready` from connected state plus nonempty implemented capabilities. The status exposes no capabilities until connected, so the dashboard has no unusable copy target.
- Produce `detectExecutable(command: string, options?: { pathEnv?: string; pathext?: string; platform?: NodeJS.Platform }): boolean` in `detect-client.ts`; inspect PATH entries, do not execute candidates.
- `GET /v1/providers` requires `GATEWAY_API_KEY`, returns `{ providers: ProviderStatus[] }` in the fixed order above, and never includes tokens or vendor keys.
- Consumes `CredentialMonitor.status` for Claude. Its Task 1 capabilities are `openai_chat` at `/v1` and `anthropic_messages` at `/`, both marked legacy and included only when their existing config flags enable those routes. Pending adapters have no capabilities and do not register routes. ChatGPT client is `not_required`; Kimi and Qwen client detection is informational. Task 1 adds the registry and status route but leaves existing Claude route registration in `app.ts`; Task 2 moves it into the Claude adapter.

- [ ] **Step 1: Write failing tests** in `tests/provider-registry.test.ts`, including these assertions:

```ts
expect(providers.map((p) => p.id)).toEqual(['claude', 'chatgpt', 'gemini', 'kimi', 'qwen']);
expect(providers[0].api.ready).toBe(true);
expect(providers.slice(1).every((p) => !p.api.ready && p.api.capabilities.length === 0)).toBe(true);
expect((await app.inject({ method: 'GET', url: '/v1/providers' })).statusCode).toBe(401);
expect(JSON.stringify(providers)).not.toContain(TEST_API_KEY);
expect(detectExecutable('gemini', { pathEnv: missingPathFixture, platform: 'win32' })).toBe(false);
expect(detectExecutable('gemini', { pathEnv: exeAndCmdFixtures, platform: 'win32' })).toBe(true);
```
- [ ] **Step 2: Run `npm test -- tests/provider-registry.test.ts`**; expect failures for missing registry/route.
- [ ] **Step 3: Implement** `detectExecutable(...)` in `detect-client.ts`, `ProviderRegistry` in `registry.ts`, `createBuiltinAdapters(credentialMonitor, detector): ProviderAdapter[]` in `builtin-adapters.ts`, and `registerProvidersRoute(app: FastifyInstance, gateway: GatewayDeps): void` in `routes/providers.ts`. Inject the detector so tests do not depend on the developer's installed apps.
- [ ] **Step 4: Run `npm test -- tests/provider-registry.test.ts`**; expect all Task 1 assertions to pass.
- [ ] **Step 5: Commit** only Task 1 files with `feat: add provider registry and status route`.

### Task 2: Claude-prefixed API aliases through its adapter

**Files:** Modify `src/providers/builtin-adapters.ts`, `src/app.ts`, `src/routes/openai-compat.ts`, `src/routes/anthropic-compat.ts`, `src/routes/models.ts`; create `tests/claude-prefixed-routes.test.ts`.

**Interfaces:**
- Claude adapter `registerRoutes(app, gateway)` registers `POST /claude/v1/chat/completions`, `POST /claude/v1/messages`, and `GET /claude/v1/models`, alongside the unchanged `/v1/...` routes. Respect `ENABLE_OPENAI_COMPAT_ROUTE` and `ENABLE_ANTHROPIC_COMPAT_ROUTE` for both legacy and matching prefixed inference paths; disabled shapes are absent from status capabilities.
- Existing route registration functions accept `paths: readonly string[]` and attach one existing handler to each path. Audit route labels remain `openai` and `anthropic` for legacy compatibility; the provider field added in Task 4 is `claude` for both paths.
- Claude's status adds `openai_chat` at `/claude/v1` and `anthropic_messages` at `/claude`, alongside legacy `/v1` and `/`; only the latter two carry `legacy: true`. Build this list from enabled route flags so the dashboard never offers a disabled shape.

- [ ] **Step 1: Write failing tests** in `tests/claude-prefixed-routes.test.ts` using the real OpenAI and Anthropic SDK clients and these assertions:

```ts
expect(openAiCompletion.choices[0].message.content).toContain('Docker networking');
expect(anthropicMessage.content[0].type).toBe('text');
expect(prefixedModels).toEqual(legacyModels);
expect(streamText).toContain('data: [DONE]');
expect(secondRequestProviderSessionId).toBe(firstRequestProviderSessionId); // same session_id across paths
expect(disabledShapeStatus.api.capabilities.some((c) => c.shape === 'anthropic_messages')).toBe(false);
expect(disabledPrefixedRequest.statusCode).toBe(404);
```
- [ ] **Step 2: Run `npm test -- tests/claude-prefixed-routes.test.ts`**; expect 404 or equivalent missing-route failures.
- [ ] **Step 3: Implement** `registerOpenAiCompatRoute(app, gateway, paths: readonly string[])`, `registerAnthropicCompatRoute(app, gateway, paths: readonly string[])`, and `registerModelsRoute(app, gateway, paths: readonly string[])`; call them from Claude's `registerRoutes` and remove their direct registration from `app.ts`. Keep the same handler closure for each path.
- [ ] **Step 4: Run `npm test -- tests/claude-prefixed-routes.test.ts`**; expect all aliases and compatibility assertions to pass.
- [ ] **Step 5: Commit** Task 2 files with `feat: expose Claude under provider prefix`.

### Task 3: Pause and resume new inference requests

**Files:** Create `src/control/serving-gate.ts`, `src/routes/control.ts`, `tests/serving-control.test.ts`; modify `src/app.ts`, `src/errors/api-error.ts`, `src/routes/openai-compat.ts`, `src/routes/anthropic-compat.ts`.

**Interfaces:**
- `ServingGate` has `enabled: boolean` (default `true`), `setEnabled(enabled: boolean): void`, and `assertEnabled(): void` throwing `ApiError('service_paused', 'Gateway inference is paused')` with HTTP 503.
- Authenticated `GET /v1/control/serving` returns `{ enabled: boolean }`; authenticated `POST /v1/control/serving` accepts exactly `{ enabled: boolean }` and returns the new state. State is process-local and resets to enabled on restart.
- Call `assertEnabled()` after API-key validation but before provider work in both Claude inference handlers; model, status, dashboard, usage, and control routes stay reachable. Future adapters call the same gate.

- [ ] **Step 1: Write failing tests** in `tests/serving-control.test.ts` with an injected delayed fake provider for the active stream and these assertions:

```ts
expect(unauthorizedControl.statusCode).toBe(401);
expect(initialControl.json()).toEqual({ enabled: true });
expect(badControl.statusCode).toBe(400);
expect(stoppedClaudeUrls.map((r) => r.statusCode)).toEqual([503, 503, 503, 503]);
expect(modelAndDashboardStatuses).toEqual([200, 200, 200]);
expect(activeStreamText).toContain('data: [DONE]');
expect(resumedCall.statusCode).toBe(200);
```
- [ ] **Step 2: Run `npm test -- tests/serving-control.test.ts`**; expect missing control route/gate failures.
- [ ] **Step 3: Implement** `ServingGate`, `registerControlRoute(app: FastifyInstance, gateway: GatewayDeps): void`, `service_paused` in `ApiErrorCategory`, and `gateway.servingGate.assertEnabled()` in both Claude inference handlers.
- [ ] **Step 4: Run `npm test -- tests/serving-control.test.ts`**; expect all control and stream assertions to pass.
- [ ] **Step 5: Commit** Task 3 files with `feat: pause gateway inference without stopping dashboard`.

### Task 4: Provider-aware request audit and usage

**Files:** Modify `src/sessions/session-manager.ts`, `src/routes/openai-compat.ts`, `src/routes/anthropic-compat.ts`, `src/routes/usage.ts`; create `tests/provider-usage.test.ts`.

**Interfaces:**
- `RequestLogEntry` gains required `provider: ProviderId`; existing Claude handlers pass `'claude'`.
- `requests.provider TEXT NOT NULL DEFAULT 'claude'` is added to new DBs and migrated into old DBs only when absent. Keep the old `route` column and `/v1/usage.byRoute` contract.
- `UsageStats` gains `byProvider: Record<string, { total: number; ok: number; error: number; avgQueueWaitMs: number | null }>`; `/v1/usage` returns it alongside existing fields. Later adapters call `recordRequest` with their own IDs.

- [ ] **Step 1: Write failing tests** in `tests/provider-usage.test.ts`; create an old-schema SQLite fixture with one Claude row and 0 ms wait, then construct `SessionManager` and record one new Claude row with 20 ms wait plus one synthetic Kimi row:

```ts
expect(stats.byProvider.claude.total).toBe(2); // old row plus new row
expect(stats.byProvider.kimi.total).toBe(1);
expect(stats.byRoute.openai.total).toBe(3); // legacy route aggregate retained
expect(requestColumns).toContain('provider');
expect(stats.byProvider.claude.avgQueueWaitMs).toBe(10); // fixture's two Claude waits: 0 and 20 ms
```
- [ ] **Step 2: Run `npm test -- tests/provider-usage.test.ts`**; expect missing provider schema/aggregate failures.
- [ ] **Step 3: Implement** required `RequestLogEntry.provider`, SQLite column detection/migration in `SessionManager`'s constructor, `recordRequest(entry: RequestLogEntry): void`, and `getUsageStats(): UsageStats` with a separate provider aggregate. Keep old rows and route labels; calculate average wait across all provider requests rather than averaging grouped averages.
- [ ] **Step 4: Run `npm test -- tests/provider-usage.test.ts`**; expect migration and aggregation assertions to pass.
- [ ] **Step 5: Commit** Task 4 files with `feat: track gateway usage by provider`.

### Task 5: Five-provider dashboard and connection details

**Files:** Modify `src/routes/dashboard.ts`, `tests/dashboard.test.ts`; create `tests/dashboard-providers.test.ts`.

**Interfaces:**
- Render cards for all five IDs from `GET /v1/providers`; display client detection, account connection, and API readiness as separate lines, plus a `coming soon` action for pending adapters. Show Claude's available model identifiers in its detail panel.
- Show the one generated gateway key through the current local reveal/copy pattern. Show Claude's usable prefixed and legacy base URLs only when its route is ready; fetch model identifiers from `/claude/v1/models` for the detail panel. Do not show invented ChatGPT, Gemini, Kimi, or Qwen URLs in this stage.
- Add Stop/Start buttons backed by `/v1/control/serving`, and show `byProvider` usage under Advanced. Keep the existing sessions and Claude snippets available.
- Escape the request Host when it is embedded in HTML attributes; keep JSON script data escaped as it is today.

- [ ] **Step 1: Write failing tests** in `tests/dashboard-providers.test.ts` and extend `tests/dashboard.test.ts`; assert the following on the fetched HTML and provider status response:

```ts
expect(html).toContain('id="providerCards"');
expect(html).toContain('Client detected');
expect(html).toContain('Account connected');
expect(html).toContain('Gateway API ready');
expect(html).toContain('/v1/control/serving');
expect(html).not.toContain('provider-secret-test-value');
expect(html).not.toContain('<img src=x onerror=alert(1)>');
expect(providers.filter((p) => p.api.ready).map((p) => p.id)).toEqual(['claude']);
```
- [ ] **Step 2: Run `npm test -- tests/dashboard-providers.test.ts tests/dashboard.test.ts`**; expect new dashboard assertions to fail.
- [ ] **Step 3: Update the HTML, CSS, and browser script** in `src/routes/dashboard.ts`; use DOM text insertion for server status strings rather than constructing HTML from provider details.
- [ ] **Step 4: Run `npm test -- tests/dashboard-providers.test.ts tests/dashboard.test.ts`**; expect all new and existing dashboard assertions to pass.
- [ ] **Step 5: Commit** Task 5 files with `feat: show provider status and controls in dashboard`.

### Task 6: Foundation documentation and integrated verification

**Files:** Modify `README.md`, `docs/USER_GUIDE.md`, `docs/api.md`, `docs/architecture.md`, `openapi.yaml`; optionally modify `docs/n8n.md` only if its existing Claude URL examples become ambiguous.

**Interfaces:** Document the five card states, the one gateway key, only-Claude-ready foundation status, Claude prefixed/legacy URLs, authenticated provider/control routes, pause semantics, provider-aware usage shape, and the later adapter stages. The OpenAPI file must describe only handlers implemented by this foundation, not future routes.

- [ ] **Step 1: Write the documentation changes** in the listed files, including a quickstart request against `/claude/v1/chat/completions` and the legacy path.
- [ ] **Step 2: Check documented paths and examples against `src/app.ts` route registration**; expect every copyable path to have a registered handler and no pending-provider endpoint in `openapi.yaml`.
- [ ] **Step 3: Run `npm test`**; expect the full suite to pass, including unchanged Claude compatibility tests.
- [ ] **Step 4: Run `npm run build`**; expect TypeScript compilation to exit 0.
- [ ] **Step 5: Inspect `git diff --check` and `git status --short`**; expect no whitespace errors and no unrelated staged files.
- [ ] **Step 6: Commit** Task 6 files with `docs: describe provider gateway foundation`.

## Completion gate

After Task 6, review the foundation against the spec's first delivery stage. Confirm all five cards appear, only Claude is advertised as API-ready, existing Claude clients work, and the new prefixed Claude URLs and pause control are documented. Then create the separate ChatGPT adapter plan from its focused spec; Kimi, Qwen, and Gemini each follow with their own provider-specific plan.
