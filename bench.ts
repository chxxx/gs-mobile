/**
 * bench.ts — 3DGS 网页性能测试页（独立于 index.html demo）。
 * 模式：
 *   mode=bench  自动测试：按 profile 逐场景逐轮测量首帧/帧率，冷启动自动整页刷新，结果卡一键复制；
 *   mode=view   展示浏览：加载指定场景，可自由旋转缩放，FPS/信息叠加，供截图与录屏。
 * URL：bench.html?mode=bench&profile=quick|full|mip360|tnt|db&rounds=3&cold=1&u=xxx&res=1600x1063
 *      bench.html?mode=view&scene=garden&fpsoverlay=1
 */
import * as SPLAT from "./src/index";

// ------------------------------------------------------------------ DOM
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("view");
const stDevice = $<HTMLElement>("st-device");
const stRes = $<HTMLElement>("st-res");
const stScene = $<HTMLElement>("st-scene");
const stProgress = $<HTMLElement>("st-progress");
const benchControls = $<HTMLElement>("bench-controls");
const viewControls = $<HTMLElement>("view-controls");
const progressRow = $<HTMLElement>("bench-progress");
const progressFill = $<HTMLElement>("bar-fill");
const fpsOverlay = $<HTMLElement>("fps-overlay");
const infoOverlay = $<HTMLElement>("info-overlay");
const statusBig = $<HTMLElement>("status-big");
const welcome = $<HTMLElement>("welcome");
const resultCard = $<HTMLElement>("result-card");
const rcText = $<HTMLTextAreaElement>("rc-text");
const rcSummary = $<HTMLElement>("rc-summary");
const btnStart = $<HTMLButtonElement>("btn-start");
const btnCopy = $<HTMLButtonElement>("btn-copy");
const btnDone = $<HTMLButtonElement>("btn-done");
const btnExport = $<HTMLButtonElement>("btn-export");
const selProfile = $<HTMLSelectElement>("sel-profile");
const inpRounds = $<HTMLInputElement>("inp-rounds");
const selCold = $<HTMLSelectElement>("sel-cold");
const selViewScene = $<HTMLSelectElement>("sel-view-scene");
const ckOverlay = $<HTMLInputElement>("ck-overlay");
const ckInfo = $<HTMLInputElement>("ck-info");

const renderer = new SPLAT.WebGLRenderer(canvas);
const scene = new SPLAT.Scene();
const camera = new SPLAT.Camera();
let controls: SPLAT.OrbitControls | null = null;

// ------------------------------------------------------------------ types
interface SceneMeta {
    id: string;
    name: string;
    file: string;
    dataset: string;
    demo: boolean;
    points?: number;
}
interface RoundResult {
    scene: string;
    round: number;
    ts: string;
    ok: boolean;
    err?: string;
    drawOk?: boolean;
    coveredPct?: number;
    keptPct?: number;
    points?: number;
    bytes?: number;
    fetchMs?: number;
    parseMs?: number;
    firstFrameMs?: number;
    fps?: number;
    cpuMs?: number;
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
    idx: number;
    roundDone: number;
    results: RoundResult[];
    started: number;
}

const STATE_KEY = "gsm-bench-v1";
const ARCHIVE_KEY = "gsm-bench-archive-v1";

// ------------------------------------------------------------------ small utils
function el(id: string): HTMLElement {
    return document.getElementById(id) as HTMLElement;
}
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
const FALLBACK_SCENES: SceneMeta[] = [
    {
        id: "garden",
        name: "Garden (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-garden.ply",
        dataset: "mip360",
        demo: true,
        points: 610000,
    },
    {
        id: "bicycle",
        name: "Bicycle (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-bicycle.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "flowers",
        name: "Flowers (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-flowers.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "stump",
        name: "Stump (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-stump.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "treehill",
        name: "Treehill (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-treehill.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "room",
        name: "Room (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-room.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "counter",
        name: "Counter (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-counter.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "kitchen",
        name: "Kitchen (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-kitchen.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "bonsai",
        name: "Bonsai (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-bonsai.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "truck",
        name: "Truck (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-truck.ply",
        dataset: "tnt",
        demo: true,
        points: 273169,
    },
    {
        id: "train",
        name: "Train (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-train.ply",
        dataset: "tnt",
        demo: false,
    },
    {
        id: "drjohnson",
        name: "DrJohnson (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-drjohnson.ply",
        dataset: "db",
        demo: true,
        points: 432000,
    },
    {
        id: "playroom",
        name: "Playroom (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-playroom.ply",
        dataset: "db",
        demo: false,
    },
];

