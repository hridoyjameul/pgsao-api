# PGSAO API

**P**ersonal **G**ateway for **A**nthropic/**O**penAI **API** — expose your own Claude subscription behind two spec-accurate, drop-in-compatible HTTP surfaces:

```http
POST /v1/chat/completions      (OpenAI Chat Completions shape)
POST /v1/messages              (Anthropic Messages shape)
```

Point any existing OpenAI-SDK or Anthropic-SDK client — or n8n, or a script, or your own tool — at this gateway with just a base URL and an API key change, and it works, unmodified. Runs locally on your machine or on a private cloud server you control.

**Not** a commercial API resale service. This is for your own tools and experimentation, backed by your own Claude subscription's usage allowance. See `PRD_Claude_Personal_API_Gateway_v3.md` for the full design rationale, and `spikes/FINDINGS.md` for the empirical groundwork (concurrency limits, session-isolation proof, error-category mapping) this implementation is built on.

## Quickstart

```bash
git clone <this-repo>
cd pgsao-api
npm install

# Make sure you're logged into Claude Code / the Agent SDK on this machine —
# this gateway uses your existing subscription auth, not a separate API key.
# (Re-check current Agent SDK usage-pool policy: https://support.claude.com/en/articles/15036540)

cp .env.example .env
node -e "console.log('GATEWAY_API_KEY=cg_local_' + require('crypto').randomBytes(24).toString('hex'))"
# paste the printed line into .env

npm run dev        # or: npm run build && npm start
curl http://localhost:8787/health
```

### Test both routes

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"claude-via-gateway","messages":[{"role":"user","content":"Hello."}]}'

curl http://localhost:8787/v1/messages \
  -H "x-api-key: $GATEWAY_API_KEY" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" \
  -d '{"model":"claude-via-gateway","max_tokens":256,"messages":[{"role":"user","content":"Hello."}]}'
```

Or with the real SDKs, pointed at the gateway:

```ts
import OpenAI from 'openai';
const client = new OpenAI({ apiKey: process.env.GATEWAY_API_KEY, baseURL: 'http://localhost:8787/v1' });

import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.GATEWAY_API_KEY, baseURL: 'http://localhost:8787' });
```

## Model names

`model` is resolved against a small allow-list (`GET /v1/models`), not an open passthrough — `claude-via-gateway` uses whatever model your Agent SDK config defaults to; `claude-opus-5`/`claude-sonnet-5`/`claude-haiku-4-5` pin a specific one.

## Sessions (optional extension)

Both real APIs are stateless — resend the full `messages` history every call, which is what an unmodified client does automatically. If you control the caller (e.g. your own n8n workflow), you can add an opaque `session_id` field to skip resending history: the gateway resumes that exact Agent SDK session instead. First use of a `session_id` auto-creates it; `POST/GET/DELETE /v1/sessions` also manage it explicitly.

## Docker / cloud deployment

```bash
docker compose up -d --build
```

The compose file binds the container's port to `127.0.0.1` on the host by default — **never publish a bare `8787:8787`** if you deploy this on a cloud VM; put it behind a reverse proxy/firewall (nginx, Caddy, Tailscale, an SSH tunnel) instead of exposing the port directly to the public internet. It also mounts your `~/.claude` credentials read-only so the containerized Agent SDK authenticates as the same account you're logged into on the host — set `CLAUDE_CONFIG_DIR` in your shell if that lives somewhere non-default (the plain `~/.claude` default has been confirmed to resolve correctly on Windows/Docker Desktop too, no override needed there in practice).

Live-verified (2026-09-06): built and ran the image, confirmed `claude_auth_status: "ok"` from inside the container (credential mount works), called both `/v1/messages` and `/v1/chat/completions` against a live Claude account through the container, confirmed the SQLite volume persists to `./data` on the host, and confirmed the port is reachable only on `127.0.0.1` (`docker port` / `docker inspect`).

## n8n integration

See `docs/n8n.md` — either n8n's native "OpenAI Chat Model" node pointed at `/v1` (preferred), or a generic HTTP Request node against either route. Both host-mode and Docker-mode networking are live-verified.

## Tool/function-calling (Phase 3)

Both routes support `tools` — the model proposes a call (`stop_reason`/`finish_reason` = `tool_use`/`tool_calls`), **your code executes it**, and you report the result back on your next call (same request shape real OpenAI/Anthropic clients already use — no gateway-specific extension). Live-verified end-to-end (2026-09-06) on both routes, streaming and non-streaming.

```bash
# 1. Propose
curl http://localhost:8787/v1/messages -H "x-api-key: $GATEWAY_API_KEY" -H "Content-Type: application/json" -d '{
  "model": "claude-via-gateway", "max_tokens": 200,
  "tools": [{"name":"get_weather","description":"Get current weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],
  "messages": [{"role":"user","content":"What is the weather in Paris?"}]
}'
# -> {"content":[{"type":"tool_use","id":"toolu_...","name":"get_weather","input":{"city":"Paris"}}],"stop_reason":"tool_use",...}

# 2. Continue, with your own tool_result appended
curl http://localhost:8787/v1/messages -H "x-api-key: $GATEWAY_API_KEY" -H "Content-Type: application/json" -d '{
  "model": "claude-via-gateway", "max_tokens": 200,
  "tools": [...same tools...],
  "messages": [
    {"role":"user","content":"What is the weather in Paris?"},
    {"role":"assistant","content":[{"type":"tool_use","id":"toolu_...","name":"get_weather","input":{"city":"Paris"}}]},
    {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_...","content":"Sunny, 22C"}]}
  ]
}'
```

**Known limitations:**
- Tool-augmented turns always use the stateless flatten-and-restart path — the `session_id` extension doesn't mix with tool use yet (see `spikes/FINDINGS.md`'s Phase 3 spike for why: resuming permanently poisons a tool_use_id's resolution once a call is denied).
- `tool_choice` only supports `"auto"` and `"none"` — forcing a specific named tool isn't supported yet (rejected with a clear error, not silently ignored).
- Parallel tool calls (the model calling more than one tool in the same turn) are supported and live-verified — a small (50ms) debounce lets sibling calls in the same turn land before the query is interrupted. See `spikes/FINDINGS.md`'s Phase 3 follow-up spike for the bug this fixed.
- `usage` on a tool-call-stop response is `0`/`0` — the SDK doesn't expose real token counts on the code path that captures a proposed call.
- Tool parameter schemas support the realistic JSON Schema subset tools actually use (object/string/number/integer/boolean/array/enum) — `oneOf`/`anyOf`/`allOf`/`$ref`/conditionals are rejected with a clear error.

## CLI

```bash
npm run cli -- doctor          # end-to-end setup/health check (Node version, auth, config, port, both routes live)
npm run cli -- status          # ping an already-running instance's /health
npm run cli -- start           # same as `npm run dev`/`npm start`, via the CLI
npm run cli -- key generate    # print a new GATEWAY_API_KEY value
```

After `npm run build`, these are also available as `pgsao-api <command>` (the package's `bin` entry — works after `npm link` or a global install). `doctor` makes two small real Claude calls (one per route) as part of its check, so it costs a sliver of usage — that's the point, it's confirming your account actually works end-to-end, not just that the config parses.

## Usage dashboard

```bash
curl http://localhost:8787/v1/usage -H "Authorization: Bearer $GATEWAY_API_KEY"
```

Basic stats split by route — request counts (ok/error), average concurrency-queue wait, error counts by category — pulled from the same audit log every call already writes to (`data/gateway.db`'s `requests` table).

## Known MVP limitations

- **Text-only** — image/vision content blocks are rejected explicitly, not silently dropped.
- Two-model-call cost/token quirk documented in `spikes/FINDINGS.md`: the gateway reports only the main-loop `usage`, not the SDK's internal auxiliary-model overhead.

## Development

```bash
npm test          # Vitest — real openai/@anthropic-ai/sdk clients against a fake, fast, free Claude backend
npm run build      # tsc -> dist/
npm run dev         # tsx watch src/server.ts
```

`npm test` never touches your real Claude account or usage allowance (see `tests/support/fake-claude-provider.ts`). To verify against your live account, run the Quickstart curl/SDK commands above against a running `npm run dev` instance.

## License

MIT.
