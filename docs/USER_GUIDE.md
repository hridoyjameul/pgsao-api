# PGSAO API — User Guide

A plain-English guide for **non-developers**. No terminal commands to memorize, no config files to edit by hand.

**What this is:** PGSAO API turns your own Claude subscription into a private API key you can paste into other apps (n8n, chatbots, scripts, etc.) instead of paying for a separate API.

**GitHub repo:** https://github.com/hridoyjameul/pgsao-api

## How it works — 3 steps

1. **You install the app.** (Windows: double-click `start.bat`. Nothing else to configure.)
2. **The app finds your Claude subscription automatically**, using the same login your Claude Code app already has on this computer.
3. **The app shows you your API key on its dashboard**, already created for you — copy it into whatever other app you're connecting.

That's the whole idea. Everything below is just the detail behind those 3 steps, plus how to use the key once you have it.

---

## 1. Before you start

You need:

- **Node.js** (version 22.5.0 or newer) installed on this computer.
- **Claude Code already installed and logged in** on this same computer — PGSAO API rides on that login; you never need a separate Anthropic API key.

That's it. You do **not** need to know Git, npm, or how to edit config files — the app handles all of that for you.

---

## 2. Install and start the app

**On Windows:** open the project folder and double-click **`start.bat`**.

- The first time, a black window will briefly appear and install some files — this only happens once and can take a minute or two.
- After that, a second window opens (that's the app running — leave it open), and your browser opens automatically to the dashboard.

**On Mac/Linux, or if you prefer a terminal:**

```bash
git clone https://github.com/hridoyjameul/pgsao-api.git
cd pgsao-api
npm install
npm run dev
```

Then open **http://localhost:8787/dashboard** in your browser.

There is nothing to configure before this step — the app creates its own settings file and its own API key automatically the first time it runs.

---

## 3. The dashboard — everything happens here

Open **http://localhost:8787/dashboard**. You'll see three setup steps at the top:

1. **App installed and running** — a checkmark. If you can see this page, this is already done.
2. **Claude account** — shows "Connected ✓" once the app has confirmed it can use your Claude login. If it says "Not connected," make sure you're logged into Claude Code on this computer, then reload the page.
3. **Your API key** — already filled in for you. Click **show** to reveal it, and **copy** to copy it to your clipboard.

Below that, a **"Use it in another app"** box gives you the two things any other app will ask for:

- A **Base URL** (there are two — use whichever the other app expects; most modern tools want the OpenAI one)
- Your **API key** (same one as above)

Just paste those two values into the other app's settings. That's the entire integration.

---

## 4. Using your key in another app (e.g., n8n)

Most tools that let you "bring your own API key" ask for exactly two things:

| Field the other app asks for | What to paste |
|---|---|
| Base URL / Endpoint (OpenAI-style) | `http://localhost:8787/v1` |
| Base URL / Endpoint (Anthropic/Claude-style) | `http://localhost:8787` |
| API key | The key shown on your dashboard |

For **n8n** specifically: use its built-in **"OpenAI Chat Model"** node, and enter the Base URL and key above as its credential. See `docs/n8n.md` in this repo for a more detailed walkthrough if needed.

---

## 5. Troubleshooting

| Problem | Fix |
|---|---|
| Dashboard's "Claude account" step says "Not connected" | Open Claude Code on this computer and make sure you're logged in, then reload the dashboard page. On Windows, if you're running via Docker, this is expected — see the Docker note in section 7 and use `start.bat` instead. |
| Dashboard shows "could not fetch [key] automatically" | Restart the app (close both windows, double-click `start.bat` again). |
| `start.bat` window closes immediately or shows an error | Make sure Node.js is installed. Re-run `start.bat` and read the message in the window before it closes. |
| Browser shows "can't connect" right after starting | The app takes a few seconds to start — wait a moment and reload `http://localhost:8787/dashboard`. |
| A different app can't reach the gateway | Make sure the app is still running (its window should still be open) and that you copied the Base URL and key exactly, with no extra spaces. |

If none of these help, open an issue on GitHub (see below) — include what the dashboard shows and any error text.

---

## 6. Starting a fresh key (if you ever need to)

Your key is stored in a file named `.env` in the project folder. To generate a brand-new one:

1. Close the app.
2. Open `.env` in Notepad, delete everything after `GATEWAY_API_KEY=` on that line (leave `GATEWAY_API_KEY=` itself), and save.
3. Start the app again (`start.bat`, or `npm run dev`) — it will notice the key is missing and create a new one automatically.
4. Reload the dashboard — it will pick up the new key on its own. Update the key in any other app you'd connected it to.

---

## 7. Uninstalling

PGSAO API doesn't install anything outside its own project folder — no Windows service, no registry entries, nothing added to your system PATH. To remove it:

1. Close the app (close both windows if they're still open).
2. Delete the project folder.

That's it. Your API key, settings, and any local usage data live only inside that folder (in `.env` and the `data/` subfolder), so deleting it removes everything. If you're running it via Docker instead, also run `docker stop pgsao-api && docker rm pgsao-api` first to remove the container, and `docker rmi pgsao-api` if you want the image gone too.

---

## 8. Advanced options (safe to ignore)

The dashboard has an "Advanced (for developers)" section at the bottom with usage stats, session management, and ready-to-copy `curl`/SDK code snippets. None of this is required for normal use — it's there if you (or someone helping you) ever wants to script against the gateway directly instead of using another app's built-in settings screen.

If you're comfortable with Docker, `docker compose up -d --build` runs the whole app in a container instead — see `README.md` for details.

**Windows + Docker known limitation:** on Windows, Claude Code stores your login in Windows Credential Manager, not a file — Docker containers can't reach that. Running via Docker on Windows will show "Not connected" for the Claude account even when you're logged in. Use `start.bat` (native, no Docker) on Windows instead; Docker works fine for the Claude login on Mac/Linux, where it's stored in a file under `~/.claude`.

---

## 9. GitHub — getting updates, reporting problems

- **Repository:** https://github.com/hridoyjameul/pgsao-api
- **Get the latest version:** in the project folder, run `git pull`, then run `start.bat` (or `npm install`) again in case anything changed.
- **Report a bug or ask a question:** https://github.com/hridoyjameul/pgsao-api/issues
- **License:** MIT (see `LICENSE` in the repo) — free to use, modify, and self-host.

---

## 10. Other documents in this repo (for developers)

- `README.md` — technical quickstart and overview
- `docs/api.md` — full API reference
- `docs/architecture.md` — how the gateway is built internally
- `docs/n8n.md` — detailed n8n integration guide
