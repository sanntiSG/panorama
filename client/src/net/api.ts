import type { StitchProgressEvent } from '@panorama/shared';

/**
 * Vacío en dev: el servidor de Vite proxea `/api` a `localhost:3001`
 * (ver client/vite.config.ts), así que las rutas relativas ya funcionan.
 * En producción el cliente (Netlify) y la API (Render) viven en dominios
 * distintos, así que ahí `VITE_API_BASE` debe apuntar al servicio de Render.
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export interface CreateSessionResponse {
  id: string;
  nominalFocalPx: number | null;
}

export async function createSession(overlap: number): Promise<CreateSessionResponse> {
  const res = await fetch(apiUrl('/api/sessions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overlap }),
  });
  if (!res.ok) throw new Error(`No se pudo crear la sesión (${res.status})`);
  return res.json();
}

export async function startStitch(sessionId: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/sessions/${sessionId}/stitch`), { method: 'POST' });
  if (!res.ok) throw new Error(`No se pudo iniciar el procesado (${res.status})`);
}

/**
 * Subscribes to stitch progress over SSE. The server replays the latest
 * known progress immediately on connect, so it doesn't matter whether this
 * is called before or after `startStitch` resolves.
 */
export function subscribeStitchEvents(
  sessionId: string,
  onEvent: (event: StitchProgressEvent) => void,
): () => void {
  const source = new EventSource(apiUrl(`/api/sessions/${sessionId}/stitch/events`));
  source.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as StitchProgressEvent);
    } catch {
      // malformed event — ignore rather than crash the UI
    }
  };
  return () => source.close();
}
