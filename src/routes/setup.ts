import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';

/**
 * GET /v1/setup/key — lets the dashboard fill in the gateway key by itself on
 * first load, instead of making a non-developer user open .env in a text
 * editor to find it. Deliberately unauthenticated (there's no key to send yet
 * on a fresh install).
 *
 * Gated to "this machine or its own Docker bridge," not a strict 127.0.0.1
 * check: under Docker (this project's actual documented deployment path —
 * see docker-compose.yml), the app binds HOST=0.0.0.0 inside the container
 * and every browser request arrives with remoteAddress rewritten to the
 * bridge network's gateway (e.g. 172.x.0.1) by Docker's port-forwarder, never
 * literally 127.0.0.1 — a strict loopback check 403s the exact setup this
 * app ships with. The real security boundary is already one layer up (the
 * host-side port publish restricted to 127.0.0.1, or a reverse proxy on a
 * cloud box, both documented in README's Docker section) — this is
 * defense-in-depth against the port ever being bound to 0.0.0.0 on the host,
 * not the primary fence.
 */
function isTrustedSetupCaller(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  const v4 = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  const octets = v4.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (Docker's default bridge range)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

export function registerSetupRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  app.get('/v1/setup/key', async (request, reply) => {
    if (!isTrustedSetupCaller(request.ip)) {
      reply.code(403).send({ error: { type: 'permission_error', message: 'Only reachable from this machine' } });
      return;
    }
    return { apiKey: gateway.config.GATEWAY_API_KEY };
  });
}
