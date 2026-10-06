import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Locate a CLI shim without launching it or reading its credentials. */
export function detectExecutable(
  command: string,
  options: { pathEnv?: string; pathext?: string; platform?: NodeJS.Platform } = {},
): boolean {
  if (!/^[a-z0-9_-]+$/i.test(command)) return false;
  const platform = options.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const extensions = isWindows
    ? (options.pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const candidates = isWindows ? extensions.map((ext) => command + ext.toLowerCase()) : [command];
  for (const rawDirectory of pathEnv.split(isWindows ? ';' : delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    for (const candidate of candidates) {
      const file = join(directory, candidate);
      try {
        if (!statSync(file).isFile()) continue;
        if (!isWindows) accessSync(file, constants.X_OK);
        return true;
      } catch { /* missing or inaccessible candidate */ }
    }
  }
  return false;
}
