/**
 * bench-flux-adapter.ts — 阶段 8B：`FluxGsAdapter`。
 *
 * 把 vendor 侧 H6–H12 bridge（iframe 内 `window.__FLUXGS_BENCH_SORT__` 薄原语 + 事实流）
 * 翻译成 controller 的 `ThreeWayBenchmarkAdapter` 契约。
 *
 * 设计约束：
 *   1. 状态机唯一权威 = 父侧 `FluxBenchBridge`（+ `flux-bench-state.ts`）；本文件**不**做状态迁移判定；
 *   2. adapter **不得**：计算 FPS、自己调度 rAF/timer、生成第二套相机哈希（由页面注入 renderer 侧实现）、
 *      提前伪造 `usedByDraw`（由 controller 在 warmup draw 之后派生）；
 *   3. `staticFrameRenderOnly` 只有在 iframe 真的暴露 `frameStatic`（H13 真 render-only 路径）时才为 true；
 *      否则按 §12.1 回落到 `static-full-frame-function-synchronized-throughput` 并如实报告排序活动。
 */
import { FluxBenchBridge } from "./bench-flux-bridge";
import type { FluxBridgeTransport, FluxFactMessage, FluxStaticDrawResult } from "./bench-flux-bridge";
import { EMPTY_WINDOW_COUNTERS } from "./bench-controller";
import type {
    AdapterCapabilities,
    AdapterMeasureWindowAudit,
    BenchProbe,
    BenchmarkConfig,
    CameraFrameInput,
    ContextState,
    SortAppliedProof,
    SortAudit,
    SortToken,
    ThreeWayBenchmarkAdapter,
    WindowCounters,
} from "./bench-controller";
import { buildCameraAudit } from "./bench-audit";
import type { AnchorSet, CameraAudit, ResolutionAudit, WorkloadAudit } from "./bench-audit";
import type { ProbeBinder } from "./bench-adapters";

/** iframe 内 vendor 薄原语（H9；`frameStatic`/`stats` 为 H13 之后可选增强）。 */
export interface FluxBenchPrimitives {
    session: string;
    /** 登记一次父侧发起的排序请求（vendor 只做 token 关联，不复制状态机） */
    sortRequested(sortSerial: number, viewProj: number[]): boolean;
    /** 复用唯一 frame 主体，单次显式驱动（父侧驱动，不自驱） */
    frameOnce(view16: number[]): boolean;
    /** H13：真正的 render-only 帧（不发排序请求、不写 DOM、不挂自驱调度） */
    frameStatic?: (view16?: number[]) => FluxStaticDrawResult | boolean;
    /**
     * [H22-B] **同步** GPU 排空（`gl.finish()`）：只能由父侧跨 realm **同步调用**（厂商侧 `gl` 只在本 realm 内可用）。
     * 缺失 ⇒ `finishGpu()` fail-closed 抛错（禁止在无 GPU 同步的情况下报 synchronized throughput）。
     */
    finishGpu?: () => boolean;
    contextLost(): boolean;
    dispose(): boolean;
    /** H13：负载元数据（`loaded` = 模型字节已读到；`vertexCount` 由首次上传设定）。 */
    stats?: () => { vertexCount: number; loaded?: boolean };
    /** H17：vendor 当前 view 矩阵（统一相机基线；未就绪返回 null） */
    getViewMatrix?: () => number[] | null;
}

/** Flux iframe 句柄（页面提供创建与移除；adapter 不碰 DOM 细节） */
export interface FluxIframeHandle {
    readonly contentWindow: {
        __FLUXGS_BENCH_SORT__?: FluxBenchPrimitives;
        __FLUXGS_SET_CAM__?: (view16: number[]) => boolean;
        postMessage(message: unknown, targetOrigin: string): void;
    } | null;
    /** 页面负责移除 iframe（adapter 只调用它） */
    remove(): void;
}

