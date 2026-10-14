import * as SPLAT from "./src/index";
import { perf, GpuFrameTimer } from "./src/utils/PerfDebug";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const progressDialog = document.getElementById("progress-dialog") as HTMLDialogElement;
const progressIndicator = document.getElementById("progress-indicator") as HTMLProgressElement;
const progressContainer = document.getElementById("progress-container") as HTMLDivElement;
const fpsCounter = document.getElementById("fps-counter") as HTMLDivElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const dropZone = document.getElementById("drop-zone") as HTMLDivElement;
// [2026-10-13] "默认部署臂"的 URL 注入**已移到 index.html 的 <head> 内联脚本**：加载器/渲染器都在初始化时
// 读 `location.search`，在模块里再 replaceState 已经太晚（loader 读不到 `lr=1` 会报"低秩载荷缺失"并作废本轮数据）。
// 开关：默认 `shcache=frag&lr=1&nocolortx=1`；`?arm=full` 追加 `notx=1`（单对象场景才可用）；`?arm=base` 关闭。

const sceneSelect = document.getElementById("scene-select") as HTMLSelectElement;

// 注意：这里**不再**单独建探测上下文做"WebGL2 能力自检"。
// 手机端每页多建一个"建了不用 / 丢了不还"的上下文会挤占上下文名额（连续冷启动尤其致命：
// 表现为第 2~3 轮建不出上下文）。可读的错误提示已由 WebGLRenderer 构造函数直接抛出。

const renderer = new SPLAT.WebGLRenderer(canvas);
const scene = new SPLAT.Scene();
const camera = new SPLAT.Camera();
const controls = new SPLAT.OrbitControls(camera, canvas);
const gpuTimer = new GpuFrameTimer(renderer.gl);

let lastTime = performance.now();
let frameCount = 0;
let firstFrameStart: number | null = null;
let firstFrameLogged = false;
let lastFrameAt = 0;
let lastSummaryAt = 0;
let windowFrames = 0;
let cameraMovingFrames = 0;
let prevViewProj: Float32Array | null = null;

interface ResolutionScanState {
    scales: number[];
    idx: number;
    stageStart: number;
    stageDur: number;
    fpsSum: number;
    fpsCount: number;
    rows: { scale: number; fps: number }[];
}
let resolutionScan: ResolutionScanState | null = null;
let pendingCaptureLabel: string | null = null;
interface CapProbeState {
    base: number;
    bufA: Uint8Array | null;
    caps: number[];
    idx: number;
}
let capProbe: CapProbeState | null = null;

if (perf.enabled) {
    console.info("[Perf] instrumentation ENABLED (?perf=1). Summary is printed to the console every ~1 s.");
    console.info(
        `[Perf] frustum-culling prototype: ${renderer.renderProgram.cullEnabled ? "ON" : "OFF"} (?cull=1 enables for A/B).`,
    );
    if (!gpuTimer.supported) {
        console.warn("[Perf] EXT_disjoint_timer_query_webgl2 unavailable: real GPU timing will be missing.");
    }
} else {
    console.info(
        "[Perf] disabled. Append ?perf=1 to the URL, or run window.__PERF_DEBUG__ = true to enable at runtime.",
    );
}

function updateFps() {
    const now = performance.now();
    frameCount++;
    if (now - lastTime >= 1000) {
        fpsCounter.textContent = `FPS: ${frameCount}`;
        frameCount = 0;
        lastTime = now;
    }
}

const fmtMs = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(2));

function getSplatVertexCount(): number {
    let total = 0;
    for (const obj of scene.objects) {
        if (obj instanceof SPLAT.Splat && obj.data) {
            total += obj.data.vertexCount;
        }
    }
    return total;
}

/**
 * Render-resolution clamp for mobile profiling: renders at scale × the CSS
 * canvas size (scale is meant to be the pixel ratio you want to test, e.g.
 * 4 = current physical DPR on the phone, 2 = half physical resolution).
 */
function setResolutionScale(scale: number) {
    renderer.disableAutoResize();
    const width = Math.max(1, Math.floor(canvas.clientWidth * scale));
    const height = Math.max(1, Math.floor(canvas.clientHeight * scale));
    renderer.setSize(width, height);
    console.log(`[res] scale=${scale.toFixed(2)} -> canvas ${width} x ${height}`);
}

function restoreResolutionAutoScale() {
    renderer.enableAutoResize();
    renderer.resize();
}

/**
 * Automated 3-resolution scan for stable on-device FPS comparison.
 * Keep the camera still while it runs. Example:
 *   __PERF__.scanResolution()            // scales 1, 2, 4, 4s each
 *   __PERF__.scanResolution([1, 2], 3)   // custom
 */
function scanResolution(scales: number[] = [1, 2, 4], secondsPerStage = 4) {
    if (resolutionScan) {
        console.warn("[scan] already running; wait for it to finish.");
        return;
    }
    renderer.disableAutoResize();
    resolutionScan = {
        scales,
        idx: 0,
        stageStart: 0,
        stageDur: secondsPerStage * 1000,
        fpsSum: 0,
        fpsCount: 0,
        rows: [],
    };
    applyResolutionScanStage();
}

