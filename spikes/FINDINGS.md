# Phase 0 Feasibility Findings

Recorded from live runs of `spike-01` through `spike-03` and `spike-05` against a real Claude account, plus static inspection of the installed `@anthropic-ai/claude-agent-sdk` type declarations. These are the answers Phase 1's `config/config.ts`, `providers/claude.ts`, `translator/*.ts`, and `auth/credential-monitor.ts` must be built from — not re-guessed from the PRD's placeholder values.

## Confirmed package versions (pin these, don't re-resolve)

- `@anthropic-ai/claude-agent-sdk@0.3.263` (real runtime dependency)
- `@anthropic-ai/sdk@0.124.0` (devDependency only — types reference, never called at runtime)
- `openai@7.10.0` (devDependency only — types reference, never called at runtime)
- Peer deps auto-installed by npm: `zod@^4` (matches PRD's chosen validation library), `@modelcontextprotocol/sdk@^1.29`
- Node `v24.13.0` used for spikes; `package.json` sets `engines.node >= 20`

## R7 — explicit resume(sessionId) isolation: CLOSED

`spike-02` proved zero cross-contamination both sequentially and under concurrent `Promise.all`. Two sessions seeded with different secret words (`PELICAN` / `TROMBONE`) each correctly recalled only their own secret in every combination. `providers/claude.ts` must have exactly one call site that sets `Options.resume`, always given an explicit session id captured from that session's own `SDKSystemMessage.session_id` (the `init` system message) — never `Options.continue` (which is documented as mutually exclusive with `resume` and is the exact "continue most recent" shortcut PRD flags as unsafe).

## R6 — concurrency ceiling: EMPIRICAL DEFAULT

`spike-03` ran N=1,2,3,4,6 concurrent `query()` calls with zero built-in tools. **All succeeded with no errors up to N=6** on this account. Latency degraded but did not fail:

| N | avg ms | max ms |
|---|---|---|
| 1 | 2826 | 2826 |
| 2 | 2892 | 2977 |
| 3 | 3133 | 3617 |
| 4 | 4014 | 6718 |
| 6 | 4102 | 5574 |

**Recommended default: `MAX_CONCURRENT_REQUESTS=3`** (up from PRD's placeholder `2`) — the jump from N=3→4 nearly doubles average latency and pushes max latency toward `REQUEST_TIMEOUT_MS` territory on a slow turn, so 3 is the practical ceiling before user-visible latency degrades, even though no hard errors appeared until higher N. Users on their own machine/account can raise this in `.env`; keep the shipped default conservative per R2 (shared usage pool with interactive use).

## Open question #2 — SDK-level throttling distinguishable from account usage limits: YES, first-class

No throttling errors were observed at N≤6, but the SDK emits a dedicated `SDKRateLimitEvent` (`type: 'rate_limit_event'`) on every turn, carrying:

```ts
rate_limit_info: {
  status: 'allowed' | 'allowed_warning' | 'rejected',
  resetsAt?: number,
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage',
  utilization?: number,
  overageStatus?, overageResetsAt?, overageDisabledReason?, isUsingOverage?, overageInUse?, ...
}
```

**Design implication for `providers/claude.ts`**: watch for `rate_limit_event` messages during every `query()` iteration, cache the latest `rate_limit_info`, and when `status === 'rejected'` fail subsequent requests fast with `usage_limit_error` (using `resetsAt` to populate a retry-after hint) instead of making a doomed call. This is a real, typed signal — no need for a third ad-hoc error category as the PRD worried; it slots directly into the existing `usage_limit_error` category.

## Six-category error mapping (concrete, from SDK types)

`providers/claude.ts` should map `SDKAssistantMessage.error` / `SDKResultError.subtype` / `SDKRateLimitEvent` to the gateway's six categories like this:

| SDK signal | Gateway category |
|---|---|
| `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold` (`SDKAssistantMessageError`) | `credential_error` |
| `rate_limit_info.status === 'rejected'` (`SDKRateLimitEvent`), `billing_error` | `usage_limit_error` |
| gateway's own concurrency queue full (§6.6, not an SDK signal) | `rate_limit_error` |
| `overloaded`, `server_error` (`SDKAssistantMessageError`); `error_during_execution` (`SDKResultError.subtype`) | `provider_error` |
| `invalid_request`, `model_not_found` (`SDKAssistantMessageError`) | `invalid_request_error` |
| `unknown`, `max_output_tokens`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries` | unexpected → `500` (or finish_reason mapping for `max_output_tokens`, which is a normal stop condition, not strictly an error) |

## Credential status: `accountInfo()` works in plain-string mode (not streaming-only)

The SDK doc comment groups `accountInfo()` under "control requests... only supported when streaming input/output is used," but `spike-01`/`spike-04` confirmed it works on a plain-string `query()` too. Returns (from the real account used in these spikes):

```json
{ "email": "velosend11@gmail.com", "organization": "...", "subscriptionType": "Claude API", "apiProvider": "firstParty" }
```

`auth/credential-monitor.ts`'s `checkCredentials()` should call `query({prompt: 'ping-equivalent', options: ISOLATED_OPTIONS}).accountInfo()` and treat a thrown error as `credential_error`.

**Invalid-credential case — CONFIRMED, without touching the real login**: `spike-04` points the SDK subprocess at an empty, freshly-created `CLAUDE_CONFIG_DIR` via `Options.env` (spreading `process.env`, overriding `CLAUDE_CONFIG_DIR` to a throwaway temp dir, unsetting `ANTHROPIC_API_KEY`) — this makes the subprocess find no credentials without ever touching `~/.claude`. Result: fails in **1117ms** with `Claude Code returned an error result: Not logged in · Please run /login` — fast, distinguishable, no hang. `credential-monitor.ts` should pattern-match `/not logged in/i` (or check for a thrown error at all, since `accountInfo()` on valid credentials never throws) and map to `credential_error` / 503.

## Token usage IS reported — PRD's "known limitation" caveat does not apply

`SDKResultSuccess.usage` (`NonNullableUsage`, "MAIN AGENT LOOP ONLY") gives real `input_tokens`/`output_tokens` and should populate §8's `usage` fields on both routes directly — no fabrication needed.

**Gotcha**: `SDKResultSuccess.modelUsage` includes a *second*, smaller `claude-haiku-4-5-*` entry on every single-turn call in these spikes (e.g. ~900 input / ~10-13 output tokens) alongside the main `claude-sonnet-5` entry — an internal SDK-side auxiliary call (prompt-suggestion/classification machinery), not part of the user-visible response. **Use `result.usage` (main-loop only), never sum `modelUsage`,** when populating the gateway's response `usage` field, or reported token counts will be inflated and won't match what the caller's own history/cost tracking expects.

## THE major architectural finding: how to replay stateless multi-turn history into a fresh query()

This was an open design question the original plan didn't fully resolve: `query()`'s `prompt` is either a single string or an `AsyncIterable<SDKUserMessage>` — neither is a natural "replay this full OpenAI/Anthropic-style `messages[]` array (including prior assistant turns) as one stateless call" API. `spike-01` tested three approaches empirically:

1. **Flatten full history into one prompt string** (system → `Options.systemPrompt`, prior turns → `"User: ...\nAssistant: ...\nUser: ..."` text passed as the single `prompt` string): **WORKS CORRECTLY.** Recalled "teal" from prior turns with `stop_reason: 'end_turn'` after exactly one turn. **This is the technique to use in the stateless (no `session_id`) default path.**
2. **Streaming input, user-role turns only** (skip replaying assistant turns, yield only `SDKUserMessage` user entries): technically "worked" but only because streaming-input mode keeps a **real, persistent session across yields** — each yielded user message becomes its own sequential turn in the *same* session, so it behaves like a live multi-turn conversation, not a single stateless replay. Confirms streaming-input mode is unsuitable for the "one HTTP request in, one response out" stateless contract the gateway needs — it's built for a genuinely long-lived streaming client, not request replay.
3. **Streaming input, mixed user+assistant roles** (attempt to inject a `role: 'assistant'` entry into the user-message stream to replay prior assistant turns verbatim): **REJECTED by the CLI bridge** — `Error: Expected message role 'user', got 'assistant'`. Confirms `SDKUserMessage` is strictly user-role-only; there is no structured way to replay arbitrary prior assistant turns via streaming input.

**Conclusion, binding for `providers/claude.ts` (not the translators — keep this Agent-SDK-specific transform in one place beneath the Format Translator, per PRD §4's shape-agnostic boundary):**

- **Stateless path (no `session_id`)**: flatten the full incoming `messages[]` (mapping `system`/system-role → `Options.systemPrompt`, remaining turns → a formatted `"Role: content"` transcript string) into a single `prompt` string, single non-streaming `query()` call.
- **Extension path (`session_id` present, resume)**: since `resume()` already loads the session's own transcript from disk, do **not** re-flatten and resend the whole history — pass only the new trailing user message(s) since the last call as the `prompt` string. Re-sending full history on every resumed call would duplicate context turn over turn.

## Policy re-confirmation (§1.4 action item, open question #3): CLOSED, unchanged

Fetched `support.claude.com`'s Agent SDK usage-policy article live (2026-09-06): as of the June 15, 2026 pause, Agent SDK/`claude -p`/third-party-app usage still draws from the subscription's normal plan usage limits — **no separate credit pool exists**. Matches PRD §1.4's assumption exactly; no design change needed. Re-check this article again before a public Phase 1 release in case Anthropic ships the "better support" update they say is pending.

## Phase 0 exit criteria — all six closed

1. Single request works reliably — `spike-01` part 1a. ✓
2. Explicit `resume(sessionId)` isolates two concurrent sessions (R7) — `spike-02`. ✓
3. Concurrency ceiling tested (R6) — `spike-03`, default set to `MAX_CONCURRENT_REQUESTS=3`. ✓
4. Credential-expiry detectable, not assumed — `spike-04` (safe empty-config-dir probe, real login untouched). ✓
5. Round-trip proof via real `openai` + real `@anthropic-ai/sdk` packages against a minimal translator — `spike-05`. ✓
6. Usage-pool policy reconfirmed against support.claude.com — done live, 2026-09-06, unchanged. ✓

Phase 1 may proceed.
