import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy API + WebSocket to the backend so the browser stays same-origin.
// OC_BACKEND overrides the target (e.g. a second local backend on :3101).
const backend = process.env.OC_BACKEND ?? 'http://localhost:3000';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/ws': { target: backend, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split heavy, rarely-changing vendors into their own chunks so the
        // main bundle stays small and these cache across app deploys. Matched
        // by module path (subpath imports like y-protocols/awareness included).
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/](@codemirror|@lezer)[\\/]/.test(id)) return 'codemirror';
          if (/[\\/](yjs|y-codemirror\.next|y-protocols|y-indexeddb|lib0)[\\/]/.test(id)) return 'yjs';
          if (/[\\/](marked|dompurify)[\\/]/.test(id)) return 'markdown';
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
        },
      },
    },
  },
});
