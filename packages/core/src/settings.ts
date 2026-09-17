import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_OPTIONS, type ConnectionOptions } from './connections.js';

/**
 * App-wide settings: the defaults new computers start with.
 *
 * Kept out of connections.json so a hand-edited or corrupt settings file never
 * takes saved computers with it, and written the same atomic way. Only
 * options that make sense as a default are accepted; per-computer values such
 * as a trusted certificate or a shared folder never live here.
 */

export interface AppSettings {
  version: 1;
  defaults: Pick<ConnectionOptions,
    'scaling' | 'fullscreenOnConnect' | 'viewOnly' | 'shareClipboard' | 'enableAudio' | 'autoReconnect'>;
}

const DEFAULT_KEYS = ['scaling', 'fullscreenOnConnect', 'viewOnly', 'shareClipboard', 'enableAudio', 'autoReconnect'] as const;

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  defaults: {
    scaling: DEFAULT_OPTIONS.scaling,
    fullscreenOnConnect: DEFAULT_OPTIONS.fullscreenOnConnect,
    viewOnly: DEFAULT_OPTIONS.viewOnly,
    shareClipboard: DEFAULT_OPTIONS.shareClipboard,
    enableAudio: DEFAULT_OPTIONS.enableAudio,
    autoReconnect: DEFAULT_OPTIONS.autoReconnect,
  },
};

export class SettingsStore {
  private data: AppSettings = structuredClone(DEFAULT_SETTINGS);

  constructor(private readonly dataDir: string) {}

  private get file() { return path.join(this.dataDir, 'settings.json'); }

  async load(): Promise<AppSettings> {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<AppSettings>;
        this.data = { version: 1, defaults: sanitize({ ...DEFAULT_SETTINGS.defaults, ...(raw.defaults ?? {}) }) };
      } catch {
        // Settings are cheap to lose; the defaults are a working configuration.
        this.data = structuredClone(DEFAULT_SETTINGS);
      }
    }
    return this.get();
  }

  get(): AppSettings { return structuredClone(this.data); }

  async update(patch: { defaults?: Partial<AppSettings['defaults']> }): Promise<AppSettings> {
    this.data.defaults = sanitize({ ...this.data.defaults, ...(patch?.defaults ?? {}) });
    await mkdir(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
    return this.get();
  }
}

/** Keeps known keys with values of the right type; anything else falls back to the default. */
function sanitize(input: Record<string, unknown>): AppSettings['defaults'] {
  const out = structuredClone(DEFAULT_SETTINGS.defaults) as Record<string, unknown>;
  for (const key of DEFAULT_KEYS) {
    const value = input[key];
    if (key === 'scaling') {
      if (value === 'fit' || value === 'fill' || value === 'none') out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out as AppSettings['defaults'];
}
