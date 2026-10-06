# Separate ChatGPT plan API alongside the Claude API

Date: 2026-10-06

This focused design is the ChatGPT adapter within the [multi-provider gateway design](2026-10-06-multi-provider-gateway-design.md).

## Intent and scope

PGSAO API is an MIT licensed, open-source hobby project used personally. It currently serves two request formats through a Claude Agent SDK backend. Add a second, separately addressed API that uses a user's ChatGPT plan through OpenAI's documented Sign in with ChatGPT flow. A user should be able to connect their ChatGPT account once, call the new API from local tools, and see clearly which provider handled each request.

The existing Claude routes and their default behavior remain available. This change does not turn the Claude-compatible `/v1/chat/completions` route into an OpenAI inference route. It adds a new provider boundary and public route prefix within the same Fastify service.

## Chosen approach

Use a dedicated ChatGPT credential manager and a direct Responses API adapter. The alternatives were (1) a second server or port, which adds deployment and dashboard setup, and (2) forcing ChatGPT through the Claude-specific internal request and session types, which would couple unrelated protocols. One service with a distinct prefix keeps the client choice explicit while keeping the current deployment model.

## External API

| Route | Backend | Contract |
| --- | --- | --- |
| Existing `/v1/chat/completions` | Claude | Current OpenAI Chat Completions compatibility shape |
| Existing `/v1/messages` | Claude | Current Anthropic Messages compatibility shape |
| Existing `/v1/models` | Claude | Current Claude model aliases |
| New `POST /chatgpt/v1/responses` | ChatGPT plan | Supported subset of OpenAI Responses API over SSE |
| New `GET /chatgpt/v1/models` | ChatGPT plan | The connected account's documented model catalog, with a `models` array |

The caller sends the gateway's API key to the new routes. The gateway replaces that credential with its saved ChatGPT OAuth access token when calling `https://api.openai.com/v1`. Client headers cannot override the upstream token. The ChatGPT route never falls back to Claude.

The Responses route requires `store: false`, `stream: true`, and an `input` array containing the needed context. It validates or rejects fields outside the currently documented plan-usage subset, forwards supported request fields, and streams upstream events without inventing nonstreaming or Chat Completions behavior. The model route obtains the account's model catalog from OpenAI; a listed model is a choice, while a completed inference call is the access check. Provider-specific errors are translated to a stable gateway error without exposing tokens or raw authorization details. Limits and supported fields must track the official preview contract.

## ChatGPT connection and credential lifecycle

The local dashboard shows Claude and ChatGPT connection states separately and offers **Continue with ChatGPT**. The first connection uses OpenAI's dynamic agent registration for an open-source app. The gateway persists a stable, opaque host ID for each installation and uses the same app name consistently.

For each authorization attempt, generate fresh state, nonce, and PKCE verifier. Open the system browser at OpenAI's authorization endpoint, using an exact `127.0.0.1` callback URI and the required identity, offline access, resource, and ChatGPT plan scopes. Validate state and the returned client ID, exchange the code with the same redirect URI and PKCE verifier, validate the ID token's signature and claims, and confirm the granted `chatgpt.tokens.use.direct` scope before enabling inference. Reauthorization uses the issued client ID rather than the initial dynamic-registration value.

Persist account identity, issued client ID, host ID, granted scopes, token expiry, and tokens in protected local runtime storage outside source control. Access and refresh tokens do not go into `.env`, browser storage, URLs, logs, or API responses. If a retained ID token is used as `id_token_hint` on reauthorization, its authorization URL is redacted from logs. Support one selected account for requests; a new or returning connection does not replace that selection until the new identity and permission are validated. Refresh near expiry, serialize refreshes for the selected account, and save rotated tokens atomically. A revoked or invalid grant changes only ChatGPT connection state and requires reconnection.

The browser callback flow targets a locally reachable gateway. A remote VM cannot receive a `127.0.0.1` redirect from a user's browser, so its setup documentation must follow OpenAI's local authorization and protected credential transfer guidance with a distinct host ID for the VM. Docker's existing host loopback publication can use the local flow when the browser reaches that port.

## Internal boundaries and operations

- Keep `AgentSdkClaudeProvider`, Claude credential monitoring, Claude aliases, and Claude sessions scoped to Claude routes.
- Add a ChatGPT OAuth module, protected credential store, and Responses provider without making the Claude-specific `InternalClaudeRequest` the common type.
- Share gateway API-key authentication, logging, and general server infrastructure where their behavior is provider-neutral. Extend request audit categories and the dashboard so Claude and ChatGPT traffic and connection status remain distinguishable.
- Preserve the existing bind defaults and Docker setup. Add a separate ChatGPT credential file path to ignored local data and document its filesystem protection.
- Start the server even when ChatGPT is disconnected. ChatGPT routes return a clear connection error; Claude routes continue to use their own credential state.

## Failure handling

Reject unsupported ChatGPT request fields before starting SSE. If consent is declined or the plan-use scope is absent, leave the previous valid connection intact and show an actionable status. On expiry, refresh before sending a request. On a revoked refresh grant, clear the active ChatGPT connection and require sign-in. Surface OpenAI usage limits and upstream errors on the ChatGPT route with useful status and retry information where available. Never retry a failed ChatGPT request through Claude.

## Verification criteria

- Existing Claude endpoints and model aliases preserve their behavior.
- First-time sign-in checks state, nonce, PKCE, issued client ID, ID-token claims, and granted plan-use scope; returning sign-in does not silently switch accounts.
- Credential storage and logs do not expose OAuth tokens, and concurrent requests cannot race token rotation.
- The new route authenticates gateway callers, enforces the supported Responses contract, streams events through completion, and forwards no caller-supplied upstream authorization.
- Disconnected, declined, expired, revoked, rate-limited, and upstream-failure states are visible on the ChatGPT side without breaking Claude.
- Local dashboard and usage documentation identify the separate base URLs and the current ChatGPT plan limitations.

## Official OpenAI references

- [Open-source ChatGPT plan usage overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts, token refresh, and credential storage](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Model listing and Responses inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Self-hosted VM setup](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