function applyResolutionScanStage() {
    if (!resolutionScan) return;
    const scan = resolutionScan;
    const scale = scan.scales[scan.idx];
    const width = Math.max(1, Math.floor(canvas.clientWidth * scale));
    const height = Math.max(1, Math.floor(canvas.clientHeight * scale));
    renderer.setSize(width, height);
    scan.fpsSum = 0;
    scan.fpsCount = 0;
    scan.stageStart = performance.now();
    console.log(
        `[scan] stage ${scan.idx + 1}/${scan.scales.length}: scale=${scale} -> ${width}x${height} ` +
            `(hold the camera still…)`,
    );
}

function tickResolutionScan(nowMs: number, frameMs: number) {
    if (!resolutionScan) return;
    const scan = resolutionScan;

    if (nowMs - scan.stageStart >= scan.stageDur) {
        const fps = scan.fpsCount > 0 ? (scan.fpsCount * 1000) / scan.fpsSum : NaN;
        scan.rows.push({ scale: scan.scales[scan.idx], fps: Math.round(fps) });
        console.log(`[scan] stage ${scan.idx + 1}: scale=${scan.scales[scan.idx]} -> ~${Math.round(fps)} fps`);

        scan.idx++;
        if (scan.idx >= scan.scales.length) {
            console.log("[scan] done:", scan.rows);
            console.table(scan.rows.map((r) => ({ scale: r.scale, "avg fps": r.fps })));
            renderer.enableAutoResize();
            renderer.resize();
            resolutionScan = null;
            return;
        }
        applyResolutionScanStage();
        return;
    }

    if (nowMs >= scan.stageStart) {
        scan.fpsCount++;
        scan.fpsSum += frameMs;
    }
}

/**
 * Apply per-scene render tweaks that come from URL parameters:
 *   ?splatPx=256   caps the maximum on-screen splat footprint (default 1024)
 */
function applySceneTweaks() {
    try {
        const splatPx = parseFloat(new URLSearchParams(location.search).get("splatPx") || "");
        if (Number.isFinite(splatPx) && splatPx > 0) {
            renderer.renderProgram.maxSplatSize = splatPx;
            console.log(`[tweak] maxSplatSize=${splatPx}  (override at runtime with __PERF__.setMaxSplatSize(n))`);
        }
    } catch {
        /* ignore */
    }
}

/**
 * Capture the current frame as a PNG at the end of the next rendered frame
 * (i.e. right after render() in the same rAF callback, before the compositor
 * clears the drawing buffer). Download is triggered automatically.
 */
function captureFrame(label: string) {
    pendingCaptureLabel = label;
    console.log(`[capture] will save "${label}" after the next frame…`);
}

