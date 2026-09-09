import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ShotMeta, ShotRecord } from '@panorama/shared';
import { addShot, createSession as createSessionRecord, getSession, isValidSessionId } from '../sessionStore.js';
import { shotsDir } from '../paths.js';
import { publishProgress, subscribeProgress } from '../stitch/progress.js';
import { runStitch } from '../stitch/pipeline.js';

const DEFAULT_OVERLAP = 0.35;

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/sessions', async (request) => {
    const body = request.body as { overlap?: number } | undefined;
    const overlap = typeof body?.overlap === 'number' && body.overlap > 0 && body.overlap < 1 ? body.overlap : DEFAULT_OVERLAP;
    const session = await createSessionRecord(overlap, null);
    return { id: session.id, nominalFocalPx: session.nominalFocalPx };
  });

  app.post('/api/sessions/:id/shots', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidSessionId(id) || !getSession(id)) {
      return reply.code(404).send({ error: 'session not found' });
    }

    let metaRaw: string | undefined;
    let fileBuffer: Buffer | undefined;

    for await (const part of request.parts()) {
      if (part.type === 'file' && part.fieldname === 'photo') {
        fileBuffer = await part.toBuffer();
      } else if (part.type === 'field' && part.fieldname === 'meta') {
        metaRaw = String(part.value);
      }
    }

    if (!metaRaw || !fileBuffer) {
      return reply.code(400).send({ error: 'missing meta or photo field' });
    }

    let meta: ShotMeta;
    try {
      meta = JSON.parse(metaRaw) as ShotMeta;
    } catch {
      return reply.code(400).send({ error: 'invalid meta JSON' });
    }
    if (!meta.targetId || !meta.quat || !meta.cam) {
      return reply.code(400).send({ error: 'incomplete shot metadata' });
    }

    // Target ids come from our own capture plan (ring0_3, zenith, ...) but
    // sanitize before touching the filesystem regardless.
    const safeTargetId = meta.targetId.replace(/[^A-Za-z0-9_-]/g, '_');
    const fileName = `${safeTargetId}.jpg`;
    await fs.writeFile(path.join(shotsDir(id), fileName), fileBuffer);

    const record: ShotRecord = { ...meta, fileName };
    await addShot(id, record);

    return { ok: true };
  });

  app.post('/api/sessions/:id/stitch', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(id);
    if (!isValidSessionId(id) || !session) {
      return reply.code(404).send({ error: 'session not found' });
    }
    if (session.shots.length < 2) {
      return reply.code(400).send({ error: 'need at least 2 shots to stitch' });
    }

    // Fire-and-forget: the client tracks progress over the SSE endpoint below.
    runStitch(session).catch((err) => {
      app.log.error(err);
      publishProgress(id, { stage: 'error', message: err instanceof Error ? err.message : String(err) });
    });

    return { ok: true };
  });

  app.get('/api/sessions/:id/stitch/events', (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidSessionId(id)) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Render (and other reverse-proxy PaaS) buffer proxied responses by
      // default, which would hold back SSE events until the buffer flushes.
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(':ok\n\n');

    // Stitching can run for over a minute without a progress event (e.g.
    // decoding many full-res photos on a slow CPU tier) — a comment-only
    // heartbeat keeps the connection alive through proxies/load balancers
    // that would otherwise time out an idle stream.
    const heartbeat = setInterval(() => reply.raw.write(':\n\n'), 20_000);

    const unsubscribe = subscribeProgress(id, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
