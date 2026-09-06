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

The compose file binds the container's port to `127.0.0.1` on the host by default — **never publish a bare `8787:8787`** if you deploy this on a cloud VM; put it behind a reverse proxy/firewall (nginx, Caddy, Tailscale, an SSH tunnel) instead of exposing the port directly to the public internet. It also mounts your `~/.claude` credentials read-only so the containerized Agent SDK authenticates as the same account you're logged into on the host — set `CLAUDE_CONFIG_DIR` in your shell if that lives somewhere non-default.

## n8n integration

See `docs/n8n.md` — either n8n's native "OpenAI Chat Model" node pointed at `/v1` (preferred), or a generic HTTP Request node against either route.

## Known MVP limitations

- **No tool/function-calling yet** on either route (`tools`/`tool_choice`/`functions`/`function_call` are rejected explicitly with a clear error, not silently dropped) — deferred to a later phase.
- **Text-only** — image/vision content blocks are rejected the same way.
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
