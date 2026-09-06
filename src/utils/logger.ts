import type { Config } from '../config/config.js';

/**
 * Options for Fastify's built-in pino logger (Fastify constructs the actual
 * instance — passing a hand-built pino instance via `loggerInstance` doesn't
 * type-check cleanly against Fastify's own logger interface). Never logs
 * API keys, tokens, or full prompt/response bodies by default (PRD §14).
 */
export function createLoggerOptions(config: Pick<Config, 'LOG_LEVEL'>) {
  return {
    level: config.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'GATEWAY_API_KEY', '*.apiKey', '*.api_key'],
      remove: true,
    },
  };
}
