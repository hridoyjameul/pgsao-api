# PGSAO API — User Guide

A plain-English, step-by-step guide to installing, running, and using PGSAO API — no AI assistant needed.

**What this is:** PGSAO API turns your own Claude subscription (via Claude Code / Agent SDK login) into a private HTTP API server on your computer. Any tool that speaks the OpenAI or Anthropic API format (n8n, scripts, SDKs, etc.) can point at it instead of paying for a separate API key.

**GitHub repo:** https://github.com/hridoyjameul/pgsao-api

---

## 1. Requirements

Before you start, make sure you have:

- **Node.js version 22.5.0 or newer** — check with `node -v` in a terminal.
- **Git** — check with `git -v`.
- **Claude Code (or another Agent SDK tool) already installed and logged in** on this machine. PGSAO API uses that existing login — it does NOT need a separate Anthropic API key.
- (Optional) **Docker Desktop** — only needed if you want to run this in a container instead of directly with Node.

---

## 2. Download the project

Open a terminal and run:

```bash
git clone https://github.com/hridoyjameul/pgsao-api.git
cd pgsao-api
npm install
```

This downloads the code and installs its dependencies.

---

## 3. Set up your configuration file

The project needs a `.env` file with your settings and a secret key.

**Step 1** — Copy the example file:

```bash
cp .env.example .env
```

(On Windows PowerShell, use `Copy-Item .env.example .env` instead.)

**Step 2** — Generate a secret API key (this is the password your own tools will use to talk to the gateway — not your Anthropic account password):

```bash
node -e "console.log('GATEWAY_API_KEY=cg_local_' + require('crypto').randomBytes(24).toString('hex'))"
```

This prints a line like:

```
GATEWAY_API_KEY=cg_local_a1b2c3...
```

**Step 3** — Open the `.env` file in any text editor, find the empty `GATEWAY_API_KEY=` line, and paste in the value you just generated (the whole line, including `GATEWAY_API_KEY=`).

**Step 4** — Save the file. Leave every other setting in `.env` at its default unless you have a specific reason to change it (each setting has a comment explaining what it does).

---

## 4. Start the server

Run one of these:

```bash
npm run dev        # for everyday/development use, auto-reloads on code changes
```

or

```bash
npm run build && npm start   # for a production-style run
```

You should see log output saying the server is listening. Leave this terminal window open — closing it stops the server.

**Check it's alive** — open a new terminal (or your browser) and visit:

```
http://localhost:8787/health
```

You should get a small JSON response back, not an error page.

---

## 5. Use the web dashboard (recommended — no terminal needed after this)

Open your browser and go to:

```
http://localhost:8787/dashboard
```

On first visit, paste in the `GATEWAY_API_KEY` value from your `.env` file when asked. The dashboard remembers it in your browser only (it is never sent anywhere else).

From the dashboard you can:

- See live server status and health
- View usage statistics (how many requests, by route)
- Create, view, and delete **sessions** (see section 7)
- Copy ready-to-use `curl` and SDK code snippets for your own tools

This is the easiest way to use PGSAO API day-to-day — you do not need to write any curl commands yourself if you don't want to.

---

## 6. Point your own tools at the gateway

Any tool that can call an OpenAI-compatible or Anthropic-compatible API can use PGSAO API by changing two things: the **base URL** and the **API key**.

### OpenAI-style tools / SDKs

- Base URL: `http://localhost:8787/v1`
- API key: your `GATEWAY_API_KEY`

Example (Node.js, `openai` package):

```ts
import OpenAI from 'openai';
const client = new OpenAI({
  apiKey: process.env.GATEWAY_API_KEY,
  baseURL: 'http://localhost:8787/v1',
});
```

### Anthropic-style tools / SDKs

- Base URL: `http://localhost:8787`
- API key: your `GATEWAY_API_KEY`

Example (Node.js, `@anthropic-ai/sdk` package):

```ts
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({
  apiKey: process.env.GATEWAY_API_KEY,
  baseURL: 'http://localhost:8787',
});
```

### Testing with curl directly

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-via-gateway","messages":[{"role":"user","content":"Hello."}]}'
```

```bash
curl http://localhost:8787/v1/messages \
  -H "x-api-key: YOUR_GATEWAY_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-via-gateway","max_tokens":256,"messages":[{"role":"user","content":"Hello."}]}'
