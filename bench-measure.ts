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
import { CAM_FLUX, PROTO_FLUX, param } from "./bench-shared";
import type { RoundResult, SceneMeta } from "./bench-shared";

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

/** 测帧驱动方式：raf = 每个 requestAnimationFrame 渲染一帧（默认）；timer = 旧的 setTimeout(0) 链 */
export type ThroughputDriver = "raf" | "timer";

/** 测帧统计（诊断字段；FPS 公式未变：frames / 整段墙钟秒数）。 */
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
}

function emptyThroughput(driver: ThroughputDriver, note: string): ThroughputStats {
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

    /**
     * 帧率测量。**默认由 requestAnimationFrame 驱动，每个 RAF 恰好 render 一帧**：
     * 这样每一帧都是"被合成器调度、真正提交"的帧，不可能测成 CPU 提交循环。
     * `?driver=timer` 可切回旧的 `setTimeout(0)` 链（仅用于与历史数据对照；会被 rAF 的 vsync 影响，
     * 因此默认口径是 rAF，并在结果头写明 `driver=`）。
     *
     * 计时口径不变：FPS = frames / (整段墙钟秒数)，整段墙钟 = 从第一个测帧前的时刻到最后一帧之后的时刻。
     */
    async runThroughputFrames(frames: number, warmup = 10): Promise<ThroughputStats> {
        const driver: ThroughputDriver = param("driver", "raf") === "timer" ? "timer" : "raf";
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                if (driver === "raf") {
                    requestAnimationFrame(() => resolve());
                } else {
                    setTimeout(resolve, 0);
                }
            });

        const tWarmup0 = performance.now();
        for (let i = 0; i < warmup; i++) {
            if (this.stopped) return emptyThroughput(driver, "warmup 期间被取消");
            this.frameRender();
            await nextFrame();
        }
        const warmupMs = performance.now() - tWarmup0;

        const t0 = performance.now();
        const rendersBefore = this.renderCalls;
        const gaps: number[] = [];
        let last = t0;
        let rendered = 0;
        let aborted = false;
        while (rendered < frames) {
            if (this.stopped) {
                aborted = true;
                break;
            }
            await nextFrame();
            const now = performance.now();
            gaps.push(now - last);
            last = now;
            this.frameRender(); // 每个 RAF（或每个 timer tick）**只**渲染并统计一帧
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
            fps: elapsedMs > 0 ? frames / (elapsedMs / 1000) : 0,
            cpuMs: rendered > 0 ? elapsedMs / rendered : 0,
            gapMinMs: sortedGaps[0] ?? 0,
            gapMedMs: medianGapMs,
            gapMaxMs: sortedGaps[sortedGaps.length - 1] ?? 0,
            warmupMs,
            aborted,
            note: aborted ? "测帧过程中被取消（stopped）" : "",
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
     *  从而两个渲染器在同一画布下得到完全相同的视场角；`?fx=N` 可显式覆盖。 */
    applyFocalFromParam(): void {
        const fx = parseFloat(param("fx", PROTO_FLUX ? "1159.588" : "0"));
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
    ctx.setBenchmarkResolution(opts.resW, opts.resH);
    {
        // item 6：确认测的确实是 res 尺寸（canvas 后备缓冲 + gl.drawingBuffer）
        const cs = ctx.canvasStats();
        const sizeOk = cs.bufW === opts.resW && cs.bufH === opts.resH && cs.glW === opts.resW && cs.glH === opts.resH;
        mark("scale-set", `${ctx.canvasStatsLine()}${sizeOk ? "" : " ⚠ 后备缓冲与 res 不一致！"}`);
    }
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
        // cam=flux：用 Flux-GS 原相机（位置 + 姿态 + 焦距）复现同一视角；资产缺失时才退回包围盒取景
        if (!(CAM_FLUX && ctx.applyFluxCamera())) {
            ctx.frameScene(splat);
        }
        ctx.camera.update();
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

        const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        let fetchMs: number | undefined;
        let bytes: number | undefined;
        let foundEntry: PerformanceResourceTiming | undefined;
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (opts.token && e.name.includes(`ts=${opts.token}`)) {
                foundEntry = e;
                fetchMs = e.duration;
                bytes = e.transferSize > 0 ? e.transferSize : undefined;
                break;
            }
        }
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
        base.resW = opts.resW;
        base.resH = opts.resH;
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
        if (perf.aborted || perf.rendered < opts.frames) {
            base.err = `测帧未完成（rendered=${perf.rendered}/${opts.frames} ${perf.note}）`;
            mark("FAIL-throughput-aborted");
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
        base.timeline = formatTimeline(timeline);

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
