import { startServer } from './start-server.js';

try {
  await startServer();
} catch (err) {
  console.error(err);
  process.exit(1);
}