function tickCapture(): void {
    if (!pendingCaptureLabel) return;
    const label = pendingCaptureLabel;
    pendingCaptureLabel = null;
    try {
        const url = renderer.canvas.toDataURL("image/png");
        const a = document.createElement("a");
        a.href = url;
        a.download = `${label}_${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        console.log(`[capture] saved ${a.download}`);
    } catch (e) {
        console.error("[capture] failed:", e);
    }
}

/**
 * In-browser cap A/B probe. Compares the current view rendered at `base`
 * (default 1024) against one or more smaller caps, reading the framebuffer one
 * frame at a time. Keep the camera perfectly still while it runs.
 *
 *   __PERF__.probeCap()                     -> 1024 vs 256
 *   __PERF__.probeCap(384)                  -> 1024 vs 384
 *   __PERF__.probeCapCurve([384, 256, 160]) -> 1024 vs each, one run
 */
function startCapProbe(caps: number[], base = 1024) {
    const clean = caps.filter((c) => Number.isFinite(c) && c > 0 && c !== base);
    if (clean.length === 0) {
        console.warn("[probe] nothing to compare");
        return;
    }
    capProbe = { base, bufA: null, caps: clean, idx: 0 };
    renderer.renderProgram.maxSplatSize = base;
    console.log(`[probe] baseline cap=${base} captured next frame; measuring ${clean.join(" → ")}…`);
}

function tickCapProbe(): void {
    if (!capProbe) return;
    const gl = renderer.gl;
    const w = renderer.canvas.width;
    const h = renderer.canvas.height;
    if (w < 1 || h < 1) return;

    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    // First tick: this frame was rendered at `base`; remember it, switch to cap[0].
    if (!capProbe.bufA) {
        capProbe.bufA = px;
        renderer.renderProgram.maxSplatSize = capProbe.caps[0];
        console.log(`[probe] captured baseline cap=${capProbe.base}; switched to cap=${capProbe.caps[0]}…`);
        return;
    }

    const a = capProbe.bufA as Uint8Array;
    const target = capProbe.caps[capProbe.idx];

    let diffPixels = 0;
    let maxDiff = 0;
    let sumDiff = 0;
    const n = w * h * 4;
    for (let i = 0; i < n; i += 4) {
        // compare RGB only; ignore alpha channel
        const dr = Math.abs(a[i] - px[i]);
        const dg = Math.abs(a[i + 1] - px[i + 1]);
        const db = Math.abs(a[i + 2] - px[i + 2]);
        const d = Math.max(dr, dg, db);
        if (d > 0) {
            diffPixels++;
            sumDiff += d;
            if (d > maxDiff) maxDiff = d;
        }
    }
    const total = w * h;
    console.log(
        `[probe] cap${capProbe.base} vs cap${target}: ${diffPixels} / ${total} px differ ` +
            `(${((diffPixels / total) * 100).toFixed(2)}%)  maxΔ=${maxDiff}  meanΔ(over diffs)=` +
            (diffPixels ? (sumDiff / diffPixels).toFixed(2) : "0"),
    );

    capProbe.idx++;
    if (capProbe.idx < capProbe.caps.length) {
        renderer.renderProgram.maxSplatSize = capProbe.caps[capProbe.idx];
        console.log(`[probe] switched to cap=${capProbe.caps[capProbe.idx]}…`);
        return;
    }

    capProbe = null;
    renderer.renderProgram.maxSplatSize = 1024; // back to default (cap disabled)
    console.log("[probe] done (cap restored to default 1024). Capture PNGs now if a view matters.");
}

/** True if the view-projection matrix changed since the previous frame. */
function isCameraMoving(): boolean {
    const vp = camera.data.viewProj.buffer;
    const arr = vp instanceof Float32Array ? vp : new Float32Array(vp);
    if (prevViewProj && arr.length === prevViewProj.length) {
        let same = true;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i] !== prevViewProj[i]) {
                same = false;
                break;
            }
        }
        if (same) return false;
    }
    prevViewProj = new Float32Array(arr);
    return true;
}

function flushPerfSummary() {
    if (!perf.enabled) return;
    const rows = perf.summarize(true);
    if (rows.length === 0) return;

    const tableRows = rows.map((r) => ({
        phase: r.phase,
        "avg ms": fmtMs(r.avgMs),
        "p95 ms": fmtMs(r.p95Ms),
        "max ms": fmtMs(r.maxMs),
        "events/s": r.count,
    }));

    const avgOf = (phase: string) => {
        const row = rows.find((r) => r.phase === phase);
        return row && Number.isFinite(row.avgMs) ? row.avgMs : null;
    };
    const fpsOf = (phase: string) => {
        const avg = avgOf(phase);
        return avg ? (1000 / avg).toFixed(1) : "-";
    };

    const motionLabel = `${cameraMovingFrames}/${windowFrames} frames moving`;
    const stillCpu = avgOf("cpu.render.still.ms");
    const movingCpu = avgOf("cpu.render.moving.ms");

    let header = `[Perf] splats=${getSplatVertexCount()}  res=${renderer.canvas.width}x${renderer.canvas.height}`;
    header += `  |  rAF≈${fpsOf("frame.interval.ms")} fps  (${motionLabel})`;
    header += `  |  CPU: still≈${stillCpu ? stillCpu.toFixed(2) : "-"}ms moving≈${movingCpu ? movingCpu.toFixed(2) : "-"}ms`;
    header += `  |  GPU: still≈${fpsOf("gpu.render.still.ms")} moving≈${fpsOf("gpu.render.moving.ms")}`;
    if (!gpuTimer.supported) header += "  |  GPU timing unsupported";

    const cull = renderer.renderProgram.cullStats;
    if (cull.samples > 0) {
        header += `  |  cull kept≈${(cull.keptRatio * 100).toFixed(0)}% of ${cull.total} (${cull.samples} sorts)`;
        renderer.renderProgram.resetCullStats();
    }

    console.groupCollapsed(`%c${header}`, "color:#7c3aed;font-weight:bold;");
    console.table(tableRows);
    if (gpuTimer.supported) {
        console.info(
            `[Perf] GPU timer: collected=${gpuTimer.collected}, missed=${gpuTimer.misses}` +
                ` (misses mean the GPU had not finished the previous frame's query in time).`,
        );
    }
    console.info(
        "[Perf] Read like this:\n" +
            "  * cpu.render.*  — all JS + GL commands issued on the main thread;\n" +
            "  * gpu.render.*  — real GPU execution (needs EXT_disjoint_timer_query_webgl2);\n" +
            "  * If cpu.render.still.ms ≈ rAF budget (16.7@60 / 8.3@120), CPU/GL submission is the limit;\n" +
            "  * If gpu.render.still.ms is large while cpu is small, the shader/fill-rate is the limit;\n" +
            "  * sort.* and gl.depthIndex* appear only while the camera moves.",
    );
    console.groupEnd();

    cameraMovingFrames = 0;
    windowFrames = 0;
}

