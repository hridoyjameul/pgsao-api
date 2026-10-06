# Multi-provider personal AI gateway

Date: 2026-10-06

## Goal and agreed scope

PGSAO API is an open-source, MIT licensed hobby gateway. The intended product is one local control panel for five initial providers: Claude, ChatGPT, Gemini, Kimi, and Qwen. It detects relevant installed clients, shows whether an account is connected and an API route is usable, and gives the owner a local gateway API key plus copyable provider-specific base URLs. New providers should fit through adapters without changing the existing Claude integration or pretending that every vendor has the same API.

The user's one-page PDF is the UI direction: provider cards, install/connection status, start/stop control, and a detail view with Base URL and key. The PDF repeats the same local key under provider sections, so the first version uses one generated `GATEWAY_API_KEY` across all enabled provider routes. Provider OAuth tokens and vendor keys are different credentials and are never shown as the gateway key.

Success means the gateway can serve a working, documented route for each of the five providers when that provider's documented connection method is available and configured. Installing a desktop app by itself is not evidence of an active subscription or callable API. The UI must show those states separately and state what action is needed.

## Architecture choice

Use one Fastify service with an adapter registry. Every adapter declares its ID, display name, install detection, connection method, runtime status, model discovery if available, supported API shapes, route registration, and request audit category. Provider-specific modules own the actual authentication and inference calls. Shared modules own the local gateway API key, dashboard, request limits, audit logging, and error envelope utilities.

Considered approaches:

| Approach | Result |
| --- | --- |
| Adapter registry in this server (chosen) | One dashboard and deployment, clear route ownership, incremental provider support |
| A separate server per provider | Strong process isolation, but multiple ports, startup paths, keys, and dashboards |
| One universal request/response type for all providers | Simpler-looking routes, but Claude sessions, ChatGPT Responses, CLI output, and vendor protocol details would be flattened or misrepresented |

The existing `InternalClaudeRequest` and Claude session manager stay Claude-specific. An adapter may translate a supported client contract, but it must reject fields or behaviors it cannot faithfully provide. There is no cross-provider fallback.

## Dashboard and status model

All five cards are visible, including before installation. Each card exposes independent states:

1. **Client detected:** A known CLI or desktop client is found on this machine, where detection is practical. The detection method is shown; absence does not block a provider that supports direct keys.
2. **Account connected:** The documented OAuth session or vendor key is configured; a non-inference status check is used where the provider offers one.
3. **Gateway API ready:** At least one handler is implemented and its required connection is configured. A live request remains the final proof that the provider will answer. A route can be unavailable even when a client is installed.

The card's action reflects its connection method: sign in, enter a vendor-issued key, install a required CLI, reconnect, or view a failure. Detail panels show only supported base URLs and request formats, a model identifier or model list when available, and the generated gateway API key behind the existing local reveal/copy behavior. They never reveal provider tokens or vendor keys. Usage and errors are split by provider and request route. A dashboard Stop/Start control pauses or resumes inference routes while leaving the local dashboard reachable.

Detection uses documented executables, paths, or app registrations. It does not scrape browser sessions or copy credentials from arbitrary application files. CLI presence and provider authentication are checked separately. Status checks must be bounded and must not silently consume model usage.

## Route and credential contract

Each provider uses a separate local prefix. The existing Claude routes remain valid for current clients. The local gateway key authenticates all inference and model routes; the adapter supplies the provider credential only on its own upstream request. Client-supplied authorization headers never pass through to an upstream provider.

| Provider | Initial gateway surface | Connection source |
| --- | --- | --- |
| Claude | Existing `/v1/chat/completions`, `/v1/messages`, `/v1/models`; add equivalent `/claude/v1/...` aliases | Existing Claude Agent SDK account session |
| ChatGPT | `/chatgpt/v1/responses` and `/chatgpt/v1/models` | Sign in with ChatGPT plan-use OAuth |
| Gemini | `/gemini/v1/chat/completions`, text-only subset after validating the CLI adapter | Authenticated Gemini CLI in headless mode |
| Kimi | `/kimi/v1/chat/completions` and `/kimi/v1/messages`, within Kimi Code's supported coding use | User-created Kimi Code membership API key |
| Qwen | `/qwen/v1/chat/completions`, within the Alibaba Cloud Coding Plan contract | User-provided Coding Plan key and selected region |

The dashboard does not advertise an Anthropic-style URL for ChatGPT, Gemini, or Qwen unless a later adapter implements and verifies that shape. The Kimi and Qwen setup flows do not depend on an installed CLI when their documented subscription endpoint and key are available. Route examples and `openapi.yaml` specify supported parameters per provider rather than claiming full OpenAI or Anthropic parity.

## Provider behavior

### Claude

Reuse the current provider and compatibility translators. Add provider-prefixed aliases without changing the behavior of current paths. Keep the existing credential monitor and model aliases attached to Claude only. Preserve the current isolation from host tools and settings.

