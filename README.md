# PGSAO API

**P**ersonal **G**ateway for **A**nthropic/**O**penAI **API** — a local, MIT-licensed gateway for your own AI accounts. Claude and ChatGPT have separate working routes. Gemini, Kimi, and Qwen retain status cards while their adapters are built.

```http
POST /v1/chat/completions      (OpenAI Chat Completions shape)
POST /v1/messages              (Anthropic Messages shape)
POST /claude/v1/chat/completions (Claude's provider-specific OpenAI shape)
POST /claude/v1/messages         (Claude's provider-specific Anthropic shape)
POST /chatgpt/v1/responses       (ChatGPT plan Responses SSE, text only)
GET  /chatgpt/v1/models          (selected ChatGPT account's visible models)
```

Claude's compatibility routes work with existing OpenAI Chat Completions and Anthropic Messages clients by changing the base URL and API key. ChatGPT has a separate Responses API stream route with a narrower text-only contract. Runs locally on your machine or on a private cloud server you control.

**Not** a commercial API resale service. This is for your own tools and experimentation, backed by your own Claude subscription's usage allowance. See `PRD_Claude_Personal_API_Gateway_v3.md` for the full design rationale, and `spikes/FINDINGS.md` for the empirical groundwork (concurrency limits, session-isolation proof, error-category mapping) this implementation is built on.

## Quickstart

Not a developer? See `docs/USER_GUIDE.md` for a plain-English, no-terminal-knowledge-needed walkthrough. The short version:

```bash
git clone https://github.com/hridoyjameul/pgsao-api.git
cd pgsao-api
npm install
npm run dev
curl http://localhost:8787/health
```

Make sure you're logged into Claude Code / the Agent SDK on this machine first — this gateway uses your existing subscription auth, not a separate API key. (Re-check current Agent SDK usage-pool policy: https://support.claude.com/en/articles/15036540). `npm run dev` can be swapped for `npm run build && npm start` if you'd rather run the built output.

On Windows, double-clicking `start.bat` does the `npm install` + `npm run dev` + opening the dashboard for you — no terminal required at all.

There's no manual config step: on first run, the app creates its own `.env` (from `.env.example`) and generates its own `GATEWAY_API_KEY` automatically if one isn't already set. (You can still set either by hand first if you want to pin specific values — the auto-setup only fills in what's missing.)

Then open **http://localhost:8787/dashboard** — a web control panel for provider status, usage, Start/Stop, session management, and ready-to-copy URLs. It fetches your auto-generated `GATEWAY_API_KEY` on first load (from this machine only) and keeps that gateway key in the browser's localStorage. Provider credentials are never stored there. Select **Continue with ChatGPT** on its card to authorize that provider separately.

### Test both routes

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"claude-via-gateway","messages":[{"role":"user","content":"Hello."}]}'

# Same Claude handler under its provider prefix:
curl http://localhost:8787/claude/v1/chat/completions \
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
// Claude-specific baseURL: http://localhost:8787/claude/v1

import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.GATEWAY_API_KEY, baseURL: 'http://localhost:8787' });
// Claude-specific baseURL: http://localhost:8787/claude
```

## Model names

`model` is resolved against a small allow-list (`GET /v1/models` or `/claude/v1/models`), not an open passthrough — `claude-via-gateway` uses whatever model your Agent SDK config defaults to; `claude-opus-5`/`claude-sonnet-5`/`claude-haiku-4-5` pin a specific one.

## Provider dashboard and Start/Stop

The dashboard always shows Claude, ChatGPT, Gemini, Kimi, and Qwen. Its three states are separate: **client detected** means a known CLI is on PATH (or no CLI is required), **account connected** means this gateway has a usable connection, and **Gateway API ready** means an implemented inference route is available. Claude is ready with a working Claude login; ChatGPT becomes ready after its own sign-in. Gemini, Kimi, and Qwen remain “Coming soon.” Installing a CLI alone does not make an API route ready.

One local `GATEWAY_API_KEY` authenticates every implemented gateway route. It is separate from each provider's login or vendor key. Stop pauses admission of new inference requests; existing streams can finish, and the dashboard, health, model, status, usage, and control routes remain available. The control is process-local and starts enabled after restart. The same controls are available through authenticated `GET` and `POST /v1/control/serving` (`{ "enabled": false }` or `true`). Provider states are available at authenticated `GET /v1/providers`.

ChatGPT uses the [open-source Sign in with ChatGPT plan-use flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). It gives this gateway an issued client ID and account tokens; it does not reveal a ChatGPT subscription's API key. The one gateway key authenticates `/chatgpt/v1` locally. This preview route accepts only `model`, full text `input` items with `user`, `assistant`, or `developer` roles, optional `instructions`, and exact `store:false`, `stream:true`. Tools, images, system-role items, and `previous_response_id` are rejected. Use `GET /chatgpt/v1/models` for the selected account's visible model slugs. ChatGPT plan limits are shared with other apps using that plan; the gateway does not create a separate allowance. See [OpenAI's model and inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

```bash
curl -N http://localhost:8787/chatgpt/v1/responses \
  -H "Authorization: Bearer $GATEWAY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"MODEL_SLUG_FROM_CATALOG","input":[{"role":"user","content":"Hello."}],"store":false,"stream":true}'
```

The next adapter stages add Kimi Code, Qwen Coding Plan, and Gemini CLI routes under their own prefixes.

## Sessions (optional extension)

Claude's two compatibility routes are stateless by default — resend the full `messages` history every call, which is what an unmodified client does automatically. If you control the caller (e.g. your own n8n workflow), you can add an opaque `session_id` field to skip resending history: the gateway resumes that exact Agent SDK session instead. First use of a `session_id` auto-creates it; `POST/GET/DELETE /v1/sessions` also manage it explicitly. ChatGPT requires the full `input` array every call and does not use this Claude session extension.

## Docker / cloud deployment

On Windows, double-click `docker-start.bat` (stop with `docker-stop.bat`) — it builds the image and runs it with plain `docker run`, so it shows up as a single flat container in Docker Desktop instead of a collapsed compose stack. Otherwise:

```bash
docker compose up -d --build
```

Both produce the same container (same `Dockerfile`, port, env, volumes) — `docker compose` is still what you want if you're networking this alongside other Docker containers on a shared compose network (see the n8n Docker-mode section below).

Docker stores ChatGPT credentials in a protected named volume at `/app/chatgpt`, separate from the project bind mount. Native Windows storage defaults to `%LOCALAPPDATA%\PGSAO API\chatgpt.json`; Mac/Linux defaults to `~/.config/pgsao-api/chatgpt.json` (or `$XDG_CONFIG_HOME`). `CHATGPT_CREDENTIALS_PATH` overrides the path. The local callback is `http://127.0.0.1:8787/auth/callback`. On a remote VM, follow [OpenAI's self-hosted VM guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) to authorize through a local loopback tunnel and transfer protected credentials; a browser on your laptop cannot reach a remote machine's loopback directly.

If you already created the plain `docker-start.bat` container before ChatGPT support, stop and remove that old container before running the updated script so Docker applies the new credential volume. Its SQLite data remains in `./data`.

The port is bound to `127.0.0.1` on the host by default — **never publish a bare `8787:8787`** if you deploy this on a cloud VM; put it behind a reverse proxy/firewall (nginx, Caddy, Tailscale, an SSH tunnel) instead of exposing the port directly to the public internet. It also mounts your `~/.claude` credentials read-only so the containerized Agent SDK authenticates as the same account you're logged into on the host — set `CLAUDE_CONFIG_DIR` in your shell if that lives somewhere non-default (the plain `~/.claude` default has been confirmed to resolve correctly on Windows/Docker Desktop too, no override needed there in practice).

Live-verified (2026-09-06): built and ran the image, confirmed `claude_auth_status: "ok"` from inside the container (credential mount works), called both `/v1/messages` and `/v1/chat/completions` against a live Claude account through the container, confirmed the SQLite volume persists to `./data` on the host, and confirmed the port is reachable only on `127.0.0.1` (`docker port` / `docker inspect`).

## n8n integration

See `docs/n8n.md` — either n8n's native "OpenAI Chat Model" node pointed at `/v1` (preferred), or a generic HTTP Request node against either route. Both host-mode and Docker-mode networking are live-verified, **including the AI Agent node driving real tool use** (a genuine, unscripted propose → n8n-executes-locally → continue loop through this gateway — see `docs/n8n.md`'s Status section).

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

Basic stats split by provider and by route — request counts (ok/error), average concurrency-queue wait, error counts by category — pulled from the same audit log every call already writes to (`data/gateway.db`'s `requests` table). Existing request rows migrate to provider `claude`.

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
