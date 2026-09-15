/**
 * bench-controller.ts — 三方法 benchmark 的**唯一状态机**（纯逻辑：无 DOM、无 GL、不 import `./src`）。
 *
 * 依据 THREE_WAY_BENCH_DESIGN.md 与 2026-09-15 强制验收条件：
 *   主协议：preFinish 返回 → t0 → N 次 render → postFinish 返回 → t1（结束排水计入 elapsed）
 *   条件 1  静态吞吐必须处理 Worker 排序队列（request one sort → 等该次 → 禁止后续排序 →
 *           warmup → 等 worker 静止 → preFinish → t0 → N 次静态 render → postFinish → t1）
 *   条件 4  draw 归因用**作用域**（begin/endControlledFrame），不用简单相减
 *   条件 5  正式主表 rounds=12（6 种排列各两次）+ 热漂移判定
 */
import { computeThermalDrift, iqr, mean, median, percentile, resolutionIsRequested, stddev } from "./bench-audit";
import type { CameraAudit, ResolutionAudit, ThermalDrift, WorkloadAudit } from "./bench-audit";

// ------------------------------------------------------------------ 协议名（禁止混称）
export const METRIC_SYNCED_FPS = "gpu-drain-synchronized-throughput-fps";
export const PROTOCOL_SYNCED = "gpu-drain-synchronized-throughput-v1";
export const PROTOCOL_STATIC_RENDER_ONLY = "static-render-only-synchronized-throughput-v1";
export const PROTOCOL_STATIC_FULL_FRAME = "static-full-frame-function-synchronized-throughput";
export const PROTOCOL_MOVING_PIPELINED = "moving-camera-pipelined-throughput";
export const PROTOCOL_MOVING_BLOCKING = "moving-camera-blocking-throughput";
export const PROTOCOL_RAF = "presentation-raf-v1";
export const METRIC_RAF = "presentation-raf-fps";
export const PROTOCOL_LEGACY_SUBMIT = "local-flux-hook-unsynchronized-submit-v1";

export type BenchMethod = "ours" | "flux-gs" | "reduced-3dgs";
export type YieldMode = "none" | "messagechannel";
export type VisibilityState = "visible" | "hidden" | "prerender" | "unloaded" | "unknown";

// ------------------------------------------------------------------ 环境依赖（全部可注入 ⇒ 可单测）
export interface ControllerDeps {
    now(): number;
    /** 让出主线程（`none` 模式不调用；`messagechannel` 每批一次） */
    yieldToMainThread(): Promise<void>;
    logEvent(name: string, payload?: Record<string, unknown>): void;
    getVisibilityState(): VisibilityState;
}

// ------------------------------------------------------------------ adapter（三个实现同一接口）
export interface AdapterCapabilities {
    /** 能否"只绘制、不发新排序请求"（false ⇒ 只能用 full-frame 协议并如实报告排序活动） */
    staticFrameRenderOnly: boolean;
    /** 能否冻结后续排序请求 */
    sortFreezeSupported: boolean;
    /** 动态相机时该实现的排序语义（决定协议名，不得混称） */
    movingSortMode: "pipelined" | "blocking";
}

export interface CameraFrameInput {
    viewMatrix: number[];
    projectionMatrix?: number[];
    fx: number;
    fy: number;
}

// ------------------------------------------------------------------ 排序归因（阶段 7A 结论）
/**
 * 一次排序请求的令牌。
 * `sortViewProjHash` = **实际传给排序 worker 的那个 viewProj 数组**的哈希
 * （实现必须复用 renderer 侧的 `sortCameraHash()`，禁止第二套实现）。
 * 注意与 `CameraAudit` 里独立的 `viewMatrixSha256 / projectionMatrixSha256 /
 * viewProjectionMatrixSha256`（SHA-256，追溯用）不是同一个东西。
 */
export interface SortToken {
    serial: number;
    sortViewProjHash: string;
    /** 主表静态协议**必须**为 true（force 请求不得被 dirty 启发式吞掉） */
    forced: boolean;
    /** 生成该 token 的实现（诊断） */
    source: string;
}

/**
 * 排序"已应用"的证明。
 *
 * `waitForSortApplied()` 在**冻结后的 warmup draw 之前**只能证明
 * `completed / uploaded / activated`；`usedByDraw` 必须保持 false，
 * 由 controller 在 warmup draw 之后依据
 * `lastDrawSortSerial === token.serial ∧ lastDrawCameraHash === token.sortViewProjHash` 派生。
 *
 * `vendor-equivalence-heuristic`（Flux 的 dot 跳过启发式）**不得**用于主表。
 */
export interface SortAppliedProof {
    proven: boolean;
    serial: number;
    sortViewProjHash: string;
    completed: boolean;
    uploaded: boolean;
    activated: boolean;
    usedByDraw: boolean;
    evidence: "renderer-bridge" | "probe-cross-check" | "vendor-equivalence-heuristic" | "none";
    reason: string;
}

