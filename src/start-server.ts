import type { FastifyInstance } from 'fastify';
import { loadDotenv } from './utils/load-dotenv.js';
import { loadConfig } from './config/config.js';
import { buildApp } from './app.js';

/** Shared by src/server.ts (the direct-run entry — Docker CMD, `npm start`/`dev`) and `cli.ts start`, so there's one real startup path instead of two. */
export async function startServer(): Promise<FastifyInstance> {
  loadDotenv();
  const config = loadConfig();
  const app = await buildApp({ config });
  app.gateway.credentialMonitor.start();

  async function shutdown(signal: string) {
    app.log.info(`Received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(`pgsao-api listening on http://${config.HOST}:${config.PORT}`);
  return app;
}
