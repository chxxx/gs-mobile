/**
 * bench-measure.ts — 单轮测量内核（旧 bench.ts 的 `measureRound` 及其依赖，原样搬到这里，口径不变）。
 *
 * 谁在用：
 *   - bench-case.ts（子测试页，静态导入）：一个 iframe 只创建一次本类的实例，测完即释放；
 *   - bench-view.ts（mode=view 展示模式）复用同一份 frameScene / 相机逻辑。
 * 谁**不能**用：
 *   - bench.ts（父调度页）在 mode=bench 下不得导入本文件 —— 该文件 import 了 src/index，
 *     会连带把渲染器/wasm 模块拉进父页面。父页面靠"不导入"来保证 bench 模式下零 WebGL 上下文。
 */
import * as SPLAT from "./src/index";
import { CAM_FLUX, fluxSpec, param } from "./bench-shared";
import type { RoundResult, SceneMeta } from "./bench-shared";
import {
    fluxNativeBufferSize,
    formatResolutionAudit,
    projectionFovHash,
    projectionFovKey,
    replicationFocalPx,
    resolutionAuditFrom,
    runFluxLoop,
    timerClampObservedFrom,
    viewMatrixHash,
} from "./bench-flux-protocol";
import type { FluxLoopResult, ResolutionAudit, ThroughputDriver } from "./bench-flux-protocol";
import type { ResolutionAudit as SlaveResolutionAudit, WorkloadAudit as SlaveWorkloadAudit } from "./bench-audit";
import type { ContextState as SlaveContextState, SortAudit as SlaveSortAudit } from "./bench-controller";

export type { SlaveResolutionAudit, SlaveWorkloadAudit, SlaveContextState, SlaveSortAudit };

export type { ThroughputDriver } from "./bench-flux-protocol";

/** Flux-GS 原相机资产（`bench-flux-camera.json`，由 tools/extract_flux_camera.py 抽出）。 */
export interface FluxCameraAsset {
    focal_px: number;
    default_view: { position: number[]; quaternion: number[] };
}

/** 一轮测量需要的、来自父页面 job 的参数。 */
export interface MeasureOptions {
    /** 已带 `ts=` 令牌的模型 URL（cache-busting 与旧口径完全一致） */
    modelUrl: string;
    /** 令牌本身：用于从 Resource Timing 里定位本轮的下载段 */
    token: string;
    resW: number;
    resH: number;
    frames: number;
    warmup: number;
    /** 中止信号：disposeCase() 会 abort 它，取消 fetch/读取与后续解码 */
    signal?: AbortSignal;
    /** 阶段回调（只用于 UI，不参与计时） */
    onPhase?: (phase: "loading" | "sorting" | "measuring") => void;
    /** 时间线打点回调（写日志用，不参与计时） */
    onMark?: (mark: string, detail?: string) => void;
}

/** 测帧驱动方式见 `bench-flux-protocol.ts`：`timer` = 参考协议（setTimeout(0) 链），`raf` = 旧口径。 */

/** 测帧统计（诊断字段；FPS 公式与参考协议一致：frames / 整段墙钟秒数）。 */
export interface ThroughputStats {
    driver: ThroughputDriver;
    /** 计划帧数（= frames 参数） */
    frames: number;
    /** 实际完成的帧数（被取消时会 < frames） */
    rendered: number;
    /** 测帧区间内 `frameRender()` 的真实调用次数（应等于 rendered） */
    renders: number;
    elapsedMs: number;
    fps: number;
    cpuMs: number;
    gapMinMs: number;
    gapMedMs: number;
    gapMaxMs: number;
    warmupMs: number;
    aborted: boolean;
    note: string;
    /** 协议是否与参考协议一致（无 driver 冲突） */
    protocolMatched: boolean;
    /** 是否可归类为 Flux-compatible FPS（protocolMatched && driver === "timer"） */
    fluxCompatible: boolean;
    /** 作废原因（"" = 正常完成；hidden / context-lost / stopped / …） */
    abortedReason: string;
    /** 相邻帧开始间隔的中位数 / P95（诊断） */
    timerGapMedMs: number;
    timerGapP95Ms: number;
    /** 是否**实测到** setTimeout(0) 节拍聚集（条件判定；不是"约 250fps 上限"的常量结论） */
    timerClampObserved: boolean;
    /** 测量结束时的 document.visibilityState */
    visibilityState: string;
    /** 本轮实际分辨率审计块（canvas / drawingBuffer / viewport / css …） */
    resolution: ResolutionAudit | null;
}

function emptyThroughput(driver: ThroughputDriver, note: string): ThroughputStats {
    const spec = fluxSpec();
    return {
        driver,
        frames: 0,
        rendered: 0,
        renders: 0,
        elapsedMs: 0,
        fps: 0,
        cpuMs: 0,
        gapMinMs: 0,
        gapMedMs: 0,
        gapMaxMs: 0,
        warmupMs: 0,
        aborted: true,
        note,
        protocolMatched: spec.protocolMatched,
        fluxCompatible: false,
        abortedReason: note,
        timerGapMedMs: 0,
        timerGapP95Ms: 0,
        timerClampObserved: false,
        visibilityState: "",
        resolution: null,
    };
}

/**
 * 一个测量会话持有的全部对象：canvas / renderer / scene / camera / controls。
 * 生命周期由调用方控制：`createRenderer()` → `measureOneRound()` → `dispose()`。
 * `dispose()` 幂等；一旦 `dispose()` 被调用（或 `stopped` 置位），后续渲染/写场景的动作全部空转。
 */
export class BenchCase {
    readonly canvas: HTMLCanvasElement;
    readonly scene: SPLAT.Scene;
    readonly camera: SPLAT.Camera;
    renderer: SPLAT.WebGLRenderer | null = null;
    controls: SPLAT.OrbitControls | null = null;
    /** `cam=flux`：机位由显式注入指定，frameRender 不再让 OrbitControls 覆写相机 */
    cameraLocked = false;
    /** 置位后不再渲染、不再写 scene（清理/取消后防止迟到的异步续体污染场景） */
    stopped = false;
    /** 是否已经对上下文调用过 `WEBGL_lose_context.loseContext()`（幂等 + 供子页面日志说明） */
    loseContextCalled = false;
    /** `frameRender()` 的累计调用次数（诊断：用来证明"测帧区间里确实发生了 N 次 render"） */
    renderCalls = 0;
    /** WebGL 上下文丢失标记：由 bench-case.ts 的 onContextLost 置位；置位后测帧必须立即作废 */
    contextLost = false;
    /** 最近一次分辨率审计块（applyResolutionProtocol 的输出，供结果上报） */
    lastResolution: ResolutionAudit | null = null;