/** 权威排序审计（来自 renderer bridge 的 `getSortAudit()`）。 */
export interface SortAudit {
    requestSerial: number;
    completedSerial: number;
    uploadedSerial: number;
    activeSerial: number;
    pendingCount: number;
    frozen: boolean;
    outOfOrderResults: number;
    activeCameraHash: string | null;
    lastDrawSortSerial: number;
    lastDrawCameraHash: string | null;
}

/** 主表静态协议的排序等待上限。 */
export const SORT_APPLY_TIMEOUT_MS = 8000;

/** 适配器汇报的测量窗口审计（slave 侧 `endMeasureWindow()` 的结果子集）。 */
export interface AdapterMeasureWindowAudit {
    resolutionChanged: boolean;
    invalidReason: string;
    activeSortSerialChanged: boolean;
    lastDrawSortSerialChanged: boolean;
    warmupDrawMissingAtWindowStart: boolean;
}

export interface ContextState {
    contextLost: boolean;
    rendererName: string;
    canvasWidth: number;
    canvasHeight: number;
}

export interface ThreeWayBenchmarkAdapter {
    readonly name: BenchMethod;
    readonly capabilities: AdapterCapabilities;
    /**
     * 该臂尚未实现时给出原因（例如 Flux bridge 未落地）。
     * controller 见到非空值会**直接**判 `invalidReason = "adapter-not-implemented"`，
     * 不做任何降级运行（禁止拿旧的自挂 rAF / 自动排序页面冒充 full-frame slave）。
     */
    readonly unimplementedReason?: string;
    /**
     * slave 侧测量窗口审计（分辨率四项 / 序号不变 / warmup draw 守卫）。
     * 存在时 controller **必须**消费（阶段 5/8A 强制）。
     */
    getMeasureWindowAudit?(): AdapterMeasureWindowAudit | null;
    init(config: BenchmarkConfig): Promise<void>;
    loadScene(scene: SceneConfig): Promise<void>;
    /** 每轮只允许调用一次（D5②） */
    setResolution(width: number, height: number): Promise<void>;
    setCamera(camera: CameraFrameInput): Promise<void>;
    waitUntilReady(): Promise<void>;
    /**
     * **只发一次**排序请求（强制 force=true），返回令牌。调用前 `getSortAudit().pendingCount` 必须为 0。
     * 不得被实现的 dirty/等价相机启发式吞掉；worker 必须回传同一 `serial`。
     */
    requestSortOnce(camera: CameraFrameInput, opts?: { force?: boolean }): Promise<SortToken>;
    /** 等到该 token 的排序已完成/上传/激活（不要求已被 draw 使用——那由 warmup draw 之后验证）。 */
    waitForSortApplied(token: SortToken, timeoutMs?: number): Promise<SortAppliedProof>;
    /** 冻结后续排序请求（不支持时必须是 no-op，并把 capabilities.sortFreezeSupported 置 false） */
    freezeSortRequests(): Promise<void>;
    /** 解冻（每轮结束必须调用；冻结开关不得跨轮残留） */
    unfreezeSortRequests(): Promise<void>;
    /** 权威排序审计（renderer bridge；外部 wrap 只能作交叉验证） */
    getSortAudit(): SortAudit;
    /** 等到 worker 静止：无在飞排序、无排队任务 */
    waitForWorkerQuiescence(): Promise<void>;
    /** 只绘制：不更新相机、不发排序请求、不写 DOM、不挂 rAF */
    renderStaticFrame(): void;
    /** 动态相机：保留原始异步排序语义，但不得自挂 rAF */
    renderPipelinedFrame(): void;
    finishGpu(): void;
    getResolutionAudit(): ResolutionAudit;
    getCameraAudit(): CameraAudit;
    getWorkloadAudit(): WorkloadAudit;
    getContextState(): ContextState;
    /** adapter 内部帧序号（有效性要求：结束值 − 开始值 === N） */
    getFrameSerial(): number;
    /** 外部观察者（wrap 计数）由 bench-gl-probe 提供 */
    readonly probe: BenchProbe;
    dispose(): Promise<void>;
}

// ------------------------------------------------------------------ probe（条件 4：作用域归因）
export interface WindowCounters {
    sortRequests: number;
    sortCompleted: number;
    indexBufferUploads: number;
    drawCalls: number;
    drawInstances: number;
    drawCallsPerFrame: number[];
    /** 不属于任何 controlled frame 的 draw 次数 */
    unexpectedDrawCalls: number;
    unexpectedFrameCallbacks: number;
    rafCalls: number;
    timerSchedules: number;
}

export const EMPTY_WINDOW_COUNTERS: WindowCounters = {
    sortRequests: 0,
    sortCompleted: 0,
    indexBufferUploads: 0,
    drawCalls: 0,
    drawInstances: 0,
    drawCallsPerFrame: [],
    unexpectedDrawCalls: 0,
    unexpectedFrameCallbacks: 0,
    rafCalls: 0,
    timerSchedules: 0,
};

