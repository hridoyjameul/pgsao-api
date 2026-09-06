import { loadConfig } from './config/config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const app = buildApp({ config });

await app.gateway.credentialMonitor.checkNow();
app.gateway.credentialMonitor.start();

async function shutdown(signal: string) {
  app.log.info(`Received ${signal}, shutting down`);
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(`pgsao-api listening on http://${config.HOST}:${config.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
