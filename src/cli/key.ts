import { randomBytes } from 'node:crypto';

/** `pgsao-api key generate` — same scheme as README's quickstart snippet. */
export function keyGenerate(): void {
  const key = `cg_local_${randomBytes(24).toString('hex')}`;
  console.log(`GATEWAY_API_KEY=${key}`);
}
