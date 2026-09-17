import { defineConfig } from 'vite';
import { join, resolve } from 'path';
import fs from 'node:fs';
import dts from 'vite-plugin-dts';
import compression from 'vite-plugin-compression';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import compressionMiddleware from 'compression';

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

/** 把 URL 里的 name 收敛成安全的文件名片段（中文/空格/斜杠/引号等一律换成 '_'）。 */
function ch7SafeName(raw) {
  const cleaned = String(raw || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 64);
  return cleaned || 'anon';
}

/** 本地时间戳 YYYYMMDD_HHmmss（到秒，避免同分钟的两个测试者撞名）。 */
function ch7Stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 同秒撞名时依次尝试 `<name>_<ts>-2.txt`、`-3.txt`… */
function ch7TargetPath(name) {
  const ts = ch7Stamp();
  let file = join(CH7_RAW_DIR, `${name}_${ts}.txt`);
  for (let n = 2; fs.existsSync(file); n++) {
    file = join(CH7_RAW_DIR, `${name}_${ts}-${n}.txt`);
  }
  return file;
}

function ch7ReportPlugin() {
  return {
    name: 'configure-ch7-report',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/__ch7/report')) return next();
        const cors = () => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        };
        if (req.method === 'OPTIONS') {
          cors();
          res.statusCode = 204;
          res.end();
          return;
        }
        const fail = (code, msg) => {
          cors();
          res.statusCode = code;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(msg + '\n');
          console.log(`[ch7-report] 拒收（${code}）：${msg}`);
        };
        if (req.method !== 'POST') return fail(405, 'only POST');
        const url = new URL(req.url, 'http://localhost');
        // 口令闸门：不符就"不读 body、不写盘"，并且**只在终端打印一行、不回显收到的值**（避免日志泄露口令）
        if ((url.searchParams.get('token') || '') !== CH7_REPORT_TOKEN) {
          req.resume();
          return fail(403, 'token 不匹配');
        }
        const name = ch7SafeName(url.searchParams.get('name'));
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
          size += c.length;
          if (size > CH7_MAX_BODY) {
            req.destroy();
            return fail(413, `body too large (>${CH7_MAX_BODY} bytes)`);
          }
          chunks.push(c);
        });
        req.on('error', () => {
          /* 客户端中断（测试者提前关页面）：下面的 end 不会触发，静默即可 */
        });
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const text = body.toString('utf-8');
          // 宽松但有效的协议校验：必须是跑批页面产出的结果文本，避免垃圾/探测请求污染数据目录
          if (!text.includes('[RESULT]') || !text.includes('[END]')) {
            return fail(400, 'not a [RESULT]...[END] report body');
          }
          try {
            fs.mkdirSync(CH7_RAW_DIR, { recursive: true });
            const file = ch7TargetPath(name);
            // 先写 .part 再改名：报表脚本永远不会读到半截文件
            fs.writeFileSync(file + '.part', body);
            fs.renameSync(file + '.part', file);
            cors();
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(`OK ${file}\n`);
            console.log(`[ch7-report] 已保存 ${file}（${body.length} 字节，name=${name}）`);
          } catch (e) {
            fail(500, `write failed: ${e && e.message ? e.message : e}`);
          }
        });
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    ch7ReportPlugin(),
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
