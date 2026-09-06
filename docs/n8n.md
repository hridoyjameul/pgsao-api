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

The routes and both integration paths above are implemented and covered by the automated test suite (`tests/openai-compat.test.ts`) against a fake Claude backend, and manually smoke-tested against a live account (see `README.md`). A live n8n workflow run against a running gateway instance is a good next manual verification step if you rely on this path heavily — it isn't part of this repo's own automated tests since n8n itself isn't a dependency here.
