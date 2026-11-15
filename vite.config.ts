import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  // strictPort matters: tauri.conf.json's devUrl is hard-wired to 5183.
  server: { port: 5183, strictPort: true },
  build: {
    target: 'es2022',
    // Source maps are 4.3 MB and would ship inside the desktop bundle.
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
