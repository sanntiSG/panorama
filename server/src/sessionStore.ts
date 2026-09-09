import { promises as fs } from 'node:fs';
import { nanoid } from 'nanoid';
import type { SessionManifest, ShotRecord } from '@panorama/shared';
import { manifestPath, sessionDir, shotsDir } from './paths.js';

const sessions = new Map<string, SessionManifest>();

/** Valid session ids only ever come from nanoid, but this also guards every
 *  filesystem path built from a client-supplied `:id` route param against
 *  traversal (`../..`) — reject anything outside nanoid's own alphabet. */
const ID_PATTERN = /^[A-Za-z0-9_-]{6,40}$/;

export function isValidSessionId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export async function createSession(overlap: number, nominalFocalPx: number | null): Promise<SessionManifest> {
  const id = nanoid();
  const manifest: SessionManifest = { id, createdAt: Date.now(), overlap, nominalFocalPx, shots: [] };
  sessions.set(id, manifest);
  await fs.mkdir(shotsDir(id), { recursive: true });
  await persist(manifest);
  return manifest;
}

export function getSession(id: string): SessionManifest | undefined {
  return sessions.get(id);
}

export async function addShot(id: string, shot: ShotRecord): Promise<SessionManifest | undefined> {
  const manifest = sessions.get(id);
  if (!manifest) return undefined;
  // Re-uploading the same target (a retried request) replaces the earlier shot rather than duplicating it.
  manifest.shots = manifest.shots.filter((s) => s.targetId !== shot.targetId);
  manifest.shots.push(shot);
  await persist(manifest);
  return manifest;
}

async function persist(manifest: SessionManifest): Promise<void> {
  await fs.mkdir(sessionDir(manifest.id), { recursive: true });
  await fs.writeFile(manifestPath(manifest.id), JSON.stringify(manifest, null, 2), 'utf-8');
}
