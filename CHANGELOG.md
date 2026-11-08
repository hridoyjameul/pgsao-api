# Changelog

Versions follow [Semantic Versioning](https://semver.org/). While on 0.x, a new feature bumps the middle number and a fix bumps the last one. Each release is tagged `vX.Y.Z`.

## [0.2.0] - 2026-11-08

### Added
- **Sign in with Claude** in the dashboard: add another Claude account entirely in the browser. claude.ai opens in a new tab; paste the code it shows back into the dashboard. No terminal needed, and it works in Docker too. Behind the scenes the gateway runs the official `claude auth login` into a private folder that is deleted again when the account is removed.
- Token and folder options moved under "Other ways to add an account".

### Fixed
- Starting a sign-in no longer leaves the private credentials folder with default permissions.

## [0.1.1] - 2026-11-08

### Fixed
- Dashboard stuck on "Could not load providers" after ChatGPT sign-in. OpenAI returns to `127.0.0.1`, which keeps its own saved key separate from `localhost`; an outdated key there failed every request. The dashboard now replaces a rejected saved key with the current one, and sign-in returns to the address it started from.
- A failed or cancelled ChatGPT sign-in now explains why, including OpenAI's "A required permission is unavailable" (that plan cannot be shared with apps).

## [0.1.0] - 2026-11-08

Multiple accounts and multiple API keys per provider. This release also covers everything committed since 0.0.2 that was never versioned.

### Added
- Accounts card for Claude, ChatGPT and Kimi: see which account is connected, switch accounts, and remove them. The active account shows on each provider tile.
- Extra Claude accounts, added from a `claude setup-token` token or a separate `CLAUDE_CONFIG_DIR` folder. Each account's login is checked on its own.
- Several named Kimi membership keys.
- Any number of gateway API keys per provider. Each key can be pinned to one account, one model, and one effort or thinking level (Claude effort/thinking, ChatGPT reasoning effort, Kimi thinking).
- ChatGPT Responses requests accept `reasoning`.
- Kimi Code provider using a paid membership API key (OpenAI and Anthropic request shapes).
- ChatGPT provider using a paid ChatGPT subscription through local OAuth, with a Responses route, model list, plan type and usage-limit status.
- Multi-provider foundation: provider registry, `/claude/...` routes, per-provider API keys, per-provider start/stop, usage split by provider.
- Dashboard redesigned around selectable provider tiles.

### Fixed
- A Claude usage-limit block now clears once the limit window resets instead of lasting until restart.
- Garbled character in the API key error message.
- ChatGPT streams that omit `content-type` are accepted.
- ChatGPT credential store locking and token refresh hardened.

### Upgrade note
`provider-keys.json` moves to a new format the first time 0.1.0 starts. Existing keys keep working. Do not run an older version against the same data folder afterwards: it would replace every provider key.

## [0.0.2] - 2026-09-08

### Added
- App icon and simple Docker start/stop/reinstall scripts.
- Web dashboard, user guide, automatic `.env` and API key generation.

### Fixed
- `/v1/setup/key` under Docker bridge networking, masked key display, `0.0.0.0` Base URL.

## [0.0.1] - 2026-09-06

### Added
- Gateway exposing a Claude subscription through OpenAI Chat Completions and Anthropic Messages compatible routes, with sessions, a concurrency queue and credential checks.
- Tool/function calling, CLI (`start`, `status`, `doctor`, `key generate`), usage stats, Docker image.
