import { promises as fs } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { OUTPUT_DIR, SESSIONS_DIR } from './paths.js';
import { sessionRoutes } from './routes/sessions.js';

const PORT = Number(process.env.PORT ?? 3001);

await fs.mkdir(OUTPUT_DIR, { recursive: true });
await fs.mkdir(SESSIONS_DIR, { recursive: true });

const app = Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 });

// In local dev the client is served from the same machine over the LAN
// (vite's HTTPS dev server proxies /api here), so a permissive CORS policy
// is fine and only matters if something hits :3001 directly. In production
// the client (Netlify) and this API (Render) are different origins, so
// CLIENT_ORIGIN restricts CORS to the deployed site(s) — comma-separated
// for multiple. Falls back to permissive when unset (local dev).
const clientOrigins = process.env.CLIENT_ORIGIN?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
await app.register(cors, { origin: clientOrigins && clientOrigins.length > 0 ? clientOrigins : true });
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024 }, // one full-res iPhone JPEG comfortably fits
});
await app.register(fastifyStatic, {
  root: OUTPUT_DIR,
  prefix: '/api/output/',
  decorateReply: false,
});

await app.register(sessionRoutes);

app.get('/api/health', async () => ({ ok: true }));

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