function resetScene() {
    // [2026-10-13] 与 `bench-measure.ts:1715` 同款：reset 中途抛错时不要让后续加载踩在半清空的状态上。
    try {
        scene.reset();
    } catch (err) {
        console.warn("[reset] scene.reset() 抛错（已忽略并继续）", err);
    }
    firstFrameStart = null;
    firstFrameLogged = false;
}

function showProgress() {
    progressContainer.hidden = false;
    progressDialog.open = true;
}

function hideProgress() {
    progressDialog.close();
    progressContainer.hidden = true;
}

// [2026-10-02] 原值 500000（flux-gs / MEGS-2 风格的分点数策略）**默认不再使用**：
//   用户明确要求"不要因为点数多就降渲染质量"。现在只有显式 `?nthresh=<count>` 才启用该策略。
//   （常量保留在此仅作记录，避免有人再去别处找不到这个 500k 的出处。）

/** Decide the render pixelRatio (= canvas CSS-size multiplier). */
function resolutionPolicyPixelRatio(vertexCount: number): { pixelRatio: number; reason: string } {
    // 1) Explicit manual override wins: ?dpr=<n>
    try {
        const dprOverride = parseFloat(new URLSearchParams(location.search).get("dpr") || "");
        if (Number.isFinite(dprOverride) && dprOverride > 0) {
            return { pixelRatio: dprOverride, reason: `?dpr=${dprOverride} (manual override)` };
        }
    } catch {
        /* ignore */
    }

    // 2) Splat-count resolution policy, mirroring flux-gs / MEGS-2:
    //      splats > threshold  -> render at 1x CSS resolution (canvas = CSS px)
    //      splats <= threshold -> render at physical (devicePixelRatio) resolution
    //    [2026-10-02 用户要求] **默认关闭**：不再因为"点数多"自动降分辨率（那会让画面明显变糊）。
    //    现在只有显式给 `?nthresh=<count>` 时才启用这条策略（做 flux 对齐测量时再用）。
    //    想强制某个分辨率：`?dpr=<n>`（上一段的手动覆盖，优先级更高）。
    let threshold = Infinity;
    try {
        const t = parseFloat(new URLSearchParams(location.search).get("nthresh") || "");
        if (Number.isFinite(t) && t > 0) threshold = t;
    } catch {
        /* ignore */
    }

    if (vertexCount > threshold) {
        return { pixelRatio: 1, reason: `splat-count policy (?nthresh=${threshold}): ${vertexCount} > ${threshold} -> 1x CSS` };
    }
    return {
        pixelRatio: window.devicePixelRatio || 1,
        reason: threshold === Infinity ? "default: physical DPR (splat-count policy OFF)" : `splat-count policy: ${vertexCount} <= ${threshold} -> physical DPR`,
    };
}

function adjustPixelRatio() {
    const splat = scene.objects.find((o) => o instanceof SPLAT.Splat) as SPLAT.Splat | undefined;
    const vertexCount = splat?.data?.vertexCount ?? 0;
    const policy = resolutionPolicyPixelRatio(vertexCount);
    renderer.setPixelRatio(policy.pixelRatio);
    console.log(`Vertex count: ${vertexCount}, pixel ratio set to: ${policy.pixelRatio.toFixed(2)} (${policy.reason})`);
    console.log(`Render resolution: ${renderer.canvas.width} x ${renderer.canvas.height}`);
}

/**
 * [2026-10-13] **演示页默认套用 Flux 默认视角**，使线上演示与 Flux-GS 取景一致。
 *   数据源：`bench-flux-camera.json`（随站点一起发布）
 *     · `focal_px` = 1159.588，`cameras[0].position/rotation` = Flux 原代码的 default_view（**13 场景共用**）
 *     · 其 note 明确：position/rotation 与 gsplat.js 的 `CameraData.update` 同构，可直接套用
 *   开关：`?cam=flux`（默认）/ `?cam=fluxcam:N`（它第 N 个硬编码镜头）/ `?cam=auto`（回退旧的自适应取景）
 *   资产缺失或解析失败 ⇒ 静默保持原行为（不 alert，避免打扰演示）。
 */
