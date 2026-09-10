#!/usr/bin/env node
/**
 * `npm run local` — runs the whole app as a single HTTPS process on this
 * machine: builds the client once, then starts the Fastify server serving
 * both the API and that build on the same origin (server/src/index.ts's
 * PANORAMA_CLIENT_DIST/PANORAMA_HTTPS_* support). No CORS to configure, no
 * Render free-tier cold start or CPU limit — the stitching pipeline runs on
 * this machine's own CPU instead. This is the mode to actually capture a
 * panorama with; `npm run dev` (scripts/dev.mjs) is for iterating on code.
 *
 * Reuses the exact mkcert CA that `npm run dev:client` already generated
 * (and that `npm run serve-ca` installs on the iPhone) — so a phone that
 * already trusts that CA trusts this server's certificate too, with no
 * extra step. If that CA doesn't exist yet, run `npm run dev:client` once
 * first (it downloads mkcert and creates the CA on first launch).
 *
 * Usage: npm run local
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lanIPv4s } from './lan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MKCERT_DATA_DIR = path.join(homedir(), '.vite-plugin-mkcert');
const MKCERT_BIN = path.join(MKCERT_DATA_DIR, process.platform === 'win32' ? 'mkcert.exe' : 'mkcert');
const CERTS_DIR = path.join(ROOT, 'certs');
const KEY_PATH = path.join(CERTS_DIR, 'local-key.pem');
const CERT_PATH = path.join(CERTS_DIR, 'local-cert.pem');
const CLIENT_DIST = path.join(ROOT, 'client', 'dist');

function run(cmd, args, extraEnv) {
  return new Promise((resolve, reject) => {
    // npm on Windows is npm.cmd, a batch file — Node refuses to spawn those
    // directly without `shell: true` (a Windows-only restriction added as a
    // security fix), hence the platform check. mkcert is a real .exe, so it
    // doesn't need this.
    const isNpm = cmd === 'npm';
    const resolvedCmd = process.platform === 'win32' && isNpm ? 'npm.cmd' : cmd;
    const child = spawn(resolvedCmd, args, {
      stdio: 'inherit',
      cwd: ROOT,
      shell: process.platform === 'win32' && isNpm,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} terminó con código ${code ?? signal}`));
    });
  });
}

async function main() {
  if (!existsSync(MKCERT_BIN)) {
    console.error(`No se encontró mkcert en ${MKCERT_BIN}.`);
    console.error('Arranca el cliente en modo dev al menos una vez (descarga mkcert y crea el CA la primera vez): npm run dev:client');
    process.exit(1);
  }

  const ips = lanIPv4s();
  const hosts = ['localhost', '127.0.0.1', ...ips];

  mkdirSync(CERTS_DIR, { recursive: true });

  console.log(`Generando certificado local para: ${hosts.join(', ')}\n`);
  // CAROOT apunta al mismo CA que usa vite-plugin-mkcert (el que instala
  // `npm run serve-ca` en el iPhone) — así el certificado que se genera
  // aquí ya es de confianza para cualquier dispositivo que haya seguido
  // esos pasos una vez, sin instalar nada nuevo.
  await run(MKCERT_BIN, ['-install', '-key-file', KEY_PATH, '-cert-file', CERT_PATH, ...hosts], {
    CAROOT: MKCERT_DATA_DIR,
  });

  console.log('\nCompilando el cliente...\n');
  // VITE_API_BASE vacío: el cliente hace fetch a rutas relativas (/api/...),
  // que en este modo resuelve contra el propio servidor Fastify — mismo
  // origen, sin CORS. Se fuerza explícitamente por si el shell ya tuviera
  // la variable puesta desde otra sesión.
  await run('npm', ['run', 'build', '-w', 'client'], { VITE_API_BASE: '' });

  console.log(`\nAbre esto en el iPhone (misma WiFi que este ordenador):`);
  for (const ip of ips) console.log(`  https://${ip}:3001`);
  console.log(
    '\nSi el iPhone todavía no confía en el certificado, corre en otra terminal "npm run serve-ca" y sigue sus pasos (una sola vez por dispositivo).',
  );
  console.log('\nArrancando el servidor (API + cliente compilado) por HTTPS... Ctrl+C para detenerlo.\n');

  const server = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'start', '-w', 'server'], {
    stdio: 'inherit',
    cwd: ROOT,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PANORAMA_HTTPS_KEY: KEY_PATH,
      PANORAMA_HTTPS_CERT: CERT_PATH,
      PANORAMA_CLIENT_DIST: CLIENT_DIST,
    },
  });

  process.on('SIGINT', () => server.kill('SIGINT'));
  process.on('SIGTERM', () => server.kill('SIGTERM'));
  server.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
