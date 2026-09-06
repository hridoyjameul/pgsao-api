#!/usr/bin/env node
import { startServer } from './start-server.js';
import { status } from './cli/status.js';
import { doctor } from './cli/doctor.js';
import { keyGenerate } from './cli/key.js';

const [command, subcommand] = process.argv.slice(2);

async function main() {
  switch (command) {
    case 'start':
      await startServer();
      return; // keep running
    case 'status':
      await status();
      break;
    case 'doctor':
      await doctor();
      break;
    case 'key':
      if (subcommand === 'generate') {
        keyGenerate();
      } else {
        console.error(`Unknown "key" subcommand: ${subcommand ?? '(none)'} — try "key generate"`);
        process.exitCode = 1;
      }
      break;
    default:
      console.log(
        [
          'pgsao-api — Personal Gateway for Anthropic/OpenAI API',
          '',
          'Usage:',
          '  pgsao-api start          Start the gateway server',
          '  pgsao-api status         Check an already-running instance\'s health',
          '  pgsao-api doctor         Run end-to-end setup/health checks',
          '  pgsao-api key generate   Print a new GATEWAY_API_KEY value',
        ].join('\n')
      );
      if (command) process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
