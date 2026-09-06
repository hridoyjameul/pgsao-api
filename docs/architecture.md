# Architecture

```text
                 OpenAI-shaped              Anthropic-shaped
                       │                           │
                       ▼                           ▼
              /v1/chat/completions           /v1/messages
              (routes/openai-compat.ts)  (routes/anthropic-compat.ts)
                       │                           │
                       ▼                           ▼
              translator/openai.ts          translator/anthropic.ts
                       │                           │
                       └─────────────┬─────────────┘
                                     ▼
                   InternalClaudeRequest / InternalClaudeResponse
                              (providers/types.ts)
                                     │
              auth/api-key.ts · concurrency/queue.ts ·
              sessions/session-manager.ts · auth/credential-monitor.ts
                                     │
                                     ▼
                         providers/claude.ts
                    (the only file that touches the
                     Claude Agent SDK's query()/resume)
                                     │
                                     ▼
                                  Claude
```

## Why Anthropic-first

The Claude Adapter's native response shape (`SDKAssistantMessage.message`) is already an Anthropic Messages API `Message` object — `id`, `content` blocks, `stop_reason`, `usage`. The Anthropic translator is close to a direct mapping; the OpenAI translator does the real translation work (stop_reason → finish_reason, response envelope, `[DONE]` sentinel). Built and tested in that order for the same reason.

## The stateless/session split

Real OpenAI and Anthropic APIs are stateless: the caller resends full history every call. The Agent SDK's `query()` isn't a "replay arbitrary history" API — see `spikes/FINDINGS.md`'s "THE major architectural finding" for the empirical proof behind this design:

- **No `session_id`** (default): `providers/claude.ts` flattens the caller's full `messages[]` into one prompt string (or passes a lone user turn through verbatim) and starts a fresh, unresumed `query()` call every time.
- **`session_id` present** (extension, PRD §7.C): `sessions/session-manager.ts` maps it to a real Agent SDK session id (SQLite), and `providers/claude.ts` calls `query()` with an **explicit** `resume: <that id>` — never the SDK's "continue most recent" shortcut, which would leak context between unrelated callers (PRD R7, closed empirically in `spikes/spike-02-resume-isolation.ts` and `tests/session-isolation.test.ts`).

## Isolation from this machine's own Claude Code config

Every `query()` call passes `tools: []` (no Bash/Read/Write/etc. — this is a plain chat/messages gateway until tool-calling ships in a later phase) and `settingSources: []` ("SDK isolation mode" — don't load `~/.claude/settings.json` or project/local `CLAUDE.md`). An HTTP caller should get pure model behavior, not whatever this host's own Claude Code happens to be configured to do.

## Error taxonomy

Six categories throughout (`invalid_request_error`, `rate_limit_error`, `usage_limit_error`, `credential_error`, `provider_error`, plus a 500 fallback), plus a 401 `authentication_error` for the gateway's own API key (distinct from `credential_error`, which is the Claude *account's* auth going stale). `providers/claude.ts` maps the SDK's own `SDKAssistantMessageError` enum and `SDKRateLimitEvent` into these — see `spikes/FINDINGS.md` for the concrete mapping table. Each route's translator renders the SAME `ApiError` into its own native shape: Anthropic requires a top-level `"type":"error"` wrapper, OpenAI does not.

## Testing philosophy

`tests/support/fake-claude-provider.ts` is a deterministic `ClaudeProvider` test double, letting the full HTTP/schema/translator/SSE pipeline be exercised by the **real** `openai` and `@anthropic-ai/sdk` client libraries (proving request/response shape fidelity) without spending real Claude usage on every `npm test` run. The true end-to-end proof against a live account is the manual curl/SDK walkthrough in `README.md`.
