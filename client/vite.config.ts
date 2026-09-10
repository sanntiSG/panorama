import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import mkcert from 'vite-plugin-mkcert';
import { lanIPv4s } from '../scripts/lan.mjs';

// Dev server is served over HTTPS on the LAN so an iPhone on the same WiFi
// can open it directly (Safari requires a secure context for getUserMedia
// and DeviceOrientationEvent.requestPermission). vite-plugin-mkcert
// generates a locally-trusted cert on first run; see scripts/serve-ca.mjs
// and the README for how to install the CA on the iPhone.
//
// The cert's SAN list is built from whatever LAN IPv4 addresses this
// machine currently has, rather than a hardcoded IP, so it keeps working
// after switching WiFi networks or getting a new DHCP lease.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    mkcert({ hosts: ['localhost', '127.0.0.1', ...lanIPv4s()] }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
