import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The runner public HTTP service (ticket #5) listens on 127.0.0.1:8787 by
// default. The dev server proxies `/api/*` to it (stripping `/api`) so browser
// requests are same-origin and the HttpOnly session cookie works without CORS.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.HIVECAST_API ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    target: 'es2022',
  },
});