### ChatGPT

Use the [focused ChatGPT design](2026-10-06-chatgpt-plan-separate-api-design.md) for dynamic client registration, OAuth checks, protected token storage and refresh, model catalog, and the streaming Responses route. This plan is for the official open-source, locally hosted flow. HTTP inference requires `store: false`, `stream: true`, and an `input` array; unsupported plan-use fields are rejected before streaming. The new route does not impersonate Chat Completions.

### Gemini

Use Google's supported Gemini CLI sign-in, including Google AI Pro/Ultra accounts where eligible, through the CLI's documented headless JSON or JSONL output. The gateway launches it only with an isolated, reviewed configuration that prevents host file, shell, browser, or MCP tool execution from an API request. Start with text messages and no tool calling or multimodal claims. Map input history and text output to a documented Chat Completions subset, and treat nonzero exits, malformed output, and interrupted streams as provider errors. If the safe no-tool mode cannot be established for the installed CLI version, the Gemini card remains unavailable rather than running a privileged agent process.

### Kimi

Ask the owner for a key created in the Kimi Code console; the desktop or CLI login is not reused as a third-party key. Store the key in protected local runtime storage. Use the official Kimi Code coding endpoint for the selected region, passing native OpenAI-compatible or Anthropic-compatible requests only within the documented feature set. Distinguish Kimi Code membership from the separately billed Kimi Open Platform.

### Qwen

Use the supported Alibaba Cloud Coding Plan key and regional coding endpoint. The old Qwen OAuth free tier is discontinued, so the dashboard never offers it as a connection path. Store the user-provided key locally and forward only the documented OpenAI-compatible request shape. Distinguish the fixed-fee Coding Plan from usage-billed Token Plan or standard ModelStudio API keys.

## Storage, isolation, and failure handling

- Keep each provider credential in protected local runtime storage outside source control and separate from `GATEWAY_API_KEY`. Never place OAuth access or refresh tokens in browser storage, logs, API responses, or copied snippets.
- Restrict upstream hosts and paths per adapter. Do not create an arbitrary forward proxy. Redact authorization headers, provider keys, prompts, and responses from logs by default.
- Give each provider an independent concurrency budget or limiter so one exhausted provider does not block another. Record usage, errors, and queue waits by provider and route.
- Return a clear provider-specific disconnected, expired, unsupported, limit, or upstream error. A provider failure must not change another provider's status or send the request to another provider.
- Start the server with any subset of providers connected. Dashboard and existing Claude routes remain usable while other providers are being set up.
- Preserve the loopback bind default. Docker persistence must include provider credential storage and document protected host mounting. Remote ChatGPT OAuth setup follows OpenAI's documented local authorization and VM credential transfer procedure.

## Delivery sequence

This work is split into implementation subprojects so each provider can be verified against its own contract:

1. **Foundation:** Adapter registry, provider-prefixed Claude aliases, provider status model, dashboard cards and detail view, provider-aware usage/error records, and pause/resume control. All five cards are present; only Claude is initially API-ready.
2. **ChatGPT adapter:** Complete the focused ChatGPT design and expose its Responses and model routes.
3. **Kimi adapter:** Add membership-key setup and the two supported coding API shapes.
4. **Qwen adapter:** Add Coding Plan key/region setup and supported OpenAI-compatible route.
5. **Gemini adapter:** Validate safe headless operation, then add the text-only route and install/auth detection.
6. **Documentation and integration:** Update README, user guide, API reference, OpenAPI spec, Docker guidance, examples, and dashboard status language for all five.

Each subproject has its own detailed plan and provider-specific verification. The foundation plan comes first. The later adapters are part of the agreed product goal, while their exact supported fields are fixed against current vendor documentation and empirical behavior when each adapter is built.

## Verification criteria

- Current Claude clients keep working, and Claude's new prefixed routes produce equivalent results.
- The dashboard can distinguish detected, connected, and API-ready states for all five providers and never shows a copyable route that has no implemented handler.
- The gateway key authenticates every inference route, provider credentials never appear in browser storage or logs, and stopping inference leaves the dashboard accessible.
- Each completed adapter has a deterministic route-level verification against fake provider responses, plus a documented optional live check with the owner's account.
- Streaming and error paths reach their terminal state correctly; one provider's authentication or usage failure leaves other providers available.
- Gemini API requests cannot execute host tools through the CLI process.

## Primary documentation

- [OpenAI open-source plan usage](https://developers.openai.com/siwc/token-sharing-open-source) and [preview contract](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Gemini CLI authentication](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx), [headless mode](https://geminicli.com/docs/cli/headless/), and [tool controls](https://geminicli.com/docs/reference/tools/)
- [Kimi Code membership API access](https://www.kimi.com/en/help/kimi-code/membership-guide)
- [Qwen Code authentication and Coding Plan](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)
