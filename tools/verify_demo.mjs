#!/usr/bin/env node
/**
 * Demo 部署验证脚本（headless 浏览器 + Chrome DevTools Protocol）。
 *
 * 作用：不依赖任何 npm 依赖（只用 Node 内置模块 + 全局 fetch/WebSocket，需 Node >= 21），
 * 用本机已有的 Edge/Chrome 无头模式打开一个部署好的 Demo 页面，自动：
 *   1. 探测 WebGL2 是否可用、记录实际 GL renderer；
 *   2. 读取场景下拉框并**模拟用户选择**一个场景（`--scene`，默认第一个）；
 *   3. 记录网络请求状态（是否存在 404/WASM 丢失）、控制台日志；
 *   4. 等场景加载完成后抓取控制台里的 `First Frame: x s` 与资源耗时；
 *   5. 截图并统计像素（非黑像素占比 / 平均亮度），用于判断"黑屏或几何爆炸"；
 *   6. 在 stdout 打印一份 JSON 报告（便于贴进文档），进度信息走 stderr。
 *
 * 用法：
 *   node tools/verify_demo.mjs --url=https://chxxx.github.io/gs-mobile/
 *   node tools/verify_demo.mjs --url=http://localhost:4173/ --scene=truck --mobile
 *   node tools/verify_demo.mjs --url=https://chxxx.github.io/gs-mobile/?scene=truck --no-select
 *   node tools/verify_demo.mjs --serve=site-dist --no-select --url="http://127.0.0.1:4173/?scene=truck"
 *
 * 参数：
 *   --url=<url>        必备（或配合 --serve 省略），Demo 页面地址（可带查询串）
 *   --scene=<值>       要选择的场景：下拉框 value（文件路径）、显示名，或 1 起的序号；缺省选第一个
 *   --no-select        不碰下拉框，只验证页面自身对 `?scene=` 的预选（直达链接冒烟用）
 *   --mobile           启用移动端模拟（390x844 / DPR 3 / Android UA）
 *   --serve=<dir>      由本脚本自带静态服务器托管该目录（如 site-dist/），无需另开 vite/npx
 *   --http-port=<n>    --serve 的监听端口（默认 4173，此时 --url 可省略）
 *   --out=<png>        截图输出路径（默认 _verify/demo-<desktop|mobile>.png）
 *   --wait=<ms>        选择场景后等待加载的上限（默认 240000）
 *   --settle=<ms>      加载完成后再停留多少毫秒用于 FPS 采样（默认 4000）
 *   --port=<n>         DevTools 端口（默认 9333）
 *   --browser=<path>   指定浏览器可执行文件（默认自动查找 Edge/Chrome）
 *   --extra-args=<a,b> 追加给浏览器的命令行参数
 *
 * 注意：无头软件渲染（SwiftShader）得到的 FPS **不代表真机性能**，本脚本报告里的
 * fpsText/耗时只用于"能不能跑起来、大致的数量级"，不要写进对外 README 当性能结论。
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { inflateSync } from 'node:zlib';

const BROWSER_CANDIDATES = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

function parseArgs(argv) {
    const opts = {
        url: '',
        scene: '',
        mobile: false,
        out: '',
        wait: 240000,
        settle: 4000,
        port: 9333,
        browser: '',
        extraArgs: [],
        serve: '',
        httpPort: 4173,
        noSelect: false,
    };
    for (const raw of argv.slice(2)) {
        const eq = raw.indexOf('=');
        if (eq < 0) {
            if (raw === '--mobile') opts.mobile = true;
            else if (raw === '--no-select') opts.noSelect = true;
            continue;
        }
        const key = raw.slice(2, eq);
        const val = raw.slice(eq + 1);
        if (key === 'url') opts.url = val;
        else if (key === 'scene') opts.scene = val;
        else if (key === 'out') opts.out = val;
        else if (key === 'wait') opts.wait = Number(val);
        else if (key === 'settle') opts.settle = Number(val);
        else if (key === 'port') opts.port = Number(val);
        else if (key === 'browser') opts.browser = val;
        else if (key === 'extra-args') opts.extraArgs = val.split(',').filter(Boolean);
        else if (key === 'serve') opts.serve = val;
        else if (key === 'http-port') opts.httpPort = Number(val);
    }
    if (!opts.out) opts.out = opts.mobile ? '_verify/demo-mobile.png' : '_verify/demo-desktop.png';
    // --serve 自带静态服务器：不传 --url 时默认访问它的根路径
    if (!opts.url && opts.serve) opts.url = `http://127.0.0.1:${opts.httpPort}/`;
    return opts;
}

const log = (...a) => console.error('[verify]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser(explicit) {
    if (explicit) return existsSync(explicit) ? explicit : '';
    if (process.env.BROWSER_PATH && existsSync(process.env.BROWSER_PATH)) return process.env.BROWSER_PATH;
    return BROWSER_CANDIDATES.find((p) => existsSync(p)) || '';
}

/** 极简 CDP 客户端：一条 WebSocket 连一个 page target。 */
class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 0;
        this.pending = new Map();
        this.listeners = [];
        ws.addEventListener('message', (ev) => {
            let msg;
            try {
                msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
            } catch {
                return;
            }
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const { resolve: res, reject: rej } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) rej(new Error(`${msg.error.message}`));
                else res(msg.result);
            } else if (msg.method) {
                for (const l of this.listeners) l(msg);
            }
        });
    }
    on(fn) {
        this.listeners.push(fn);
    }
    send(method, params = {}) {
        const id = ++this.nextId;
        return new Promise((res, rej) => {
            this.pending.set(id, { resolve: res, reject: rej });
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    rej(new Error(`CDP timeout: ${method}`));
                }
            }, 120000);
        });
    }
    async evaluate(expression, awaitPromise = false) {
        const r = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise,
        });
        if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.text}`);
        return r.result ? r.result.value : undefined;
    }
}

/**
 * 解析 PNG（8bit、非隔行、colorType 2/6）并统计画面亮度，用来客观区分
 * "渲染出内容" 与 "黑屏/几何爆炸"。只做最少的解码：IHDR + IDAT + 反滤波。
 */
function pngStats(buf) {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
    let off = 8;
    let width = 0;
    let height = 0;
    let colorType = 0;
    let bitDepth = 0;
    const idat = [];
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') break;
        off += 12 + len;
    }
    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG (bitDepth=${bitDepth}, colorType=${colorType})`);
    }
    const bpp = colorType === 6 ? 4 : 3;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    const px = Buffer.alloc(height * stride);
    let p = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[p++];
        const rowIn = raw.subarray(p, p + stride);
        p += stride;
        const rowOut = px.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? rowOut[x - bpp] : 0;
            const b = prev ? prev[x] : 0;
            const c = prev && x >= bpp ? prev[x - bpp] : 0;
            let v = rowIn[x];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const pa = Math.abs(b - c);
                const pb = Math.abs(a - c);
                const pc = Math.abs(a + b - 2 * c);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            rowOut[x] = v & 0xff;
        }
    }
    let sum = 0;
    let nonBlack = 0;
    let bright = 0;
    const total = width * height;
    for (let i = 0; i < total; i++) {
        const r = px[i * bpp];
        const g = px[i * bpp + 1];
        const b = px[i * bpp + 2];
        const m = Math.max(r, g, b);
        sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (m > 16) nonBlack++;
        if (m > 200) bright++;
    }
    // 32x18 灰度缩略签名：用于比较"拖动前后画面是否真的变了"（交互性证据）
    const gx = 32;
    const gy = 18;
    const acc = new Float64Array(gx * gy);
    const cnt = new Float64Array(gx * gy);
    for (let y = 0; y < height; y++) {
        const by = Math.min(gy - 1, ((y * gy) / height) | 0);
        for (let x = 0; x < width; x++) {
            const bx = Math.min(gx - 1, ((x * gx) / width) | 0);
            const i = (y * width + x) * bpp;
            const k = by * gx + bx;
            acc[k] += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
            cnt[k] += 1;
        }
    }
    return {
        width,
        height,
        meanLuma: +(sum / total).toFixed(2),
        nonBlackRatio: +(nonBlack / total).toFixed(4),
        brightRatio: +(bright / total).toFixed(4),
        signature: Array.from(acc, (v, i) => (cnt[i] ? v / cnt[i] : 0)),
    };
}

