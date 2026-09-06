# n8n Integration

n8n is one client of this gateway, not the design target — it happens to have two ways in.

## 1. Native path (preferred) — "OpenAI Chat Model" node

n8n's built-in AI/LangChain "OpenAI Chat Model" sub-node accepts a custom base URL:

```text
Base URL: http://<gateway-host>:8787/v1
API Key:  <your GATEWAY_API_KEY>
```

This gets Claude into n8n's native AI Agent/Chain nodes with no manual HTTP Request node or response-parsing step. **Caveat**: n8n's AI Agent node may attempt tool/function calls, which this gateway doesn't support yet (rejected with a clear `invalid_request_error`, not a silent failure) — plain chat/completion nodes work today.

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

This closes PRD M7 and §26's n8n acceptance checkbox for host-mode networking. Docker-mode n8n (`host.docker.internal` / shared compose network, per the section above) is documented but not separately live-tested with two containers — same status as the gateway's own `docker compose up`, still pending a live run.
