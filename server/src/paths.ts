import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
/** server/ package root (this file lives at server/src/paths.ts). */
export const SERVER_ROOT = path.resolve(here, '..');
export const SESSIONS_DIR = path.join(SERVER_ROOT, 'sessions');
export const OUTPUT_DIR = path.join(SERVER_ROOT, 'out');

export function sessionDir(id: string): string {
  return path.join(SESSIONS_DIR, id);
}

export function shotsDir(id: string): string {
  return path.join(sessionDir(id), 'shots');
}

export function manifestPath(id: string): string {
  return path.join(sessionDir(id), 'manifest.json');
}

export function outputPath(id: string): string {
  return path.join(OUTPUT_DIR, `${id}.jpg`);
}