/** 静态服务器用到的 MIME 表（演示站产物只有这几类文件）。 */
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.ply': 'application/octet-stream',
    '.splat': 'application/octet-stream',
    '.bin': 'application/octet-stream',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
};

/**
 * `--serve=<dir>` 用的静态目录服务器：把 `vite.site.config.js` 的产物（site-dist/）就地托管，
 * 于是在这台机器上做"部署前离线冒烟"只需一条命令、一个进程（不用另开 `npm run site:preview`，
 * 那种后台服务在本环境里会被下一条命令杀掉）。不做压缩/缓存协商：浏览器直接拿原始文件。
 */
function startStaticServer(rootDir, port) {
    const root = resolve(rootDir);
    if (!existsSync(root)) throw new Error(`--serve 目录不存在: ${root}`);
    const server = createServer((req, res) => {
        let rel = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
        if (rel.endsWith('/')) rel += 'index.html';
        let file = resolve(root, '.' + rel);
        if (file !== root && !file.startsWith(root + sep)) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('403 forbidden');
            return;
        }
        let stat = existsSync(file) ? statSync(file) : null;
        if (stat && stat.isDirectory()) {
            file = join(file, 'index.html');
            stat = existsSync(file) ? statSync(file) : null;
        }
        if (!stat) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('404 not found');
            return;
        }
        res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Content-Length', String(stat.size));
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        createReadStream(file).pipe(res);
    });
    return new Promise((res, rej) => {
        server.once('error', rej);
        server.listen(port, '127.0.0.1', () => {
            log(`静态服务器: http://127.0.0.1:${port}/ → ${root}`);
            res({ server, url: `http://127.0.0.1:${port}/`, close: () => server.close() });
        });
    });
}

