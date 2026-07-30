import { defineConfig } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';
import compression from 'vite-plugin-compression';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import compressionMiddleware from 'compression';

const throttleSpeedMbps = process.env.THROTTLE_SPEED ? parseFloat(process.env.THROTTLE_SPEED) : 0;

export default defineConfig(({ command }) => ({
  plugins: [
    dts(),
    viteStaticCopy({
      targets: [
        { src: 'scenes', dest: '.' },
        { src: 'scenes.json', dest: '.' },
      ],
    }),
    compression({
      algorithm: 'brotliCompress',
      ext: '.br',
      threshold: 1024,
      filter: /\.(js|css|html|ply|json|wasm)$/,
    }),
    compression({
      algorithm: 'gzip',
      ext: '.gz',
      threshold: 1024,
      filter: /\.(js|css|html|ply|json|wasm)$/,
    }),
    {
      name: 'configure-compression',
      configureServer(server) {
        server.middlewares.use(compressionMiddleware());
      },
    },
    {
      name: 'configure-throttle',
      async configureServer(server) {
        if (throttleSpeedMbps <= 0) return;
        const bytesPerSecond = (throttleSpeedMbps * 1024 * 1024) / 8;
        console.log(`[Vite] Throttling .ply downloads to ${throttleSpeedMbps} Mbps (${bytesPerSecond.toFixed(0)} B/s), with gzip`);
        const { default: Throttle } = await import('throttle');
        const { createGzip } = await import('zlib');
        const fs = await import('fs');
        const path = await import('path');
        server.middlewares.use((req, res, next) => {
          if (!req.url?.endsWith('.ply')) return next();
          const filePath = path.join(process.cwd(), req.url);
          if (!fs.existsSync(filePath)) return next();
          const acceptEncoding = req.headers['accept-encoding'] || '';
          const useGzip = acceptEncoding.includes('gzip');
          res.setHeader('Content-Type', 'application/octet-stream');
          if (useGzip) {
            res.setHeader('Content-Encoding', 'gzip');
          }
          const readStream = fs.createReadStream(filePath);
          const throttle = new Throttle(bytesPerSecond);
          if (useGzip) {
            readStream.pipe(createGzip()).pipe(throttle).pipe(res);
          } else {
            const stat = fs.statSync(filePath);
            res.setHeader('Content-Length', stat.size);
            readStream.pipe(throttle).pipe(res);
          }
        });
      },
    },
  ],
  base: './',
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'gsplat',
      fileName: (format) => `index.${format}.js`,
      formats: ['es']
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.wasm')) {
            return '[name][extname]';
          }
          return 'assets/[name]-[hash][extname]';
        }
      }
    },
    sourcemap: true,
    target: 'esnext',
    copyPublicDir: false
  },
  worker: {
    format: 'es',
    sourcemap: false,
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js'
      }
    }
  },
  publicDir: command === 'serve' ? 'public' : false
}));