export interface BenchProbe {
    /** 打开/关闭测量窗口；窗口外的计数不计入本轮 */
    openWindow(): void;
    closeWindow(): void;
    /** 当前在飞的排序请求数（窗口开始/结束时读） */
    pendingSorts(): number;
    beginControlledFrame(frameSerial: number): void;
    endControlledFrame(frameSerial: number): void;
    snapshotWindow(): WindowCounters;
}

export interface BenchmarkConfig {
    warmupFrames: number;
    measureFrames: number;
    yieldMode: YieldMode;
    batchSize: number;
    width: number;
    height: number;
    cameraStatic: boolean;
}

export interface SceneConfig {
    id: string;
    file: string;
    dataset: string;
    anchorSetFile: string;
}

export interface SyncedRoundResult {
    method: BenchMethod;
    protocol: string;
    metric: string;
    valid: boolean;
    invalidReason: string | null;

    warmupFrames: number;
    requestedFrames: number;
    completedFrames: number;
    renderCalls: number;
    controllerRenderCalls: number;
    adapterFrameSerialStart: number;
    adapterFrameSerialEnd: number;
    adapterFrameDelta: number;

    submitStartMs: number;
    lastSubmitMs: number;
    gpuCompleteMs: number;
    submitPhaseMs: number;
    drainPhaseMs: number;
    totalSyncedMs: number;
    fps: number;

    /** 条件 1：窗口内的排序/索引活动 + 边界在飞排序数 */
    sortRequestsDuringMeasure: number;
    sortCompletedDuringMeasure: number;
    indexBufferUploadsDuringMeasure: number;
    pendingSortsAtStart: number;
    pendingSortsAtEnd: number;

    drawCallsDuringMeasure: number;
    drawInstancesDuringMeasure: number;
    drawCallsPerFrame: number[];
    unexpectedDrawCalls: number;
    unexpectedFrameCallbacks: number;
    rafCallsDuringMeasure: number;
    timerSchedulesDuringMeasure: number;

    yieldMode: YieldMode;
    batchSize: number;
    yieldCount: number;
    sortFrozenBeforeWarmup: boolean;

    resolution: ResolutionAudit;
    camera: CameraAudit;
    workload: WorkloadAudit;
    visibilityState: VisibilityState;
    contextLost: boolean;
    eventLog: string[];

    /** 排序归因（阶段 7A：主表静态协议必须四项齐全，且不得用 vendor 启发式） */
    sortToken: SortToken | null;
    sortAppliedProof: SortAppliedProof | null;
    sortAuditAtStart: SortAudit | null;
    sortAuditAtEnd: SortAudit | null;
    /** 冻结后至少一次 static warmup draw 是否已证明 `lastDrawSortSerial === token.serial` */
    sortWarmupDrawVerified: boolean;
    /** slave 侧测量窗口审计（分辨率四项 / 序号不变 / warmup draw 守卫） */
    measureWindowAudit: AdapterMeasureWindowAudit | null;
}

// ------------------------------------------------------------------ 主协议实现（静态/动态共用一份状态机）
export interface SyncedRunOptions {
    config: BenchmarkConfig;
    /** 动态相机 trace（给出 ⇒ 走 moving 协议；否则静态协议） */
    cameraTrace?: CameraFrameInput[];
}

function emptyResolutionAudit(requested: [number, number]): ResolutionAudit {
    return {
        requested,
        canvas: [0, 0],
        drawingBuffer: [0, 0],
        viewport: [0, 0, 0, 0],
        internalFramebuffer: [0, 0],
        renderScale: 0,
        adaptiveResolution: true,
        cssWidth: 0,
        cssHeight: 0,
        devicePixelRatio: 0,
    };
}

/**
 * 执行一轮同步吞吐（静态或动态）。
 *
 * 静态路径（条件 1 的强制顺序）：
 *   setResolution（仅一次）→ setCamera → requestSortAndWait → freezeSortRequests
 *   → warmup → waitForWorkerQuiescence → preFinish → t0 → N 次 renderStaticFrame
 *   → postFinish → t1
 */
export async function runSyncedThroughput(
    adapter: ThreeWayBenchmarkAdapter,
    deps: ControllerDeps,
    opts: SyncedRunOptions,
): Promise<SyncedRoundResult> {
    // 未实现的臂：**不做任何降级运行**，直接给出可读的无效原因
    if (adapter.unimplementedReason) {
        return unimplementedRoundResult(adapter, opts, adapter.unimplementedReason, deps);
    }
    return runSyncedThroughputImpl(adapter, deps, opts);
}

