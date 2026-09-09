import type { ShotMeta } from '@panorama/shared';
import { getPendingShots, markAttemptFailed, markUploaded } from '../storage/session.js';
import { apiUrl } from './api.js';

const MAX_RETRY_DELAY_MS = 15_000;

async function uploadShot(sessionId: string, meta: ShotMeta, blob: Blob): Promise<boolean> {
  try {
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('photo', blob, `${meta.targetId}.jpg`);
    const res = await fetch(apiUrl(`/api/sessions/${sessionId}/shots`), { method: 'POST', body: form });
    return res.ok;
  } catch {
    return false; // offline / network error — the queue will retry with backoff
  }
}

/**
 * Drains the local shot queue for one session, uploading in the background
 * while the user keeps rotating and shooting. Idempotent to re-kick: safe to
 * call `enqueueAndKick()` after every new shot and after regaining
 * connectivity — it's a no-op if a drain is already running.
 */
export class UploadQueue {
  private processing = false;
  private stopped = false;
  private readonly listeners = new Set<(pending: number) => void>();
  private readonly onOnline = () => this.enqueueAndKick();

  constructor(private readonly sessionId: string) {
    window.addEventListener('online', this.onOnline);
  }

  onPendingChange(cb: (pending: number) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  enqueueAndKick(): void {
    void this.notify();
    void this.process();
  }

  dispose(): void {
    this.stopped = true;
    window.removeEventListener('online', this.onOnline);
  }

  private async notify(): Promise<void> {
    const pending = (await getPendingShots(this.sessionId)).length;
    for (const cb of this.listeners) cb(pending);
  }

  private async process(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;
    try {
      while (!this.stopped) {
        const pending = await getPendingShots(this.sessionId);
        if (pending.length === 0) break;
        const shot = pending[0];
        const ok = await uploadShot(this.sessionId, shot.meta, shot.blob);
        if (this.stopped) break;
        if (ok) {
          await markUploaded(this.sessionId, shot.meta.targetId);
          await this.notify();
        } else {
          await markAttemptFailed(this.sessionId, shot.meta.targetId);
          const delayMs = Math.min(1000 * 2 ** Math.min(shot.attempts, 4), MAX_RETRY_DELAY_MS);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
