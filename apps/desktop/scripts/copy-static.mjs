/**
 * Copies build inputs that tsc does not emit.
 *
 * The preload script is CommonJS on purpose — Electron's sandboxed preload
 * environment cannot load ES modules — so it is kept as a hand-written .cjs file
 * rather than compiled, and must be placed next to main.js, which resolves it
 * relative to its own directory.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['preload.cjs'];

mkdirSync(path.join(root, 'dist'), { recursive: true });
for (const file of files) {
  copyFileSync(path.join(root, 'src', file), path.join(root, 'dist', file));
}
