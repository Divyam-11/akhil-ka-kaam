import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The dev server proxies /api, /auth and /health to the API so cookies are same-origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  const target = env.API_PROXY_TARGET || 'http://localhost:3001';
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target, changeOrigin: false },
        '/auth': { target, changeOrigin: false },
        '/health': { target, changeOrigin: false },
        '/admin': { target, changeOrigin: false },
      },
    },
    build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
  };
});