async function applyFluxCameraDefault(): Promise<void> {
    const q = new URLSearchParams(location.search);
    const mode = (q.get("cam") || "flux").toLowerCase();
    if (mode === "auto" || mode === "off" || mode === "ours") return;
    const want = /^fluxcam:(\d+)$/.exec(mode);
    try {
        const res = await fetch("./bench-flux-camera.json");
        if (!res.ok) return;
        const asset = (await res.json()) as {
            focal_px?: number;
            refWidth?: number;
            cameras?: { id?: number; width?: number; position?: number[]; quaternion?: number[] }[];
            default_view?: { position?: number[]; quaternion?: number[]; view_matrix?: number[] };
        };
        const cams = asset.cameras ?? [];
        // 【关键】默认视角要用资产里的 `default_view`（Flux 未交互时的原始视角，13 场景共用）；
        // `cameras[N]` 是"第 N 个硬编码镜头"，**不是**默认视角。
        const entry = want ? cams[Number(want[1])] : asset.default_view ?? cams[0];
        if (!entry?.position || entry.position.length < 3) return;

        // 焦距按画布宽等比缩放：资产焦距是在参照分辨率(width=1959)下的像素焦距，
        // 画布更宽时若沿用同一像素值会"变大"（FOV 变小）⇒ 这里保持 fx/width 不变才叫取景一致。
        const refW = asset.refWidth ?? cams.find((c) => typeof c?.width === "number")?.width ?? 1959;
        const canvasW = renderer.canvas.width || refW;
        const focal = Number.isFinite(asset.focal_px) && (asset.focal_px as number) > 0 ? (asset.focal_px as number) : camera.data.fx;
        const fx = focal * (canvasW / refW);
        camera.data.fx = fx;
        camera.data.fy = fx;

        const p = entry.position;
        camera.position = new SPLAT.Vector3(p[0], p[1], p[2]);
        // 【关键】资产里的 `rotation` 是 3x3 矩阵（9 个数），**四元数在 `quaternion` 字段**（[x,y,z,w]）。
        const qd = entry.quaternion;
        if (qd && qd.length === 4) {
            camera.rotation = new SPLAT.Quaternion(qd[0], qd[1], qd[2], qd[3]);
        }
        camera.update();

        // 【关键】OrbitControls 每帧都会 `lookAt(target)` ⇒ 不设 target 的话朝向会立刻被改回旧值。
        // Flux 的 default_view 看向**原点**（用它的 view_matrix 反解目标点 ≈ (0,0,0)：p + Rᵗ·t ≈ 0），
        // 所以把 target 放到原点：既保住朝向，也让后续拖拽/阻尼从正确状态开始。
        // `?cam=nolookat` 跳过这一步（只保留纯四元数朝向），用于 A/B 对比。
        if (mode !== "nolookat" && controls) {
            const oc = controls as unknown as { target: SPLAT.Vector3 };
            oc.target = new SPLAT.Vector3(0, 0, 0);
            controls.update();
        }
        console.info(
            `[cam] 已套用 Flux ${want ? `镜头#${want[1]}` : "default_view"}：pos=(${p.map((v) => v.toFixed(3)).join(", ")}) ` +
                `fx=${fx.toFixed(1)}（画布宽 ${canvasW} / 参照 ${refW}）`,
        );
    } catch (e) {
        console.warn("[cam] Flux 默认视角套用失败（保持原行为）", e);
    }
}

async function loadFromUrl(url: string) {
    resetScene();
    stopLoop(); // [2026-10-13] 加载期间停帧（见 startLoop 注释）
    showProgress();
    firstFrameStart = performance.now();
    firstFrameLogged = false;

    try {
        await SPLAT.PLYLoader.LoadAsync(url, scene, (progress) => {
            progressIndicator.value = progress * 100;
        });
        adjustPixelRatio();
        applySceneTweaks();
        await applyFluxCameraDefault();
    } catch (err) {
        console.error("Failed to load scene:", err);
        // [2026-10-13] 不再用阻塞式 `alert`：它会把页面留在"停帧 + 黑屏"状态且手机端难取证。
        flashLoadError(`加载失败：${url}\n${err instanceof Error ? err.message : String(err)}`);
    } finally {
        // [2026-10-13] **成败都必须恢复渲染**：循环若停在"加载中"，页面就永久黑屏（切场景失败时最容易踩到）。
        hideProgress();
        dropZone.style.display = "none";
        logLowRankSelfCheck();
        startLoop();
        logLoadDiag(url);
    }
}

async function loadFile(file: File) {
    resetScene();
    stopLoop(); // [2026-10-13] 加载期间停帧（见 startLoop 注释）
    showProgress();
    firstFrameStart = performance.now();
    firstFrameLogged = false;

    try {
        await SPLAT.PLYLoader.LoadFromFileAsync(file, scene, (progress) => {
            progressIndicator.value = progress * 100;
        });
    } catch (err) {
        console.error("Failed to load file:", err);
        flashLoadError(`加载失败：${file.name}\n${err instanceof Error ? err.message : String(err)}`);
        hideProgress();
        startLoop(); // [2026-10-13] 失败也别把渲染循环停死（否则表现为永久黑屏）
        return;
    }

    adjustPixelRatio();
    applySceneTweaks();
    await applyFluxCameraDefault();
    logLowRankSelfCheck();
    startLoop(); // [2026-10-13] 数据齐了才开始渲染（否则 ?lr=1 会每帧抛错、全黑）
    logLoadDiag(file.name);
    hideProgress();
    dropZone.style.display = "none";
    sceneSelect.value = "";
}

/**
 * 解析 `?scene=` 直达参数（给"在线 Demo 直达链接"用；**不带参数时行为完全不变**，
 * 访客仍然需要手动在下拉框里选择场景）。
 *
 *   ?scene=truck                     按文件名/显示名的子串匹配（大小写不敏感）
 *   ?scene=2                         1 起算的下拉序号
 *   ?scene=scenes/xxx.ply            直接给相对路径
 *   ?scene=https://.../xxx.ply       直接给完整 URL（需目标站允许跨域）
 *   ?scene=0 / ?scene=off            显式关闭预选
 */