export interface FluxGsAdapterDeps {
    sessionId: string;
    scene: { id: string; dataset: string; modelUrl: string; iframeUrl: string };
    modelSource: WorkloadAudit["model"];
    /** 页面侧创建 iframe；**必须**注入 `bridge=1` 与 `benchres=WxH` */
    createIframe(url: string): FluxIframeHandle;
    /** 等待 iframe 暴露 `__FLUXGS_BENCH_SORT__` */
    waitForPrimitives(handle: FluxIframeHandle, timeoutMs: number): Promise<FluxBenchPrimitives>;
    /** 渲染器侧唯一相机哈希（禁止第二套实现；由页面注入） */
    hashView(view16: readonly number[]): string;
    /** 统一投影参数（主表冻结值；由页面从 bench-constants 注入，禁止各臂各写一套） */
    projectionMatrix: readonly number[];
    focalPx: number;
    near: number;
    far: number;
    anchorSet: AnchorSet;
    probe: ProbeBinder;
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
    readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** 构建标记：出现在页面状态行与所有适配器错误里，用于确认运行的是哪一版代码。 */
export const FLUX_ADAPTER_BUILD = "8B-8";

/** 只转发、不改写计数的探针代理（vendor 侧由 GlProbe 绑定 worker）。 */
/** 只转发、不改写计数的探针代理（vendor 侧由 GlProbe 绑定 worker）。 */
class BridgeProbeProxy implements BenchProbe {
    constructor(private readonly binder: ProbeBinder) {}
    openWindow(): void {
        void this.binder.getAuthority();
    }
    closeWindow(): void {}
    pendingSorts(): number {
        return 0;
    }
    beginControlledFrame(): void {}
    endControlledFrame(): void {}
    snapshotWindow(): WindowCounters {
        return { ...EMPTY_WINDOW_COUNTERS, drawCallsPerFrame: [] };
    }
}

export class FluxGsAdapter implements ThreeWayBenchmarkAdapter {
    readonly name = "flux-gs" as const;
    readonly probe: BenchProbe;

    private readonly deps: FluxGsAdapterDeps;
    private bridge: FluxBenchBridge;
    private handle: FluxIframeHandle | null = null;
    private prims: FluxBenchPrimitives | null = null;
    private view16: number[] = [];
    private frozen = false;
    private frameSerial = 0;
    private lastRequestedSerial = 0;
    private contextLost = false;
    private windowStartSerial = -1;
    private windowStartLastDraw = -1;
    /** [H22-A] 冻结后的第一次 static draw（warmup draw）是否已**同步**归因成功 */
    private windowStartDrawSynced = false;
    /** [H22-A] 冻结后 warmup draw 尚未发生（`renderStaticFrame()` 里消费） */
    private warmupDrawPending = false;
    private resolutionAtWindowStart: [number, number] = [0, 0];
    private detachMessage: (() => void) | null = null;

    constructor(deps: FluxGsAdapterDeps) {
        this.deps = deps;
        this.probe = new BridgeProbeProxy(deps.probe);
        this.bridge = new FluxBenchBridge({
            transport: this.buildTransport(),
            sessionId: deps.sessionId,
            width: 1600,
            height: 1063,
        });
    }

    /** iframe → 父 事实流（postMessage）+ 上传前同步授权门（`window.__fxbenchAuthorize`）。 */
    private buildTransport(): FluxBridgeTransport {
        return {
            post: (msg: Record<string, unknown>): void => {
                const w = this.handle?.contentWindow;
                if (!w) return;
                try {
                    w.postMessage(msg, "*");
                } catch (err) {
                    this.deps.log?.(`flux-adapter: post 失败 ${String(err)}`);
                }
            },
            subscribe: (handler: (m: FluxFactMessage) => void): (() => void) => {
                const onMessage = (ev: MessageEvent): void => {
                    const d = ev.data as FluxFactMessage | undefined;
                    if (!d || d.__fxbench !== true) return;
                    if (d.fact === "context-lost") this.contextLost = true;
                    handler(d);
                };
                window.addEventListener("message", onMessage);
                // 同步上传门：vendor 在 gl.bufferData 之前同栈调用
                const authWin = window as unknown as {
                    __fxbenchAuthorize?: (input: {
                        session: string;
                        sortSerial: number;
                        viewProj: readonly number[];
                    }) => boolean;
                };
                authWin.__fxbenchAuthorize = (input) => this.bridge.authorizeUpload(input);
                this.detachMessage = (): void => {
                    window.removeEventListener("message", onMessage);
                    delete authWin.__fxbenchAuthorize;
                };
                return (): void => {
                    this.detachMessage?.();
                    this.detachMessage = null;
                };
            },
        };
    }

