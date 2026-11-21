/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// In dev the API is proxied and the test-admin token is injected server-side (same as nginx in Docker),
// so the token never ships inside the browser bundle.
export default defineConfig(({ mode }) => {
  // Read only the dev proxy settings from the same root .env used by Docker Compose.
  // Do not set envPrefix or inject these values into define: the admin token stays server-side.
  const root = fileURLToPath(new URL('../', import.meta.url));
  const env = loadEnv(mode, root, ['VITE_API_PROXY', 'TEST_ADMIN_TOKEN']);
  const api = process.env.VITE_API_PROXY ?? env.VITE_API_PROXY ?? 'http://127.0.0.1:8090';
  const adminToken = process.env.TEST_ADMIN_TOKEN ?? env.TEST_ADMIN_TOKEN ?? '';
  const proxy = (extraHeaders: Record<string, string> = {}) => ({ target: api, changeOrigin: true, headers: extraHeaders });

  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      port: 3091,
      strictPort: true,
      host: '127.0.0.1',
      proxy: {
        '/api/v2/simulator/dispute': proxy(),
        '/demo': proxy(),
        '/health': proxy(),
        '/test-admin': proxy({ 'x-test-admin-token': adminToken }),
      },
    },
    test: { environment: 'jsdom', globals: true, setupFiles: [] },
  };
});