function resolvePresetScene(options: { value: string; text: string }[]): { index: number; directUrl: string } {
    let raw = "";
    try {
        raw = (new URLSearchParams(location.search).get("scene") || "").trim();
    } catch {
        /* ignore */
    }
    if (!raw || raw === "0" || raw.toLowerCase() === "off") return { index: -1, directUrl: "" };

    const lower = raw.toLowerCase();
    const exact = options.findIndex((o) => o.value.toLowerCase() === lower);
    if (exact >= 0) return { index: exact, directUrl: "" };
    const byText = options.findIndex((o) => o.text.toLowerCase().includes(lower));
    if (byText >= 0) return { index: byText, directUrl: "" };
    const byPath = options.findIndex((o) => o.value.toLowerCase().includes(lower));
    if (byPath >= 0) return { index: byPath, directUrl: "" };
    const asIndex = parseInt(raw, 10);
    if (Number.isFinite(asIndex) && asIndex >= 1 && asIndex <= options.length) {
        return { index: asIndex - 1, directUrl: "" };
    }
    if (/\.ply(\?|$)/i.test(raw) || /^https?:/i.test(raw)) return { index: -1, directUrl: raw };
    return { index: -1, directUrl: "" };
}

async function populateSceneSelector() {
    let scenes: { name: string; file: string }[] = [];
    try {
        const response = await fetch("scenes.json");
        if (!response.ok) {
            console.warn("scenes.json not found");
        } else {
            scenes = await response.json();
        }
    } catch (err) {
        console.warn("Failed to load scenes.json:", err);
    }

    for (const scene of scenes) {
        const option = document.createElement("option");
        option.value = scene.file;
        option.textContent = scene.name;
        sceneSelect.appendChild(option);
    }

    // ?scene= 预选（缺省无参数 → 保持"手动选择后才渲染"的既有行为，不额外下载模型）
    const preset = resolvePresetScene(scenes.map((s) => ({ value: s.file, text: s.name })));
    if (preset.index >= 0) {
        const option = sceneSelect.options[preset.index + 1]; // +1: 第 0 项是占位 "-- Select a scene --"
        if (option) {
            sceneSelect.value = option.value;
            console.info(`[scene] ?scene= 预选：${option.textContent}`);
            void loadFromUrl(option.value);
        }
    } else if (preset.directUrl) {
        console.info(`[scene] ?scene= 直接加载：${preset.directUrl}`);
        void loadFromUrl(preset.directUrl);
    }
}

sceneSelect.addEventListener("change", (e) => {
    const target = e.target as HTMLSelectElement;
    const url = target.value;
    if (url) {
        // [2026-10-13] 默认**整页重载切场景**：就地切换依赖"旧场景状态被彻底清干净"，一旦有残留就整屏黑
        //   （用户实测：首个场景正常、切到别的场景全黑）。页面本来就支持 `?scene=` 直达，重载后机位、
        //   臂开关、像素比、RAF 门控都会按同一份逻辑重新套一遍 ⇒ 结果与首次进入完全一致、可复现。
        //   `?switch=inline` 保留原来的就地切换（配合 `[diag]` 一行诊断定位残留状态用）。
        if (new URLSearchParams(location.search).get("switch") !== "inline") {
            const u = new URL(location.href);
            u.searchParams.set("scene", url);
            console.info(`[scene] 整页重载切换 ⇒ ${u.toString()}`);
            location.href = u.toString();
            return;
        }
        void loadFromUrl(url);
    }
});

fileInput.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
        void loadFile(file);
    }
});

dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer?.files[0];
    if (file) {
        void loadFile(file);
    }
});

dropZone.addEventListener("click", () => {
    fileInput.click();
});

/**
 * [2026-10-13] RAF 循环开关 —— 与 `bench-view.ts:129-138` 同一修复：
 *   `?shcache/lr/notx/nocolortx` 这些臂开关由**渲染程序自己读页面 URL** 决定，而低秩载荷（lrRank）
 *   与逐点变换表（transformsHeight）是在 PLY **流式解码过程中**才逐步挂到 Splat 上的。
 *   若此时已有 RAF 在 `renderer.render()`：第一帧就会在"数据没齐"的状态下建 RenderData
 *     · `?lr=1` ⇒ `sphericalHarmonics.lowRank` 缺失 ⇒ **每帧抛错、画面持续全黑**；
 *     · `?notx=1` ⇒ 运行期自证 `transformsHeight === 1` 判成 0 ⇒ 永久 `notx-rejected`。
 *   所以：**加载完成后再起循环**；切换场景前先停帧（见 loadFromUrl / loadFile）。
 */
let loopRunning = false;
let frameRef: ((now: number) => void) | null = null;

function startLoop(): void {
    if (loopRunning) return;
    loopRunning = true;
    if (frameRef) requestAnimationFrame(frameRef);
}