let manifest: SceneMeta[] = [];

async function loadManifest(): Promise<void> {
    try {
        const res = await fetch("./bench-scenes.json");
        if (!res.ok) throw new Error("not found");
        const json = (await res.json()) as { scenes: SceneMeta[] };
        if (Array.isArray(json.scenes) && json.scenes.length > 0) {
            manifest = json.scenes;
            return;
        }
    } catch {
        /* dev 模式下静态清单可能不可达，退回到内置清单 */
    }
    manifest = FALLBACK_SCENES;
}
function sceneById(id: string): SceneMeta | undefined {
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

// ------------------------------------------------------------------ renderer helpers
function setBenchmarkResolution(w: number, h: number): void {
    renderer.disableAutoResize();
    renderer.setPixelRatio(1);
    renderer.setSize(w, h);
}
function frameRender(): void {
    if (controls) controls.update();
    renderer.render(scene, camera);
}
/**
 * 帧率测量：仿照 Flux-GS Offscreen Benchmark 的帧驱动方式——
 * 每渲染一帧后 setTimeout(0) 让出事件循环，再渲染下一帧；整段墙钟时间 / 帧数 = 平均单帧耗时。
 * 这样每帧都是“完整提交并被驱动执行”的帧，规避同步死循环里 Worker/驱动消息无法回流的失真。
 */
async function runThroughputFrames(frames: number): Promise<{ fps: number; cpuMs: number }> {
    const warmup = 10;
    for (let i = 0; i < warmup; i++) {
        frameRender();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const t0 = performance.now();
    let rendered = 0;
    await new Promise<void>((resolve) => {
        const step = (): void => {
            frameRender();
            rendered++;
            if (rendered >= frames) {
                resolve();
                return;
            }
            setTimeout(step, 0);
        };
        setTimeout(step, 0);
    });
    const t1 = performance.now();
    const ms = (t1 - t0) / frames;
    return { fps: frames / ((t1 - t0) / 1000), cpuMs: ms };
}

/**
 * 渲染器的深度排序在 Web Worker 中异步完成，首帧可能深度索引尚未回传（实际绘制 0 实例）。
 * 测帧前必须让出事件队列，等待 worker 至少完成一次排序并产生真实绘制。
 */
/** 读一帧像素，统计画面中被高斯覆盖的像素比例；同时读取视锥剔除后的保留比例，用于诊断测帧画面是否“空转”。 */
function probeFrameCoverage(): { coveredPct: number; keptPct: number } {
    const gl = renderer.gl as WebGL2RenderingContext;
    const w = renderer.canvas.width || 1;
    const h = renderer.canvas.height || 1;
    frameRender();
    gl.finish();
    let covered = 0;
    let samples = 0;
    try {
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const stride = 8;
        for (let y = 0; y < h; y += stride) {
            for (let x = 0; x < w; x += stride) {
                const idx = (y * w + x) * 4;
                if (buf[idx + 3] > 0) covered++;
                samples++;
            }
        }
    } catch {
        /* readPixels 不可用时忽略 */
    }
    const cull = renderer.renderProgram?.cullStats;
    const keptPct = cull && cull.total > 0 ? cull.keptRatio * 100 : 0;
    return { coveredPct: samples > 0 ? (covered / samples) * 100 : 0, keptPct };
}

async function waitForSortedFrame(timeoutMs = 12000): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        frameRender();
        const cull = renderer.renderProgram?.cullStats;
        if (cull && cull.total > 0 && cull.keptRatio > 0) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return false;
}

function ensureControls(): SPLAT.OrbitControls {
    if (!controls) controls = new SPLAT.OrbitControls(camera, canvas);
    return controls;
}

/** 把相机放到能完整框住场景包围盒的固定机位，避免“默认视角大半被剔除”导致测帧失真。 */
function frameScene(splat: SPLAT.Splat): void {
    const data = splat.data;
    const p = data.positions;
    const n = data.vertexCount;
    if (!p || n === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
        const x = p[3 * i];
        const y = p[3 * i + 1];
        const z = p[3 * i + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-4);
    const dist = span * 1.6;
    camera.position = new SPLAT.Vector3(cx, cy, cz + dist);
    camera.update();
    const c = ensureControls();
    c.setCameraTarget(new SPLAT.Vector3(cx, cy, cz));
}

// ------------------------------------------------------------------ device info
function glRendererName(): string {
    try {
        const gl = renderer.gl as WebGL2RenderingContext;
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        return String(name || "");
    } catch {
        return "";
    }
}

interface ChipGuess {
    vendor: string;
    chip: string;
}
let chipCache: ChipGuess | null = null;
/** 根据 GL_RENDERER 识别 GPU/SoC（Adreno→骁龙、Mali/Immortalis→天玑等）。识别不到时回退显示原始渲染器名。 */
function guessChip(): ChipGuess {
    if (chipCache) return chipCache;
    const g = glRendererName();
    if (/qualcomm|adreno/i.test(g)) {
        const m = /Adreno[^0-9]*(\d+)/i.exec(g);
        const v = m ? parseInt(m[1], 10) : 0;
        let chip = "Qualcomm Adreno";
        if (v >= 830) chip = "Snapdragon 8 Elite (Adreno " + v + ")";
        else if (v === 750) chip = "Snapdragon 8 Gen 3 (Adreno 750)";
        else if (v === 740) chip = "Snapdragon 8 Gen 2 (Adreno 740)";
        else if (v === 730) chip = "Snapdragon 8 Gen 1 / 8+ (Adreno 730)";
        else if (v >= 700) chip = "Snapdragon 8/7 系列 (Adreno " + v + ")";
        else if (v > 0) chip = "Qualcomm Adreno " + v;
        chipCache = { vendor: "Qualcomm", chip };
        return chipCache;
    }
    if (/immortalis|mali|mediatek/i.test(g)) {
        const m = /Immortalis[^0-9]*(\d+)|Mali[^0-9]*G?(\d+)/i.exec(g);
        const v = m ? m[1] || m[2] : "";
        let chip = "ARM Mali";
        if (v === "G615") chip = "Dimensity 8300/8200 系列 (Mali-G615)";
        else if (v === "G610") chip = "Dimensity 8100 系列 (Mali-G610)";
        else if (v === "G715" || v === "G720") chip = "Dimensity 9200/9300 级 (Immortalis-" + v + ")";
        else if (v === "G710") chip = "Dimensity 9000 系列 (Mali-G710)";
        else if (v === "G78") chip = "Kirin 9000/980 级 (Mali-G78)";
        else if (v) chip = "ARM Mali-" + v;
        chipCache = { vendor: "MediaTek/Arm", chip };
        return chipCache;
    }
    chipCache = { vendor: "other", chip: g || "unknown" };
    return chipCache;
}
function chipSlug(): string {
    const g = glRendererName();
    const mm = /(Adreno|Mali|Immortalis)[^0-9]*(\d+)/i.exec(g);
    const slug = mm ? `${mm[1].toLowerCase()}-${mm[2]}` : "device";
    return "auto-" + slug;
}
function deviceInfo(): Record<string, string | number> {
    const chip = guessChip();
    return {
        ua: navigator.userAgent,
        gl_renderer: glRendererName(),
        vendor: chip.vendor,
        chip: chip.chip,
        screen: `${window.screen.width}x${window.screen.height}`,
        dpr: window.devicePixelRatio || 1,
        hardwareConcurrency: navigator.hardwareConcurrency || 0,
        deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory || 0,
        timestamp: new Date().toISOString(),
    };
}
function shortDeviceLabel(): string {
    const chip = guessChip();
    return chip.chip;
}

// ------------------------------------------------------------------ session state
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
        /* ignore quota errors */
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
    welcome.classList.add("hidden");
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    progressFill.style.width = `${pct}%`;
    stProgress.textContent = `${done}/${total} 轮`;
    stScene.textContent = `${sceneName} · ${roundText}`;
}
function flashStatusBig(text: string): void {
    statusBig.textContent = text;
    statusBig.classList.remove("hidden");
}

// ------------------------------------------------------------------ measurement
async function measureRound(meta: SceneMeta, round: number, st: BenchState): Promise<RoundResult> {
    const base: RoundResult = { scene: meta.id, round, ts: new Date().toISOString(), ok: false };
    const token = `r${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const url = `${meta.file}${meta.file.includes("?") ? "&" : "?"}ts=${token}`;
    const tStart = performance.now();
    scene.reset();
    setBenchmarkResolution(st.resW, st.resH);
    try {
        const splat = await SPLAT.PLYLoader.LoadAsync(url, scene, undefined);
        const tLoaded = performance.now();
        frameScene(splat);
        camera.update();
        // 让出事件循环等待深度排序回传——此时才产生真实的首帧绘制
        const sorted = await waitForSortedFrame();
        const tFirstFrame = performance.now();

        const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        let fetchMs: number | undefined;
        let bytes: number | undefined;
        let foundEntry: PerformanceResourceTiming | undefined;
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (e.name.includes(`ts=${token}`)) {
                foundEntry = e;
                fetchMs = e.duration;
                bytes = e.transferSize > 0 ? e.transferSize : undefined;
                break;
            }
        }
        // 论文口径：首帧时间从“文件获取完成”之后算起
        // responseEnd 与 performance.now() 同时间轴，不能再加 performance.timeOrigin
        const fetchEndWall = foundEntry ? foundEntry.responseEnd : tStart;
        base.fetchMs = fetchMs ?? tLoaded - tStart;
        base.parseMs = tLoaded - fetchEndWall;
        base.firstFrameMs = tFirstFrame - fetchEndWall;
        base.drawOk = sorted;
        base.points = splat.data ? splat.data.vertexCount : undefined;
        base.bytes = bytes;
        const perf = await runThroughputFrames(st.benchFrames);
        base.fps = perf.fps;
        base.cpuMs = perf.cpuMs;
        const probe = probeFrameCoverage();
        base.coveredPct = probe.coveredPct;
        base.keptPct = probe.keptPct;
        base.ok = true;
        return base;
    } catch (err) {
        base.err = err instanceof Error ? err.message : String(err);
        return base;
    }
}

function buildResultText(st: BenchState): string {
    const env = deviceInfo();
    const lines: string[] = [];
    lines.push("[RESULT]");
    lines.push(`u=${st.u}`);
    lines.push(`chip=${env.chip}`);
    lines.push(`vendor=${env.vendor}`);
    lines.push(`mode=bench`);
    lines.push(`profile=${st.sceneIds.join(",")}`);
    lines.push(`rounds=${st.rounds}`);
    lines.push(`cold=${st.cold ? 1 : 0}`);
    lines.push(`res=${st.resW}x${st.resH}`);
    lines.push(`ts=${new Date().toISOString()}`);
    lines.push(`ua=${env.ua}`);
    lines.push(`gl_renderer=${env.gl_renderer}`);
    lines.push(`screen=${env.screen}`);
    lines.push(`dpr=${env.dpr}`);
    lines.push(`hardwareConcurrency=${env.hardwareConcurrency}`);
    lines.push(`deviceMemory=${env.deviceMemory}`);
    lines.push("--- per-round ---");
    for (const r of st.results) {
        const tags = [
            `scene=${r.scene}`,
            `round=${r.round}`,
            `ok=${r.ok ? 1 : 0}`,
            `drawOk=${r.drawOk === undefined ? "" : r.drawOk ? 1 : 0}`,
            `points=${r.points ?? ""}`,
            `bytes=${r.bytes ?? ""}`,
            `fetch_ms=${fmt(r.fetchMs, 0)}`,
            `parse_ms=${fmt(r.parseMs, 0)}`,
            `first_frame_ms=${fmt(r.firstFrameMs, 0)}`,
            `fps=${fmt(r.fps, 1)}`,
            `cpu_ms=${fmt(r.cpuMs, 2)}`,
            `covered=${fmt(r.coveredPct, 1)}%`,
            `kept=${fmt(r.keptPct, 1)}%`,
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
        const ok = arr.filter((r) => r.ok && r.drawOk !== false);
        if (ok.length === 0) {
            lines.push(`summary scene=${sceneId} ok=0`);
            continue;
        }
        lines.push(
            [
                `summary scene=${sceneId}`,
                `ok=${ok.length}/${arr.length || st.rounds}`,
                `fps_median=${fmt(median(ok.map((r) => r.fps ?? NaN).filter((v) => Number.isFinite(v))), 1)}`,
                `first_frame_ms_median=${fmt(median(ok.map((r) => r.firstFrameMs ?? NaN).filter((v) => Number.isFinite(v))), 0)}`,
                `parse_ms_median=${fmt(median(ok.map((r) => r.parseMs ?? NaN).filter((v) => Number.isFinite(v))), 0)}`,
                `fetch_ms_median=${fmt(median(ok.map((r) => r.fetchMs ?? NaN).filter((v) => Number.isFinite(v))), 0)}`,
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
    // 归一化：当前场景已完成全部轮次则推进到下一个场景
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
        // 整页冷启动：新页面重建 WebGL 上下文与 shader，更接近真实首开
        await new Promise((resolve) => setTimeout(resolve, 600));
        location.reload();
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
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
    const okCount = st.results.filter((r) => r.ok).length;
    const text = buildResultText(st);
    rcText.value = text;
    const reportUrl = param("report");
    rcSummary.textContent = reportUrl
        ? `测试完成：成功 ${okCount}/${st.results.length} 轮。结果将自动提交给测试发起人。`
        : `测试完成：成功 ${okCount}/${st.results.length} 轮。请复制下方文本并发送给测试发起人。`;
    resultCard.style.display = "flex";
    if (reportUrl) {
        void fetch(reportUrl, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: text,
            keepalive: true,
        }).catch(() => {
            rcSummary.textContent += "（自动提交失败，请手动复制发送）";
        });
    }
}

async function copyResult(): Promise<void> {
    const text = rcText.value;
    try {
        await navigator.clipboard.writeText(text);
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
        a.download = `bench-archive-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch {
        /* ignore */
    }
}

// ------------------------------------------------------------------ view (showcase) mode
let viewLoopStarted = false;
let lastFrameAt = 0;
let emaMs = 0;

function updateOverlay(metaName: string, splatCount: number): void {
    const now = performance.now();
    if (lastFrameAt > 0) {
        const ms = now - lastFrameAt;
        emaMs = emaMs === 0 ? ms : emaMs * 0.9 + ms * 0.1;
    }
    lastFrameAt = now;
    const fps = emaMs > 0 ? 1000 / emaMs : 0;
    fpsOverlay.innerHTML = `FPS ${fps.toFixed(0)}`;
    const info = deviceInfo();
    const dpr = window.devicePixelRatio || 1;
    infoOverlay.textContent = `${metaName}\n${deviceInfo().chip}\nsplats=${splatCount.toLocaleString()}\ncanvas=${canvas.width}x${canvas.height} (${canvas.clientWidth}x${canvas.clientHeight} CSS, dpr=${dpr.toFixed(2)})\ngl=${info.gl_renderer}`;
}

function startViewLoop(): void {
    if (viewLoopStarted) return;
    viewLoopStarted = true;
    const loop = (): void => {
        requestAnimationFrame(loop);
        if (controls) controls.update();
        renderer.render(scene, camera);
        const splat = scene.objects.find((o) => o instanceof SPLAT.Splat) as SPLAT.Splat | undefined;
        const name = currentViewScene ? currentViewScene.name : "-";
        updateOverlay(name, splat ? splat.data.vertexCount : 0);
    };
    requestAnimationFrame(loop);
}

let currentViewScene: SceneMeta | null = null;

async function loadViewScene(id: string): Promise<void> {
    const meta = sceneById(id);
    if (!meta) {
        flashStatusBig(`未知场景：${id}`);
        return;
    }
    currentViewScene = meta;
    stScene.textContent = `${meta.name}（加载中…）`;
    try {
        scene.reset();
        const splat = await SPLAT.PLYLoader.LoadAsync(meta.file, scene, undefined);
        frameScene(splat);
        camera.update();
        stScene.textContent = meta.name;
        welcome.classList.add("hidden");
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stScene.textContent = `${meta.name} 加载失败`;
        flashStatusBig(`加载失败：${msg}`);
        return;
    }
    const splat = scene.objects.find((o) => o instanceof SPLAT.Splat) as SPLAT.Splat | undefined;
    void splat;
}

function resetViewCamera(): void {
    try {
        if (controls && typeof controls.dispose === "function") controls.dispose();
    } catch {
        /* ignore */
    }
    camera.position = new SPLAT.Vector3(0, 0, -5);
    camera.update();
    controls = new SPLAT.OrbitControls(camera, canvas);
    viewLoopStarted = false;
    startViewLoop();
}

function setupViewMode(): void {
    benchControls.classList.add("hidden");
    viewControls.classList.remove("hidden");
    progressRow.classList.add("hidden");
    welcome.classList.add("hidden");
    fpsOverlay.classList.toggle("hidden", !ckOverlay.checked);
    infoOverlay.classList.toggle("hidden", !ckInfo.checked);
    const big = param("fpsoverlay") === "1";
    fpsOverlay.style.fontSize = big ? "56px" : "18px";
    renderer.enableAutoResize();
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.resize();
    window.addEventListener("resize", () => renderer.resize());
    camera.position = new SPLAT.Vector3(0, 0, -5);
    camera.update();
    controls = new SPLAT.OrbitControls(camera, canvas);
    startViewLoop();
}

// ------------------------------------------------------------------ bench mode
function buildStateFromParams(): BenchState {
    const rounds = Math.max(1, Math.min(9, parseInt(param("rounds", "3"), 10) || 3));
    const cold = param("cold") !== "0"; // 默认整页冷启动刷新
    const resRaw = param("res", "1600x1063");
    const parts = resRaw.split("x");
    const resW = parseInt(parts[0], 10) || 1600;
    const resH = parseInt(parts[1], 10) || 1063;
    const benchFrames = parseInt(param("frames", "300"), 10) || 300;
    const profile = param("profile", selProfile.value);
    const sceneIds = expandProfile(profile);
    return {
        v: 1,
        busy: true,
        u: param("u") || chipSlug(),
        sceneIds,
        rounds,
        cold,
        resW,
        resH,
        benchFrames,
        idx: 0,
        roundDone: 0,
        results: [],
        started: Date.now(),
    };
}

function showBenchSettings(): void {
    benchControls.classList.remove("hidden");
    viewControls.classList.add("hidden");
    progressRow.classList.add("hidden");
    welcome.classList.remove("hidden");
}

function bindBenchEvents(): void {
    btnStart.addEventListener("click", () => {
        const st = buildStateFromParams();
        if (st.sceneIds.length === 0) {
            flashStatusBig("没有可用的场景文件（场景尚未上传或清单为空）");
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
        showBenchSettings();
    });
    btnExport.addEventListener("click", exportArchive);
}

function setupViewEvents(): void {
    btnLoadView.addEventListener("click", () => {
        void loadViewScene(selViewScene.value);
    });
    btnResetView.addEventListener("click", resetViewCamera);
    ckOverlay.addEventListener("change", () => {
        fpsOverlay.classList.toggle("hidden", !ckOverlay.checked);
    });
    ckInfo.addEventListener("change", () => {
        infoOverlay.classList.toggle("hidden", !ckInfo.checked);
    });
    selViewScene.addEventListener("change", () => {
        void loadViewScene(selViewScene.value);
    });
}

// ------------------------------------------------------------------ mode UI & bootstrap
function setTopLinks(mode: "bench" | "view"): void {
    const lnkBench = el("lnk-bench");
    const lnkView = el("lnk-view");
    lnkBench.classList.toggle("active", mode === "bench");
    lnkView.classList.toggle("active", mode === "view");
    const hint = el("mode-hint");
    hint.textContent = mode === "bench" ? "自动测试：打开后点“开始测试”即可" : "展示浏览：可拖动视角，供截图/录屏";
}

function populateSceneSelect(): void {
    for (const s of manifest) {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = `${s.name}${s.demo ? "" : "（扩展）"}`;
        selViewScene.appendChild(opt);
    }
}

function applyParamToControls(): void {
    const profile = param("profile");
    if (profile && ["quick", "full", "mip360", "tnt", "db"].includes(profile)) {
        selProfile.value = profile;
    }
    const rounds = param("rounds");
    if (rounds) inpRounds.value = rounds;
    const cold = param("cold");
    if (cold !== "") selCold.value = cold === "0" ? "0" : "1";
}

async function main(): Promise<void> {
    stDevice.textContent = "读取场景清单…";
    try {
        await loadManifest();
    } catch {
        stDevice.textContent = "清单加载失败";
        welcome.textContent = "bench-scenes.json 未能加载，请检查部署是否完整。";
        return;
    }
    populateSceneSelect();
    applyParamToControls();
    stDevice.textContent = shortDeviceLabel();
    stRes.textContent = param("res", "1600×1063");

    const modeParam = param("mode");
    if (modeParam === "view") {
        setTopLinks("view");
        setupViewEvents();
        setupViewMode();
        const sceneParam = param("scene");
        const initialId = sceneParam && sceneById(sceneParam) ? sceneParam : (manifest.find((s) => s.demo)?.id ?? "");
        if (initialId) {
            selViewScene.value = initialId;
            void loadViewScene(initialId);
        }
        return;
    }

    setTopLinks("bench");
    bindBenchEvents();
    const st = loadState();
    if (st && st.busy) {
        // 冷启动整页刷新后自动续跑
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
    showBenchSettings();
}

window.addEventListener("DOMContentLoaded", () => {
    void main();
});
