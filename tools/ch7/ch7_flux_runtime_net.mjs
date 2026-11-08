/**
 * flux_net.mjs — [T1 2026-10-04] Flux-GS 页面**实际运行时**请求清单核对（无头 Edge + CDP `Network` 域）。
 *
 * 为什么必须实测而不是推断：论文要写"Flux 首次加载体积"的口径（场景数据 / 解码器 / 合计），
 * 而仓库里同时存在 `scene/*.json`、可能的 `xyz.bin/.ply`、以及 huggingface 兜底地址 —— 只有真跑一遍、
 * 把浏览器**实际发出的每个请求**（文件名 / 字节数 / Content-Encoding / 来源）记下来才算数。
 *
 * 用法：
 *   node _tmp_ch7probe\flux_net.mjs --url=<页面 URL> --out=<json 路径> [--secs=150] [--quiet=6000]
 *                                   [--port=9444] [--dpr=1] [--sentinel=<正则>]
 * 产物：JSON（请求全清单 + 按来源分组体积 + 页面文本 + 控制台尾部）。仅本地核对，不参与论文数据。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = /^--([^=]+)=?(.*)$/.exec(a);
        return m ? [m[1], m[2] === "" ? "1" : m[2]] : [a, "1"];
    }),
);
const url = args.url;
if (!url) throw new Error("缺少 --url=");
const outFile = args.out || join(process.cwd(), "_flux_net.json");
const port = Number(args.port || 9444);
const secs = Number(args.secs || 150);
const quietMs = Number(args.quiet || 6000);
const waitRe = new RegExp(args.sentinel || "__NO_SENTINEL__");
const dpr = Number(args.dpr || 1);
const browser = args.browser || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const profileDir = mkdtempSync(join(tmpdir(), "flux-net-"));
const child = spawn(
    browser,
    [
        "--headless=new",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--disable-features=CalculateNativeWinOcclusion,Translate",
        "--window-size=1280,800",
        "--allow-file-access-from-files",
        `--force-device-scale-factor=${dpr}`,
        "--use-angle=d3d11",
        ...(process.env.CH7_GPU === "high" ? ["--force_high_performance_gpu"] : []),
        "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
);
const browserLog = [];
child.stderr.on("data", (d) => browserLog.push(d.toString().trim().split("\n").slice(-1)[0]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageWs() {
    for (let i = 0; i < 80; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/json/list`);
            if (r.ok) {
                const t = (await r.json()).find((x) => x.type === "page");
                if (t && t.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
            }
        } catch {
            /* 浏览器还没起来 */
        }
        await sleep(500);
    }
    throw new Error("拿不到 page target（浏览器未起来）");
}

const ws = new WebSocket(await pageWs());
await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
});
let nextId = 1;
const pending = new Map();
const reqs = new Map(); // requestId → 记录
const consoleLines = [];
let loadFired = false;
let lastEvt = Date.now();
let sentinelHit = false;

const rec = (id, u0) => {
    let r = reqs.get(id);
    if (!r) {
        r = { url: u0 || "(unknown)", method: "", status: null, mime: "", contentEncoding: "", contentLength: null, encoded: 0, body: 0, fromCache: false, fromSW: false, ip: "", type: "", failed: "" };
        reqs.set(id, r);
    }
    return r;
};