function stopLoop(): void {
    loopRunning = false;
}

/** [2026-10-13] `?lr=1` 载荷自证：加载完成后确认低秩载荷确实挂上了（缺了就会全黑，见 startLoop 注释）。 */
function logLowRankSelfCheck(): void {
    if (!new URLSearchParams(location.search).has("lr")) return;
    const splat = scene.objects.find((o) => o instanceof SPLAT.Splat) as SPLAT.Splat | undefined;
    const lowRank = (splat?.data as unknown as { sphericalHarmonics?: { lowRank?: unknown } } | undefined)
        ?.sphericalHarmonics?.lowRank;
    if (lowRank) {
        console.info("[lr] 载荷自证：sphericalHarmonics.lowRank 存在 ✓");
    } else {
        console.warn(
            "[lr] 载荷自证：sphericalHarmonics.lowRank **缺失** ⇒ 请去掉 lr=1（用 ?arm=base），否则每帧抛错、画面全黑",
        );
    }
}

/** [2026-10-13] 非阻塞错误横幅。替代 `alert`：阻塞弹窗会把页面留在"停帧 + 黑屏"状态，手机端还会吞掉控制台信息。 */
function flashLoadError(msg: string): void {
    let el = document.getElementById("load-error-banner");
    if (!el) {
        el = document.createElement("div");
        el.id = "load-error-banner";
        el.style.cssText =
            "position:fixed;left:12px;bottom:12px;max-width:72vw;padding:10px 14px;border-radius:6px;" +
            "background:rgba(127,29,29,.92);color:#fff;font:13px/1.5 ui-monospace,monospace;z-index:20;white-space:pre-wrap";
        document.body.appendChild(el);
    }
    el.textContent = msg;
}

/**
 * 累计已渲染帧数（**单调递增**，`logLoadDiag` 用它判断"循环到底有没有在出帧"）。
 * 注意：与上面 FPS 用的 `frameCount`（每秒清零）不是一回事，故另起名字。
 */
let renderedFrameTotal = 0;

/**
 * [2026-10-13] 每次加载结束后打一行**切场景诊断**，并在 1 秒后再判一次，用于定位"首个场景正常、切到别的场景全黑"：
 *   · `objects>1` ⇒ 上一个场景没被清掉（旧 Splat 残留会让渲染器带上旧状态）；
 *   · `lowRank=✗` 且 URL 带 `lr=1` ⇒ 载荷没挂上（渲染器每帧抛错 ⇒ 全黑）；
 *   · 1s 后帧数不增 ⇒ `renderer.render` 里在抛异常；`loop=false` ⇒ 循环根本没恢复。
 */
function logLoadDiag(label: string): void {
    const splats = scene.objects.filter((o) => o instanceof SPLAT.Splat) as SPLAT.Splat[];
    const splat = splats[0];
    const lowRank = (splat?.data as unknown as { sphericalHarmonics?: { lowRank?: unknown } } | undefined)
        ?.sphericalHarmonics?.lowRank;
    const frames0 = renderedFrameTotal;
    console.info(
        `[diag] ${label}: objects=${scene.objects.length}(splat=${splats.length}) vertex=${splat?.data?.vertexCount ?? 0} ` +
            `lowRank=${lowRank ? "✓" : "✗"} loop=${loopRunning} frames=${frames0}`,
    );
    if (scene.objects.length > 1) {
        console.warn("[diag] scene 里对象数 > 1 ⇒ 上一个场景有残留（切场景的 reset 没清干净）");
    }
    window.setTimeout(() => {
        const delta = renderedFrameTotal - frames0;
        if (!loopRunning) {
            console.warn("[diag] 1s 后：循环仍处于**停止**状态 ⇒ 不会再有新帧（这就是全黑的直接原因）");
        } else if (delta === 0) {
            console.warn("[diag] 1s 后：循环在跑但**没有新帧** ⇒ renderer.render 内抛异常（多半是 lr/notx 开关与载荷不匹配）");
        } else {
            console.info(`[diag] 1s 后：帧数 +${delta}（循环正常）⇒ 若画面仍黑，问题在渲染内容/相机而不在循环`);
        }
    }, 1000);
}

