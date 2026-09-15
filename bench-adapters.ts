/**
 * bench-adapters.ts — 阶段 8A：`CaseSlaveAdapter`（共享）+ Ours / Reduced-3DGS 两臂 + Flux 的**明确未实现**占位。
 *
 * 设计约束（阶段 8A）：
 *   1. adapter 只做：创建并等待 iframe slave、取得已有 canvas/context、绑定 sort worker 探针、
 *      转发 `CaseSlaveApi`、收集 renderer bridge audit、finally 里 unfreeze + probe.detach + dispose + **移除 iframe**；
 *   2. adapter **不得**：计算 FPS、实现 batch/yield、自己启动 rAF/timer、生成 sort serial/hash、
 *      修改 protocol、提前伪造 `usedByDraw=true`；
 *   3. Flux 在 bridge 落地前**不降级运行**：`unimplementedReason` ⇒ controller 判 `adapter-not-implemented`。
 */
import { EMPTY_WINDOW_COUNTERS } from "./bench-controller";
import type {
    AdapterCapabilities,
    AdapterMeasureWindowAudit,
    BenchMethod,
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
import type { CameraAudit, ResolutionAudit, WorkloadAudit } from "./bench-audit";
import type { CaseSlaveApi, CaseSlaveProbeApi } from "./bench-case-slave";

/** iframe 句柄（由页面提供；adapter 只负责 `remove()`，不创建 DOM 细节） */
export interface IframeSlaveHandle {
    readonly contentWindow: { __CASE_BENCH__?: CaseSlaveApi } | null;
    remove(): void;
}

/**
 * adapter 清理审计（**移除 iframe 之前**保存）。
 * 语义分离：`slaveDispose` = 解冻 + 清理 renderer（iframe 内）；
 *           `iframeRemoved` = 父页面移除 iframe（**只有 adapter 能证明**）。
 */
export interface AdapterDisposeAudit {
    finalSortAudit: SortAudit;
    finalFrameSerial: number;
    contextLost: boolean;
    resolutionAtDispose: ResolutionAudit;
    unfrozenBeforeDispose: boolean;
    probeDetached: boolean;
    slaveDisposeCalled: boolean;
    iframeRemoved: boolean;
}

/** 探针绑定器（页面持有 `GlProbe`；adapter 只调用这三个方法） */
export interface ProbeBinder {
    /** 把探针绑定到 iframe 内的排序 worker 实例 */
    bindSortWorker(worker: Worker, opts?: { createdAtMs?: number }): void;
    detach(): void;
    getAuthority(): unknown;
}

export interface CaseSlaveAdapterConfig {
    name: BenchMethod;
    /** 场景/模型标识（仅元数据，不参与测量逻辑） */
    scene: { id: string; dataset: string; modelUrl: string; iframeUrl: string };
    /** 模型来源元数据（§12.6：分开记录，禁止含糊的 modelBytes） */
    modelSource: WorkloadAudit["model"];
    /** 页面侧：创建 iframe（**必须**由调用方负责，adapter 不碰 DOM 细节） */
    createIframe(url: string): IframeSlaveHandle;
    /** 页面侧：等待 `__CASE_BENCH__` 出现（轮询/超时由调用方实现） */
    waitForSlave(handle: IframeSlaveHandle, timeoutMs: number): Promise<CaseSlaveApi>;
    /** 探针绑定器 */
    probe: ProbeBinder;
    /** 协议静止等待用的调度器（**唯一的** timer 用途；adapter 自身不调度 rAF） */
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
    readyTimeoutMs?: number;
    capabilityOverrides?: Partial<AdapterCapabilities>;
}

/** 跨 iframe 的探针代理：**只转发**，不改写任何计数。 */
class IframeProbeProxy implements BenchProbe {
    constructor(private readonly get: () => CaseSlaveProbeApi | null) {}
    openWindow(): void {
        this.get()?.openWindow();
    }
    closeWindow(): void {
        this.get()?.closeWindow();
    }
    pendingSorts(): number {
        return this.get()?.pendingSorts() ?? 0;
    }
    beginControlledFrame(frameSerial: number): void {
        this.get()?.beginControlledFrame(frameSerial);
    }
    endControlledFrame(frameSerial: number): void {
        this.get()?.endControlledFrame(frameSerial);
    }
    snapshotWindow(): WindowCounters {
        return this.get()?.snapshotWindow() ?? { ...EMPTY_WINDOW_COUNTERS, drawCallsPerFrame: [] };
    }
}

/**
 * Ours / Reduced-3DGS 共用的 slave adapter。
 * 两臂只在 `name` / `scene` / `modelSource` 上有差别（共用同一 renderer）。
 */
export class CaseSlaveAdapter implements ThreeWayBenchmarkAdapter {
    readonly name: BenchMethod;
    readonly capabilities: AdapterCapabilities;
    readonly probe: BenchProbe;

    private readonly cfg: CaseSlaveAdapterConfig;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly log: (line: string) => void;
    private handle: IframeSlaveHandle | null = null;
    private api: CaseSlaveApi | null = null;
    private disposed = false;
    private measureWindowOpened = false;
    private measureWindowClosed = false;
    private warmupDrawPending = false;
    private roundFrameSerialStart = 0;
    /** 移除 iframe **之前**保存的最终审计（dispose 之后不得再调用 slave 的 getter） */
    private disposeAudit: AdapterDisposeAudit | null = null;
    /** 诊断：adapter 自身产生的协议静止等待次数（**rAF 恒为 0**） */
    private protocolSleeps = 0;
    private events: string[] = [];

    constructor(cfg: CaseSlaveAdapterConfig) {
        this.cfg = cfg;
        this.name = cfg.name;
        this.capabilities = {
            staticFrameRenderOnly: true,
            sortFreezeSupported: true,
            movingSortMode: "pipelined",
            ...(cfg.capabilityOverrides ?? {}),
        };
        this.sleep = cfg.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
        this.log = cfg.log ?? ((): void => {});
        this.probe = new IframeProbeProxy(() => this.api?.probe ?? null);
    }

    get eventLog(): string[] {
        return [...this.events];
    }

    get protocolSleepCount(): number {
        return this.protocolSleeps;
    }

    get slaveApi(): CaseSlaveApi | null {
        return this.api;
    }

    private note(name: string): void {
        this.events.push(name);
        this.log(`[adapter][${this.name}] ${name}`);
    }

    private requireApi(): CaseSlaveApi {
        if (!this.api) throw new Error(`${this.name}: slave 未就绪（init 尚未完成）`);
        return this.api;
    }

    /** 创建并等待 iframe slave；绑定排序 worker 探针。**不做**任何 FPS/循环动作。 */
    async init(_config: BenchmarkConfig): Promise<void> {
        this.handle = this.cfg.createIframe(this.cfg.scene.iframeUrl);
        this.api = await this.cfg.waitForSlave(this.handle, this.cfg.readyTimeoutMs ?? 30000);
        this.note("slave-ready");
        this.api.ensureFirstFrame();
        const report = this.api.ensureFirstFrameReport();
        this.log(`[adapter][${this.name}] first-frame ${JSON.stringify(report)}`);
        const worker = this.api.getSortWorker();
        if (worker) {
            this.cfg.probe.bindSortWorker(worker);
            this.note("probe-bound-to-sort-worker");
        } else {
            this.note("probe-bind-skipped-no-worker");
        }
    }

    async loadScene(): Promise<void> {
        // slave 侧已在装配时加载模型；这里只记录元数据
        this.note("scene-metadata");
    }

    async setResolution(width: number, height: number): Promise<void> {
        this.requireApi().setResolution(width, height);
        this.roundFrameSerialStart = this.requireApi().getFrameSerial();
        this.measureWindowOpened = false;
        this.measureWindowClosed = false;
        this.note("set-resolution");
    }

    async setCamera(camera: CameraFrameInput): Promise<void> {
        this.requireApi().setCamera(camera);
        this.note("set-camera");
    }

    async waitUntilReady(): Promise<void> {
        this.note("ready");
    }

    async requestSortOnce(camera: CameraFrameInput, opts?: { force?: boolean }): Promise<SortToken> {
        // force 默认 true；**不生成** serial/hash（一律由 renderer bridge 提供）
        const token = await this.requireApi().requestSortOnce(camera, { force: opts?.force ?? true });
        this.note("sort-requested");
        return token;
    }

    async waitForSortApplied(token: SortToken, timeoutMs?: number): Promise<SortAppliedProof> {
        const proof = await this.requireApi().waitForSortApplied(token, timeoutMs);
        this.note("sort-applied");
        return proof; // usedByDraw 保持 false（由 controller 在 warmup draw 后派生）
    }

    async freezeSortRequests(): Promise<void> {
        this.requireApi().freezeSortRequests();
        this.warmupDrawPending = true;
        this.note("sort-frozen");
    }

    async unfreezeSortRequests(): Promise<void> {
        this.api?.unfreezeSortRequests();
        this.note("sort-unfrozen");
    }

    getSortAudit(): SortAudit {
        return this.requireApi().getSortAudit();
    }

    /** 协议静止等待：`pendingCount === 0`（唯一等待用途，由注入 scheduler 提供）。 */
    async waitForWorkerQuiescence(): Promise<void> {
        for (let i = 0; i < 200; i++) {
            if (this.requireApi().getSortAudit().pendingCount === 0) {
                this.note("worker-quiescent");
                return;
            }
            this.protocolSleeps++;
            await this.sleep(2);
        }
        this.note("worker-quiescence-timeout");
    }

    /** 只 draw。冻结后的**第一次** static draw 之后才打开测量窗口（顺序要求）。 */
    renderStaticFrame(): void {
        this.requireApi().renderStaticFrame();
        if (this.warmupDrawPending) {
            this.warmupDrawPending = false;
            this.api?.beginMeasureWindow();
            this.measureWindowOpened = true;
            this.note("static-warmup-draw-then-window-open");
        }
    }

    renderPipelinedFrame(): void {
        this.requireApi().renderPipelinedFrame();
    }

    finishGpu(): void {
        this.requireApi().finishGpu();
        this.note("finish-gpu");
    }

    getResolutionAudit(): ResolutionAudit {
        return this.requireApi().getResolutionAudit();
    }

    getCameraAudit(): CameraAudit {
        return this.requireApi().getCameraAudit();
    }

    getWorkloadAudit(): WorkloadAudit {
        const w = this.requireApi().getWorkloadAudit();
        // 模型来源元数据由 adapter 按 §12.6 补齐（分开字段，不用含糊的 modelBytes）
        return { ...w, model: { ...w.model, ...this.cfg.modelSource } };
    }

    getContextState(): ContextState {
        return this.requireApi().getContextState();
    }

    getFrameSerial(): number {
        return this.requireApi().getFrameSerial();
    }

    /** 消费 slave 的 `endMeasureWindow()`：分辨率四项 + 序号不变 + warmup draw 守卫。 */
    getMeasureWindowAudit(): AdapterMeasureWindowAudit | null {
        if (!this.api) return null;
        if (!this.measureWindowOpened || this.measureWindowClosed) return this.api.getMeasureWindowAudit();
        this.measureWindowClosed = true;
        const w = this.api.endMeasureWindow();
        this.note("measure-window-ended");
        return {
            resolutionChanged: w.resolutionChanged,
            invalidReason: w.invalidReason,
            activeSortSerialChanged: w.activeSortSerialChanged,
            lastDrawSortSerialChanged: w.lastDrawSortSerialChanged,
            warmupDrawMissingAtWindowStart: w.warmupDrawMissingAtWindowStart,
        };
    }

    get roundFrameSerialStartForDiag(): number {
        return this.roundFrameSerialStart;
    }

    /** finally 语义（顺序固定，且**先取审计再移除 iframe**）：
     *   ① 保存最终审计 ② unfreeze ③ probe.detach ④ slave.dispose ⑤ iframe.remove ⑥ 标记已移除 */
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        const api = this.api;
        // ① 审计必须在移除 iframe 之前取（移除后不得再调用 slave 的 getter）
        const audit: AdapterDisposeAudit = {
            finalSortAudit: api
                ? api.getSortAudit()
                : {
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
                  },
            finalFrameSerial: api ? api.getFrameSerial() : 0,
            contextLost: api ? api.getContextState().contextLost : false,
            resolutionAtDispose: api ? api.getResolutionAudit() : ({} as ResolutionAudit),
            unfrozenBeforeDispose: false,
            probeDetached: false,
            slaveDisposeCalled: false,
            iframeRemoved: false,
        };
        this.disposeAudit = audit;
        // ② 解冻（slave 侧清理的前提）
        try {
            api?.unfreezeSortRequests();
            audit.unfrozenBeforeDispose = true;
        } catch {
            /* ignore */
        }
        // ③ 探针 detach（父页面侧包装）
        try {
            this.cfg.probe.detach();
            audit.probeDetached = true;
        } catch {
            /* ignore */
        }
        // ④ slave 侧清理（解冻 + renderer.dispose + 主动丢上下文）
        try {
            await api?.dispose();
            audit.slaveDisposeCalled = true;
        } catch {
            /* ignore */
        }
        // ⑤ 父页面移除 iframe（**只有这一步能证明 iframe 被移除**）
        try {
            this.handle?.remove();
            audit.iframeRemoved = true;
        } catch {
            /* ignore */
        }
        this.api = null;
        this.handle = null;
        this.note("disposed(iframe-removed)");
    }

    /** 清理审计（必须在 `dispose()` 之后读取；`iframeRemoved` 是父侧证据）。 */
    getDisposeAudit(): AdapterDisposeAudit | null {
        return this.disposeAudit;
    }

    /** 一轮的边界：无论 fn 如何失败都执行 dispose。 */
    async runRound<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } finally {
            await this.dispose();
        }
    }
}