    get capabilities(): AdapterCapabilities {
        const staticOnly = typeof this.prims?.frameStatic === "function";
        return {
            staticFrameRenderOnly: staticOnly,
            sortFreezeSupported: true,
            movingSortMode: "pipelined",
        };
    }

    async init(config: BenchmarkConfig): Promise<void> {
        const url = injectBridgeParams(this.deps.scene.iframeUrl, config.width, config.height, this.bridge.session);
        this.handle = this.deps.createIframe(url);
        this.prims = await this.deps.waitForPrimitives(
            this.handle,
            this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        );
        if (this.prims.session !== this.bridge.session) {
            // session 必须一致，否则授权门与事实流会整体失效
            throw new Error("flux-adapter: 父/子 session 不一致（bridge init 未生效）");
        }
        this.deps.log?.(`flux-adapter: ready session=${this.bridge.session} url=${url}`);
        // H17：采用 vendor 默认机位作为统一相机基线（controller 会先读 getCameraAudit() 再 setCamera()）
        const defaultView = this.prims.getViewMatrix?.();
        if (Array.isArray(defaultView) && defaultView.length === 16) this.view16 = [...defaultView];
        else this.deps.log?.("flux-adapter: vendor 未提供默认 view 矩阵（getViewMatrix 缺失或未就绪）");
    }

    async loadScene(): Promise<void> {
        // 场景由 iframeUrl（含 render_<scene>/index.html）决定，无需额外动作
        if (!this.prims) throw new Error("flux-adapter: loadScene before init");
    }

    async setResolution(width: number, height: number): Promise<void> {
        // 分辨率在 iframe URL 的 benchres=WxH 上生效（vendor 读取后再创建上下文）
        const actual = this.readCanvasSize();
        if (actual[0] !== width || actual[1] !== height) {
            this.deps.log?.(`flux-adapter: 分辨率不符 requested=${width}x${height} actual=${actual[0]}x${actual[1]}`);
        }
        this.resolutionAtWindowStart = actual;
    }

    async setCamera(camera: CameraFrameInput): Promise<void> {
        // 仅接受合法 16 元 view（controller 首轮可能传入空矩阵——此时保留 vendor 默认基线）
        if (!Array.isArray(camera.viewMatrix) || camera.viewMatrix.length !== 16) {
            this.deps.log?.("flux-adapter: setCamera 收到非法 view（长度≠16），保留现有基线");
            return;
        }
        this.view16 = [...camera.viewMatrix];
        const w = this.handle?.contentWindow;
        if (w && typeof w.__FLUXGS_SET_CAM__ === "function") w.__FLUXGS_SET_CAM__(this.view16);
    }

    async waitUntilReady(): Promise<void> {
        if (!this.prims) throw new Error("flux-adapter: waitUntilReady before init");
        // ① 模型字节读到
        await this.pollUntil(() => {
            const st = this.prims?.stats?.();
            return st?.loaded === true;
        }, "等待模型字节（vendor loaded）");
        // ② bridge 模式 vendor 不自驱 ⇒ 必须由父侧驱动首帧，worker 才会产出首次排序/上传
        this.prims.frameOnce(this.view16.length === 16 ? this.view16 : []);
        this.frameSerial++;
        // ③ 等首次上传完成（此后 getWorkloadAudit() 才能取得有效 vertexCount）
        await this.pollUntil(() => {
            const st = this.prims?.stats?.();
            return !!st && st.vertexCount > 0;
        }, "等待首次排序上传（vertexCount>0）");
    }

    /** 轮询直到条件成立；超时抛错（fail-closed）。 */
    private async pollUntil(test: () => boolean, what: string): Promise<void> {
        const timeoutMs = this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (test()) return;
            if (Date.now() > deadline) throw new Error(`flux-adapter[${FLUX_ADAPTER_BUILD}]: ${what} 超时`);
            if (this.deps.sleep) await this.deps.sleep(100);
            else await new Promise<void>((r) => setTimeout(r, 100));
        }
    }

