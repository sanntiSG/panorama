import { createStore, del, get, keys, set } from 'idb-keyval';
import type { ShotMeta } from '@panorama/shared';

/**
 * Local durability layer: every shot is written here the instant it's
 * captured, *before* attempting to upload it. A dropped WiFi connection or a
 * killed tab loses nothing — the upload queue (net/uploader.ts) just resumes
 * from whatever is still marked `uploaded: false` next time it runs.
 */

const store = createStore('panorama-capture', 'shots');

export interface QueuedShot {
  sessionId: string;
  meta: ShotMeta;
  blob: Blob;
  uploaded: boolean;
  attempts: number;
}

function keyFor(sessionId: string, targetId: string): string {
  return `${sessionId}:${targetId}`;
}

export async function queueShot(sessionId: string, meta: ShotMeta, blob: Blob): Promise<void> {
  const record: QueuedShot = { sessionId, meta, blob, uploaded: false, attempts: 0 };
  await set(keyFor(sessionId, meta.targetId), record, store);
}

export async function markUploaded(sessionId: string, targetId: string): Promise<void> {
  // Once the server has confirmed receipt there's no reason to keep the
  // (potentially multi-MB) blob around locally.
  await del(keyFor(sessionId, targetId), store);
}

export async function markAttemptFailed(sessionId: string, targetId: string): Promise<void> {
  const k = keyFor(sessionId, targetId);
  const record = await get<QueuedShot>(k, store);
  if (record) {
    record.attempts += 1;
    await set(k, record, store);
  }
}

async function sessionKeys(sessionId: string): Promise<string[]> {
  const all = await keys(store);
  const prefix = `${sessionId}:`;
  return all.filter((k): k is string => typeof k === 'string' && k.startsWith(prefix));
}

export async function getPendingShots(sessionId: string): Promise<QueuedShot[]> {
  const relevant = await sessionKeys(sessionId);
  const records = await Promise.all(relevant.map((k) => get<QueuedShot>(k, store)));
  return records.filter((r): r is QueuedShot => !!r && !r.uploaded);
}

export async function clearSession(sessionId: string): Promise<void> {
  const relevant = await sessionKeys(sessionId);
  await Promise.all(relevant.map((k) => del(k, store)));
}
