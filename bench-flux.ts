/**
 * bench-flux.ts — 第7章对比方法（Flux-GS）离屏测帧页。
 *
 * 为什么是 iframe 桥接：Flux-GS 只有其自带 WebGL 渲染器
 * （flux-gs-project-gh-pages/render_<scene>/index.html），本仓库的 PLY/QPLY 加载器无法加载它的
 * 压缩格式，因此本页在同源 iframe 里驱动 Flux-GS 渲染器，而不是重写它的解码器。
 *
 * 与 bench.html 对齐的测量口径（论文 7.2.2，参考协议 = Flux-GS 原协议）：
 *   1. 画布分辨率 = **渲染器原生策略**（点数 > 500000 → 1× CSS；否则 CSS × devicePixelRatio），
 *      即"分辨率随设备与场景变化"，与 Flux-GS 论文报告的测帧条件一致；用 `force=WxH` 可强制对照旧口径；
 *      本文臂可用 `res=table` 按 bench-resolutions.json 逐场景匹配同一像素负载；
 *   2. 帧率：调用渲染器自带的 window.runFluxBenchmark(frames)，其内部用 setTimeout(0) 链驱动完整帧，
 *      300 帧、**无预热**（与 Flux-GS 原实现一致）；warmup 参数可显式覆盖；
 *   3. 首帧：只计"模型文件获取完成之后"的解码、纹理上传与首个真实绘制帧，不含网络下载段；
 *   4. 冷启动：每轮新建 iframe、追加 ts= 令牌重取模型；整页冷启动刷新由 sessionStorage 续跑。
 *   5. 机位：测帧会话启动即冻结（carousel=false），并在结果里输出 pose= 指纹供核对。
 *
 * URL：bench-flux.html?profile=full|mip360|tnt|db|quick&rounds=3&cold=1&u=xxx&frames=300&warmup=0
 *      bench-flux.html?...&force=1600x1063   （强制分辨率，与旧口径对照）
 */

// ------------------------------------------------------------------ DOM
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const stage = $<HTMLElement>("stage");
const frameHost = $<HTMLElement>("frame-host");
const statusBig = $<HTMLElement>("status-big");
const stDevice = $<HTMLElement>("st-device");
const stRes = $<HTMLElement>("st-res");
const stScene = $<HTMLElement>("st-scene");
const stProgress = $<HTMLElement>("st-progress");
const benchControls = $<HTMLElement>("bench-controls");
const progressRow = $<HTMLElement>("bench-progress");
const progressFill = $<HTMLElement>("bar-fill");
const resultCard = $<HTMLElement>("result-card");
const rcText = $<HTMLTextAreaElement>("rc-text");
const rcSummary = $<HTMLElement>("rc-summary");
const btnStart = $<HTMLButtonElement>("btn-start");
const btnCopy = $<HTMLButtonElement>("btn-copy");
const btnDone = $<HTMLButtonElement>("btn-done");
const btnExport = $<HTMLButtonElement>("btn-export");
const selProfile = $<HTMLSelectElement>("sel-profile");
const inpRounds = $<HTMLInputElement>("inp-rounds");
const inpFrames = $<HTMLInputElement>("inp-frames");
const selCold = $<HTMLSelectElement>("sel-cold");

// ------------------------------------------------------------------ types
interface FluxSceneMeta {
    id: string;
    name: string;
    dataset: string;
    page: string;
    model: string;
    storageMB?: number;
}
/** 由 render_shared/main.js 的 benchmark 钩子写入（iframe 内时间轴，单位 ms）。 */
interface FluxStats {
    enabled: boolean;
    t0: number;
    fetchStartAt: number;
    fetchEndAt: number;
    decodeDoneAt: number;
    texUploadDoneAt: number;
    firstFrameAt: number;
    resW: number;
    resH: number;
}
interface FluxBenchResult {
    fps: number;
    frames: number;
    ms: number;
    resW: number;
    resH: number;
    /** 测帧首帧的画面覆盖率（由渲染器钩子统计，用于与本文方法做可比性核对） */
    coveredPct?: number;
    /** 测帧所用视图矩阵（保留 3 位小数），用于核对每轮机位是否一致 */
    view?: number[];
}
interface RoundResult {
    scene: string;
    dataset: string;
    round: number;
    ts: string;
    ok: boolean;
    err?: string;
    fps?: number;
    firstFrameMs?: number;
    fetchMs?: number;
    decodeMs?: number;
    texMs?: number;
    bytes?: number;
    resW?: number;
    resH?: number;
    storageMB?: number;
    /** 画面覆盖率（可比性核对：与本文方法同场景的 covered% 对照） */
    coveredPct?: number;
    /** 机位指纹（视图矩阵前 6 项；每轮应完全一致，否则说明机位未固定） */
    poseKey?: string;
    /** `pose=ours` 时机位是否成功注入（false 表示仍用 Flux-GS 自己的机位） */
    poseInjected?: boolean;
    /** dump=1 时导出的世界坐标点数 */
    dumped?: number;
}
interface BenchState {
    v: number;
    busy: boolean;
    u: string;
    sceneIds: string[];
    rounds: number;
    cold: boolean;
    resW: number;
    resH: number;
    benchFrames: number;
    warmupFrames: number;
    idx: number;
    roundDone: number;
    results: RoundResult[];
    started: number;
}

