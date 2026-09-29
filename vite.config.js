import { defineConfig } from 'vite';
import { join, resolve } from 'path';
import fs from 'node:fs';
import dts from 'vite-plugin-dts';
import compression from 'vite-plugin-compression';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import compressionMiddleware from 'compression';
import { ch7ReportPlugin as ch7ReportPluginImpl } from './tools/ch7_report_middleware.mjs';

const throttleSpeedMbps = process.env.THROTTLE_SPEED ? parseFloat(process.env.THROTTLE_SPEED) : 0;

// ---------------------------------------------------------------- ch7 结果自动回传（外部测试者用，2026-09-17 追加）
/**
 * 为什么是 dev server 中间件（方案 A）：跑批页面本来就是从**这个** server 打开的，
 * 测试者页面对 `/__ch7/report` 的 POST 是**同源**请求 —— 没有 CORS、不用证书、不用再起第二个进程；
 * 外网测试者经 cloudflared 临时隧道进来时，隧道转发的仍是同一个 server，同源关系不变。
 *
 * 限制（重要）：这个接口只在 `npm run dev`（vite dev server）下存在。将来若改用 `vite preview`
 * 或静态托管（如 GitHub Pages）发布，接口不存在，页面会退化成"提交失败 → 请手动复制发送"
 * （见 bench.ts / bench-flux.ts 里 submitReport 的失败分支）。
 *
 * 协议：POST /__ch7/report?name=<测试者标识>&token=<回传口令>，请求体 = 页面的 [RESULT]…[END] 纯文本，
 * 原样落盘到 thesis_project/data/ch7_measurements/raw/<name>_YYYYMMDD_HHmmss.txt
 *   - `token` 必须等于 CH7_REPORT_TOKEN（不回显收到的值）；缺失/不符 → 403、不写盘；
 *   - name 只保留 [A-Za-z0-9._-]，去掉前导 '.'，避免路径穿越；
 *   - 时间戳到秒 + 重名自动加序号：多个测试者（或同名测试者重复交）不会互相覆盖；
 *   - **先写 `<目标名>.txt.part` 再 rename**：报表脚本扫 raw/ 时永远不会读到"写了一半"的文件
 *     （`.part` 不匹配 `*.txt`，即使脚本正在扫描也只是看不到这个尚未完成的文件）。
 */
const CH7_RAW_DIR = resolve(__dirname, '../thesis_project/data/ch7_measurements/raw');
/** 单次回传体上限：结果文本正常只有几十 KB，超过说明不是结果文本 */
const CH7_MAX_BODY = 4 * 1024 * 1024;
/**
 * 回传口令（2026-09-17 追加）：外部测试者的页面 URL 带 `rtok=<口令>`，页面提交时把它转成请求的
 * `token=<口令>`；隧道把本服务暴露到公网后，这是唯一的写入闸门。
 * 可用环境变量 `CH7_REPORT_TOKEN` 覆盖（改它需要重启 dev server）；缺省值用于本地与临时测试。
 * 换口令时**不用改代码**：只要换分发链接里的 rtok=（接收端缺省值不变即可）。
 */
const CH7_REPORT_TOKEN = process.env.CH7_REPORT_TOKEN || 'ch7-2026-phase4';

/** 本地时间戳 YYYYMMDD_HHmmss（到秒，避免同分钟的两个测试者撞名）。 */
function ch7Stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 回传端点的**实现**已移到 `tools/ch7_report_middleware.mjs`（2026-09-26）：
 * 真机实测发现"手机连 dev server（未打包）导致每轮要几分钟"，改法是让隧道指向构建产物
 * （`site-dist/`，整站 10 文件 0.42MB），而构建产物由 `vite preview` 伺服——
 * 于是这段中间件必须 dev（`configureServer`）与 preview（`configurePreviewServer`）**共用同一份**，
 * 否则两种伺服方式下的落盘目录/口令/命名规则会分叉。这里只做参数绑定。
 */
function ch7ReportPlugin() {
  return ch7ReportPluginImpl({ rawDir: CH7_RAW_DIR, token: CH7_REPORT_TOKEN, maxBody: CH7_MAX_BODY });
}

// ---------------------------------------------------------------- ch7 静态请求埋点（2026-09-23 追加）
/**
 * 为什么需要：真机测试出现过"页面白屏、无结果回传"的现象，而 vite dev server 默认不记录静态请求，
 * 事后无法区分"模型文件根本没下载完"与"下载完成后解析/上传阶段失败"（见 7.9 节探针记录）。
 * 本中间件只对 `*.ply` 请求在响应结束时打一行：状态码、实际写出的字节数、耗时。
 *   - 字节数是**写出量**（经过 gzip/brotli 或 throttled 管道后），因此可与磁盘字节数对照判断是否传输完整；
 *   - 同时落盘到 raw/_probe/ply_requests.log，方便真机测试失败后离线回溯（stdout 会随终端滚掉）。
 * 只在 `npm run dev` 下存在；不影响 build 产物，也不改变任何请求行为（仅挂 res 事件）。
 */
const CH7_PLY_LOG = resolve(__dirname, '../thesis_project/data/ch7_measurements/raw/_probe/ply_requests.log');
function ch7PlyLogPlugin() {
  return {
    name: 'configure-ch7-ply-log',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !/\.ply(\?|$)/.test(req.url)) return next();
        const t0 = Date.now();
        let sent = 0;
        const write = res.write.bind(res);
        const end = res.end.bind(res);
        res.write = (chunk, ...rest) => {
          if (chunk) sent += chunk.length;
          return write(chunk, ...rest);
        };
        res.end = (chunk, ...rest) => {
          if (chunk) sent += chunk.length;
          return end(chunk, ...rest);
        };
        res.on('finish', () => {
          const line = `[ch7-ply] ${ch7Stamp()} ${req.method} ${req.url} → ${res.statusCode} 写出 ${sent} B 耗时 ${Date.now() - t0} ms`;
          console.log(line);
          try {
            fs.appendFileSync(CH7_PLY_LOG, line + '\n');
          } catch {
            /* 日志写不进去不影响请求本身 */
          }
        });
        next();
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    ch7ReportPlugin(),
    ch7PlyLogPlugin(),
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
  // 隧道公网访问（2026-09-17 追加）：dev server 默认只接受 localhost / IP 字面量的 Host 头，
  // Cloudflare quick tunnel 的域名会被 vite 自己拒掉（403 "Blocked request. This host is not allowed."，
  // 表现为页面打不开但 curl 打 /__ch7/report 却正常）。这里放行 *.trycloudflare.com；
  // 以后换正式域名/别名，在数组里补一条即可（改完 vite 会自动重启，必要时手动重启）。
  server: {
    allowedHosts: ['localhost', '127.0.0.1', '.trycloudflare.com'],
  },
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
