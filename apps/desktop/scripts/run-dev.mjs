/** Starts the built app the way a user's launcher does. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { launchEnvironment, ozoneArgs } from './launch-args.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = launchEnvironment(process.env);
delete env.ELECTRON_RUN_AS_NODE;              // set by VS Code's terminal

const child = spawn(createRequire(import.meta.url)('electron'),
  [path.join(desktopDir, 'dist/main.js'), ...ozoneArgs(env), ...process.argv.slice(2)],
  { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 0));