function main() {
    const handleResize = () => {
        renderer.resize();
    };

    const frame = (now: number) => {
        // [2026-10-13] 循环被停（加载中）时直接退出：不在"数据没齐"时建 RenderData（见 startLoop 注释）。
        if (!loopRunning) return;
        renderedFrameTotal++;
        const nowMs = now || performance.now();

        const frameMs = lastFrameAt > 0 ? nowMs - lastFrameAt : 0;
        if (frameMs > 0) {
            perf.sample("frame.interval.ms", frameMs);
            tickResolutionScan(nowMs, frameMs);
        }
        lastFrameAt = nowMs;

        const tControls = performance.now();
        controls.update();
        perf.sample("cpu.controls.update.ms", performance.now() - tControls);

        if (perf.enabled) windowFrames++;
        const moving = perf.enabled && isCameraMoving();
        if (moving) cameraMovingFrames++;
        const renderCpuKey = moving ? "cpu.render.moving.ms" : "cpu.render.still.ms";
        const renderGpuKey = moving ? "gpu.render.moving.ms" : "gpu.render.still.ms";

        if (perf.enabled) {
            gpuTimer.begin(renderGpuKey);
        }
        const tRender = performance.now();
        renderer.render(scene, camera);
        perf.sample(renderCpuKey, performance.now() - tRender);
        if (perf.enabled) {
            gpuTimer.end();
        }

        tickCapture();
        tickCapProbe();

        if (firstFrameStart !== null && !firstFrameLogged && scene.objects.length > 0) {
            const elapsedSeconds = (performance.now() - firstFrameStart) / 1000;
            console.log(`First Frame: ${elapsedSeconds.toFixed(3)} s`);
            firstFrameLogged = true;
        }
        updateFps();

        if (perf.enabled && nowMs - lastSummaryAt >= 1000) {
            flushPerfSummary();
            lastSummaryAt = nowMs;
        }

        requestAnimationFrame(frame);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    void populateSceneSelector();
    // [2026-10-13] **不再在这里无条件起 RAF**：数据没齐就渲染会让 `?lr=1` 每帧抛错、画面全黑
    //   （与 bench-view.ts 同一修复）。循环改由加载完成后 `startLoop()` 启动；
    //   `?scene=` 直达与拖拽文件两条路径都会在 load* 末尾调用它。
    frameRef = frame;
    if (loopRunning) requestAnimationFrame(frame);
}

function setBenchmarkResolution(width: number, height: number) {
    renderer.disableAutoResize();
    renderer.setPixelRatio(1);
    renderer.setSize(width, height);
    console.log(`Benchmark resolution set to: ${renderer.canvas.width} x ${renderer.canvas.height}`);
}

async function benchmarkFPS(frameCount: number = 300, batchSize: number = 60) {
    if (scene.objects.length === 0) {
        console.warn("No scene loaded");
        return;
    }

    // Warm-up
    for (let i = 0; i < 30; i++) {
        controls.update();
        renderer.render(scene, camera);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const start = performance.now();
    let rendered = 0;
    while (rendered < frameCount) {
        const currentBatch = Math.min(batchSize, frameCount - rendered);
        for (let i = 0; i < currentBatch; i++) {
            const tControls = performance.now();
            controls.update();
            perf.sample("bench.controls.update.ms", performance.now() - tControls);

            const tRender = performance.now();
            renderer.render(scene, camera);
            perf.sample("bench.renderer.render.ms", performance.now() - tRender);
        }
        rendered += currentBatch;
        if (rendered < frameCount) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    const elapsed = (performance.now() - start) / 1000;
    const fps = frameCount / elapsed;
    console.log(`Benchmark FPS: ${fps.toFixed(2)} (${frameCount} frames in ${elapsed.toFixed(3)} s)`);
    console.log(`Render resolution: ${renderer.canvas.width} x ${renderer.canvas.height}`);
    flushPerfSummary();
}

(window as unknown as { benchmarkFPS: typeof benchmarkFPS }).benchmarkFPS = benchmarkFPS;
(window as unknown as { setBenchmarkResolution: typeof setBenchmarkResolution }).setBenchmarkResolution =
    setBenchmarkResolution;
// Console helpers for profiling sessions:
//   __PERF__.flush()                    -> print accumulated samples and reset
//   __PERF__.reset()                    -> discard accumulated samples
//   __PERF__.setResolutionScale(2)      -> clamp render resolution (mobile)
//   __PERF__.restoreResolutionAutoScale()-> back to automatic DPR sizing
//   __PERF__.scanResolution([1,2,4])    -> auto A/B several resolutions (hold still)
//   __PERF__.setMaxSplatSize(512)       -> cap max splat footprint (overdraw A/B)
//   __PERF__.captureFrame("name")       -> save current view as PNG (A/B quality)
(
    window as unknown as {
        __PERF__: {
            flush: () => void;
            reset: () => void;
            setResolutionScale: (scale: number) => void;
            restoreResolutionAutoScale: () => void;
            scanResolution: (scales?: number[], secondsPerStage?: number) => void;
            setMaxSplatSize: (size: number) => void;
            captureFrame: (label: string) => void;
            probeCap: (cap?: number) => void;
            probeCapCurve: (caps?: number[]) => void;
        };
    }
).__PERF__ = {
    flush: flushPerfSummary,
    reset: () => perf.reset(),
    setResolutionScale,
    restoreResolutionAutoScale,
    scanResolution,
    setMaxSplatSize: (size: number) => {
        renderer.renderProgram.maxSplatSize = size;
        console.log(`[tweak] maxSplatSize=${size}`);
    },
    captureFrame,
    probeCap: (cap?: number) => startCapProbe(cap ? [cap] : [256]),
    probeCapCurve: (caps?: number[]) => startCapProbe(caps ?? [384, 256, 160]),
};

main();