const STATE_KEY = "gsm-fluxbench-v1";
const ARCHIVE_KEY = "gsm-fluxbench-archive-v1";


// ------------------------------------------------------------------ small utils
function param(name: string, dflt = ""): string {
    try {
        const v = new URLSearchParams(location.search).get(name);
        return v === null ? dflt : v;
    } catch {
        return dflt;
    }
}
function fmt(n: number | undefined, digits = 1): string {
    return n === undefined || !Number.isFinite(n) ? "-" : n.toFixed(digits);
}
function median(nums: number[]): number | undefined {
    if (nums.length === 0) return undefined;
    const a = [...nums].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ------------------------------------------------------------------ scene manifest
let manifest: FluxSceneMeta[] = [];
/** 本文臂导出的逐场景视图矩阵（bench-camviews.json）；`pose=ours` 时注入到 Flux-GS 渲染器，
 *  使基线在**完全相同的机位**下测帧。 */
let camViews: Record<string, number[]> = {};

async function loadCamViews(): Promise<void> {
    try {
        const res = await fetch("./bench-camviews.json");
        if (!res.ok) return;
        const json = (await res.json()) as { views?: Record<string, number[]> };
        camViews = json.views ?? {};
    } catch {
        /* 缺失时用 Flux-GS 自己的机位 */
    }
}

/** pose=aligned 用：由 align_flux_positions.py 生成的"本文机位→其坐标系"注入表。 */
async function loadInjectedViews(): Promise<Record<string, number[]>> {
    try {
        const res = await fetch("./bench-camviews-flux.json");
        if (!res.ok) return {};
        const json = (await res.json()) as { views?: Record<string, number[]> };
        return json.views ?? {};
    } catch {
        return {};
    }
}

async function loadManifest(): Promise<void> {
    const res = await fetch("./flux-baseline-scenes.json");
    if (!res.ok) throw new Error(`flux-baseline-scenes.json 加载失败：HTTP ${res.status}`);
    const json = (await res.json()) as { scenes?: FluxSceneMeta[] };
    manifest = Array.isArray(json.scenes) ? json.scenes : [];
}
function sceneById(id: string): FluxSceneMeta | undefined {
    return manifest.find((s) => s.id === id);
}
function expandProfile(profile: string): string[] {
    if (profile === "full") return manifest.map((s) => s.id);
    if (profile === "mip360" || profile === "tnt" || profile === "db") {
        return manifest.filter((s) => s.dataset === profile).map((s) => s.id);
    }
    if (profile === "quick") return ["garden", "truck", "drjohnson"].filter((id) => sceneById(id));
    return [];
}

// ------------------------------------------------------------------ device info
function glRendererName(): string {
    try {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl2") as WebGL2RenderingContext | null;
        if (!gl) return "";
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        return String(name || "");
    } catch {
        return "";
    }
}
function guessChip(): string {
    const g = glRendererName();
    if (/qualcomm|adreno/i.test(g)) {
        const m = /Adreno[^0-9]*(\d+)/i.exec(g);
        return m ? `Snapdragon (Adreno ${m[1]})` : "Qualcomm Adreno";
    }
    if (/immortalis|mali|mediatek/i.test(g)) {
        const m = /Immortalis[^0-9]*(\d+)|Mali[^0-9]*G?(\d+)/i.exec(g);
        return m ? `MediaTek/ARM (${m[1] || m[2]})` : "ARM Mali";
    }
    return g || "unknown";
}
function deviceInfo(): Record<string, string | number> {
    return {
        ua: navigator.userAgent,
        gl_renderer: glRendererName(),
        chip: guessChip(),
        screen: `${window.screen.width}x${window.screen.height}`,
        dpr: window.devicePixelRatio || 1,
        hardwareConcurrency: navigator.hardwareConcurrency || 0,
        timestamp: new Date().toISOString(),
    };
}

// ------------------------------------------------------------------ stage sizing
/**
 * iframe 的布局尺寸固定为离屏分辨率（保证渲染器内部 innerWidth/Height 与画布一致），
 * 仅用 CSS transform 缩放显示，因此缩放不改变被测渲染负载。
 */
function layoutStage(): void {
    const w = stage.clientWidth || 1;
    const h = stage.clientHeight || 1;
    const hostW = Number(frameHost.dataset.w || "1600");
    const hostH = Number(frameHost.dataset.h || "1063");
    const s = Math.min(1, w / hostW, h / hostH);
    frameHost.style.transform = `scale(${s.toFixed(4)})`;
}


// ------------------------------------------------------------------ session state
type FluxWindow = Window & {
    __FLUXGS_STATS__?: FluxStats;
    __FLUXGS_SET_CAM__?: (view16: number[]) => boolean;
    __FLUXGS_DUMP_XYZ__?: () => Float32Array | null;
    runFluxBenchmark?: (count?: number) => Promise<FluxBenchResult | null> | void;
};

/** 轮询等待渲染器暴露注入接口并调用（钩子在 main() 里 fetch 之后才定义，需要等一下）。 */
async function injectView(cw: FluxWindow, view: number[], timeoutMs = 30000): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        const fn = cw.__FLUXGS_SET_CAM__;
        if (typeof fn === "function") {
            try {
                return fn.call(cw, view) !== false;
            } catch {
                return false;
            }
        }
        await sleep(100);
    }
    return false;
}

