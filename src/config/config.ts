import { z } from 'zod';

// z.coerce.boolean() just calls Boolean(value), so env var "false" would
// coerce to `true` (non-empty string). Parse explicit true/false tokens instead.
const envBoolean = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? defaultValue : /^(true|1)$/i.test(v)));

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('127.0.0.1'),

  GATEWAY_API_KEY: z.string().min(16, 'GATEWAY_API_KEY must be at least 16 characters — run the key-generation step in README.md'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().default('./data/gateway.db'),

  // Defaults per spikes/FINDINGS.md's empirical concurrency-ceiling test, not PRD's placeholder value.
  MAX_CONCURRENT_REQUESTS: z.coerce.number().int().positive().default(3),
  QUEUE_MAX_SIZE: z.coerce.number().int().positive().default(10),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  CREDENTIAL_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  ENABLE_OPENAI_COMPAT_ROUTE: envBoolean(true),
  ENABLE_ANTHROPIC_COMPAT_ROUTE: envBoolean(true),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid gateway configuration:\n${issues}`);
  }
  return result.data;
}
