// Build writes dist/ (served by the controller); dev proxies /api to VITE_API (default http://127.0.0.1).
// VITE_MOCK=1 uses the in-browser mock; it is inlined at build time so production drops the mock.
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const mock = process.env.VITE_MOCK === '1' ? '1' : '';
const target = process.env.VITE_API ?? 'http://127.0.0.1';

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  define: { 'import.meta.env.VITE_MOCK': JSON.stringify(mock) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Keep assets as files so the server's cache headers apply to them.
    assetsInlineLimit: 0,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // No proxy in mock mode: the mock answers in the browser.
    proxy: mock === '1' ? {} : { '/api': { target, changeOrigin: false } },
  },
  preview: { host: '127.0.0.1', port: 4173 },
});