/** 未实现臂的结果骨架（字段齐全但全部标注无效，便于上层统一渲染/汇总）。 */
function unimplementedRoundResult(
    adapter: ThreeWayBenchmarkAdapter,
    opts: SyncedRunOptions,
    reason: string,
    deps: ControllerDeps,
): SyncedRoundResult {
    const cfg = opts.config;
    return {
        method: adapter.name,
        protocol: PROTOCOL_SYNCED,
        metric: METRIC_SYNCED_FPS,
        valid: false,
        invalidReason: "adapter-not-implemented",
        warmupFrames: cfg.warmupFrames,
        requestedFrames: cfg.measureFrames,
        completedFrames: 0,
        renderCalls: 0,
        controllerRenderCalls: 0,
        adapterFrameSerialStart: 0,
        adapterFrameSerialEnd: 0,
        adapterFrameDelta: 0,
        submitStartMs: 0,
        lastSubmitMs: 0,
        gpuCompleteMs: 0,
        submitPhaseMs: 0,
        drainPhaseMs: 0,
        totalSyncedMs: 0,
        fps: 0,
        sortRequestsDuringMeasure: 0,
        sortCompletedDuringMeasure: 0,
        indexBufferUploadsDuringMeasure: 0,
        pendingSortsAtStart: 0,
        pendingSortsAtEnd: 0,
        drawCallsDuringMeasure: 0,
        drawInstancesDuringMeasure: 0,
        drawCallsPerFrame: [],
        unexpectedDrawCalls: 0,
        unexpectedFrameCallbacks: 0,
        rafCallsDuringMeasure: 0,
        timerSchedulesDuringMeasure: 0,
        yieldMode: cfg.yieldMode,
        batchSize: cfg.batchSize,
        yieldCount: 0,
        sortFrozenBeforeWarmup: false,
        resolution: emptyResolutionAudit([cfg.width, cfg.height]),
        camera: adapter.getCameraAudit(),
        workload: adapter.getWorkloadAudit(),
        visibilityState: deps.getVisibilityState(),
        contextLost: false,
        eventLog: [`adapter-not-implemented:${reason}`],
        sortToken: null,
        sortAppliedProof: null,
        sortAuditAtStart: null,
        sortAuditAtEnd: null,
        sortWarmupDrawVerified: false,
        measureWindowAudit: null,
    };
}

