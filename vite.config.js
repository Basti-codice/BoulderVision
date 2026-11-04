import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import os from 'node:os';

// Tells the app which address a phone on the same Wi-Fi can use to reach this server (used for the QR code).
function lanInfo() {
  const handler = (server, https) => (req, res) => {
    const port = server.httpServer?.address()?.port;
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 3 : 2);
    ips.sort((a, b) => rank(a) - rank(b));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ protocol: https ? 'https' : 'http', port, ips }));
  };
  return {
    name: 'bv-lan-info',
    configureServer(server) { server.middlewares.use('/__lan', handler(server, server.config.server.https || server.config.mode === 'phone')); },
    configurePreviewServer(server) { server.middlewares.use('/__lan', handler(server, server.config.mode === 'phone')); },
  };
}

// `--mode phone` serves over HTTPS (self-signed) so that a phone browser allows camera access.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [mode === 'phone' ? basicSsl() : null, lanInfo()].filter(Boolean),
  esbuild: { target: 'es2022' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: true },
  preview: { host: true },
}));