// ------------------------------------------------------------------ 两臂工厂（只声明差异）
export interface SlaveArmProfile {
    name: BenchMethod;
    sceneId: string;
    dataset: string;
    modelUrl: string;
    iframeUrl: string;
    modelSource: WorkloadAudit["model"];
}

type SlaveArmDeps = Omit<CaseSlaveAdapterConfig, "name" | "scene" | "modelSource">;

export function createOursAdapter(profile: SlaveArmProfile, deps: SlaveArmDeps): CaseSlaveAdapter {
    return new CaseSlaveAdapter({
        ...deps,
        name: "ours",
        scene: {
            id: profile.sceneId,
            dataset: profile.dataset,
            modelUrl: profile.modelUrl,
            iframeUrl: profile.iframeUrl,
        },
        modelSource: profile.modelSource,
    });
}

export function createReduced3dgsAdapter(profile: SlaveArmProfile, deps: SlaveArmDeps): CaseSlaveAdapter {
    return new CaseSlaveAdapter({
        ...deps,
        name: "reduced-3dgs",
        scene: {
            id: profile.sceneId,
            dataset: profile.dataset,
            modelUrl: profile.modelUrl,
            iframeUrl: profile.iframeUrl,
        },
        modelSource: profile.modelSource,
    });
}

// ------------------------------------------------------------------ Flux：**明确未实现**（阶段 6 之前不得降级运行）
export const FLUX_ADAPTER_NOT_IMPLEMENTED =
    "Flux benchSlaveMode/forceSort/bridge 未实现（阶段 6）；旧页面的自挂 rAF / 自动排序 / 无强制排序 / 无权威 serial 使其不构成合格 slave";

