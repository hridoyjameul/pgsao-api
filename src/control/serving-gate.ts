import { ApiError } from '../errors/api-error.js';
import type { ProviderId } from '../providers/registry.js';

/** Process-local control for admission of new inference requests: one global switch plus one per provider. */
export class ServingGate {
  enabled = true;
  private readonly disabledProviders = new Set<ProviderId>();

  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  isProviderEnabled(provider: ProviderId): boolean { return !this.disabledProviders.has(provider); }

  setProviderEnabled(provider: ProviderId, enabled: boolean): void {
    if (enabled) this.disabledProviders.delete(provider); else this.disabledProviders.add(provider);
  }

  assertEnabled(provider?: ProviderId): void {
    if (!this.enabled || (provider && !this.isProviderEnabled(provider))) throw new ApiError('service_paused', 'Gateway inference is paused');
  }
}
