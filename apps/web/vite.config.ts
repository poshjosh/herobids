import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // In development, proxy API calls to the API server.
      // VITE_API_PROXY_TARGET overrides the target for container environments
      // where the API is reachable via its Compose service name.
      '/api': {
        target: process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
        changeOrigin: true,
      },
    },
  },
});