    async requestSortOnce(camera: CameraFrameInput, opts?: { force?: boolean }): Promise<SortToken> {
        if (this.frozen) throw new Error("flux-adapter: 排序已冻结，禁止新请求");
        if (!this.prims) throw new Error("flux-adapter: requestSortOnce before init");
        this.view16 = [...camera.viewMatrix];
        const serial = this.bridge.requestSortOnce(this.view16, { force: opts?.force !== false });
        this.lastRequestedSerial = serial;
        const ok = this.prims.sortRequested(serial, this.view16);
        if (!ok) throw new Error("flux-adapter: vendor 拒绝登记排序 token");
        // bridge 模式 vendor 不自驱 ⇒ 必须由父侧驱动一次完整帧，worker 才会真正收到排序请求
        this.prims.frameOnce(this.view16);
        this.frameSerial++;
        return {
            serial,
            sortViewProjHash: this.deps.hashView(this.view16),
            forced: true,
            source: "flux-bench-bridge",
        };
    }

    async waitForSortApplied(token: SortToken): Promise<SortAppliedProof> {
        await this.bridge.waitForSortQuiescence(token.serial, this.view16);
        return this.proofFor(token);
    }

    async freezeSortRequests(): Promise<void> {
        this.frozen = true;
        // [H22-A] 测量窗口基线**不能**在这里取：此刻冻结后的 warmup draw 还没发生，
        // 读到的 lastDraw 属于上一轮/上一代 ⇒ 旧实现（`windowStartLastDraw <= 0` 判 missing）
        // 在第 1 轮必然为真，把合法轮判成 `warmup-draw-not-verified`。基线改在
        // `renderStaticFrame()`（warmup draw 返回后）取，先置 fail-closed 初值。
        this.warmupDrawPending = true;
        this.windowStartDrawSynced = false;
        this.windowStartSerial = -1;
        this.windowStartLastDraw = -1;
        this.resolutionAtWindowStart = this.readCanvasSize();
    }

    async unfreezeSortRequests(): Promise<void> {
        this.frozen = false;
    }

    /** 排序审计（vendor 事实 + 父侧状态机；**不用** vendor 的 dot 启发式）。 */
    getSortAudit(): SortAudit {
        const snap = this.bridge.sortAudit;
        const outOfOrder = this.bridge.getEventLog().filter((e) => e.verdict === "ignored-stale").length;
        return {
            requestSerial: this.lastRequestedSerial,
            completedSerial: snap.resultReceivedSerial,
            uploadedSerial: snap.uploadedSerial,
            activeSerial: snap.activeSerial,
            pendingCount: this.bridge.pendingSorts,
            frozen: this.frozen,
            outOfOrderResults: outOfOrder,
            activeCameraHash: snap.activeViewProj ? this.deps.hashView(snap.activeViewProj) : null,
            lastDrawSortSerial: snap.lastDrawSerial,
            lastDrawCameraHash:
                snap.lastDrawSerial > 0 && snap.activeViewProj ? this.deps.hashView(snap.activeViewProj) : null,
        };
    }

    /** 诊断：bridge 事实日志（紧凑文本；供页面在无效轮打印，便于一步定位）。 */
    getBridgeEventLog(): string[] {
        return this.bridge
            .getEventLog()
            .map(
                (e) =>
                    `#${e.seq} ${e.fact} serial=${e.serial ?? "-"} ${e.verdict}${e.reason ? ` reason=${e.reason}` : ""}`,
            );
    }

    getMeasureWindowAudit(): AdapterMeasureWindowAudit | null {
        const now = this.readCanvasSize();
        const snap = this.bridge.sortAudit;
        const resolutionChanged =
            now[0] !== this.resolutionAtWindowStart[0] || now[1] !== this.resolutionAtWindowStart[1];
        return {
            resolutionChanged,
            invalidReason: resolutionChanged ? "resolution-changed-during-measure" : "",
            activeSortSerialChanged: snap.activeSerial !== this.windowStartSerial,
            lastDrawSortSerialChanged: snap.lastDrawSerial !== this.windowStartLastDraw,
            // [H22-A] 与共享 slave 同语义（`activeSerial > 0 && lastDraw !== active` ⇒ 漏了冻结后的 warmup draw）：
            // 基线取在 warmup draw **之后**，因此这里能真正证明"冻结后确实画过、且画的是那一代 active"。
            warmupDrawMissingAtWindowStart:
                !this.windowStartDrawSynced || this.windowStartLastDraw !== this.windowStartSerial,
        };
    }

