import { EventEmitter } from 'node:events';
import type { StitchProgressEvent } from '@panorama/shared';

/**
 * Per-session progress bus for the stitch pipeline. The client's POST
 * /stitch (which starts the job) and its GET /stitch/events (SSE, which
 * streams progress) are separate requests that can arrive in either order,
 * so every subscriber gets the last known event replayed immediately on
 * connect rather than only future ones.
 */

const emitters = new Map<string, EventEmitter>();
const lastEvent = new Map<string, StitchProgressEvent>();

function emitterFor(sessionId: string): EventEmitter {
  let e = emitters.get(sessionId);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(20);
    emitters.set(sessionId, e);
  }
  return e;
}

export function publishProgress(sessionId: string, event: StitchProgressEvent): void {
  lastEvent.set(sessionId, event);
  emitterFor(sessionId).emit('progress', event);
  if (event.stage === 'done' || event.stage === 'error') {
    // Give slow subscribers a moment to receive the terminal event, then
    // free the bus — a session is stitched once, not repeatedly.
    setTimeout(() => {
      emitters.delete(sessionId);
      lastEvent.delete(sessionId);
    }, 60_000);
  }
}

export function subscribeProgress(sessionId: string, onEvent: (event: StitchProgressEvent) => void): () => void {
  const emitter = emitterFor(sessionId);
  emitter.on('progress', onEvent);
  const last = lastEvent.get(sessionId);
  if (last) onEvent(last);
  return () => emitter.off('progress', onEvent);
}