function loadState(): BenchState | null {
    try {
        const raw = sessionStorage.getItem(STATE_KEY);
        return raw ? (JSON.parse(raw) as BenchState) : null;
    } catch {
        return null;
    }
}
function saveState(st: BenchState): void {
    try {
        sessionStorage.setItem(STATE_KEY, JSON.stringify(st));
    } catch {
        /* ignore */
    }
}
function clearState(): void {
    try {
        sessionStorage.removeItem(STATE_KEY);
    } catch {
        /* ignore */
    }
}
function archiveState(st: BenchState): void {
    try {
        const prev = localStorage.getItem(ARCHIVE_KEY);
        const arr = prev ? (JSON.parse(prev) as BenchState[]) : [];
        arr.push(st);
        localStorage.setItem(ARCHIVE_KEY, JSON.stringify(arr));
    } catch {
        /* ignore */
    }
}

// ------------------------------------------------------------------ ui helpers
function updateProgress(done: number, total: number, sceneName: string, roundText: string): void {
    progressRow.classList.remove("hidden");
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    progressFill.style.width = `${pct}%`;
    stProgress.textContent = `${done}/${total} 轮`;
    stScene.textContent = `${sceneName} · ${roundText}`;
}
function flashStatusBig(text: string): void {
    statusBig.textContent = text;
    statusBig.classList.remove("hidden");
}
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_resolve, reject) =>
            setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms),
        ),
    ]);
}


// ------------------------------------------------------------------ iframe bridge
function waitIframeLoad(iframe: HTMLIFrameElement, timeoutMs = 30000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("iframe 加载超时")), timeoutMs);
        iframe.addEventListener(
            "load",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}

/** 渲染器内部错误文案暴露在 #message（main() 的 catch 分支写入）。 */
function iframeErrorText(cw: FluxWindow): string {
    try {
        const el = cw.document.getElementById("message");
        return el ? (el.textContent || "").trim() : "";
    } catch {
        return "";
    }
}

