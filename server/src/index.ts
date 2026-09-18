import { loadConfig, ConfigError, suggestSecret } from './config.js';
import { startServer } from './server.js';

/** Entry point for the container and for `npm -w @hopdesk/server start`. */

if (process.argv.includes('--print-secret')) {
  process.stdout.write(`${suggestSecret()}\n`);
  process.exit(0);
}

try {
  const config = loadConfig();
  const server = await startServer({ config });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void server.close().then(() => process.exit(0));
    });
  }
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`hopdesk server: ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}
