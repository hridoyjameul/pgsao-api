/**
 * Model alias allow-list (PRD §7.A/§7.B) — `model` is resolved against this,
 * not an open passthrough, since actual model availability depends on the
 * authenticated plan/config. `undefined` means "let the Agent SDK use its
 * own configured default model" rather than pinning a specific one.
 */
export const MODEL_ALIASES: Record<string, string | undefined> = {
  'claude-via-gateway': undefined,
  'claude-opus-5': 'claude-opus-5',
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-haiku-4-5': 'claude-haiku-4-5',
};

export function resolveModelAlias(requestedModel: string): { resolved: string | undefined } | undefined {
  if (!(requestedModel in MODEL_ALIASES)) return undefined;
  return { resolved: MODEL_ALIASES[requestedModel] };
}

export function listModelAliases(): string[] {
  return Object.keys(MODEL_ALIASES);
}