async function launchBrowser(opts) {
    const exe = findBrowser(opts.browser);
    if (!exe) throw new Error('未找到 Edge/Chrome，可用 --browser=<path> 指定');
    const profile = mkdtempSync(join(tmpdir(), 'verify-demo-'));
    const args = [
        '--headless=new',
        `--remote-debugging-port=${opts.port}`,
        '--remote-allow-origins=*',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--hide-scrollbars',
        '--mute-audio',
        '--window-size=1280,720',
        '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage',
        'about:blank',
        ...opts.extraArgs,
    ];
    log(`启动浏览器: ${exe}`);
    const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
    const base = `http://127.0.0.1:${opts.port}`;
    let pageWs = '';
    for (let i = 0; i < 120; i++) {
        try {
            const list = await fetch(`${base}/json/list`).then((r) => r.json());
            const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) {
                pageWs = page.webSocketDebuggerUrl;
                break;
            }
        } catch {
            /* not up yet */
        }
        await sleep(250);
    }
    if (!pageWs) {
        proc.kill();
        throw new Error(`DevTools 端口未就绪（${base}/json/list）`);
    }
    const ws = new WebSocket(pageWs);
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', (e) => rej(new Error(`WebSocket 连接失败: ${e.message || e.type}`)), { once: true });
    });
    return { proc, cdp: new Cdp(ws), exe, profile };
}

/** 用鼠标/触摸事件模拟一次拖拽（OrbitControls 监听 canvas 的 mouse* / touch* 事件）。 */
async function dragOnce(cdp, mobile, from, to) {
    const steps = 8;
    if (mobile) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: from.x, y: from.y, id: 1 }],
        });
        for (let i = 1; i <= steps; i++) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [
                    { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, id: 1 },
                ],
            });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        return 'touch';
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...from });
    for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            button: 'left',
            buttons: 1,
            x: from.x + ((to.x - from.x) * i) / steps,
            y: from.y + ((to.y - from.y) * i) / steps,
        });
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...to });
    return 'mouse';
}

function shotDiff(a, b) {
    if (!a || !b || a.length !== b.length) return null;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return +(sum / a.length).toFixed(2);
}