    async waitForWorkerQuiescence(): Promise<void> {
        await this.bridge.waitForSortQuiescence(this.lastRequestedSerial, this.view16);
    }

    /**
     * 只绘制：不更新相机、不发排序请求、不写 DOM、不挂 rAF（要求 vendor 暴露 `frameStatic`）。
     *
     * [H22-A] `frameStatic()` 的**返回值**是"这一帧真实画了什么"的**唯一同步可观测量**（跨 realm 同栈调用）：
     *   - controller 在 warmup draw 之后**同步**读 `getSortAudit().lastDrawSortSerial` 做归因校验，
     *     而 `draw-completed` 事实走 postMessage（至少晚一个任务）⇒ 只靠事实时该值恒为 0；
     *   - 测量窗口基线（`windowStartSerial/windowStartLastDraw`）也必须取在 warmup draw **之后**，
     *     否则读到的 lastDraw 属于冻结前的上一代（实测第 1 轮必然误判）。
     */
    renderStaticFrame(): void {
        const fn = this.prims?.frameStatic;
        if (typeof fn !== "function") {
            throw new Error("flux-adapter: 该 vendor 构建不支持 render-only 静态帧（frameStatic 缺失）");
        }
        this.frameSerial++;
        const res = fn.call(this.prims);
        // 同步归属：不等待 `draw-completed` 事实（跨任务），否则 warmup 校验必读到 0
        this.bridge.noteStaticDrawSync(res);
        if (this.warmupDrawPending) {
            this.warmupDrawPending = false;
            const snap = this.bridge.sortAudit; // 已被上面的同步归属推进（同任务可见）
            this.windowStartDrawSynced = typeof res === "object" && res !== null && res.drawn === true;
            this.windowStartSerial = snap.activeSerial;
            this.windowStartLastDraw = snap.lastDrawSerial;
        }
    }

    /** 动态相机：保留原始异步排序语义，但不得自挂 rAF。 */
    renderPipelinedFrame(): void {
        if (!this.prims) throw new Error("flux-adapter: renderPipelinedFrame before init");
        this.frameSerial++;
        this.prims.frameOnce(this.view16);
    }

    /**
     * [H22-B] `gl.finish()` 的**同步**落点 —— `synchronized throughput` 的有效性前提（t1 必须含真实 GPU 排空）。
     *
     * 为什么不能再用 `bridge.finishGpu()`：它 post 的 `prim:"finish-gpu"` 在本 vendor 中**没有监听者**
     * ⇒ finish 变成空操作，`fps` 退化为 CPU 提交吞吐（实测 build 8B-7：30 帧「1829 fps」≈ 16ms 纯提交时间）。
     * `gl` 只存在于 iframe 的 realm ⇒ 只能跨 realm **同步**调用；缺失/失败一律 fail-closed 抛错，
     * 让 round 以 `exception:` 失效，而不是给论文留下一个不可比的数字。
     */
    finishGpu(): void {
        const fn = this.prims?.finishGpu;
        if (typeof fn !== "function") {
            throw new Error(
                `flux-adapter[${FLUX_ADAPTER_BUILD}]: vendor 未暴露同步 GPU 排空原语（finishGpu 缺失）⇒ 不得声称 synchronized throughput`,
            );
        }
        if (fn.call(this.prims) === false) {
            throw new Error(`flux-adapter[${FLUX_ADAPTER_BUILD}]: vendor finishGpu 返回失败`);
        }
    }

    getResolutionAudit(): ResolutionAudit {
        const [w, h] = this.readCanvasSize();
        return {
            requested: [1600, 1063],
            canvas: [w, h],
            drawingBuffer: [w, h],
            viewport: [0, 0, w, h],
            internalFramebuffer: [w, h],
            renderScale: h > 0 ? w / 1600 : 0,
            adaptiveResolution: false,
            cssWidth: w,
            cssHeight: h,
            devicePixelRatio: typeof window === "undefined" ? 0 : window.devicePixelRatio,
        };
    }

