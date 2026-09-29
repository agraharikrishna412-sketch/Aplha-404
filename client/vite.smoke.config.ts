/**
 * UI smoke harness (developer tool, not part of the app build).
 *
 * The production client is code-split ESM, which a DOM-only environment cannot execute. This
 * config produces a single self-contained IIFE bundle so `scripts/ui-smoke.mjs` can boot the real
 * application against a running API and assert that every screen renders.
 *
 *   npm run smoke:ui --workspace client
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist-smoke',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
});
