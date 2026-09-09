#!/usr/bin/env node
/**
 * Serves mkcert's root CA certificate over plain HTTP so an iPhone (or any
 * device) on the same WiFi can install it — deliberately NOT served over
 * HTTPS, because the whole point is that the device doesn't trust this
 * machine's HTTPS certificate *yet*. Run once per machine (or whenever the
 * CA changes) and follow the on-screen steps to trust it on the iPhone;
 * after that, https://<this machine's LAN IP>:5173 will just work.
 *
 * Usage: npm run serve-ca
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import path from 'node:path';

const PORT = 3002;
const CA_PATH = path.join(homedir(), '.vite-plugin-mkcert', 'rootCA.pem');

function lanIPv4s() {
  const ips = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

if (!existsSync(CA_PATH)) {
  console.error(`No se encontró el CA de mkcert en ${CA_PATH}.`);
  console.error('Arranca primero el cliente al menos una vez (npm run dev:client) — genera el certificado y el CA la primera vez que corre.');
  process.exit(1);
}

const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/rootCA.pem') {
    const cert = readFileSync(CA_PATH);
    res.writeHead(200, {
      // This exact content-type is what makes Safari on iOS offer to
      // install it as a configuration profile instead of just showing the
      // raw text.
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Length': cert.length,
    });
    res.end(cert);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPv4s();
  console.log(`Sirviendo el CA de mkcert por HTTP (sin cifrar, a propósito) en el puerto ${PORT}.\n`);
  console.log('En el iPhone (en la misma WiFi), abre en Safari:');
  for (const ip of ips) console.log(`  http://${ip}:${PORT}/`);
  console.log('\nLuego en el iPhone:');
  console.log('  1. Toca "Permitir" cuando pida descargar el perfil.');
  console.log('  2. Ajustes → Perfil descargado → Instalar (te pedirá el código del teléfono).');
  console.log('  3. Ajustes → General → Información → Ajustes de confianza de certificados →');
  console.log('     activa la confianza TOTAL para el certificado del CA recién instalado.');
  console.log('     (Este paso es el que la gente olvida — sin él, Safari sigue bloqueando la cámara.)');
  console.log('\nHecho eso, abre https://<esa misma IP>:5173 y ya debería confiar en el certificado.');
  console.log('\nCtrl+C para detener este servidor una vez instalado el perfil.');
});