async function runSyncedThroughputImpl(
    adapter: ThreeWayBenchmarkAdapter,
    deps: ControllerDeps,
    opts: SyncedRunOptions,
): Promise<SyncedRoundResult> {
    const cfg = opts.config;
    const N = Math.max(1, Math.floor(cfg.measureFrames));
    const warmupFrames = Math.max(0, Math.floor(cfg.warmupFrames));
    const moving = Array.isArray(opts.cameraTrace) && opts.cameraTrace.length > 0;
    const renderOnly =
        !moving && adapter.capabilities.staticFrameRenderOnly && adapter.capabilities.sortFreezeSupported;
    const protocol = moving
        ? adapter.capabilities.movingSortMode === "blocking"
            ? PROTOCOL_MOVING_BLOCKING
            : PROTOCOL_MOVING_PIPELINED
        : renderOnly
          ? PROTOCOL_STATIC_RENDER_ONLY
          : PROTOCOL_STATIC_FULL_FRAME;

    const eventLog: string[] = [];
    const mark = (name: string, payload?: Record<string, unknown>): void => {
        eventLog.push(`${name}@${deps.now().toFixed(2)}`);
        deps.logEvent(name, payload);
    };

    let resolution = emptyResolutionAudit([cfg.width, cfg.height]);
    let controllerRenderCalls = 0;
    let yieldCount = 0;
    let sortFrozen = false;
    let sortToken: SortToken | null = null;
    let sortProof: SortAppliedProof | null = null;
    let sortAuditAtStart: SortAudit | null = null;
    let sortAuditAtEnd: SortAudit | null = null;
    let warmupDrawVerified = false;
    let measureWindowAudit: AdapterMeasureWindowAudit | null = null;
    let pendingAtStart = -1;
    let pendingAtEnd = -1;
    let counters = { ...EMPTY_WINDOW_COUNTERS };
    let submitStartMs = 0;
    let lastSubmitMs = 0;
    let gpuCompleteMs = 0;
    let invalidReason: string | null = null;
    let frameSerialStart = 0;

    try {
        // ① 分辨率：每轮只设置一次（D5②），随后立即审计
        await adapter.setResolution(cfg.width, cfg.height);
        resolution = adapter.getResolutionAudit();
        mark("set-resolution");
        const resCheck = resolutionIsRequested(resolution);
        if (!resCheck.ok) invalidReason = resCheck.reason;

        // ② 相机 + **强制**一次性排序（force=true 不得被 dirty 启发式吞掉）→ 再冻结后续请求
        const cameraForRound: CameraFrameInput = {
            viewMatrix: adapter.getCameraAudit().viewMatrix,
            fx: adapter.getCameraAudit().fx,
            fy: adapter.getCameraAudit().fy,
        };
        await adapter.setCamera(cameraForRound);
        mark("set-camera");
        if (!moving) {
            if (renderOnly && warmupFrames < 1) {
                // 主表静态协议要求"冻结后至少一次 static warmup draw"来证明 lastDraw 归因
                invalidReason = "warmup-frames-too-few-for-sort-proof";
            }
            const pendingBefore = adapter.getSortAudit().pendingCount;
            sortToken = await adapter.requestSortOnce(cameraForRound, { force: true });
            mark("sort-requested", { serial: sortToken.serial, forced: sortToken.forced, pendingBefore });
            sortProof = await adapter.waitForSortApplied(sortToken, SORT_APPLY_TIMEOUT_MS);
            mark("sort-applied", {
                proven: sortProof.proven,
                evidence: sortProof.evidence,
                completed: sortProof.completed,
                uploaded: sortProof.uploaded,
                activated: sortProof.activated,
            });
            await adapter.freezeSortRequests();
            sortFrozen = adapter.capabilities.sortFreezeSupported;
            mark("sort-frozen", { sortFrozen });
        }

        // ③ warmup → 等 worker 静止 → preFinish
        for (let i = 0; i < warmupFrames; i++) {
            if (moving) adapter.renderPipelinedFrame();
            else adapter.renderStaticFrame();
        }
        mark("warmup-done", { warmupFrames });
        // 冻结后至少一次 static warmup draw 必须证明"当前被 draw 使用的就是目标 serial"
        if (!moving && sortToken) {
            const auditAfterWarmup = adapter.getSortAudit();
            warmupDrawVerified =
                auditAfterWarmup.lastDrawSortSerial === sortToken.serial &&
                auditAfterWarmup.lastDrawCameraHash === sortToken.sortViewProjHash;
            mark("warmup-draw-verified", {
                verified: warmupDrawVerified,
                lastDrawSortSerial: auditAfterWarmup.lastDrawSortSerial,
                lastDrawCameraHash: auditAfterWarmup.lastDrawCameraHash,
                expectedSerial: sortToken.serial,
                expectedSortViewProjHash: sortToken.sortViewProjHash,
            });
        }
        await adapter.waitForWorkerQuiescence();
        mark("worker-quiescent");
        adapter.finishGpu();
        mark("finish-start");

        // ④ frameSerial 基线：必须取在 warmup 之后、t0 之前，
        //    否则 adapterFrameDelta 会把 warmup 帧也算进来（有效性要求 delta === N）
        frameSerialStart = adapter.getFrameSerial();

        // ⑤ t0（必须在 preFinish 返回之后）
        submitStartMs = deps.now();
        mark("t0");
        sortAuditAtStart = adapter.getSortAudit();
        adapter.probe.openWindow();
        pendingAtStart = adapter.probe.pendingSorts();

        // ⑤ 提交 N 帧（yieldMode=none ⇒ 连续；messagechannel ⇒ 每批让出一次）
        for (let i = 1; i <= N; i++) {
            adapter.probe.beginControlledFrame(i);
            if (moving) {
                const cam = opts.cameraTrace![(i - 1) % opts.cameraTrace!.length];
                await adapter.setCamera(cam);
                adapter.renderPipelinedFrame();
            } else {
                adapter.renderStaticFrame();
            }
            adapter.probe.endControlledFrame(i);
            controllerRenderCalls++;
            if (cfg.yieldMode === "messagechannel" && i % Math.max(1, cfg.batchSize) === 0 && i < N) {
                await deps.yieldToMainThread();
                yieldCount++;
            }
        }
        lastSubmitMs = deps.now();
        mark("last-submit", { controllerRenderCalls });

        // ⑥ postFinish → t1（必须在 finish 返回之后）
        adapter.finishGpu();
        gpuCompleteMs = deps.now();
        mark("finish-end-return");
        mark("t1");

        pendingAtEnd = adapter.probe.pendingSorts();
        counters = adapter.probe.snapshotWindow();
        sortAuditAtEnd = adapter.getSortAudit();
        measureWindowAudit = adapter.getMeasureWindowAudit?.() ?? null;
        adapter.probe.closeWindow();
    } catch (err) {
        invalidReason = invalidReason ?? `exception:${err instanceof Error ? err.message : String(err)}`;
        try {
            adapter.probe.closeWindow();
        } catch {
            /* ignore */
        }
    }
    // 冻结开关不得跨轮残留（即使上面抛异常也要解冻）
    try {
        await adapter.unfreezeSortRequests();
    } catch {
        /* ignore */
    }

    const ctx = adapter.getContextState();
    const visibilityState = deps.getVisibilityState();
    const adapterFrameSerialEnd = adapter.getFrameSerial();
    const adapterFrameDelta = adapterFrameSerialEnd - frameSerialStart;
    const submitPhaseMs = Math.max(0, lastSubmitMs - submitStartMs);
    const drainPhaseMs = Math.max(0, gpuCompleteMs - lastSubmitMs);
    const totalSyncedMs = Math.max(0, gpuCompleteMs - submitStartMs);
    const fps = totalSyncedMs > 0 ? (controllerRenderCalls * 1000) / totalSyncedMs : 0;

    // ⑦ 有效性判定
    if (!invalidReason) {
        if (ctx.contextLost) invalidReason = "context-lost";
        else if (visibilityState !== "visible") invalidReason = `hidden(${visibilityState})`;
        else if (controllerRenderCalls !== N || adapterFrameDelta !== N) invalidReason = "frame-count-mismatch";
        else if (counters.unexpectedDrawCalls > 0) invalidReason = "unexpected-draw";
        else if (counters.unexpectedFrameCallbacks > 0) invalidReason = "unexpected-frame-callback";
        else if (measureWindowAudit?.resolutionChanged)
            invalidReason = measureWindowAudit.invalidReason || "resolution-changed-during-measure";
        else if (measureWindowAudit?.warmupDrawMissingAtWindowStart) invalidReason = "warmup-draw-not-verified";
        else if (measureWindowAudit?.activeSortSerialChanged) invalidReason = "active-sort-changed";
        else if (measureWindowAudit?.lastDrawSortSerialChanged) invalidReason = "last-draw-serial-changed";
        else if (renderOnly) {
            // 阶段 7A：主表静态协议必须"强制请求 + 四项证明 + 冻结后 warmup draw 归因 + 序号不变"
            if (!sortToken || !sortToken.forced) invalidReason = "sort-not-forced";
            else if (
                !sortProof ||
                !sortProof.proven ||
                !sortProof.completed ||
                !sortProof.uploaded ||
                !sortProof.activated
            ) {
                invalidReason = "sort-not-proven";
            } else if (sortProof.evidence === "vendor-equivalence-heuristic") {
                invalidReason = "sort-proof-heuristic-not-accepted";
            } else if (!warmupDrawVerified) invalidReason = "warmup-draw-not-verified";
            else if (sortAuditAtStart && !sortAuditAtStart.frozen) invalidReason = "sort-not-frozen";
            else if (sortAuditAtStart && sortAuditAtStart.pendingCount !== 0) invalidReason = "sort-pending-nonzero";
            else if (
                sortAuditAtStart &&
                sortAuditAtEnd &&
                sortAuditAtEnd.activeSerial !== sortAuditAtStart.activeSerial
            ) {
                invalidReason = "active-sort-changed";
            } else if (
                sortAuditAtStart &&
                sortAuditAtEnd &&
                sortAuditAtEnd.lastDrawSortSerial !== sortAuditAtStart.lastDrawSortSerial
            ) {
                invalidReason = "last-draw-serial-changed";
            } else if (
                counters.sortRequests !== 0 ||
                counters.sortCompleted !== 0 ||
                counters.indexBufferUploads !== 0 ||
                pendingAtStart !== 0 ||
                pendingAtEnd !== 0
            ) {
                invalidReason = "sort-activity-during-measure";
            }
        }
    }
    mark("validity", { invalidReason: invalidReason ?? "ok" });

    return {
        method: adapter.name,
        protocol,
        metric: METRIC_SYNCED_FPS,
        valid: invalidReason === null,
        invalidReason,
        warmupFrames,
        requestedFrames: N,
        completedFrames: controllerRenderCalls,
        renderCalls: controllerRenderCalls,
        controllerRenderCalls,
        adapterFrameSerialStart: frameSerialStart,
        adapterFrameSerialEnd,
        adapterFrameDelta,
        submitStartMs,
        lastSubmitMs,
        gpuCompleteMs,
        submitPhaseMs,
        drainPhaseMs,
        totalSyncedMs,
        fps,
        sortRequestsDuringMeasure: counters.sortRequests,
        sortCompletedDuringMeasure: counters.sortCompleted,
        indexBufferUploadsDuringMeasure: counters.indexBufferUploads,
        pendingSortsAtStart: pendingAtStart,
        pendingSortsAtEnd: pendingAtEnd,
        drawCallsDuringMeasure: counters.drawCalls,
        drawInstancesDuringMeasure: counters.drawInstances,
        drawCallsPerFrame: counters.drawCallsPerFrame,
        unexpectedDrawCalls: counters.unexpectedDrawCalls,
        unexpectedFrameCallbacks: counters.unexpectedFrameCallbacks,
        rafCallsDuringMeasure: counters.rafCalls,
        timerSchedulesDuringMeasure: counters.timerSchedules,
        yieldMode: cfg.yieldMode,
        batchSize: cfg.batchSize,
        yieldCount,
        sortFrozenBeforeWarmup: sortFrozen,
        resolution,
        camera: adapter.getCameraAudit(),
        workload: adapter.getWorkloadAudit(),
        visibilityState,
        contextLost: ctx.contextLost,
        eventLog,
        sortToken,
        sortAppliedProof: sortProof,
        sortAuditAtStart,
        sortAuditAtEnd,
        sortWarmupDrawVerified: warmupDrawVerified,
        measureWindowAudit,
    };
}