function send(method, params = {}) {
    const id = nextId++;
    return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
    });
}
ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
        return;
    }
    if (!m.method) return;
    lastEvt = Date.now();
    const p = m.params || {};
    if (m.method === "Network.requestWillBeSent") {
        const r = rec(p.requestId, p.request.url);
        r.method = p.request.method;
        r.type = p.type || "";
    } else if (m.method === "Network.responseReceived") {
        const r = rec(p.requestId, p.response.url);
        r.status = p.response.status;
        r.mime = p.response.mimeType || "";
        r.fromCache = !!p.response.fromDiskCache;
        r.fromSW = !!p.response.fromServiceWorker;
        r.ip = p.response.remoteIPAddress || "";
        const h = p.response.headers || {};
        r.contentEncoding = h["content-encoding"] || h["Content-Encoding"] || "";
        r.contentLength = h["content-length"] ?? h["Content-Length"] ?? null;
    } else if (m.method === "Network.dataReceived") {
        rec(p.requestId).body += p.dataLength || 0;
    } else if (m.method === "Network.loadingFinished") {
        rec(p.requestId).encoded = p.encodedDataLength || 0;
    } else if (m.method === "Network.loadingFailed") {
        rec(p.requestId).failed = p.errorText || "failed";
    } else if (m.method === "Page.loadEventFired") {
        loadFired = true;
    } else if (m.method === "Runtime.consoleAPICalled" || m.method === "Runtime.exceptionThrown") {
        const isCon = m.method === "Runtime.consoleAPICalled";
        const text = isCon
            ? (p.args || []).map((a) => (a.value !== undefined ? a.value : a.description ?? a.type)).join(" ")
            : "exception: " + (p.exceptionDetails?.text || "") + " " + (p.exceptionDetails?.exception?.description || "");
        consoleLines.push(`${new Date().toISOString().slice(11, 19)} ${isCon ? p.type : "exception"}: ${text.slice(0, 400)}`);
        if (waitRe.test(text)) sentinelHit = true;
    }
};

const t0 = Date.now();
let pageText = "";
try {
    await send("Network.enable", { maxTotalBufferSize: 1e8, maxResourceBufferSize: 1e8 });
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Page.navigate", { url });
    const deadline = t0 + secs * 1000;
    while (Date.now() < deadline) {
        await sleep(2000);
        console.log(
            `t=${Math.round((Date.now() - t0) / 1000)}s reqs=${reqs.size} load=${loadFired} quiet=${Math.round((Date.now() - lastEvt) / 1000)}s`,
        );
        if (sentinelHit) {
            console.log("⇒ 哨兵命中，提前结束");
            break;
        }
        if (loadFired && Date.now() - lastEvt > quietMs) {
            console.log("⇒ 静默期达标（load 已触发且无新请求），提前结束");
            break;
        }
    }
    const ev = await Promise.race([
        send("Runtime.evaluate", { expression: "document.body ? document.body.innerText.slice(0,3000) : 'no-body'", returnByValue: true }),
        sleep(20000),
    ]);
    pageText = String(ev?.result?.value ?? "");
} catch (e) {
    pageText = "ERR " + e.message;
}

const list = [...reqs.values()].map((r) => {
    let origin = "(n/a)";
    try {
        origin = new URL(r.url).origin;
    } catch {
        /* data:/blob: 等无 origin */
    }
    return { ...r, origin };
});
const size = (r) => r.encoded || r.body || 0;
const byOrigin = {};
for (const r of list) {
    const o = (byOrigin[r.origin] = byOrigin[r.origin] || { count: 0, bytes: 0 });
    o.count++;
    o.bytes += size(r);
}
const remote = list.filter((r) => !/127\.0\.0\.1|localhost/.test(r.origin));
const out = {
    meta: { url, startedAt: new Date(t0).toISOString(), elapsedMs: Date.now() - t0, loadFired, cacheDisabled: true, browser },
    totals: { count: list.length, bytesEncoded: list.reduce((a, r) => a + r.encoded, 0), bytesBody: list.reduce((a, r) => a + r.body, 0), remoteCount: remote.length },
    byOrigin,
    remote,
    requests: list.slice().sort((a, b) => size(b) - size(a)),
    pageText,
    console: consoleLines.slice(-200),
    browserLog: browserLog.slice(-20),
};
writeFileSync(outFile, JSON.stringify(out, null, 2), "utf-8");
console.log(`WROTE ${outFile} reqs=${list.length} bytes=${list.reduce((a, r) => a + r.encoded, 0)}`);
console.log(JSON.stringify(byOrigin, null, 2));
try {
    ws.close();
} catch {
    /* ignore */
}
try {
    child.kill();
} catch {
    /* ignore */
}
await sleep(1200);
try {
    rmSync(profileDir, { recursive: true, force: true });
} catch {
    /* ignore */
}

