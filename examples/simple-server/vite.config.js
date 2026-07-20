import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    include: ['splat-shq']
  },
  build: {
    target: 'esnext'
  }
});