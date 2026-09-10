import { promises as fs, readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { OUTPUT_DIR, SESSIONS_DIR } from './paths.js';
import { sessionRoutes } from './routes/sessions.js';

const PORT = Number(process.env.PORT ?? 3001);

await fs.mkdir(OUTPUT_DIR, { recursive: true });
await fs.mkdir(SESSIONS_DIR, { recursive: true });

// "npm run local" (see scripts/local.mjs): this server terminates HTTPS
// itself, with the same mkcert-issued cert the Vite dev server uses — so a
// device that already trusts that CA (see npm run serve-ca) trusts this
// too. Both vars are unset in production; Render terminates TLS for us.
const httpsOptions =
  process.env.PANORAMA_HTTPS_KEY && process.env.PANORAMA_HTTPS_CERT
    ? {
        key: readFileSync(process.env.PANORAMA_HTTPS_KEY),
        cert: readFileSync(process.env.PANORAMA_HTTPS_CERT),
      }
    : undefined;

// Fastify's TS overloads pick the http.Server vs. https.Server instantiation
// based on whether `https` is present in the options object at all — not on
// whether its value happens to be undefined — so this has to be a real
// conditional call, not a single object literal with an optional field. The
// `as FastifyInstance` widens back to one common type: every method we use
// below (register/get/listen) behaves the same regardless of which raw
// server type is actually underneath.
const app = (
  httpsOptions
    ? Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024, https: httpsOptions })
    : Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 })
) as FastifyInstance;

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

// Same local, single-process mode as above: serve the already-built client
// (scripts/local.mjs builds it before setting this) alongside the API on
// this same origin, so there's nothing else to run and no CORS involved.
// Unset in production — Netlify serves the client there instead.
if (process.env.PANORAMA_CLIENT_DIST) {
  const clientDist = process.env.PANORAMA_CLIENT_DIST;
  await app.register(fastifyStatic, {
    root: clientDist,
    prefix: '/',
  });
  // SPA fallback, mirroring netlify.toml's `/* -> /index.html` redirect:
  // any unmatched GET that isn't under /api gets index.html instead of a
  // 404, so a direct load or refresh never breaks even if routes are added
  // later. Unmatched /api/* requests still get a real 404.
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api')) {
      reply.sendFile('index.html', clientDist);
    } else {
      reply.code(404).send({ error: 'not found' });
    }
  });
}

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