/** 轮询等待 benchmark 钩子写入首帧时刻。 */
async function waitFirstFrame(cw: FluxWindow, timeoutMs = 180000): Promise<FluxStats> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        const err = iframeErrorText(cw);
        if (err) throw new Error(`Flux-GS 加载失败：${err}`);
        const stats = cw.__FLUXGS_STATS__;
        if (stats && stats.firstFrameAt > 0) return stats;
        await sleep(200);
    }
    throw new Error("等待 Flux-GS 首帧超时");
}

/** 从 iframe 的 Resource Timing 里取模型文件的下载段（与 bench.html 同口径）。 */
function modelFetchTiming(
    cw: FluxWindow,
    modelName: string,
): { fetchMs?: number; bytes?: number; responseEnd?: number } {
    try {
        const entries = cw.performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (!e.name.includes(modelName) || !e.responseEnd) continue;
            return {
                fetchMs: e.duration,
                bytes: e.transferSize > 0 ? e.transferSize : undefined,
                responseEnd: e.responseEnd,
            };
        }
    } catch {
        /* ignore */
    }
    return {};
}

/** dump=1：把 iframe 里解码出的世界坐标下载成本地 .bin（Float32 LE，N×3）。 */
function exportXyzDump(cw: FluxWindow, sceneId: string): number {
    const fn = cw.__FLUXGS_DUMP_XYZ__;
    const xyz = typeof fn === "function" ? (fn.call(cw) as Float32Array | null) : null;
    if (!xyz || xyz.length === 0) return 0;
    const blob = new Blob([xyz.buffer as ArrayBuffer], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `xyz-${sceneId}.bin`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return xyz.length / 3;
}

async function runBenchmark(cw: FluxWindow, frames: number, timeoutMs: number): Promise<FluxBenchResult> {
    const fn = cw.runFluxBenchmark;
    if (typeof fn !== "function") {
        throw new Error("Flux-GS 渲染器未暴露 runFluxBenchmark：请确认已应用 render_shared/main.js 的 benchmark 钩子");
    }
    const result = await withTimeout(Promise.resolve(fn.call(cw, frames)), timeoutMs, `runFluxBenchmark(${frames})`);
    if (!result || !Number.isFinite(result.fps) || result.fps <= 0) {
        throw new Error("runFluxBenchmark 未返回有效帧率");
    }
    return result;
}

// ------------------------------------------------------------------ measurement
async function measureRound(meta: FluxSceneMeta, round: number, st: BenchState): Promise<RoundResult> {
    const base: RoundResult = {
        scene: meta.id,
        dataset: meta.dataset,
        round,
        ts: new Date().toISOString(),
        ok: false,
        storageMB: meta.storageMB,
    };
    const token = `r${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const modelUrl = new URL(meta.model, location.href);
    modelUrl.searchParams.set("ts", token);
    const pageUrl = new URL(meta.page, location.href);
    pageUrl.searchParams.set("url", modelUrl.href);
    // 参考协议（Flux-GS 原协议）：不干预其画布尺寸，用其原生策略
    //   点数 > 500000 → 1× CSS；否则 CSS × devicePixelRatio
    // 仅当显式给出 force=<W>x<H> 时才强制分辨率（用于与 1600×1063 旧口径对照）。
    const forceRaw = param("force", "");
    if (/^\d+x\d+$/.test(forceRaw)) {
        pageUrl.searchParams.set("benchres", forceRaw);
    }
    // ?fluxcam=N：让它的渲染器使用自己源码里的第 N 个真实镜头（与本文臂 cam=fluxcam:N 完全同一机位）
    const fluxCam = param("fluxcam", "");
    if (/^\d+$/.test(fluxCam)) {
        pageUrl.searchParams.set("fluxcam", fluxCam);
    }

    frameHost.dataset.w = String(st.resW);
    frameHost.dataset.h = String(st.resH);
    frameHost.textContent = "";
    const iframe = document.createElement("iframe");
    // 参考协议下 iframe 布局 = 设备视口（复刻"整页打开渲染器"的条件）；
    // 给出 force=WxH 时改为固定尺寸，用于 1600×1063 对照口径。
    const forceSize = /^\d+x\d+$/.test(forceRaw) ? forceRaw.split("x").map((v) => parseInt(v, 10)) : null;
    const hostW = forceSize ? forceSize[0] : Math.max(320, window.innerWidth);
    const hostH = forceSize ? forceSize[1] : Math.max(320, window.innerHeight);
    iframe.width = String(hostW);
    iframe.height = String(hostH);
    iframe.style.width = `${hostW}px`;
    iframe.style.height = `${hostH}px`;
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("allow", "fullscreen");
    frameHost.dataset.w = String(hostW);
    frameHost.dataset.h = String(hostH);
    frameHost.appendChild(iframe);
    layoutStage();

    try {
        const loaded = waitIframeLoad(iframe); // 先挂 load 监听再设 src，避免极快加载时丢事件
        iframe.src = pageUrl.href;
        await loaded;
        const cw = iframe.contentWindow as FluxWindow | null;
        if (!cw) throw new Error("无法访问 iframe 内容窗口");

        // pose=aligned：把"本文机位换算到它的坐标系"后的视图矩阵注入它的渲染器
        if (param("pose", "") === "aligned") {
            const views = await loadInjectedViews();
            const view = views[meta.id] ?? null;
            base.poseInjected = view ? await injectView(cw, view, 30000) : false;
        }
        // `pose=ours`：把本文臂导出的同一机位注入基线渲染器（视角对齐的关键一步）
        if (param("pose", "") === "ours") {
            const view = camViews[meta.id] ?? camViews[meta.page] ?? null;
            if (!view) {
                base.poseInjected = false;
            } else {
                base.poseInjected = await injectView(cw, view, 30000);
            }
        }

        const stats = await waitFirstFrame(cw, 180000);

        // dump=1：只导出该场景解码后的世界坐标（.bin），用于跨实现坐标系对齐，不做测帧
        if (param("dump") === "1") {
            const n = exportXyzDump(cw, meta.id);
            base.dumped = n;
            base.ok = n > 0;
            if (n === 0) base.err = "未能取到解码后的世界坐标（__FLUXGS_DUMP_XYZ__ 为空）";
            return base;
        }
        const fetched = modelFetchTiming(cw, meta.model.split("/").pop() || "");
        const fetchEnd = fetched.responseEnd ?? stats.fetchEndAt;
        base.fetchMs = fetched.fetchMs;
        base.bytes = fetched.bytes;
        base.resW = stats.resW || st.resW;
        base.resH = stats.resH || st.resH;
        base.firstFrameMs = stats.firstFrameAt - fetchEnd;
        base.decodeMs = stats.decodeDoneAt > 0 ? stats.decodeDoneAt - fetchEnd : undefined;
        base.texMs =
            stats.texUploadDoneAt > 0 && stats.decodeDoneAt > 0
                ? stats.texUploadDoneAt - stats.decodeDoneAt
                : undefined;

        if (st.warmupFrames > 0) {
            await runBenchmark(cw, st.warmupFrames, 120000);
        }
        const bench = await runBenchmark(cw, st.benchFrames, 240000);
        base.fps = bench.fps;
        base.resW = bench.resW || base.resW;
        base.resH = bench.resH || base.resH;
        base.coveredPct = bench.coveredPct;
        base.poseKey = Array.isArray(bench.view) ? bench.view.slice(0, 6).join(",") : undefined;
        base.ok = true;
        return base;
    } catch (err) {
        base.err = err instanceof Error ? err.message : String(err);
        return base;
    } finally {
        iframe.remove();
    }
}

function buildResultText(st: BenchState): string {
    const env = deviceInfo();
    const lines: string[] = [];
    lines.push("[RESULT]");
    lines.push("engine=fluxgs");
    lines.push(`u=${st.u}`);
    lines.push(`chip=${env.chip}`);
    lines.push(`vendor=${glRendererName()}`);
    lines.push("mode=bench");
    lines.push(`profile=${st.sceneIds.join(",")}`);
    lines.push(`rounds=${st.rounds}`);
    lines.push(`cold=${st.cold ? 1 : 0}`);
    lines.push(`res=${st.resW}x${st.resH}`);
    lines.push(`frames=${st.benchFrames}`);
    lines.push(`warmup=${st.warmupFrames}`);
    lines.push(`force=${param("force", "native")}`);
    lines.push(`pose_src=${param("pose", "flux")}`);
    lines.push(`ts=${new Date().toISOString()}`);
    lines.push(`ua=${env.ua}`);
    lines.push(`gl_renderer=${env.gl_renderer}`);
    lines.push(`screen=${env.screen}`);
    lines.push(`dpr=${env.dpr}`);
    lines.push(`hardwareConcurrency=${env.hardwareConcurrency}`);
    lines.push("--- per-round ---");
    for (const r of st.results) {
        const tags = [
            `scene=${r.scene}`,
            `dataset=${r.dataset}`,
            `round=${r.round}`,
            `ok=${r.ok ? 1 : 0}`,
            `res=${r.resW ?? ""}x${r.resH ?? ""}`,
            `bytes=${r.bytes ?? ""}`,
            `fetch_ms=${fmt(r.fetchMs, 0)}`,
            `first_frame_ms=${fmt(r.firstFrameMs, 0)}`,
            `decode_ms=${fmt(r.decodeMs, 0)}`,
            `tex_ms=${fmt(r.texMs, 0)}`,
            `fps=${fmt(r.fps, 1)}`,
            `covered=${fmt(r.coveredPct, 1)}%`,
            `poseInjected=${r.poseInjected === undefined ? "" : r.poseInjected ? 1 : 0}`,
            `pose=${r.poseKey ?? ""}`,
        ];
        if (!r.ok) tags.push(`err=${r.err ?? ""}`);
        lines.push(tags.join(" "));
    }
    lines.push("--- summary (median) ---");
    const byScene = new Map<string, RoundResult[]>();
    for (const r of st.results) {
        if (!r.ok) continue;
        const arr = byScene.get(r.scene) || [];
        arr.push(r);
        byScene.set(r.scene, arr);
    }
    for (const sceneId of st.sceneIds) {
        const arr = byScene.get(sceneId) || [];
        if (arr.length === 0) {
            const all = st.results.filter((r) => r.scene === sceneId);
            lines.push(`summary scene=${sceneId} dataset=${all[0]?.dataset ?? ""} ok=0`);
            continue;
        }
        const med = (key: keyof RoundResult): number | undefined =>
            median(arr.map((r) => Number(r[key])).filter((v) => Number.isFinite(v)));
        lines.push(
            [
                `summary scene=${sceneId}`,
                `dataset=${arr[0].dataset}`,
                `storage_mb=${arr[0].storageMB ?? ""}`,
                `ok=${arr.length}/${st.rounds}`,
                `fps_median=${fmt(med("fps"), 1)}`,
                `first_frame_ms_median=${fmt(med("firstFrameMs"), 0)}`,
                `decode_ms_median=${fmt(med("decodeMs"), 0)}`,
                `tex_ms_median=${fmt(med("texMs"), 0)}`,
                `fetch_ms_median=${fmt(med("fetchMs"), 0)}`,
                `covered_median=${fmt(med("coveredPct"), 1)}%`,
                `pose=${arr[0].poseKey ?? ""}`,
                `res=${arr[0].resW ?? ""}x${arr[0].resH ?? ""}`,
            ].join(" "),
        );
    }
    lines.push("[END]");
    return lines.join("\n");
}

// ------------------------------------------------------------------ bench runner
function totalRounds(st: BenchState): number {
    return st.sceneIds.length * st.rounds;
}

async function runBench(st: BenchState): Promise<void> {
    while (st.roundDone >= st.rounds && st.idx < st.sceneIds.length) {
        st.idx++;
        st.roundDone = 0;
    }
    if (st.idx >= st.sceneIds.length) {
        finishBench(st);
        return;
    }
    const meta = sceneById(st.sceneIds[st.idx]);
    if (!meta) {
        st.idx++;
        st.roundDone = 0;
        saveState(st);
        await runBench(st);
        return;
    }
    const roundNo = st.roundDone + 1;
    updateProgress(st.results.length, totalRounds(st), meta.name, `第 ${roundNo}/${st.rounds} 轮`);
    flashStatusBig(`正在测试 ${meta.name} · 第 ${roundNo}/${st.rounds} 轮，请稍候`);
    const r = await measureRound(meta, roundNo, st);
    st.results.push(r);
    st.roundDone = roundNo;
    saveState(st);

    const allDone = st.idx === st.sceneIds.length - 1 && roundNo >= st.rounds;
    if (allDone) {
        finishBench(st);
        return;
    }
    if (st.cold) {
        // 整页冷启动：重建 iframe/WebGL 上下文/解码 worker，更接近真实首开
        await sleep(600);
        location.reload();
        return;
    }
    await sleep(300);
    await runBench(st);
}

function finishBench(st: BenchState): void {
    try {
        archiveState(st);
    } catch {
        /* ignore */
    }
    clearState();
    progressRow.classList.add("hidden");
    statusBig.classList.add("hidden");
    frameHost.textContent = "";
    const okCount = st.results.filter((r) => r.ok).length;
    const text = buildResultText(st);
    rcText.value = text;
    rcSummary.textContent = `测试完成：成功 ${okCount}/${st.results.length} 轮。请复制下方文本并发送给测试发起人。`;
    resultCard.style.display = "flex";
}

async function copyResult(): Promise<void> {
    try {
        await navigator.clipboard.writeText(rcText.value);
    } catch {
        rcText.focus();
        rcText.select();
        try {
            document.execCommand("copy");
        } catch {
            /* ignore */
        }
    }
    btnCopy.textContent = "已复制 ✓";
    setTimeout(() => {
        btnCopy.textContent = "复制结果";
    }, 2000);
}

function exportArchive(): void {
    try {
        const raw = localStorage.getItem(ARCHIVE_KEY);
        const blob = new Blob([raw || "[]"], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `bench-flux-archive-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch {
        /* ignore */
    }
}

function buildStateFromParams(): BenchState {
    const rounds = Math.max(1, Math.min(9, parseInt(param("rounds", "3"), 10) || 3));
    const cold = param("cold") !== "0";
    const resRaw = param("res", "1600x1063");
    const parts = resRaw.split("x");
    const resW = parseInt(parts[0], 10) || 1600;
    const resH = parseInt(parts[1], 10) || 1063;
    const benchFrames = parseInt(param("frames", "300"), 10) || 300;
    // 参考协议（Flux-GS 原协议）**没有预热帧**；默认 0。旧 1600×1063 对照口径可用 warmup=10。
    const warmupFrames = Math.max(0, parseInt(param("warmup", "0"), 10) || 0);
    const profile = param("profile", selProfile.value);
    return {
        v: 1,
        busy: true,
        u: param("u") || "fluxgs-auto",
        sceneIds: expandProfile(profile),
        rounds,
        cold,
        resW,
        resH,
        benchFrames,
        warmupFrames,
        idx: 0,
        roundDone: 0,
        results: [],
        started: Date.now(),
    };
}

function bindBenchEvents(): void {
    btnStart.addEventListener("click", () => {
        const st = buildStateFromParams();
        if (st.sceneIds.length === 0) {
            flashStatusBig("没有可用的场景（清单为空或 profile 无匹配项）");
            return;
        }
        saveState(st);
        void runBench(st);
    });
    btnCopy.addEventListener("click", () => {
        void copyResult();
    });
    btnDone.addEventListener("click", () => {
        resultCard.style.display = "none";
        frameHost.textContent = "";
        progressRow.classList.add("hidden");
        benchControls.classList.remove("hidden");
        btnExport.disabled = false;
    });
    btnExport.addEventListener("click", exportArchive);
}

function applyParamToControls(): void {
    const profile = param("profile");
    if (profile && ["quick", "full", "mip360", "tnt", "db"].includes(profile)) {
        selProfile.value = profile;
    }
    const rounds = param("rounds");
    if (rounds) inpRounds.value = rounds;
    const frames = param("frames");
    if (frames) inpFrames.value = frames;
    const cold = param("cold");
    if (cold !== "") selCold.value = cold === "0" ? "0" : "1";
}

async function main(): Promise<void> {
    stDevice.textContent = "读取场景清单…";
    try {
        await loadManifest();
        await loadCamViews();
    } catch (err) {
        stDevice.textContent = "清单加载失败";
        flashStatusBig(err instanceof Error ? err.message : String(err));
        return;
    }
    applyParamToControls();
    stDevice.textContent = guessChip();
    stRes.textContent = param("force", "native");
    bindBenchEvents();
    window.addEventListener("resize", layoutStage);
    layoutStage();

    const st = loadState();
    if (st && st.busy) {
        await runBench(st);
        return;
    }
    if (param("profile")) {
        const auto = buildStateFromParams();
        if (auto.sceneIds.length > 0) {
            saveState(auto);
            void runBench(auto);
            return;
        }
    }
    flashStatusBig("选择上方测试范围并点击“开始测试”");
}

window.addEventListener("DOMContentLoaded", () => {
    void main();
});