// ------------------------------------------------------------------ 指标 B：rAF 呈现（presentation-raf-v1）
export interface RafDeps {
    /** `requestAnimationFrame` 包装（可注入）；回调参数为该帧的**时间戳** */
    requestFrame(cb: (timestampMs: number) => void): number;
    cancelFrame(id: number): void;
}

export interface RafPresentationResult {
    method: BenchMethod;
    protocol: string;
    metric: string;
    valid: boolean;
    invalidReason: string | null;
    warmupFrames: number;
    measureFrames: number;
    renderedFrames: number;
    meanFps: number;
    medianFrameMs: number;
    p90FrameMs: number;
    p95FrameMs: number;
    p99FrameMs: number;
    minGapMs: number;
    maxGapMs: number;
    droppedFrames: number;
    screenRefreshIntervalMs: number;
    screenRefreshHz: number;
    vsyncCapped: boolean;
    visibilityState: VisibilityState;
    contextLost: boolean;
    frameGapsMs: number[];
}

/**
 * 指标 B：与指标 A 无关的**呈现**口径（每个 rAF 每方法只 render 一次）。
 * 不得与高于刷新率的吞吐数字直接比较；三方都达上限时只能结论"均满足该刷新率"。
 */
export async function runRafPresentation(
    adapter: ThreeWayBenchmarkAdapter,
    deps: ControllerDeps,
    cfg: { warmupFrames: number; measureFrames: number },
    raf: RafDeps,
): Promise<RafPresentationResult> {
    const warmupFrames = Math.max(0, Math.floor(cfg.warmupFrames));
    const measureFrames = Math.max(1, Math.floor(cfg.measureFrames));
    const gaps: number[] = [];
    let rendered = 0;
    let serial = 0;
    let invalidReason: string | null = null;
    let last = 0;

    // 帧间隔必须基于 **rAF 时间戳**（vsync 周期），不能用"回调开始执行的时刻"，
    // 否则渲染 CPU 成本会被重复计入帧间隔。
    const nextFrame = (): Promise<number> =>
        new Promise<number>((resolve) => {
            raf.requestFrame((ts: number) => resolve(Number.isFinite(ts) ? ts : deps.now()));
        });

    try {
        for (let i = 0; i < warmupFrames; i++) {
            last = await nextFrame();
            serial++;
            adapter.probe.beginControlledFrame(serial);
            adapter.renderPipelinedFrame();
            adapter.probe.endControlledFrame(serial);
        }
        for (let i = 0; i < measureFrames; i++) {
            const t = await nextFrame();
            gaps.push(t - last);
            last = t;
            serial++;
            adapter.probe.beginControlledFrame(serial);
            adapter.renderPipelinedFrame();
            adapter.probe.endControlledFrame(serial);
            rendered++;
        }
    } catch (err) {
        invalidReason = `exception:${err instanceof Error ? err.message : String(err)}`;
    }

    const ctx = adapter.getContextState();
    const visibilityState = deps.getVisibilityState();
    const medianGap = gaps.length > 0 ? median(gaps) : NaN;
    // 用 median gap 估计刷新间隔（不依赖 screen.refreshRate 的可用性）
    const refreshMs = Number.isFinite(medianGap) ? medianGap : 0;
    const refreshHz = refreshMs > 0 ? 1000 / refreshMs : 0;
    const droppedFrames = refreshMs > 0 ? gaps.filter((g) => g > refreshMs * 1.5).length : 0;
    const vsyncCapped = refreshMs > 0 && gaps.length > 0 && percentile(gaps, 0.9) <= refreshMs * 1.2;

    if (!invalidReason) {
        if (ctx.contextLost) invalidReason = "context-lost";
        else if (visibilityState !== "visible") invalidReason = `hidden(${visibilityState})`;
        else if (rendered !== measureFrames) invalidReason = "frame-count-mismatch";
    }

    const totalMs = gaps.reduce((s, g) => s + g, 0);
    return {
        method: adapter.name,
        protocol: PROTOCOL_RAF,
        metric: METRIC_RAF,
        valid: invalidReason === null,
        invalidReason,
        warmupFrames,
        measureFrames,
        renderedFrames: rendered,
        meanFps: totalMs > 0 ? (rendered * 1000) / totalMs : 0,
        medianFrameMs: medianGap,
        p90FrameMs: percentile(gaps, 0.9),
        p95FrameMs: percentile(gaps, 0.95),
        p99FrameMs: percentile(gaps, 0.99),
        minGapMs: gaps.length > 0 ? Math.min(...gaps) : NaN,
        maxGapMs: gaps.length > 0 ? Math.max(...gaps) : NaN,
        droppedFrames,
        screenRefreshIntervalMs: refreshMs,
        screenRefreshHz: refreshHz,
        vsyncCapped,
        visibilityState,
        contextLost: ctx.contextLost,
        frameGapsMs: gaps,
    };
}