    private _fluxCamera: FluxCameraAsset | null = null;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.scene = new SPLAT.Scene();
        this.camera = new SPLAT.Camera();
    }

    /** 创建渲染器（WebGL2 上下文）。失败会抛错，由调用方决定是否换 canvas 重试。 */
    createRenderer(): SPLAT.WebGLRenderer {
        this.renderer = new SPLAT.WebGLRenderer(this.canvas);
        return this.renderer;
    }

    ensureControls(): SPLAT.OrbitControls {
        if (!this.controls) this.controls = new SPLAT.OrbitControls(this.camera, this.canvas);
        return this.controls;
    }

    /** 载入模型（PLY/QPLY/low-rank QPLY 由 PLYLoader 自行判定），Splat 会被加进本会话的 scene。
     *  传入 `signal` 可在 dispose 时取消下载/读取（PLYLoader 会在中止后抛 AbortError）。 */
    loadSplat(url: string, signal?: AbortSignal): Promise<SPLAT.Splat> {
        return SPLAT.PLYLoader.LoadAsync(url, this.scene, undefined, "", false, signal);
    }

    /** 测帧分辨率：关掉自动 resize + 像素比 1 + 固定 W×H（与旧口径一致）。 */
    setBenchmarkResolution(w: number, h: number): void {
        const renderer = this.renderer;
        if (!renderer) return;
        renderer.disableAutoResize();
        renderer.setPixelRatio(1);
        renderer.setSize(w, h);
    }

    frameRender(): void {
        if (this.stopped) return;
        if (this.controls && !this.cameraLocked) this.controls.update();
        this.renderCalls++;
        this.renderer?.render(this.scene, this.camera);
    }

    /** 画布/后缓冲的实际尺寸（用于证明"测的就是 1600×1063"）。 */
    canvasStats(): { cssW: number; cssH: number; bufW: number; bufH: number; glW: number; glH: number } {
        const gl = this.renderer?.gl as WebGL2RenderingContext | undefined;
        return {
            cssW: this.canvas.clientWidth,
            cssH: this.canvas.clientHeight,
            bufW: this.canvas.width,
            bufH: this.canvas.height,
            glW: gl?.drawingBufferWidth ?? -1,
            glH: gl?.drawingBufferHeight ?? -1,
        };
    }

    /** 诊断摘要：canvas / drawingBuffer / css 尺寸一行输出（item 6）。 */
    canvasStatsLine(): string {
        const s = this.canvasStats();
        return (
            `canvas=${s.bufW}x${s.bufH} drawingBuffer=${s.glW}x${s.glH} ` +
            `css=${s.cssW}x${s.cssH} (canvas 后备缓冲必须等于 res；css 只是显示尺寸)`
        );
    }

    // ------------------------------------------------------------------ 第 6/7 阶段：分辨率协议
    /**
     * 应用协议分辨率，**复刻官方 Flux-GS 的画布策略**（FLUX_FPS_PROTOCOL.md §C.3）：
     *   - `flux-fixed`（force=WxH / 显式 res=WxH）：两边强制相同 drawing buffer；
     *   - `flux-native`（proto=flux 且未强制）：`downsample = 字节/32 > 500000 ? 1 : 1/dpr`，
     *     `buffer = round(css / downsample)`（官方 `main.js:1551-1552` + `1688-1689`）。
     *
     * 焦距同时按"两边 FOV 相同"对齐：fixed 直接用 Flux 焦距（官方 benchres 模式下 projW 就是 W），
     * native 按 `bufferW / cssW` 缩放（官方投影用的是 CSS 视口宽度）。
     *
     * @param modelBytes 本轮模型下载后的 body 字节数（官方用它决定 downsample）；0/负数 = 未知
     */
    applyResolutionProtocol(modelBytes: number): ResolutionAudit {
        const spec = fluxSpec();
        const renderer = this.renderer;
        const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        const cssW = Math.max(1, Math.round(this.canvas.clientWidth || window.innerWidth || 1));
        const cssH = Math.max(1, Math.round(this.canvas.clientHeight || window.innerHeight || 1));
        let bufW: number;
        let bufH: number;
        if (spec.resolutionMode === "flux-fixed") {
            const size = spec.forcedRes ?? { w: 1600, h: 1063 };
            bufW = size.w;
            bufH = size.h;
        } else {
            const size = fluxNativeBufferSize(cssW, cssH, modelBytes, dpr);
            bufW = size.w;
            bufH = size.h;
        }
        if (renderer) {
            renderer.disableAutoResize();
            renderer.setPixelRatio(1);
            renderer.setSize(bufW, bufH);
        }
        if (spec.focalPx > 0) {
            const fx = replicationFocalPx(spec, bufW, cssW);
            this.camera.data.fx = fx;
            this.camera.data.fy = fx;
            this.camera.update();
        }
        this.lastResolution = this.resolutionAudit();
        return this.lastResolution;
    }

    /** 分辨率审计块：canvas / drawingBuffer / viewport / css / dpr / 内部尺度 / 自适应开关。 */
    resolutionAudit(): ResolutionAudit {
        const spec = fluxSpec();
        const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        const gl = this.renderer?.gl as WebGL2RenderingContext | undefined;
        let viewport: [number, number, number, number] | undefined;
        if (gl) {
            try {
                const v = gl.getParameter(gl.VIEWPORT) as Int32Array | number[];
                if (v && v.length >= 4) viewport = [Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3])];
            } catch {
                /* ignore */
            }
        }
        return resolutionAuditFrom(
            this.canvas,
            gl
                ? {
                      drawingBufferWidth: gl.drawingBufferWidth,
                      drawingBufferHeight: gl.drawingBufferHeight,
                      viewport,
                  }
                : null,
            dpr,
            spec.resolutionMode,
        );
    }

    // ------------------------------------------------------------------ 第 8 阶段：相机 / 负载审计
    /** 完整 view matrix + 哈希（与 Flux 臂回报的 `view` 用同一个哈希函数，可直接比对）。 */
    cameraAudit(): { view16: number[]; hash: number; focalPx: number } {
        const view16 = Array.from(this.camera.data.viewMatrix.buffer as unknown as ArrayLike<number>);
        return { view16, hash: viewMatrixHash(view16), focalPx: this.camera.data.fx };
    }

    /** 该轮是否必须作废：被取消 / 上下文丢失 / 页面隐藏（三者都不产生可用数据）。 */
    abortReason(): string {
        if (this.stopped) return "stopped";
        if (this.contextLost) return "context-lost";
        try {
            if (typeof document !== "undefined" && document.visibilityState === "hidden") return "hidden";
        } catch {
            /* ignore */
        }
        return "";
    }

    /** 高斯负载：提交给 draw 的实例数 + 视锥保留估计（用于判断"矩阵相同但负载是否不同"）。 */
    gaussianLoad(submitted: number): { submitted: number; visible: number; note: string } {
        const cull = this.renderer?.renderProgram?.cullStats;
        if (cull && cull.total > 0 && cull.samples > 0) {
            return { submitted, visible: Math.round(cull.total * cull.keptRatio), note: "renderer-cull" };
        }
        return { submitted, visible: submitted, note: "no-cull-stats(visible=submitted)" };
    }

    /**
     * 第 5 阶段：与 Flux-GS `runFluxBenchmark()` **逐行一致**的测帧（共享 harness，
     * 见 `bench-flux-protocol.ts` 的 `runFluxLoop`）：
     *   - 驱动 = `setTimeout(…, 0)`（不是 rAF）；
     *   - 每次迭代：`render()` → 排下一帧（timer 开销计入 elapsed）；
     *   - 计时起点 = 第 1 帧 render **结束**时刻，终点 = 第 N 帧 render **结束**时刻；
     *   - `fps = frames / (elapsed/1000)`；无预热（warmup=0）；不等 GPU；测量期间零 DOM 写入；
     *   - 页面隐藏 / 上下文丢失 / 被取消 ⇒ 本轮作废（返回 abortedReason）。
     */
    runFluxCompatibleBenchmark(frames: number, warmup: number): Promise<FluxLoopResult> {
        return runFluxLoop(frames, warmup, {
            render: () => this.frameRender(),
            schedule: (cb) => {
                window.setTimeout(cb, 0);
            },
            now: () => performance.now(),
            shouldAbort: () => this.abortReason() || null,
        });
    }

    /**
     * 帧率测量的**调度器**（本方法不再自己实现计时口径）：
     *   - `driver === "timer"`（`proto=flux` 的默认值）⇒ 走 {@link runFluxCompatibleBenchmark}，
     *     与 Flux-GS `runFluxBenchmark()` 是**同一个协议**，结果可归类为 Flux-compatible FPS；
     *   - `driver === "raf"`（未传 proto 时的旧默认，或用户显式 `?driver=raf`）⇒ 保留旧 rAF 循环
     *     （先等 vsync 再 render），结果**永远不会**被标记为 Flux-compatible。
     */
    async runThroughputFrames(frames: number, warmup: number = fluxSpec().warmup): Promise<ThroughputStats> {
        const spec = fluxSpec();
        const resolution = this.lastResolution;
        if (spec.driver === "timer") {
            // 参考协议：完全走共享 harness（render → setTimeout(0)；计时从第 1 帧 render 结束起）
            const rendersBefore = this.renderCalls;
            const loop = await this.runFluxCompatibleBenchmark(frames, warmup);
            const renders = this.renderCalls - rendersBefore;
            return {
                driver: "timer",
                frames: loop.requested,
                rendered: loop.frames,
                renders,
                elapsedMs: loop.elapsedMs,
                fps: loop.fps,
                cpuMs: loop.frames > 0 ? loop.elapsedMs / loop.frames : 0,
                // 诊断口径统一：timer 路径的 gapMin/Med/Max 与 timer_gap_* 都填真实值（旧 rAF 路径同名同义）
                gapMinMs: loop.gapMinMs,
                gapMedMs: loop.gapMedMs,
                gapMaxMs: loop.gapMaxMs,
                warmupMs: 0,
                aborted: loop.abortedReason !== "",
                note: loop.abortedReason,
                protocolMatched: spec.protocolMatched,
                fluxCompatible: spec.protocolMatched,
                abortedReason: loop.abortedReason,
                timerGapMedMs: loop.gapMedMs,
                timerGapP95Ms: loop.gapP95Ms,
                timerClampObserved: loop.timerClampObserved,
                visibilityState: loop.visibilityState,
                resolution,
            };
        }
        // ---- 旧 rAF 口径（保留用于历史数据对照；**永远不会**被标记为 Flux-compatible）----
        const driver: ThroughputDriver = "raf";
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
            });

        const tWarmup0 = performance.now();
        for (let i = 0; i < warmup; i++) {
            const abort = this.abortReason();
            if (abort) return emptyThroughput(driver, abort);
            this.frameRender();
            await nextFrame();
        }
        const warmupMs = performance.now() - tWarmup0;

        const t0 = performance.now();
        const rendersBefore = this.renderCalls;
        const gaps: number[] = [];
        let last = t0;
        let rendered = 0;
        let abortedReason = "";
        while (rendered < frames) {
            abortedReason = this.abortReason();
            if (abortedReason) break;
            await nextFrame();
            const now = performance.now();
            gaps.push(now - last);
            last = now;
            this.frameRender(); // 每个 RAF **只**渲染并统计一帧
            rendered++;
        }
        const t1 = performance.now();
        const elapsedMs = t1 - t0;
        const sortedGaps = [...gaps].sort((a, b) => a - b);
        const medianGapMs = sortedGaps.length > 0 ? sortedGaps[Math.floor(sortedGaps.length / 2)] : 0;
        return {
            driver,
            frames,
            rendered,
            renders: this.renderCalls - rendersBefore,
            elapsedMs,
            fps: elapsedMs > 0 ? rendered / (elapsedMs / 1000) : 0,
            cpuMs: rendered > 0 ? elapsedMs / rendered : 0,
            gapMinMs: sortedGaps[0] ?? 0,
            gapMedMs: medianGapMs,
            gapMaxMs: sortedGaps[sortedGaps.length - 1] ?? 0,
            warmupMs,
            aborted: abortedReason !== "",
            note: abortedReason,
            protocolMatched: spec.protocolMatched,
            fluxCompatible: false, // rAF 驱动不是参考协议，任何情况下都不算 Flux-compatible
            abortedReason,
            timerGapMedMs: medianGapMs,
            timerGapP95Ms:
                sortedGaps.length > 0
                    ? sortedGaps[Math.min(sortedGaps.length - 1, Math.ceil(0.95 * sortedGaps.length) - 1)]
                    : 0,
            timerClampObserved: timerClampObservedFrom(gaps),
            visibilityState:
                typeof document !== "undefined" && document.visibilityState ? String(document.visibilityState) : "",
            resolution,
        };
    }

    /**
     * 首帧有效性验证（`?validateframe=1`，**默认开启**；`?validateframe=0` 关闭）：
     * 等 GPU 真正执行完（`gl.finish()`，等价于 fenceSync+clientWaitSync 的完成等待），
     * 再用稀疏采样 readPixels 确认画面**非空**。
     * 这段验证发生在测帧**之前**，不计入 FPS 区间。
     */
    validateFrame(): { ok: boolean; coveredPct: number; reason: string } {
        const renderer = this.renderer;
        if (!renderer) return { ok: false, coveredPct: 0, reason: "renderer 不存在" };
        const gl = renderer.gl as WebGL2RenderingContext;
        const w = renderer.canvas.width || 1;
        const h = renderer.canvas.height || 1;
        this.frameRender();
        try {
            gl.finish(); // 等 GPU 把这一帧执行完（不在计时区间内）
        } catch {
            /* ignore */
        }
        try {
            const buf = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            let covered = 0;
            let samples = 0;
            const stride = 16;
            for (let y = 0; y < h; y += stride) {
                for (let x = 0; x < w; x += stride) {
                    const idx = (y * w + x) * 4;
                    if (buf[idx + 3] > 0) covered++;
                    samples++;
                }
            }
            const coveredPct = samples > 0 ? (covered / samples) * 100 : 0;
            const cull = renderer.renderProgram?.cullStats;
            if (coveredPct <= 0) {
                return {
                    ok: false,
                    coveredPct,
                    reason: `首帧为空（readPixels 非空采样=0，cullTotal=${cull?.total ?? -1}，kept=${cull?.keptRatio ?? -1}）`,
                };
            }
            return { ok: true, coveredPct, reason: "" };
        } catch (err) {
            return {
                ok: false,
                coveredPct: 0,
                reason: `readPixels 失败：${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    /** 读一帧像素，统计画面中被高斯覆盖的像素比例；同时读取视锥剔除后的保留比例，用于诊断测帧画面是否"空转"。 */
    probeFrameCoverage(): { coveredPct: number; keptPct: number } {
        const renderer = this.renderer;
        if (!renderer) return { coveredPct: 0, keptPct: 0 };
        const gl = renderer.gl as WebGL2RenderingContext;
        const w = renderer.canvas.width || 1;
        const h = renderer.canvas.height || 1;
        this.frameRender();
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

    /**
     * 渲染器的深度排序在 Web Worker 中异步完成，首帧可能深度索引尚未回传（实际绘制 0 实例）。
     * 测帧前必须让出事件队列，等待 worker 至少完成一次排序并产生真实绘制。
     */
    async waitForSortedFrame(timeoutMs = 12000): Promise<boolean> {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
            this.frameRender();
            const cull = this.renderer?.renderProgram?.cullStats;
            if (cull && cull.total > 0 && cull.keptRatio > 0) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 120));
        }
        return false;
    }

    /** 把相机放到能完整框住场景包围盒的固定机位，避免"默认视角大半被剔除"导致测帧失真。 */
    frameScene(splat: SPLAT.Splat): void {
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
        this.camera.position = new SPLAT.Vector3(cx, cy, cz + dist);
        this.camera.update();
        const c = this.ensureControls();
        c.setCameraTarget(new SPLAT.Vector3(cx, cy, cz));
    }

    /** 焦距（像素）：默认 1132（gsplat.js 自带）。`?proto=flux` 时取 Flux-GS 的 COLMAP 焦距，
     *  从而两个渲染器在同一画布下得到完全相同的视场角；`?fx=N` 可显式覆盖。
     *  注意：`flux-native` 下最终焦距还要按 `bufferW / cssW` 缩放，见 applyResolutionProtocol()。 */
    applyFocalFromParam(): void {
        const spec = fluxSpec();
        const raw = param("fx", "");
        const parsed = raw === "" ? NaN : parseFloat(raw);
        const fx = Number.isFinite(parsed) && parsed > 0 ? parsed : spec.focalPx;
        if (Number.isFinite(fx) && fx > 0) {
            this.camera.data.fx = fx;
            this.camera.data.fy = fx;
        }
    }

    /**
     * `?cam=flux`：用 Flux-GS 原代码里的相机（`bench-flux-camera.json`）。
     * 它的 (position, quaternion) 与 gsplat.js 的 CameraData.update 同构，设进去即可复现同一视图矩阵，
     * 于是本方法 / reduced-3DGS 两臂与 Flux-GS 臂看到的是同一个角度、同一个视场。
     * 注：Flux 源码里的 defaultViewMatrix 只写了 2 位小数、并非严格正交，走"位置+四元数"路径与它原矩阵
     * 最多差 0.32°（1600px 画布下画面边缘约 4.4px）；对测帧结论无影响，肉眼看不出差别。
     */
    async loadFluxCamera(): Promise<void> {
        try {
            const res = await fetch("./bench-flux-camera.json");
            if (!res.ok) return;
            this._fluxCamera = (await res.json()) as FluxCameraAsset;
        } catch {
            /* 取不到就回退到包围盒自动取景 */
        }
    }

    /** 应用 Flux-GS 原相机（位置 + 姿态 + 焦距）。返回 false 表示资产缺失，调用方回退包围盒取景。 */
    applyFluxCamera(): boolean {
        const asset = this._fluxCamera;
        if (!asset || !asset.default_view) return false;
        const [px, py, pz] = asset.default_view.position;
        const [x, y, z, w] = asset.default_view.quaternion;
        this.camera.data.fx = asset.focal_px;
        this.camera.data.fy = asset.focal_px;
        this.camera.position = new SPLAT.Vector3(px, py, pz);
        this.camera.rotation = new SPLAT.Quaternion(x, y, z, w);
        this.camera.update();
        this.cameraLocked = true;
        return true;
    }

    glRendererName(): string {
        try {
            const gl = this.renderer?.gl as WebGL2RenderingContext | undefined;
            if (!gl) return "";
            const dbg = gl.getExtension("WEBGL_debug_renderer_info");
            const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
            return String(name || "");
        } catch {
            return "";
        }
    }

    /** 排序/剔除统计（诊断：total>0 说明排序 worker 已经回过消息，画面才有真实实例）。 */
    renderProgramCullTotal(): number {
        return this.renderer?.renderProgram?.cullStats?.total ?? -1;
    }

    // ------------------------------------------------------------------ 阶段 5：slave bridge（全部薄转发）
    /** slave：一次性的分辨率设置（复用既有 setBenchmarkResolution）。 */
    setResolutionOnceForSlave(w: number, h: number): void {
        this.setBenchmarkResolution(w, h);
    }

    /**
     * slave：把 view matrix 反解为 position + quaternion 后写入相机。
     * 复用 CameraData.update 的**正向**公式（`Quaternion.FromMatrix3` 与 `Matrix3.RotationFromQuaternion` 互逆），
     * **不引入第二套相机约定**；反解误差在 `recomposeErrorMax` 里如实返回（>1e-4 说明约定不匹配，必须排查）。
     */
    setCameraFromViewForSlave(viewMatrix: readonly number[], fx: number, fy: number): { recomposeErrorMax: number } {
        const v = Array.from(viewMatrix);
        const r0 = [v[0], v[1], v[2]];
        const r1 = [v[4], v[5], v[6]];
        const r2 = [v[8], v[9], v[10]];
        const q = SPLAT.Quaternion.FromMatrix3(
            new SPLAT.Matrix3(r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], r2[0], r2[1], r2[2]),
        );
        const t = [v[12], v[13], v[14]];
        // CameraData.update 里 t_view = -R·position ⇒ position = -Rᵀ·t_view
        const px = -(r0[0] * t[0] + r1[0] * t[1] + r2[0] * t[2]);
        const py = -(r0[1] * t[0] + r1[1] * t[1] + r2[1] * t[2]);
        const pz = -(r0[2] * t[0] + r1[2] * t[1] + r2[2] * t[2]);
        this.camera.data.fx = fx;
        this.camera.data.fy = fy;
        this.camera.position = new SPLAT.Vector3(px, py, pz);
        this.camera.rotation = q;
        this.camera.update();
        this.cameraLocked = true;
        const actual = this.camera.data.viewMatrix.buffer as unknown as ArrayLike<number>;
        let err = 0;
        for (let i = 0; i < 16 && i < v.length; i++) err = Math.max(err, Math.abs(actual[i] - v[i]));
        return { recomposeErrorMax: err };
    }

    /** slave：读相机 flat 矩阵 + 内参（矩阵按本仓库存储布局原样给出，供 CameraAudit 使用）。 */
    readCameraMatricesForSlave(): {
        viewMatrix: number[];
        viewProj: number[];
        fx: number;
        fy: number;
        near: number;
        far: number;
        width: number;
        height: number;
        positionX: number;
        positionY: number;
        positionZ: number;
    } {
        const d = this.camera.data;
        return {
            viewMatrix: Array.from(d.viewMatrix.buffer as unknown as ArrayLike<number>),
            viewProj: Array.from(d.viewProj.buffer as unknown as ArrayLike<number>),
            fx: d.fx,
            fy: d.fy,
            near: d.near,
            far: d.far,
            width: d.width,
            height: d.height,
            positionX: this.camera.position.x,
            positionY: this.camera.position.y,
            positionZ: this.camera.position.z,
        };
    }

    /** slave：唯一哈希实现（转发 `RenderProgram.sortCameraHash`；slave 不得自带第二套）。 */
    hashViewProjForSlave(values: ArrayLike<number>): string {
        return SPLAT.sortCameraHash(values);
    }

    /** slave：分辨率审计（四项 + CSS/DPR；与 bench-audit 的 ResolutionAudit 同构）。 */
    resolutionAuditForSlave(): SlaveResolutionAudit {
        const s = this.canvasStats();
        const gl = this.renderer?.gl as WebGL2RenderingContext | undefined;
        const vp = gl
            ? (Array.from(gl.getParameter(gl.VIEWPORT) as ArrayLike<number>) as number[])
            : [0, 0, s.bufW, s.bufH];
        return {
            requested: [s.bufW, s.bufH],
            canvas: [this.canvas.width, this.canvas.height],
            drawingBuffer: [s.glW, s.glH],
            viewport: [vp[0] ?? 0, vp[1] ?? 0, vp[2] ?? 0, vp[3] ?? 0],
            internalFramebuffer: [s.glW, s.glH],
            renderScale: 1,
            adaptiveResolution: false,
            cssWidth: s.cssW,
            cssHeight: s.cssH,
            devicePixelRatio: window.devicePixelRatio || 1,
        };
    }

    /** slave：context 状态（contextLost 由 onContextLost 置位，如实上报）。 */
    contextStateForSlave(): SlaveContextState {
        const s = this.canvasStats();
        return {
            contextLost: this.contextLost,
            rendererName: this.glRendererName(),
            canvasWidth: s.bufW,
            canvasHeight: s.bufH,
        };
    }

    /**
     * slave：工作量审计。
     * 阶段 5 只填**运行时**可测字段；模型来源字段（modelStorageBytes / networkTransferBytes /
     * decodedBodyBytes / modelHash / …）留 null，由阶段 8 的 adapter 按 §12.6 补齐
     * （禁止含糊的 `modelBytes`）。
     */
    workloadAuditForSlave(): SlaveWorkloadAudit {
        const cullTotal = this.renderProgramCullTotal();
        return {
            model: {
                modelStorageBytes: null,
                networkTransferBytes: null,
                decodedBodyBytes: null,
                modelHash: null,
                modelSourceUrl: null,
                modelSourceCommit: null,
                modelDownloadDate: null,
                rendererSourceCommit: null,
            },
            gaussianTotal: null,
            gaussianVisibleMean: null,
            gaussianSubmittedMean: null,
            shDegree: null,
            drawCallsMean: null,
            sortRequests: null,
            sortCompleted: cullTotal >= 0 ? cullTotal : null,
            sortWaited: null,
            lodEnabled: false,
            cullingEnabled: false,
            adaptiveQuality: false,
        };
    }

    /** slave：排序审计（**直接转发** `RenderProgram.getSortAudit()`，本层不实现任何计数器）。 */
    getSortAuditForSlave(): SlaveSortAudit {
        return (
            this.renderer?.renderProgram?.getSortAudit() ?? {
                requestSerial: 0,
                completedSerial: 0,
                uploadedSerial: 0,
                activeSerial: 0,
                pendingCount: 0,
                frozen: false,
                outOfOrderResults: 0,
                activeCameraHash: null,
                lastDrawSortSerial: 0,
                lastDrawCameraHash: null,
            }
        );
    }

    /** slave：只发一次排序请求（转发 `RenderProgram.requestSortOnce`）。 */
    requestSortOnceForSlave(force: boolean): number | null {
        return this.renderer?.renderProgram?.requestSortOnce(force) ?? null;
    }

    /** slave：冻结/解冻（转发 `RenderProgram.setBenchFreezeSortRequests`）。 */
    setBenchFreezeForSlave(frozen: boolean): void {
        this.renderer?.renderProgram?.setBenchFreezeSortRequests(frozen);
    }

    /** slave：当前相机哈希（转发 `RenderProgram.cameraHash()` ⇒ 内部即 `sortCameraHash(viewProj)`）。 */
    sortCameraHashForSlave(): string | null {
        return this.renderer?.renderProgram?.cameraHash() ?? null;
    }

    /** slave：排序 worker 实例（供探针按实例绑定）。 */
    getSortWorkerForSlave(): Worker | null {
        return this.renderer?.renderProgram?.worker ?? null;
    }

    /** slave：frame serial = 既有 `renderCalls` 计数（**不新增**计数器）。 */
    getFrameSerialForSlave(): number {
        return this.renderCalls;
    }

    /** slave：GPU 同步边界（复用同一个 renderer 上下文的 `gl.finish()`）。 */
    finishGpuForSlave(): void {
        const gl = this.renderer?.gl as WebGL2RenderingContext | undefined;
        gl?.finish();
    }

    /** slave：已有 WebGL2 上下文（供探针包装；**不创建**新上下文）。 */
    glContextForSlave(): WebGL2RenderingContext | null {
        return (this.renderer?.gl as WebGL2RenderingContext | undefined) ?? null;
    }

    /**
     * CPU 侧可见性探针（**与 GPU、时序、淡入无关**）：
     * 用渲染器正在用的 `viewProj` 对模型顶点做与顶点着色器**同一套**裁剪盒测试
     * （`|x| < 1.2w, |y| < 1.2w, -w < z < w`，w 为裁剪空间 w），统计落在盒内的采样点比例。
     *
     * 用途：把"首帧为空"的两种原因分开——
     *   insidePct ≈ 0  → 相机确实看不到这个模型（机位/坐标系问题）；
     *   insidePct 很高而画面仍空 → 不是机位问题，是"还没画完/管线异常"（应继续等帧）。
     */
    visibilityProbe(): { sampled: number; inside: number; insidePct: number } {
        const renderer = this.renderer;
        if (!renderer) return { sampled: 0, inside: 0, insidePct: 0 };
        const vp = this.camera.data.viewProj.buffer as unknown as ArrayLike<number>;
        let sampled = 0;
        let inside = 0;
        for (const object of this.scene.objects) {
            if (!(object instanceof SPLAT.Splat)) continue;
            const p = object.data.positions;
            const n = object.data.vertexCount;
            if (!p || n === 0) continue;
            const stride = Math.max(1, Math.floor(n / 2000)); // 最多采样 ~2000 点
            for (let i = 0; i < n; i += stride) {
                const x = p[3 * i];
                const y = p[3 * i + 1];
                const z = p[3 * i + 2];
                // 与 SortWorker.cullFrustum / 顶点着色器同构：clip = viewProj * (x,y,z,1)
                const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
                const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
                const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
                const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14];
                const clip = 1.2 * cw;
                sampled++;
                if (!(cz < -cw || cz > cw || cx < -clip || cx > clip || cy < -clip || cy > clip)) inside++;
            }
        }
        return { sampled, inside, insidePct: sampled > 0 ? (inside / sampled) * 100 : 0 };
    }

    /**
     * 首帧有效性验证（多帧版，`?validateframe=1` 默认开启）：
     * 单帧 readPixels 可能只是"还没画完"（排序回传后的第一帧仍可能用旧索引/淡入未完成），
     * 所以这里**最多连渲染 N 帧**（每帧之间等 120ms），任一次非空即通过。
     * 全程在测帧之前，不计入 FPS。
     */
    async validateFrameRobust(maxFrames = 10): Promise<{
        ok: boolean;
        coveredPct: number;
        framesUsed: number;
        insidePct: number;
        reason: string;
    }> {
        const vis = this.visibilityProbe();
        let last = { coveredPct: 0, reason: "未执行" };
        for (let i = 1; i <= maxFrames; i++) {
            const v = this.validateFrame();
            last = { coveredPct: v.coveredPct, reason: v.reason };
            if (v.ok) {
                return { ok: true, coveredPct: v.coveredPct, framesUsed: i, insidePct: vis.insidePct, reason: "" };
            }
            if (i < maxFrames) await new Promise((resolve) => setTimeout(resolve, 120));
        }
        const cameraSees = vis.insidePct > 0;
        return {
            ok: false,
            coveredPct: last.coveredPct,
            framesUsed: maxFrames,
            insidePct: vis.insidePct,
            reason:
                (cameraSees
                    ? `连渲染 ${maxFrames} 帧后仍未出现任何非空像素（CPU 投影采样 inside=${vis.insidePct.toFixed(1)}%，` +
                      `说明相机能看到模型，属"渲染没画出来"而非机位问题；注意 FadeInPass 每帧只 +1% 不透明度，` +
                      `正常轮次通常在第 1~5 帧就能看到微光）`
                    : `相机看不到模型（CPU 投影采样全部落在裁剪盒外 inside=0/${vis.sampled}，与 GPU/时序无关）`) +
                `：${last.reason}`,
        };
    }

    /** 从 scene 里移除所有对象（旧口径的 scene.reset()）。 */
    resetScene(): void {
        try {
            this.scene.reset();
        } catch {
            /* ignore */
        }
    }

    /**
     * 幂等释放：终止 Worker、删 GL 纹理/缓冲，清掉大对象引用，缩小 canvas，最后主动丢失上下文。
     *
     * 顺序很关键：
     *   1) `renderer.dispose()` —— 它要靠"仍然挂在 scene 上的 Splat"来解绑监听、删纹理；
     *   2) `loseContextOnce()` —— 让 GPU 进程立刻开始回收这一个上下文的全部显存，
     *      而不是等 iframe 文档被 GC 时才回收（后者在手机上是几轮之后才发生，正是第二轮/第三轮
     *      在 Adreno 上撞到 context lost 的直接来源）；
     *   3) `scene.reset()`、缩小 canvas、断开引用 —— 这些都不需要 GL，放在丢失之后更安全。
     * 本方法不依赖 GC，也不使用浏览器专有 GC API。
     */
    dispose(): number {
        const t0 = performance.now();
        this.stopped = true;
        try {
            this.controls?.dispose();
        } catch {
            /* ignore */
        }
        this.controls = null;
        try {
            this.renderer?.dispose();
        } catch {
            /* ignore */
        }
        if (this.renderer?.gl) {
            // 把删除命令推给驱动并等它执行完：dispose 发生在测量之后，这里的等待不影响任何指标，
            // 但能让 GPU 侧更早看到 free（而不是排在一个还没提交的队列里）。
            try {
                const gl = this.renderer.gl as WebGL2RenderingContext;
                gl.bindVertexArray?.(null);
                gl.flush();
                gl.finish(); // 只在这里（计时结束之后）用一次，代价是几十毫秒的同步等待
            } catch {
                /* ignore */
            }
        }
        if (param("losectx", "0") === "1") {
            this.loseContextOnce();
        }
        this.releaseSplatData(); // 先断开数据引用，再把它从 scene 上摘掉
        this.resetScene();
        // 缩小 canvas：让驱动尽早回收这块 framebuffer 对应的显存（本 iframe 随后整体销毁）
        try {
            this.canvas.width = 1;
            this.canvas.height = 1;
        } catch {
            /* ignore */
        }
        this._fluxCamera = null;
        this.renderer = null;
        return performance.now() - t0;
    }

    /**
     * 主动丢失 WebGL 上下文。**默认关闭**（`?losectx=1` 才启用），原因有两条实测依据：
     *   1) 仓库里 Flux-GS 臂的现场记录（bench-flux.ts）明确写过：手机端"强制丢弃 + 放弃恢复"会让
     *      上下文名额/显存**迟迟不归还**，连续冷启动到第 2~3 轮反而更容易建不出上下文；
     *   2) 本方法每轮结束都会把整个 iframe 卸载（`about:blank`）+ 摘除节点 + 断开全部引用，
     *      让浏览器走它自己的文档销毁路径回收上下文/显存/Worker —— 那条路径在手机上更可靠。
     * 打开它只用于 A/B 对照（例如怀疑"显存没及时归还"时）。
     * 一旦调用，这个 renderer/canvas/context 就绝不能再被使用（本页随后只做收尾与上报）。
     */
    loseContextOnce(): boolean {
        if (this.loseContextCalled) return false;
        this.loseContextCalled = true;
        try {
            const gl = this.renderer?.gl as WebGL2RenderingContext | undefined;
            const ext = gl?.getExtension("WEBGL_lose_context") as { loseContext: () => void } | null | undefined;
            if (!ext) return false;
            console.log(
                "[bench-measure] 主动调用 WEBGL_lose_context.loseContext()（这是清理动作，" +
                    "随后控制台出现的 CONTEXT_LOST_WEBGL 属预期，不代表崩溃）",
            );
            ext.loseContext();
            return true;
        } catch {
            return false;
        }
    }

    /** 断开 Splat/SplatData 持有的大数组引用（SplatData 是 TypedArray 的宿主，退出作用域前显式摘掉）。 */
    private releaseSplatData(): void {
        try {
            for (const object of this.scene.objects) {
                if (object instanceof SPLAT.Splat) {
                    object.data.detached = true; // 让渲染路径与此数据解耦，随后整轮数据由 GC 回收
                }
            }
        } catch {
            /* ignore */
        }
    }
}

/** 从 Resource Timing 里定位本轮模型下载条目（token 即模型 URL 上的 `ts=` 值）。 */
function findModelResourceEntry(token: string): PerformanceResourceTiming | undefined {
    const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (!token || e.name.includes(`ts=${token}`)) return e;
    }
    return undefined;
}

/**
 * 把分辨率审计块写进本轮结果，并判定"渲染分辨率是否符合协议"（不符 ⇒ 该轮无效，见 FLUX_FPS_PROTOCOL.md §C.3.3）。
 * CSS 尺寸只记录、绝不参与判定。
 */
function applyResolutionAuditToRound(base: RoundResult, audit: ResolutionAudit, reqW: number, reqH: number): void {
    const expectedW = audit.resolutionMode === "flux-fixed" ? Math.max(1, Math.round(reqW)) : audit.canvasWidth;
    const expectedH = audit.resolutionMode === "flux-fixed" ? Math.max(1, Math.round(reqH)) : audit.canvasHeight;
    const glOk = audit.drawingBufferWidth === audit.canvasWidth && audit.drawingBufferHeight === audit.canvasHeight;
    const sizeOk = audit.canvasWidth === expectedW && audit.canvasHeight === expectedH;
    base.resolutionMode = audit.resolutionMode;
    base.canvasW = audit.canvasWidth;
    base.canvasH = audit.canvasHeight;
    base.drawingBufferW = audit.drawingBufferWidth;
    base.drawingBufferH = audit.drawingBufferHeight;
    base.viewport = audit.viewport.join(",");
    base.cssW = audit.cssWidth;
    base.cssH = audit.cssHeight;
    base.dpr = audit.devicePixelRatio;
    base.internalScale = audit.internalRenderScale;
    base.adaptiveResolution = audit.adaptiveResolution;
    base.resMatch = glOk && sizeOk;
    base.resW = audit.canvasWidth;
    base.resH = audit.canvasHeight;
}

/**
 * 单轮测量（旧 bench.ts `measureRound` 的逐行等价实现，计时起点/终点与结果字段完全一致）。
 *
 * 计时锚点（不可改）：
 *   tStart          本轮开始（reset scene / 设分辨率之前）
 *   responseEnd     模型文件的下载结束时刻（Resource Timing，与 performance.now() 同一条时间轴）
 *   tLoaded         解码完成、Splat 已进 scene
 *   tFirstFrame     深度排序回传后的第一个"真实绘制帧"
 *   → fetch_ms = 下载段；parse_ms = responseEnd→tLoaded；first_frame_ms = responseEnd→tFirstFrame
 *   → fps = 在 tFirstFrame 之后、预热 warmup 帧之后，连续 frames 帧的墙钟均值
 */
export async function measureOneRound(
    ctx: BenchCase,
    meta: SceneMeta,
    roundNo: number,
    opts: MeasureOptions,
): Promise<RoundResult> {
    const base: RoundResult = { scene: meta.id, round: roundNo, ts: new Date().toISOString(), ok: false };
    base.dataset = meta.dataset;
    // 第 4 阶段：协议元信息（父子两页读同一份 spec；结果头据此标注 protocol_matched / flux_compatible）
    {
        const spec = fluxSpec();
        base.protocol = spec.label;
        base.protocolSource = spec.protocolSource;
        base.protocolMatched = spec.protocolMatched;
        base.fluxCompatible = spec.fluxCompatible;
        base.overrides = spec.overrides.join(" ");
        base.conflicts = spec.conflicts.join(" ");
        base.metric = spec.metric;
        base.gpuSynced = spec.gpuSynced;
        base.presentedFps = spec.presentedFps;
        base.paperProtocolVerified = spec.paperProtocolVerified;
        base.cameraMode = spec.cameraMode;
        base.algorithmModified = spec.modifications.algorithmModified;
        base.benchmarkLoopModified = spec.modifications.benchmarkLoopModified;
        base.resolutionModified = spec.modifications.resolutionModified;
        base.cameraModified = spec.modifications.cameraModified;
        base.modificationNotes = spec.modifications.notes.join("; ");
    }
    /** 时间线：每个 mark 记相对本轮开始的毫秒数（诊断用，不参与任何指标） */
    const timeline: Array<[string, number]> = [];
    const tRound0 = performance.now();
    const mark = (name: string, detail?: string): void => {
        const ms = performance.now() - tRound0;
        timeline.push([name, ms]);
        opts.onMark?.(name, detail);
        console.log(
            `[case-timeline][job=${opts.token}][${meta.id} r${roundNo}] ${name} +${ms.toFixed(0)}ms${detail ? " " + detail : ""}`,
        );
    };

    const tStart = performance.now();
    ctx.resetScene();
    // 第 6/7 阶段：分辨率先按协议预置（flux-native 的真实值要等模型字节数确定后再复核一次）
    ctx.applyResolutionProtocol(0);
    mark(
        "scale-set",
        `${formatResolutionAudit(ctx.lastResolution ?? ctx.resolutionAudit())}（请求 ${opts.resW}x${opts.resH}）`,
    );
    opts.onPhase?.("loading");
    try {
        const splat = await ctx.loadSplat(opts.modelUrl, opts.signal);
        // 竞态保护：本轮已被取消/已释放时，把刚落地的数据丢掉，绝不写进 scene 参与后续渲染
        if (ctx.stopped || opts.signal?.aborted) {
            ctx.resetScene();
            base.err = "已取消（dispose 早于加载完成）";
            return base;
        }
        const tLoaded = performance.now();
        mark("decode-done", `splats=${splat.data?.vertexCount ?? "?"}`);
        // ---- 第 6/7 阶段：模型字节数确定后复核分辨率（flux-native 与官方同一条分支判断）----
        const rtEntry = findModelResourceEntry(opts.token);
        const modelBytes = rtEntry ? rtEntry.decodedBodySize || rtEntry.transferSize || 0 : 0;
        const audit = ctx.applyResolutionProtocol(modelBytes);
        applyResolutionAuditToRound(base, audit, opts.resW, opts.resH);
        mark("scale-set-final", `${formatResolutionAudit(audit)} bytes=${modelBytes}`);
        if (!base.resMatch) {
            base.err = `渲染分辨率与协议不一致（该轮无效）：${formatResolutionAudit(audit)}`;
            mark("FAIL-resolution");
            base.timeline = formatTimeline(timeline);
            return base;
        }
        // cam=flux：用 Flux-GS 原相机（位置 + 姿态 + 焦距）复现同一视角；资产缺失时才退回包围盒取景
        if (!(CAM_FLUX && ctx.applyFluxCamera())) {
            ctx.frameScene(splat);
        }
        ctx.camera.update();
        // ---- 第 8 阶段：完整 view matrix + 哈希（与 Flux 臂 `view` 用同一哈希函数）----
        {
            const cam = ctx.cameraAudit();
            base.viewMatrix = cam.view16.map((v) => Math.round(v * 1000) / 1000).join(",");
            base.viewHash = cam.hash;
            base.focalPx = cam.focalPx;
            // 投影：整矩阵两边不可比（near/far 不同），只比 FOV 项 2fx/w、2fy/h
            base.projectionFovKey = projectionFovKey(cam.focalPx, cam.focalPx, base.canvasW ?? 0, base.canvasH ?? 0);
            base.projectionFovHash = projectionFovHash(cam.focalPx, cam.focalPx, base.canvasW ?? 0, base.canvasH ?? 0);
            mark(
                "camera-audit",
                `viewHash=${cam.hash} focal=${cam.focalPx} fov=${base.projectionFovKey} camLocked=${ctx.cameraLocked}`,
            );
        }
        mark("camera-ready", `camLocked=${ctx.cameraLocked}`);
        opts.onPhase?.("sorting");
        // 让出事件循环等待深度排序回传——此时才产生真实的首帧绘制
        const sorted = await ctx.waitForSortedFrame();
        const tFirstFrame = performance.now();
        mark("sort-frames-done", `sorted=${sorted} cullStats.total=${ctx.renderProgramCullTotal()}`);
        if (ctx.stopped) {
            ctx.resetScene();
            base.err = "已取消（dispose 早于首帧）";
            return base;
        }

        const foundEntry = rtEntry;
        const fetchMs = foundEntry ? foundEntry.duration : undefined;
        const bytes = foundEntry && foundEntry.transferSize > 0 ? foundEntry.transferSize : undefined;
        // 论文口径：首帧时间从"文件获取完成"之后算起
        // responseEnd 与 performance.now() 同时间轴，不能再加 performance.timeOrigin
        const fetchEndWall = foundEntry ? foundEntry.responseEnd : tStart;
        mark("fetch-timing", `fetch_ms=${(fetchMs ?? tLoaded - tStart).toFixed(0)} bytes=${bytes ?? "-"}`);
        base.fetchMs = fetchMs ?? tLoaded - tStart;
        base.parseMs = tLoaded - fetchEndWall;
        base.firstFrameMs = tFirstFrame - fetchEndWall;
        base.drawOk = sorted;
        base.points = splat.data ? splat.data.vertexCount : undefined;
        base.bytes = bytes;
        base.fx = ctx.camera.data.fx;
        base.gl = ctx.glRendererName();

        // ---- 门禁 1：深度排序必须回过消息，否则"首帧"其实是空帧 → 本轮判失败，不进入测帧 ----
        if (!sorted) {
            base.err = `首帧未验证成功：深度排序未回传（cullStats.total=${ctx.renderProgramCullTotal()}）`;
            mark("FAIL-no-sort");
            base.timeline = formatTimeline(timeline);
            return base;
        }

        // ---- 门禁 2：**渲染存活探针**（`?validateframe=1` 默认开启；**不是质量门槛**）----
        // 关键事实：渲染器默认带 FadeInPass（`depthFade` 每帧 +1%，需要 ~100 帧才完全不透明），
        // 因此"前几帧几乎看不到像素"是**设计行为**，绝不能据此判定失败或机位错误。
        // 这里只回答一个问题：管线到底有没有画出过东西（连续 N 帧像素全空 = 没画）。
        // 画面覆盖率以测帧之后的 probeFrameCoverage 为准（与原协议一致）。
        const doValidate = param("validateframe", "1") !== "0";
        let firstFrameCovered = -1;
        if (doValidate) {
            const v = await ctx.validateFrameRobust(20);
            mark(
                "validate-frame",
                `alive=${v.ok ? 1 : 0} firstCovered=${v.coveredPct.toFixed(1)}% afterFrames=${v.framesUsed} ` +
                    `inside=${v.insidePct.toFixed(1)}% ${v.reason}`,
            );
            base.visibilityInsidePct = v.insidePct;
            base.validateFramesUsed = v.framesUsed;
            if (!v.ok) {
                base.err = `渲染存活探针失败：${v.reason}`;
                base.timeline = formatTimeline(timeline);
                return base;
            }
            firstFrameCovered = v.coveredPct;
        }
        // 没有开启像素验证时也记录"相机是否看得到模型"，供后续核对
        if (base.visibilityInsidePct === undefined) {
            base.visibilityInsidePct = ctx.visibilityProbe().insidePct;
        }

        opts.onPhase?.("measuring");
        mark("throughput-start", `frames=${opts.frames} warmup=${opts.warmup} driver=${param("driver", "raf")}`);
        const perf = await ctx.runThroughputFrames(opts.frames, opts.warmup);
        // ---- 门禁 3：测帧必须是完整跑完的，且每帧都真的 render 过 ----
        // 作废原因（hidden / context-lost / stopped）优先写入，便于把"页面被切走"与"渲染坏了"分开
        if (perf.aborted || perf.rendered < opts.frames) {
            base.abortedReason = perf.abortedReason;
            base.err = `测帧未完成（rendered=${perf.rendered}/${opts.frames}${perf.abortedReason ? ` reason=${perf.abortedReason}` : ""} ${perf.note}）`;
            mark("FAIL-throughput-aborted", perf.abortedReason);
            base.timeline = formatTimeline(timeline);
            return base;
        }
        mark(
            "throughput-end",
            `rendered=${perf.rendered} renders=${perf.renders} elapsed=${perf.elapsedMs.toFixed(0)}ms fps=${perf.fps.toFixed(1)} gap(med/min/max)=${perf.gapMedMs.toFixed(2)}/${perf.gapMinMs.toFixed(2)}/${perf.gapMaxMs.toFixed(2)}ms`,
        );

        const probe = ctx.probeFrameCoverage();
        base.coveredPct = probe.coveredPct;
        base.keptPct = probe.keptPct;
        base.fps = perf.fps;
        base.cpuMs = perf.cpuMs;
        base.driver = perf.driver;
        base.frames = perf.rendered;
        base.elapsedMs = perf.elapsedMs;
        base.renders = perf.renders;
        base.gapMedMs = perf.gapMedMs;
        base.gapMinMs = perf.gapMinMs;
        base.gapMaxMs = perf.gapMaxMs;
        base.warmupMs = perf.warmupMs;
        base.firstFrameCoveredPct = firstFrameCovered >= 0 ? firstFrameCovered : undefined;
        base.fluxCompatible = base.fluxCompatible === true && perf.fluxCompatible;
        base.protocolMatched = perf.protocolMatched;
        base.timerGapMedMs = perf.timerGapMedMs;
        base.timerGapP95Ms = perf.timerGapP95Ms;
        base.timerClampObserved = perf.timerClampObserved;
        base.visibilityState = perf.visibilityState;
        base.timeline = formatTimeline(timeline);

        // ---- 第 8 阶段：测量期间相机必须保持冻结（哈希漂移 ⇒ 该轮无效）----
        {
            const camEnd = ctx.cameraAudit();
            base.viewHashEnd = camEnd.hash;
            base.camFrozen = camEnd.hash === base.viewHash;
            if (!base.camFrozen) {
                base.ok = false;
                base.err = `测量期间相机发生了漂移（viewHash ${base.viewHash} → ${camEnd.hash}），该轮无效`;
                mark("FAIL-camera-drift");
                base.timeline = formatTimeline(timeline);
                return base;
            }
        }
        // ---- 第 8 阶段：高斯负载（提交实例数 / 可见估计），用于判断"矩阵相同但负载是否不同"----
        {
            const load = ctx.gaussianLoad(splat.data.vertexCount);
            base.submittedGaussianCount = load.submitted;
            base.visibleGaussianCount = load.visible;
            base.gaussianLoadNote = load.note;
            mark("gaussian-load", `submitted=${load.submitted} visible=${load.visible} note=${load.note}`);
        }

        // ---- 人工确认用：测完之后先保持画面 holdms 毫秒再上报（默认 0，不进任何指标）----
        const holdMs = Math.max(0, parseInt(param("holdms", "0"), 10) || 0);
        if (holdMs > 0) {
            mark("hold-start", `holdms=${holdMs}（仅用于人工确认，不进指标）`);
            ctx.frameRender();
            await new Promise((resolve) => setTimeout(resolve, holdMs));
            mark("hold-end");
        }

        base.ok = true;
        mark("result-ready");
        base.timeline = formatTimeline(timeline);
        return base;
    } catch (err) {
        base.err = err instanceof Error ? err.message : String(err);
        base.timeline = formatTimeline(timeline);
        return base;
    }
}

/** 时间线 → 一行诊断字符串（空格换下划线，便于 key=value 解析）。 */
function formatTimeline(timeline: Array<[string, number]>): string {
    return timeline
        .map(([k, ms]) => `${k}:${Math.round(ms)}`)
        .join("/")
        .replace(/\s+/g, "_");
}
