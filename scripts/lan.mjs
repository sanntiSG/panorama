import { networkInterfaces } from 'node:os';

/**
 * Current LAN IPv4 addresses for this machine. Used to build the mkcert
 * certificate's SAN list (client/vite.config.ts, scripts/local.mjs) and to
 * print the URL a phone on the same WiFi should open (scripts/serve-ca.mjs,
 * scripts/local.mjs) — kept in one place so all three agree with each
 * other after switching networks or getting a new DHCP lease, instead of
 * three copies quietly drifting apart.
 */
export function lanIPv4s() {
  const ips = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}
