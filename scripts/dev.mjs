#!/usr/bin/env node
/**
 * `npm run dev` — starts the Fastify server and the Vite HTTPS dev server
 * together in one terminal (`npm run dev:server` + `npm run dev:client`,
 * previously two manual terminals — see README). Vite still proxies /api
 * to the server (client/vite.config.ts), so this is the same setup as
 * before, just one command; for the single-process, no-Render-needed setup
 * see `npm run local` instead (scripts/local.mjs).
 *
 * If either process dies, the other is killed too — a crashed server
 * silently leaving the client running (or vice versa) is more confusing
 * than just stopping everything.
 */
import { spawn } from 'node:child_process';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// npm on Windows is npm.cmd, a batch file — Node refuses to spawn those
// directly without `shell: true` (a Windows-only restriction added as a
// security fix).
const spawnOptions = { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' };

function runWorkspaceScript(label, script) {
  const child = spawn(npmCmd, ['run', script], spawnOptions);
  const forward = (stream) => (chunk) => {
    const lines = chunk.toString().split(/\r?\n/);
    for (const line of lines) {
      if (line.length > 0) stream.write(`[${label}] ${line}\n`);
    }
  };
  child.stdout.on('data', forward(process.stdout));
  child.stderr.on('data', forward(process.stderr));
  return child;
}

console.log('Arrancando servidor (Fastify :3001) y cliente (Vite HTTPS :5173)... Ctrl+C para detener ambos.\n');

const server = runWorkspaceScript('server', 'dev:server');
const client = runWorkspaceScript('client', 'dev:client');

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  server.kill();
  client.kill();
  process.exitCode = code ?? 0;
}

server.on('exit', (code) => {
  if (shuttingDown) return;
  console.error(`\n[server] se detuvo (código ${code}) — deteniendo el cliente también.`);
  shutdown(code ?? 1);
});
client.on('exit', (code) => {
  if (shuttingDown) return;
  console.error(`\n[client] se detuvo (código ${code}) — deteniendo el servidor también.`);
  shutdown(code ?? 1);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
