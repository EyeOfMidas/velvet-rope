import { defineConfig } from 'vite';

// The example's page, with /api proxied to example/server.js.
export default defineConfig({
  root: 'example/web',
  server: {
    port: Number(process.env.WEB_PORT ?? 5174),
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT ?? 3001}` },
  },
});