async function main() {
    const opts = parseArgs(process.argv);
    if (!opts.url) {
        console.error('用法: node tools/verify_demo.mjs --url=<demo url> [--scene=<name|path|index>] [--mobile] [--out=<png>]');
        console.error('      node tools/verify_demo.mjs --serve=site-dist --no-select --url="http://127.0.0.1:4173/?scene=truck"');
        process.exit(2);
    }
    mkdirSync(dirname(resolve(opts.out)), { recursive: true });

    // --serve：由本进程托管站点产物做离线冒烟（进程退出即关闭，不留后台服务）
    const local = opts.serve ? await startStaticServer(opts.serve, opts.httpPort) : null;

    const { proc, cdp, exe } = await launchBrowser(opts);
    const startedAt = new Date().toISOString();
    const consoleLogs = [];
    const pageErrors = [];
    const netStart = new Map();
    const netResponses = new Map();
    const netDone = [];
    let loadEventMs = null;

    cdp.on((msg) => {
        const { method, params } = msg;
        if (method === 'Runtime.consoleAPICalled') {
            const text = (params.args || [])
                .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
                .join(' ');
            consoleLogs.push({ level: params.type, text });
        } else if (method === 'Runtime.exceptionThrown') {
            pageErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'unknown');
        } else if (method === 'Log.entryAdded') {
            pageErrors.push(`[${params.entry.level}] ${params.entry.text}`);
        } else if (method === 'Page.javascriptDialogOpening') {
            pageErrors.push(`[dialog] ${params.type}: ${params.message}`);
            void cdp.send('Page.handleJavaScriptDialog', { accept: true });
        } else if (method === 'Page.loadEventFired') {
            loadEventMs = params.timestamp * 1000;
        } else if (method === 'Network.requestWillBeSent') {
            netStart.set(params.requestId, { url: params.request.url, ts: params.timestamp * 1000 });
        } else if (method === 'Network.responseReceived') {
            netResponses.set(params.requestId, { status: params.response.status });
        } else if (method === 'Network.loadingFinished') {
            const s = netStart.get(params.requestId);
            const r = netResponses.get(params.requestId);
            if (s) {
                netDone.push({
                    file: s.url.split('/').pop() || s.url,
                    url: s.url,
                    status: r ? r.status : null,
                    ms: +(params.timestamp * 1000 - s.ts).toFixed(1),
                    bytes: params.encodedDataLength,
                });
            }
        }
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');
    if (opts.mobile) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            mobile: true,
        });
        await cdp.send('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }

    log(`打开 ${opts.url}`);
    await cdp.send('Page.navigate', { url: opts.url });
    for (let i = 0; i < 200; i++) {
        const ready = await cdp.evaluate('document.readyState').catch(() => '');
        if (ready === 'complete') break;
        await sleep(150);
    }
    await sleep(1500);

    const readiness = await cdp.evaluate(`(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        const out = { webgl2: !!gl, renderer: '', vendor: '', maxTexture: 0 };
        if (gl) {
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            if (dbg) {
                out.renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
                out.vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '';
            }
            out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        }
        return out;
    })()`);

    const options = await cdp.evaluate(
        `(() => { const s = document.getElementById('scene-select'); return s ? [...s.options].map((o, i) => ({ i: i + 1, value: o.value, text: o.textContent })) : []; })()`,
    );
    const selectable = options.filter((o) => o.value);
    if (selectable.length === 0) pageErrors.push('没有可选场景（scenes.json 未加载或为空）');
    let target = selectable[0];
    if (opts.scene) {
        const wanted = opts.scene.toLowerCase();
        target =
            selectable.find((o) => o.value.toLowerCase() === wanted) ||
            selectable.find((o) => o.value.toLowerCase().includes(wanted)) ||
            selectable.find((o) => o.text.toLowerCase().includes(wanted)) ||
            selectable.find((o) => String(o.i) === wanted) ||
            target;
    }

    /** 等"场景已就绪"（demo.ts 加载完成后会隐藏 drop-zone）。 */
    const waitSceneReady = async () => {
        const deadline = Date.now() + opts.wait;
        while (Date.now() < deadline) {
            const state = await cdp
                .evaluate(
                    `(() => { const d = document.getElementById('drop-zone'); return { dropHidden: !!(d && d.style.display === 'none') }; })()`,
                )
                .catch(() => null);
            if (state && state.dropHidden) return true;
            await sleep(300);
        }
        return false;
    };
    const plyMsOf = () => {
        const ply = netDone.find((n) => n.file.endsWith('.ply'));
        return ply ? ply.ms : null;
    };

    let plyMs = null;
    let autoSelected = false;
    if (opts.noSelect) {
        // 不碰下拉框：只读取页面自身因 `?scene=` 预选出来的值（验证直达链接用）
        const preset = await cdp.evaluate(
            `(() => { const s = document.getElementById('scene-select'); if (!s || !s.value) return null; const o = s.selectedOptions && s.selectedOptions[0]; return { i: s.selectedIndex + 1, value: s.value, text: o ? o.textContent : '' }; })()`,
        );
        if (preset && preset.value) {
            target = preset;
            autoSelected = true;
            log(`页面自身预选（URL 参数）: ${preset.text} (${preset.value})`);
            if (!(await waitSceneReady())) pageErrors.push(`场景加载超时（>${opts.wait} ms）`);
            plyMs = plyMsOf();
        } else {
            pageErrors.push('--no-select：页面未按 URL 参数自动加载场景（下拉框仍是占位项）');
        }
    } else if (target) {
        log(`选择场景: ${target.text} (${target.value})`);
        await cdp.evaluate(
            `(() => { const s = document.getElementById('scene-select'); s.value = ${JSON.stringify(target.value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`,
        );
        if (!(await waitSceneReady())) pageErrors.push(`场景加载超时（>${opts.wait} ms）`);
        plyMs = plyMsOf();
    }

    await sleep(opts.settle);
    const runtime = await cdp.evaluate(`(() => ({
        fps: (document.getElementById('fps-counter') || {}).textContent || '',
        canvas: (() => { const c = document.getElementById('canvas'); return c ? c.width + 'x' + c.height + ' (css ' + c.clientWidth + 'x' + c.clientHeight + ')' : ''; })(),
        resources: performance.getEntriesByType('resource')
            .filter((r) => /\\.(ply|js|wasm|json|css)$/.test(r.name))
            .map((r) => ({ file: r.name.split('/').pop(), ms: +r.duration.toFixed(1), kb: Math.round((r.transferSize || 0) / 1024) })),
    }))()`);

    const geometry = await cdp.evaluate(
        `(() => { const c = document.getElementById('canvas'); return { w: c ? c.clientWidth : 0, h: c ? c.clientHeight : 0 }; })()`,
    );
    const from = { x: Math.round(geometry.w * 0.55), y: Math.round(geometry.h * 0.5) };
    const to = { x: Math.round(geometry.w * 0.3), y: Math.round(geometry.h * 0.36) };

    const shotA = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const bufA = Buffer.from(shotA.data, 'base64');
    writeFileSync(resolve(opts.out), bufA);
    const statsA = pngStats(bufA);

    const dragKind = await dragOnce(cdp, opts.mobile, from, to);
    await sleep(2500);
    const shotB = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const bufB = Buffer.from(shotB.data, 'base64');
    const outB = resolve(opts.out).replace(/\.png$/i, '-after-drag.png');
    writeFileSync(outB, bufB);
    const statsB = pngStats(bufB);

    const firstFrame = consoleLogs.map((l) => /First Frame:\s*([0-9.]+)\s*s/.exec(l.text)).find(Boolean);
    const vertexLog = consoleLogs.map((l) => /Vertex count:\s*(\d+)/.exec(l.text)).find(Boolean);
    const badStatus = netDone.filter((n) => n.status === null || n.status >= 400);

    const report = {
        url: opts.url,
        startedAt,
        browser: exe,
        mobileEmulation: opts.mobile,
        noSelect: opts.noSelect,
        autoSelectedFromUrl: autoSelected,
        localServeDir: opts.serve ? resolve(opts.serve) : null,
        webgl: readiness,
        selectedScene: target || null,
        sceneOptions: options,
        firstFrameSeconds: firstFrame ? Number(firstFrame[1]) : null,
        vertexCountLogged: vertexLog ? Number(vertexLog[1]) : null,
        plyNetworkMs: plyMs,
        fpsTextAfterSettle: runtime.fps,
        canvasSize: runtime.canvas,
        resourceTimings: runtime.resources,
        screenshot: { file: resolve(opts.out), stats: { ...statsA, signature: undefined } },
        afterDrag: {
            kind: dragKind,
            file: outB,
            stats: { ...statsB, signature: undefined },
            signatureDiff: shotDiff(statsA.signature, statsB.signature),
        },
        networkProblems: badStatus.map((n) => ({ file: n.file, status: n.status })),
        pageErrors: pageErrors.slice(0, 30),
        consoleHighlights: consoleLogs
            .filter((l) => /(First Frame|Vertex count|Render resolution|Failed|error|WebGL|Perf|splat|tweak|\[scene\])/i.test(l.text))
            .map((l) => `${l.level}: ${l.text}`)
            .slice(0, 40),
    };
    console.log(JSON.stringify(report, null, 2));
    proc.kill();
    if (local) local.close();
    await sleep(300);
}

main().catch((e) => {
    console.error('[verify] 失败:', e && e.stack ? e.stack : e);
    process.exit(1);
});