// ------------------------------------------------------------------ 轮次顺序（条件 5）
/** 正式主表轮数：6 种排列各出现两次。 */
export const MAIN_TABLE_ROUNDS = 12;
/** 仅用于预实验的轮数（6 种排列 + 1 随机）。 */
export const PRELIM_ROUNDS = 7;

export const METHOD_PERMUTATIONS: BenchMethod[][] = [
    ["ours", "flux-gs", "reduced-3dgs"],
    ["ours", "reduced-3dgs", "flux-gs"],
    ["flux-gs", "ours", "reduced-3dgs"],
    ["flux-gs", "reduced-3dgs", "ours"],
    ["reduced-3dgs", "ours", "flux-gs"],
    ["reduced-3dgs", "flux-gs", "ours"],
];

/**
 * 平衡顺序（避免温控偏向）：
 *   rounds=12 ⇒ 六种排列各两次（正式主表）
 *   rounds=7  ⇒ 六种排列 + 1 个随机排列（预实验）
 *   其它      ⇒ 依次循环使用六种排列
 */
export function buildRoundOrder(rounds: number, rng: () => number = Math.random): BenchMethod[][] {
    const n = Math.max(1, Math.floor(rounds));
    if (n === MAIN_TABLE_ROUNDS) return [...METHOD_PERMUTATIONS, ...METHOD_PERMUTATIONS];
    if (n === PRELIM_ROUNDS) {
        const idx = Math.min(METHOD_PERMUTATIONS.length - 1, Math.floor(rng() * METHOD_PERMUTATIONS.length));
        return [...METHOD_PERMUTATIONS, [...METHOD_PERMUTATIONS[idx]]];
    }
    const out: BenchMethod[][] = [];
    for (let i = 0; i < n; i++) out.push([...METHOD_PERMUTATIONS[i % METHOD_PERMUTATIONS.length]]);
    return out;
}

