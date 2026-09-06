import { loadDotenv } from '../utils/load-dotenv.js';
import { loadConfig } from '../config/config.js';

/** `pgsao-api status` — pings an already-running instance's /health; does not start one itself. */
export async function status(): Promise<void> {
  loadDotenv();
  const config = loadConfig();
  const url = `http://${config.HOST}:${config.PORT}/health`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      console.log(`Gateway responded but not healthy (HTTP ${res.status}) at ${url}`);
      process.exitCode = 1;
      return;
    }
    const body = (await res.json()) as { claude_auth_status?: string };
    console.log(JSON.stringify(body, null, 2));
    if (body.claude_auth_status !== 'ok') process.exitCode = 1;
  } catch (err) {
    console.log(`No gateway responding at ${url} — is it running? (${(err as Error).message})`);
    process.exitCode = 1;
  }
}