    getCameraAudit(): CameraAudit {
        return buildCameraAudit({
            viewMatrix: [...this.view16],
            projectionMatrix: [...this.deps.projectionMatrix],
            fx: this.deps.focalPx,
            fy: this.deps.focalPx,
            near: this.deps.near,
            far: this.deps.far,
            width: 1600,
            height: 1063,
            anchorSet: this.deps.anchorSet,
        });
    }

    getWorkloadAudit(): WorkloadAudit {
        const st = this.prims?.stats?.() ?? null;
        if (!st || !(st.vertexCount > 0)) {
            // §12.6：无法取得有效 workload 时必须**显式失败**，禁止用 0/null 冒充有效值
            throw new Error(`flux-adapter[${FLUX_ADAPTER_BUILD}]: workload 不可用（vendor 未提供有效 vertexCount）`);
        }
        const snap = this.bridge.sortAudit;
        return {
            model: this.deps.modelSource,
            gaussianTotal: st.vertexCount,
            gaussianVisibleMean: null,
            gaussianSubmittedMean: null,
            shDegree: null,
            drawCallsMean: null,
            sortRequests: snap.resultReceivedSerial,
            sortCompleted: snap.resultReceivedSerial,
            sortWaited: true,
            lodEnabled: null,
            cullingEnabled: null,
            adaptiveQuality: null,
        };
    }

    getContextState(): ContextState {
        const [w, h] = this.readCanvasSize();
        const st = this.readStats();
        return {
            contextLost: this.contextLost || this.bridge.sortAudit.disposed,
            rendererName: String(st.glRenderer ?? ""),
            canvasWidth: w,
            canvasHeight: h,
        };
    }

    getFrameSerial(): number {
        return this.frameSerial;
    }

    async dispose(): Promise<void> {
        try {
            this.frozen = false;
            this.deps.probe.detach();
            this.prims?.dispose();
            this.bridge.dispose("disposed");
        } finally {
            this.detachMessage?.();
            this.detachMessage = null;
            this.handle?.remove();
            this.handle = null;
            this.prims = null;
        }
    }

    private proofFor(token: SortToken): SortAppliedProof {
        const snap = this.bridge.sortAudit;
        const completed = snap.resultReceivedSerial === token.serial;
        const uploaded = snap.uploadedSerial === token.serial;
        const activated = snap.activeSerial === token.serial;
        return {
            proven: completed && uploaded && activated,
            serial: token.serial,
            sortViewProjHash: token.sortViewProjHash,
            completed,
            uploaded,
            activated,
            usedByDraw: false, // 由 controller 在 warmup draw 之后派生
            evidence: "renderer-bridge",
            reason: completed && uploaded && activated ? "" : "sort-not-applied",
        };
    }

    private readCanvasSize(): [number, number] {
        const doc = this.handle?.contentWindow ? (this.handle.contentWindow as unknown as Window).document : null;
        const canvas = doc ? (doc.querySelector("canvas") as HTMLCanvasElement | null) : null;
        if (!canvas) return [0, 0];
        return [canvas.width, canvas.height];
    }

    private readStats(): Record<string, unknown> {
        const w = this.handle?.contentWindow as unknown as { __FLUXGS_STATS__?: Record<string, unknown> } | null;
        return w && w.__FLUXGS_STATS__ ? w.__FLUXGS_STATS__ : {};
    }
}

/** 给 iframe URL 注入 `bridge=1`、`benchres=WxH` 与父侧下发的 `fxsession`（幂等）。 */
export function injectBridgeParams(url: string, width: number, height: number, sessionId: string): string {
    const [base, hash] = url.split("#");
    const sep = base.includes("?") ? "&" : "?";
    const add = base.includes("bridge=1") ? "" : `${sep}bridge=1`;
    let out = base + add;
    if (!/(?:^|[?&])benchres=/.test(out)) out += `${add ? "&" : sep}benchres=${width}x${height}`;
    if (sessionId && !/(?:^|[?&])fxsession=/.test(out)) out += `&fxsession=${encodeURIComponent(sessionId)}`;
    return `${out}${hash ? `#${hash}` : ""}`;
}
