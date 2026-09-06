// PRD §13's six categories, plus `authentication_error`: PRD §6.4 calls out
// gateway API-key rejection as its own 401 case, distinct from §6.7's
// `credential_error` (the Claude ACCOUNT's own auth going stale, 503). Real
// Anthropic clients specifically expect `type: "authentication_error"` + 401
// for a bad key (the @anthropic-ai/sdk client throws its AuthenticationError
// class only on that exact shape); real OpenAI clients expect 401 with
// `type: "invalid_request_error"` + `code: "invalid_api_key"`.
export type ApiErrorCategory = 'invalid_request_error' | 'rate_limit_error' | 'usage_limit_error' | 'credential_error' | 'provider_error' | 'authentication_error';

const HTTP_STATUS: Record<ApiErrorCategory, number> = {
  invalid_request_error: 400,
  rate_limit_error: 429,
  usage_limit_error: 429,
  credential_error: 503,
  provider_error: 502,
  authentication_error: 401,
};

/**
 * Route-agnostic error carrier. Never knows about OpenAI/Anthropic response
 * shapes — rendering into a specific route's error JSON is the translators'
 * job (src/translator/*.ts), per PRD §6.8/§13.
 */
export class ApiError extends Error {
  readonly category: ApiErrorCategory;
  readonly httpStatus: number;
  readonly param?: string;
  readonly code?: string;
  readonly retryAfterSeconds?: number;

  constructor(category: ApiErrorCategory, message: string, opts: { param?: string; code?: string; retryAfterSeconds?: number } = {}) {
    super(message);
    this.category = category;
    this.httpStatus = HTTP_STATUS[category];
    this.param = opts.param;
    this.code = opts.code;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}
