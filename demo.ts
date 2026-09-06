import * as SPLAT from "./src/index";
import { perf, GpuFrameTimer } from "./src/utils/PerfDebug";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const progressDialog = document.getElementById("progress-dialog") as HTMLDialogElement;
const progressIndicator = document.getElementById("progress-indicator") as HTMLProgressElement;
const progressContainer = document.getElementById("progress-container") as HTMLDivElement;
const fpsCounter = document.getElementById("fps-counter") as HTMLDivElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const dropZone = document.getElementById("drop-zone") as HTMLDivElement;
const sceneSelect = document.getElementById("scene-select") as HTMLSelectElement;

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
    scene.reset();
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

const SPLAT_COUNT_RES_THRESHOLD = 500000; // flux-gs / MEGS-2 style split

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
    //    Threshold overridable: ?nthresh=<count>
    let threshold = SPLAT_COUNT_RES_THRESHOLD;
    try {
        const t = parseFloat(new URLSearchParams(location.search).get("nthresh") || "");
        if (Number.isFinite(t) && t > 0) threshold = t;
    } catch {
        /* ignore */
    }

    if (vertexCount > threshold) {
        return { pixelRatio: 1, reason: `splat-count policy: ${vertexCount} > ${threshold} -> 1x CSS` };
    }
    return {
        pixelRatio: window.devicePixelRatio || 1,
        reason: `splat-count policy: ${vertexCount} <= ${threshold} -> physical DPR`,
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

async function loadFromUrl(url: string) {
    resetScene();
    showProgress();
    firstFrameStart = performance.now();
    firstFrameLogged = false;

    try {
        await SPLAT.PLYLoader.LoadAsync(url, scene, (progress) => {
            progressIndicator.value = progress * 100;
        });
        adjustPixelRatio();
        applySceneTweaks();
    } catch (err) {
        console.error("Failed to load scene:", err);
        alert(`Failed to load scene: ${url}`);
    } finally {
        hideProgress();
        dropZone.style.display = "none";
    }
}

async function loadFile(file: File) {
    resetScene();
    showProgress();
    firstFrameStart = performance.now();
    firstFrameLogged = false;

    await SPLAT.PLYLoader.LoadFromFileAsync(file, scene, (progress) => {
        progressIndicator.value = progress * 100;
    });

    adjustPixelRatio();
    applySceneTweaks();
    hideProgress();
    dropZone.style.display = "none";
    sceneSelect.value = "";
}

async function populateSceneSelector() {
    try {
        const response = await fetch("scenes.json");
        if (!response.ok) {
            console.warn("scenes.json not found");
            return;
        }
        const scenes: { name: string; file: string }[] = await response.json();
        for (const scene of scenes) {
            const option = document.createElement("option");
            option.value = scene.file;
            option.textContent = scene.name;
            sceneSelect.appendChild(option);
        }
    } catch (err) {
        console.warn("Failed to load scenes.json:", err);
    }
}

sceneSelect.addEventListener("change", (e) => {
    const target = e.target as HTMLSelectElement;
    const url = target.value;
    if (url) {
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

function main() {
    const handleResize = () => {
        renderer.resize();
    };

    const frame = (now: number) => {
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
    requestAnimationFrame(frame);
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