// ------------------------------------------------------------------ 聚合与热漂移（条件 5）
export interface FpsStats {
    count: number;
    median: number;
    mean: number;
    stddev: number;
    iqr: number;
    p95: number;
    min: number;
    max: number;
}

export interface MethodAggregate {
    method: BenchMethod;
    totalRounds: number;
    validRounds: number;
    fps: FpsStats | null;
    thermal: ThermalDrift;
    excluded: boolean;
    excludeReason: string | null;
    invalidReasons: string[];
}

export function aggregateSyncedRounds(results: readonly SyncedRoundResult[]): MethodAggregate {
    const method = results.length > 0 ? results[0].method : "ours";
    const valid = results.filter((r) => r.valid);
    const fpsSeries = valid.map((r) => r.fps).filter((v) => Number.isFinite(v));
    const invalidReasons = results.filter((r) => !r.valid).map((r) => r.invalidReason ?? "unknown");
    const thermal = computeThermalDrift(fpsSeries);
    const stats: FpsStats | null =
        fpsSeries.length > 0
            ? {
                  count: fpsSeries.length,
                  median: median(fpsSeries),
                  mean: mean(fpsSeries),
                  stddev: stddev(fpsSeries),
                  iqr: iqr(fpsSeries),
                  p95: percentile(fpsSeries, 0.95),
                  min: Math.min(...fpsSeries),
                  max: Math.max(...fpsSeries),
              }
            : null;
    const excluded = valid.length === 0 || thermal.thermalDrift;
    return {
        method,
        totalRounds: results.length,
        validRounds: valid.length,
        fps: stats,
        thermal,
        excluded,
        excludeReason: valid.length === 0 ? "no-valid-rounds" : thermal.thermalDrift ? "thermal-drift" : null,
        invalidReasons,
    };
}

/** 某场景的三方法是否可以进主表（跨臂相机/投影 + 各臂有效性 + 无热漂移）。 */
export function sceneCanEnterMainTable(input: {
    anchorsShared: boolean;
    crossJudgments: boolean[];
    aggregates: MethodAggregate[];
}): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (!input.anchorsShared) reasons.push("anchor-set-not-shared");
    if (input.crossJudgments.some((v) => !v)) reasons.push("cross-arm-mismatch");
    for (const a of input.aggregates) {
        if (a.validRounds < MAIN_TABLE_ROUNDS)
            reasons.push(`${a.method}:valid-rounds-${a.validRounds}/${MAIN_TABLE_ROUNDS}`);
        if (a.thermal.thermalDrift) reasons.push(`${a.method}:thermal-drift`);
    }
    return { ok: reasons.length === 0, reasons };
}