/** 占位 adapter：任何动作都不执行；controller 直接判 `invalidReason=adapter-not-implemented`。 */
export function createUnimplementedAdapter(name: BenchMethod, reason: string): ThreeWayBenchmarkAdapter {
    const fail = (): never => {
        throw new Error(`${name}: adapter 未实现（${reason}）`);
    };
    const emptyResolution: ResolutionAudit & {
        requested: [number, number];
        canvas: [number, number];
        drawingBuffer: [number, number];
        viewport: [number, number, number, number];
        internalFramebuffer: [number, number];
    } = {
        requested: [0, 0],
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
    const emptySortAudit: SortAudit = {
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
    };
    return {
        name,
        unimplementedReason: reason,
        capabilities: { staticFrameRenderOnly: false, sortFreezeSupported: false, movingSortMode: "pipelined" },
        probe: {
            openWindow: (): void => {},
            closeWindow: (): void => {},
            pendingSorts: (): number => 0,
            beginControlledFrame: (): void => {},
            endControlledFrame: (): void => {},
            snapshotWindow: (): WindowCounters => ({ ...EMPTY_WINDOW_COUNTERS, drawCallsPerFrame: [] }),
        },
        init: async (): Promise<void> => fail(),
        loadScene: async (): Promise<void> => fail(),
        setResolution: async (): Promise<void> => fail(),
        setCamera: async (): Promise<void> => fail(),
        waitUntilReady: async (): Promise<void> => fail(),
        requestSortOnce: async (): Promise<SortToken> => fail(),
        waitForSortApplied: async (): Promise<SortAppliedProof> => fail(),
        freezeSortRequests: async (): Promise<void> => fail(),
        unfreezeSortRequests: async (): Promise<void> => fail(),
        getSortAudit: (): SortAudit => emptySortAudit,
        waitForWorkerQuiescence: async (): Promise<void> => fail(),
        renderStaticFrame: (): void => fail(),
        renderPipelinedFrame: (): void => fail(),
        finishGpu: (): void => fail(),
        getResolutionAudit: (): ResolutionAudit => emptyResolution,
        getCameraAudit: (): CameraAudit => fail(),
        getWorkloadAudit: (): WorkloadAudit => fail(),
        getContextState: (): ContextState => fail(),
        getFrameSerial: (): number => 0,
        dispose: async (): Promise<void> => {},
    };
}
