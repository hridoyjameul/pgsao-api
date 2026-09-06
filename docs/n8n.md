# n8n Integration

n8n is one client of this gateway, not the design target — it happens to have two ways in.

## 1. Native path (preferred) — "OpenAI Chat Model" node

n8n's built-in AI/LangChain "OpenAI Chat Model" sub-node accepts a custom base URL:

```text
Base URL: http://<gateway-host>:8787/v1
API Key:  <your GATEWAY_API_KEY>
```

This gets Claude into n8n's native AI Agent/Chain nodes with no manual HTTP Request node or response-parsing step, **including the AI Agent node driving real tool use** — live-verified (see Status below): an "AI Agent" node with a "Calculator" tool attached ran a genuine, unscripted multi-turn tool loop — propose, n8n executes the tool locally, continue — through this gateway with zero gateway-specific handling on n8n's side.

## 2. Generic HTTP Request node (fallback, either route)

```text
Method: POST
URL:    http://<gateway-host>:8787/v1/chat/completions   (or /v1/messages)
Headers: Authorization: Bearer <GATEWAY_API_KEY>
```

```json
{
  "model": "claude-via-gateway",
  "messages": [{ "role": "user", "content": "{{$json.prompt}}" }]
}
```

## Networking: n8n in its own container

If n8n runs in Docker and the gateway doesn't (or vice versa), `localhost` won't resolve to the other service. Use `host.docker.internal` (Docker Desktop) or put both on a shared `docker-compose` network and reference the gateway by its service name.

## Status

Live-verified (2026-09-06) against a real n8n instance (`n8n@2.37.10`, CLI-driven: `import:workflow` + `execute --id`) and the real gateway backed by a live Claude account — not just the automated test suite:

- **Generic HTTP Request node → `/v1/chat/completions`**: success, model replied correctly.
- **Generic HTTP Request node → `/v1/messages`**: success, model replied correctly.
- **Native path**: `@n8n/n8n-nodes-langchain.lmChatOpenAi` ("OpenAI Chat Model") feeding a `chainLlm` ("Basic LLM Chain") node, credential type `openAiApi` with its **Base URL** field pointed at `http://<gateway>:8787/v1` — success, token usage tracked by n8n's own tracing metadata (`llm.tokens.in/out`). This exercises LangChain's own OpenAI-compatible client under the hood, a stronger compatibility proof than a raw SDK smoke test.

**AI Agent node with real tool use, also live-verified (2026-09-06):** same OpenAI Chat Model node feeding an `agent` ("AI Agent") node with a `toolCalculator` ("Calculator") tool attached, asked "What is 4837 multiplied by 6521?" — a genuine, unscripted LangChain agent loop:
1. First gateway call → `finish_reason: "tool_calls"` (gateway correctly proposed calling the Calculator).
2. n8n's own AgentExecutor ran the Calculator **locally** (no gateway involvement), got `31542077`.
3. n8n sent that back to the gateway automatically, as a normal follow-up `/v1/chat/completions` call with the tool result appended.
4. Final agent output: `31542077` — the mathematically correct product, proving the real tool result was used, not guessed.

Zero gateway-specific handling on n8n's side — this is exactly what "drop-in compatible" is supposed to mean. Closes PRD M7 and §26's n8n acceptance checkbox for host-mode networking, including tool-calling.

**Docker-mode networking, also live-verified (2026-09-06):** ran the official `n8nio/n8n` image (CLI-driven, same import/execute pattern) attached to the gateway's own `docker compose` network (`pgsaoapi_default`), calling it by service name — `http://gateway:8787/v1/chat/completions` — with no `localhost` or `host.docker.internal` involved. Success, real Claude reply came back correctly. Confirms the shared-compose-network guidance above works as described.