```

### Choosing a model

Use `model: "claude-via-gateway"` to use whichever model your Claude Code login defaults to, or pin a specific one: `claude-opus-5`, `claude-sonnet-5`, or `claude-haiku-4-5`. The full allowed list is available at `GET /v1/models`.

---

## 7. Sessions (optional — skip this unless you need it)

By default, every request is stateless: you resend the full conversation history each time, exactly like the real OpenAI/Anthropic APIs work. Most SDKs do this automatically, so you usually don't need to think about it.

If you control the calling code (e.g., your own n8n workflow) and want to avoid resending history, you can add a `session_id` field to your request body. The first time you use a given `session_id`, it's created automatically; after that, the gateway remembers the conversation for you. You can also manage sessions explicitly:

- `POST /v1/sessions` — create a session
- `GET /v1/sessions` — list sessions
- `DELETE /v1/sessions/:id` — delete a session

All of this is also available through the dashboard's Sessions panel.

**Note:** sessions and tool/function-calling (section 8) don't currently work together in the same request — this is a known limitation, not a bug.

---

## 8. Using with n8n

See `docs/n8n.md` in this repo for full details. In short: use n8n's built-in **"OpenAI Chat Model"** node and point its Base URL at `http://localhost:8787/v1` with your `GATEWAY_API_KEY` as the credential — this is the easiest path and works with n8n's AI Agent node and tool use out of the box. A generic HTTP Request node against either route also works if you prefer.

---

## 9. Tool / function calling

Both routes support the standard `tools` parameter (same shape real OpenAI/Anthropic clients use):

1. You send a request with a `tools` list describing functions the model can call.
2. If the model wants to use one, the response comes back with a `tool_use` (Anthropic) or `tool_calls` (OpenAI) result instead of plain text.
3. **Your code** runs that function/tool.
4. You send a follow-up request including the tool's result, and the model continues.

See the "Tool/function-calling" section of the main `README.md` for full copy-paste curl examples.

---

## 10. Command-line tool

Once installed, PGSAO API also ships a CLI. Use `npm run cli -- <command>` during local development, or `pgsao-api <command>` if installed globally.

| Command | What it does |
|---|---|
| `pgsao-api start` | Start the server |
| `pgsao-api status` | Check whether the server is running and healthy |
| `pgsao-api doctor` | Run a full self-check (build + test both routes) without needing the server already running |
| `pgsao-api key generate` | Generate a new `GATEWAY_API_KEY` value |

**Rotating your key:** run `pgsao-api key generate`, copy the new value into `.env` in place of the old one, then restart the server (`npm run dev` / `npm start`). The old key stops working immediately.

---

## 11. Running with Docker (optional)

If you'd rather run this in a container:

```bash
docker compose up -d --build
```

This builds the image, starts the container, and binds it to `127.0.0.1` only on your machine by default — it is **not** exposed to the internet. It automatically uses your existing `~/.claude` login (mounted read-only) so it authenticates as the same account you're logged into on your host machine.

**If you deploy this on a cloud server:** never expose the raw port (`8787`) directly to the public internet. Put it behind a reverse proxy or tunnel you control (nginx, Caddy, Tailscale, or an SSH tunnel) instead.

To check it's healthy:

```bash
docker ps
```

You should see a "healthy" status next to the container.

---

## 12. Troubleshooting

| Problem | Fix |
|---|---|
| Server crashes immediately on start, mentions `GATEWAY_API_KEY` | Your `.env` file is missing or the key wasn't pasted in. Redo section 3. |
| `/health` or dashboard shows an auth/credential error | Your Claude Code / Agent SDK login has expired. Log in again on this machine, then restart the server. |
| Dashboard can't reach the server / blank data | Make sure the server is actually running (check the terminal window from section 4), and that you're visiting the dashboard using the same host/URL the server is bound to. |
| A tool call request seems to silently drop one of two tool calls | Update to the latest code — this was a known bug that has been fixed (parallel tool calls). |
| Sessions + tool calling together behave oddly | Not supported yet — use one or the other per request, not both. |

If none of these fix it, check `spikes/FINDINGS.md` and `docs/architecture.md` in the repo for deeper technical detail, or open an issue on GitHub (see below).

---

## 13. GitHub — getting updates, reporting problems

- **Repository:** https://github.com/hridoyjameul/pgsao-api
- **Get the latest version:** inside your project folder, run `git pull` then `npm install` again (in case dependencies changed).
- **Report a bug or ask a question:** open an issue at https://github.com/hridoyjameul/pgsao-api/issues
- **License:** MIT (see `LICENSE` in the repo) — free to use, modify, and self-host.

---

## 14. Other documents in this repo

- `README.md` — quickstart and technical overview
- `docs/api.md` — full API reference
- `docs/architecture.md` — how the gateway is built internally
- `docs/n8n.md` — detailed n8n integration guide
- `PRD_Claude_Personal_API_Gateway_v3.md` — original design document
- `spikes/FINDINGS.md` — empirical test results the design is based on
