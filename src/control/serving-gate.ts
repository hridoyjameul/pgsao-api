import { ApiError } from '../errors/api-error.js';

/** Process-local control for admission of new inference requests. */
export class ServingGate {
  enabled = true;

  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  assertEnabled(): void {
    if (!this.enabled) throw new ApiError('service_paused', 'Gateway inference is paused');
  }
}
