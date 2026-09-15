/**
 * bench-case-slave.ts — `?slave=1` 模式下暴露给父控制器的**薄封装**（阶段 5）。
 *
 * 核心原则：本层**只做转发**，绝不重新实现：
 *   sort serial / sortViewProjHash / force sort / freeze 状态 / sort audit / frame serial
 * 全部来自 renderer 侧已落地的 `RenderProgram` bridge（经 deps 注入 ⇒ 可在 node 单测）。
 *
 * slave 模式**禁止**：自动 `measureOneRound`、自驱 rAF、自驱 timer benchmark、自动场景切换、自动 dispose。
 * 非 slave 默认路径完全不变（本模块只在 `?slave=1` 时装配）。
 *
 * `waitForSortApplied()` 语义：冻结后的 warmup draw 之前只能证明
 * `completed / uploaded / activated`，**不得**提前自报 `usedByDraw=true`。
 */
import type { AnchorSet, CameraAudit, ResolutionAudit, WorkloadAudit } from "./bench-audit";
import { buildCameraAudit, resolutionMatches } from "./bench-audit";
import type {
    BenchProbe,
    CameraFrameInput,
    ContextState,
    SortAppliedProof,
    SortAudit,
    SortToken,
    WindowCounters,
} from "./bench-controller";

/** renderer bridge（= `RenderProgram` 已落地的 bench API；不得在本层重复实现） */
export interface SlaveRendererBridge {
    /** `RenderProgram.getSortAudit()` */
    getSortAudit(): SortAudit;
    /** `RenderProgram.requestSortOnce(force)`；null = worker 尚未创建 */
    requestSortOnce(force: boolean): number | null;
    /** `RenderProgram.setBenchFreezeSortRequests(frozen)` */
    setBenchFreezeSortRequests(frozen: boolean): void;
    /** `RenderProgram.cameraHash()` —— 内部即 `sortCameraHash(viewProj)`，**同一实现** */
    cameraHash(): string | null;
    /** 唯一哈希实现（`RenderProgram.sortCameraHash`）—— slave 不得自带第二套 */
    hashViewProj(values: ArrayLike<number>): string;
    /** `RenderProgram.worker`（供探针按实例绑定） */
    getSortWorker(): Worker | null;
    /** bench 侧 frame serial（= adapterFrameSerial 的来源） */
    getFrameSerial(): number;
    /** `renderer.gl.finish()` —— 必须复用同一个 renderer 上下文 */
    finishGpu(): void;
}

/** scene/case 侧能力（= `BenchCase` 已落地的方法，薄封装） */
export interface SlaveSceneBridge {
    /** `BenchCase.setBenchmarkResolution` + 立即审计（每轮只允许调用一次） */
    setResolutionOnce(width: number, height: number): void;
    /** 把 `viewMatrix` 反解为 position+quaternion 写入相机（复用 CameraData.update） */
    setCameraFromView(viewMatrix: readonly number[], fx: number, fy: number): { recomposeErrorMax: number };
    /** 复用既有渲染路径（`BenchCase.frameRender`） */
    frameRender(): void;
    /** 当前分辨率审计（canvas/drawingBuffer/viewport/internalFramebuffer/…） */
    getResolutionAudit(): ResolutionAudit;
    /** 读相机 flat 矩阵（`camera.data.viewMatrix / viewProj.buffer`）+ 内参 */
    readCameraMatrices(): {
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
    };
    getWorkloadAudit(): WorkloadAudit;
    getContextState(): ContextState;
    getCanvas(): HTMLCanvasElement;
    /** 幂等释放（复用 `BenchCase.dispose`） */
    dispose(): number;
}

export interface CaseSlaveDeps {
    scene: SlaveSceneBridge;
    renderer: SlaveRendererBridge;
    probe?: BenchProbe | null;
    /** 探针 detach（清理必须调用） */
    probeDetach?: (() => void) | null;
    /** 公共锚点集（阶段 8 生成；缺省 null ⇒ anchorSetHash=""，跨臂校验会如实判不通过） */
    anchorSet?: AnchorSet | null;
    modelToCanonicalMatrix?: number[];
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    defaultTimeoutMs?: number;
}

export interface EnsureFirstFrameReport {
    frameSerialBeforeEnsure: number;
    frameSerialAfterEnsure: number;
    /** 首帧期间的 draw 调用次数（探针窗口内统计；无探针时为 -1） */
    drawCallsDuringEnsure: number;
    /** 首帧期间的实例数（首帧通常为 0：排序尚未回传） */
    drawInstancesDuringEnsure: number;
    sortWorkerBeforeEnsure: boolean;
    sortWorkerAfterEnsure: boolean;
}

export interface CaseMeasureWindowAudit {
    resolutionAtStart: ResolutionAudit;
    resolutionAtEnd: ResolutionAudit;
    resolutionChanged: boolean;
    invalidReason: string;
    frameSerialAtStart: number;
    frameSerialAtEnd: number;
    sortAuditAtStart: SortAudit;
    sortAuditAtEnd: SortAudit;
    activeSortSerialChanged: boolean;
    lastDrawSortSerialChanged: boolean;
    /**
     * `beginMeasureWindow()` 时"还没有任何已排序的 draw"（即漏掉了冻结后的 static warmup draw）。
     * controller 必须先做 warmup draw 再开窗口；本字段为 true 时不得进入主表。
     */
    warmupDrawMissingAtWindowStart: boolean;
}

export class CaseSlave {
    private readonly deps: CaseSlaveDeps;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly defaultTimeoutMs: number;
    private disposed = false;
    private cleanupDone = false;
    private resolutionSetCalls = 0;
    private frozen = false;
    private events: string[] = [];
    private windowAudit: CaseMeasureWindowAudit | null = null;
    private firstFrameDone = false;
    private framesSinceFreeze = 0;
    private ensureReport: EnsureFirstFrameReport | null = null;

    constructor(deps: CaseSlaveDeps) {
        this.deps = deps;
        this.now = deps.now ?? ((): number => (typeof performance !== "undefined" ? performance.now() : Date.now()));
        this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        this.defaultTimeoutMs = deps.defaultTimeoutMs ?? 8000;
    }

    get eventLog(): string[] {
        return [...this.events];
    }

    private note(name: string, detail?: Record<string, unknown>): void {
        this.events.push(`${name}@${this.now().toFixed(1)}${detail ? " " + JSON.stringify(detail) : ""}`);
    }

    // ---------------------------------------------------------------- 18 个接口
    /** 每轮只允许调用一次；重复调用会被审计（`resolutionSetCallsCount`）。 */
    setResolution(width: number, height: number): ResolutionAudit {
        this.resolutionSetCalls++;
        this.deps.scene.setResolutionOnce(width, height);
        const audit = this.deps.scene.getResolutionAudit();
        this.note("set-resolution", { width, height, calls: this.resolutionSetCalls });
        return audit;
    }

    setCamera(camera: CameraFrameInput): CameraAudit {
        const r = this.deps.scene.setCameraFromView(camera.viewMatrix, camera.fx, camera.fy);
        const m = this.deps.scene.readCameraMatrices();
        const requested = Array.from(camera.viewMatrix);
        let maxAbsViewMatrixError = 0;
        for (let i = 0; i < 16 && i < requested.length; i++) {
            maxAbsViewMatrixError = Math.max(maxAbsViewMatrixError, Math.abs(m.viewMatrix[i] - requested[i]));
        }
        this.note("set-camera", {
            recomposeErrorMax: r.recomposeErrorMax,
            maxAbsViewMatrixError,
            requestedViewProjectionHash: this.deps.renderer.hashViewProj(requested),
            effectiveViewProjectionHash: this.deps.renderer.hashViewProj(m.viewProj),
            cameraPosition: [m.positionX, m.positionY, m.positionZ],
        });
        return this.getCameraAudit();
    }

    /** 只发**一次**排序请求（默认 force=true）。serial 与 sortViewProjHash 均来自 renderer bridge。 */
    async requestSortOnce(camera: CameraFrameInput, opts?: { force?: boolean }): Promise<SortToken> {
        this.setCamera(camera);
        const force = opts?.force ?? true;
        const serial = this.deps.renderer.requestSortOnce(force);
        if (serial === null) {
            throw new Error("requestSortOnce: 排序 worker 尚未创建（必须先完成一次 render）");
        }
        const token: SortToken = {
            serial,
            sortViewProjHash: this.deps.renderer.cameraHash() ?? "",
            forced: force,
            source: "case-slave/renderprogram-bridge",
        };
        this.note("sort-requested", { serial, force, sortViewProjHash: token.sortViewProjHash });
        return token;
    }

    /**
     * 等该 token 的排序 completed/uploaded/activated。
     * **绝不**在此证明 `usedByDraw`（恒为 false）；由 controller 在冻结后 warmup draw 之后派生。
     */
    async waitForSortApplied(token: SortToken, timeoutMs?: number): Promise<SortAppliedProof> {
        const deadline = this.now() + (timeoutMs ?? this.defaultTimeoutMs);
        for (;;) {
            const audit = this.deps.renderer.getSortAudit();
            const completed = audit.completedSerial >= token.serial;
            const uploaded = audit.uploadedSerial >= token.serial;
            const activated = audit.activeSerial >= token.serial;
            if (completed && uploaded && activated) {
                const hashOk = audit.activeCameraHash === token.sortViewProjHash;
                this.note("sort-applied", { serial: token.serial, activeSerial: audit.activeSerial, hashOk });
                return {
                    proven: hashOk,
                    serial: token.serial,
                    sortViewProjHash: token.sortViewProjHash,
                    completed: true,
                    uploaded: true,
                    activated: true,
                    usedByDraw: false, // 阶段 5 强制：不得提前自报
                    evidence: hashOk ? "renderer-bridge" : "none",
                    reason: hashOk ? "" : "active-sort-hash-mismatch",
                };
            }
            if (this.now() >= deadline) {
                this.note("sort-timeout", { serial: token.serial });
                return {
                    proven: false,
                    serial: token.serial,
                    sortViewProjHash: token.sortViewProjHash,
                    completed,
                    uploaded,
                    activated,
                    usedByDraw: false,
                    evidence: "none",
                    reason: "timeout",
                };
            }
            await this.sleep(2);
        }
    }

    freezeSortRequests(): void {
        this.deps.renderer.setBenchFreezeSortRequests(true);
        this.frozen = true;
        this.note("sort-frozen");
    }

    unfreezeSortRequests(): void {
        this.deps.renderer.setBenchFreezeSortRequests(false);
        this.frozen = false;
        this.note("sort-unfrozen");
    }

    get isFrozen(): boolean {
        return this.frozen;
    }

    /** 只绘制：要求已冻结（否则会向 worker 发新请求，破坏 render-only 语义）。 */
    renderStaticFrame(): void {
        if (!this.frozen) {
            throw new Error("renderStaticFrame 前必须 freezeSortRequests()（否则会产生排序请求）");
        }
        this.framesSinceFreeze++;
        const isWarmupDraw = this.framesSinceFreeze === 1;
        const frameSerialBefore = this.deps.renderer.getFrameSerial();
        const requestSerialBefore = this.deps.renderer.getSortAudit().requestSerial;
        this.deps.scene.frameRender();
        const frameSerialAfter = this.deps.renderer.getFrameSerial();
        const audit = this.deps.renderer.getSortAudit();
        // 冻结后**第一次** static draw = warmup draw：必须显式打点（不得只靠
        // warmupDrawMissingAtWindowStart=false 间接推断）
        this.note(isWarmupDraw ? "static-warmup-draw" : "static-frame", {
            frameSerialBefore,
            frameSerialAfter,
            sortRequestSerialBefore: requestSerialBefore,
            sortRequestSerialAfter: audit.requestSerial,
            lastDrawSortSerial: audit.lastDrawSortSerial,
            lastDrawCameraHash: audit.lastDrawCameraHash,
            frozen: audit.frozen,
            activeSerial: audit.activeSerial,
        });
    }

    /** 冻结后的 static draw 次数（第一次即 warmup draw）。 */
    get staticDrawCount(): number {
        return this.framesSinceFreeze;
    }

    /** 动态相机：更新相机 + 发排序 + 绘制（保留原始异步语义；不自挂 rAF）。 */
    renderPipelinedFrame(camera?: CameraFrameInput): void {
        if (camera) this.setCamera(camera);
        this.deps.scene.frameRender();
    }

    finishGpu(): void {
        this.deps.renderer.finishGpu();
        this.note("finish-gpu");
    }

    getSortAudit(): SortAudit {
        return this.deps.renderer.getSortAudit();
    }

    getResolutionAudit(): ResolutionAudit {
        return this.deps.scene.getResolutionAudit();
    }

    getWorkloadAudit(): WorkloadAudit {
        return this.deps.scene.getWorkloadAudit();
    }

    getContextState(): ContextState {
        return this.deps.scene.getContextState();
    }

    getFrameSerial(): number {
        return this.deps.renderer.getFrameSerial();
    }

    getCanvas(): HTMLCanvasElement {
        return this.deps.scene.getCanvas();
    }

    getSortWorker(): Worker | null {
        return this.deps.renderer.getSortWorker();
    }

    /** 相机审计：矩阵与哈希复用 bench-audit 的 buildCameraAudit（不新增第二套哈希实现）。 */
    getCameraAudit(): CameraAudit {
        const m = this.deps.scene.readCameraMatrices();
        return buildCameraAudit({
            viewMatrix: m.viewMatrix,
            projectionMatrix: this.projectionFromCamera(m),
            fx: m.fx,
            fy: m.fy,
            near: m.near,
            far: m.far,
            width: m.width,
            height: m.height,
            modelToCanonicalMatrix: this.deps.modelToCanonicalMatrix,
            anchorSet:
                this.deps.anchorSet ??
                ({
                    file: "",
                    scene: "",
                    coordinateSystem: "canonical",
                    source: "anchor-set-not-loaded",
                    anchors: [],
                    anchorSetHash: "",
                } as AnchorSet),
        });
    }

    /** 与 `CameraData._updateProjectionMatrix` 完全同构（复用同一公式，不引入第二套约定）。 */
    private projectionFromCamera(m: {
        fx: number;
        fy: number;
        near: number;
        far: number;
        width: number;
        height: number;
    }): number[] {
        const { fx, fy, near, far, width, height } = m;
        // prettier-ignore
        return [
            2 * fx / width, 0, 0, 0,
            0, -2 * fy / height, 0, 0,
            0, 0, far / (far - near), 1,
            0, 0, -(far * near) / (far - near), 0,
        ];
    }

    // ---------------------------------------------------------------- 测量窗口审计（分辨率四项）
    /** 设置后、warmup 前调用：记录分辨率/帧号/排序审计基线。 */
    beginMeasureWindow(): void {
        const res = this.deps.scene.getResolutionAudit();
        const sortAudit = this.deps.renderer.getSortAudit();
        const frameSerial = this.deps.renderer.getFrameSerial();
        // 守卫：窗口基线必须建立在"已完成的排序已被 draw 使用"之后（否则就是漏了 warmup draw）
        const warmupDrawMissing = sortAudit.activeSerial > 0 && sortAudit.lastDrawSortSerial !== sortAudit.activeSerial;
        this.windowAudit = {
            resolutionAtStart: res,
            resolutionAtEnd: res,
            resolutionChanged: false,
            invalidReason: "",
            frameSerialAtStart: frameSerial,
            frameSerialAtEnd: frameSerial,
            sortAuditAtStart: sortAudit,
            sortAuditAtEnd: sortAudit,
            activeSortSerialChanged: false,
            lastDrawSortSerialChanged: false,
            warmupDrawMissingAtWindowStart: warmupDrawMissing,
        };
        this.note("measure-window-begin", { warmupDrawMissingAtWindowStart: warmupDrawMissing });
    }

    /** 正式测量结束后调用：二次审计 + 判定分辨率四项是否变化（复用 resolutionMatches）。 */
    endMeasureWindow(): CaseMeasureWindowAudit {
        const base = this.windowAudit;
        const end = this.deps.scene.getResolutionAudit();
        const frameSerialAtEnd = this.deps.renderer.getFrameSerial();
        const sortAuditAtEnd = this.deps.renderer.getSortAudit();
        const changed = base ? !resolutionMatches(base.resolutionAtStart, end) : false;
        const audit: CaseMeasureWindowAudit = {
            resolutionAtStart: base?.resolutionAtStart ?? end,
            resolutionAtEnd: end,
            resolutionChanged: changed,
            invalidReason: changed ? "resolution-changed-during-measure" : "",
            frameSerialAtStart: base?.frameSerialAtStart ?? frameSerialAtEnd,
            frameSerialAtEnd,
            sortAuditAtStart: base?.sortAuditAtStart ?? sortAuditAtEnd,
            sortAuditAtEnd,
            activeSortSerialChanged: base ? base.sortAuditAtStart.activeSerial !== sortAuditAtEnd.activeSerial : false,
            lastDrawSortSerialChanged: base
                ? base.sortAuditAtStart.lastDrawSortSerial !== sortAuditAtEnd.lastDrawSortSerial
                : false,
            warmupDrawMissingAtWindowStart: base?.warmupDrawMissingAtWindowStart ?? false,
        };
        this.windowAudit = audit;
        this.note("measure-window-end", {
            resolutionChanged: audit.resolutionChanged,
            activeSortSerialChanged: audit.activeSortSerialChanged,
        });
        return audit;
    }

    getMeasureWindowAudit(): CaseMeasureWindowAudit | null {
        return this.windowAudit;
    }

    /** 首帧：创建排序 worker（`RenderProgram._initialize`）并记录 frame serial 基线。 */
    ensureFirstFrame(): EnsureFirstFrameReport {
        if (this.firstFrameDone && this.ensureReport) return this.ensureReport;
        const frameSerialBeforeEnsure = this.deps.renderer.getFrameSerial();
        const sortWorkerBeforeEnsure = this.getSortWorker() !== null;
        const windowOpen = this.deps.probe != null;
        if (windowOpen) this.deps.probe!.openWindow();
        this.deps.scene.frameRender();
        const counters = windowOpen ? this.deps.probe!.snapshotWindow() : null;
        if (windowOpen) this.deps.probe!.closeWindow();
        const frameSerialAfterEnsure = this.deps.renderer.getFrameSerial();
        const sortWorkerAfterEnsure = this.getSortWorker() !== null;
        this.firstFrameDone = true;
        this.ensureReport = {
            frameSerialBeforeEnsure,
            frameSerialAfterEnsure,
            drawCallsDuringEnsure: counters ? counters.drawCalls : -1,
            drawInstancesDuringEnsure: counters ? counters.drawInstances : -1,
            sortWorkerBeforeEnsure,
            sortWorkerAfterEnsure,
        };
        this.note("first-frame", { ...this.ensureReport });
        return this.ensureReport;
    }

    getEnsureFirstFrameReport(): EnsureFirstFrameReport | null {
        return this.ensureReport;
    }

    // ---------------------------------------------------------------- 清理（必须 finally 保证）
    /**
     * 幂等清理：解冻 → 探针 detach → scene dispose。
     * 即使排序超时 / context lost / finish 抛错，也由 `runRound()` 的 finally 保证执行。
     */
    async cleanup(): Promise<void> {
        if (this.cleanupDone) return;
        this.cleanupDone = true;
        try {
            this.unfreezeSortRequests();
        } catch {
            /* ignore */
        }
        try {
            this.deps.probeDetach?.();
        } catch {
            /* ignore */
        }
        try {
            this.deps.scene.dispose();
        } catch {
            /* ignore */
        }
        this.disposed = true;
        this.note("cleanup");
    }

    /** 一轮的边界：**无论 fn 如何失败**都会执行 cleanup（cleanup 本身幂等）。 */
    async runRound<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } finally {
            await this.cleanup();
        }
    }

    async dispose(): Promise<void> {
        await this.cleanup();
    }

    get isDisposed(): boolean {
        return this.disposed;
    }

    get resolutionSetCallsCount(): number {
        return this.resolutionSetCalls;
    }
}

export function createCaseSlave(deps: CaseSlaveDeps): CaseSlave {
    return new CaseSlave(deps);
}

/** `window.__CASE_BENCH__` 的对外契约（阶段 5 要求的 18 个方法 + 诊断）。 */
export interface CaseSlaveApi {
    setResolution(w: number, h: number): ResolutionAudit;
    setCamera(camera: CameraFrameInput): CameraAudit;
    requestSortOnce(camera: CameraFrameInput, opts?: { force?: boolean }): Promise<SortToken>;
    waitForSortApplied(token: SortToken, timeoutMs?: number): Promise<SortAppliedProof>;
    freezeSortRequests(): void;
    unfreezeSortRequests(): void;
    renderStaticFrame(): void;
    renderPipelinedFrame(camera?: CameraFrameInput): void;
    finishGpu(): void;
    getSortAudit(): SortAudit;
    getResolutionAudit(): ResolutionAudit;
    getCameraAudit(): CameraAudit;
    getWorkloadAudit(): WorkloadAudit;
    getContextState(): ContextState;
    getFrameSerial(): number;
    getCanvas(): HTMLCanvasElement;
    getSortWorker(): Worker | null;
    dispose(): Promise<void>;
    // 阶段 5 附加（薄封装 + 诊断；不改变上面语义）
    ensureFirstFrame(): void;
    beginMeasureWindow(): void;
    endMeasureWindow(): CaseMeasureWindowAudit;
    getMeasureWindowAudit(): CaseMeasureWindowAudit | null;
    eventLog(): string[];
    ensureFirstFrameReport(): EnsureFirstFrameReport | null;
    probeAuthority(): unknown;
    /** iframe 内的探针访问器（父控制器读窗口计数用；null = 未安装探针） */
    probe: CaseSlaveProbeApi | null;
}

/** 跨 iframe 暴露的探针访问器（与 `BenchProbe` 同形，父侧包一层即可）。 */
export interface CaseSlaveProbeApi {
    openWindow(): void;
    closeWindow(): void;
    pendingSorts(): number;
    beginControlledFrame(frameSerial: number): void;
    endControlledFrame(frameSerial: number): void;
    snapshotWindow(): WindowCounters;
}

/** 把 `CaseSlave` 装配成可挂到 `window.__CASE_BENCH__` 的普通对象（可在 node 单测里直接验证）。 */
export function createSlaveApi(
    slave: CaseSlave,
    probe?: BenchProbe | null,
    probeAuthority?: () => unknown,
): CaseSlaveApi {
    return {
        setResolution: (w, h) => slave.setResolution(w, h),
        setCamera: (camera) => slave.setCamera(camera),
        requestSortOnce: (camera, opts) => slave.requestSortOnce(camera, opts),
        waitForSortApplied: (token, timeoutMs) => slave.waitForSortApplied(token, timeoutMs),
        freezeSortRequests: () => slave.freezeSortRequests(),
        unfreezeSortRequests: () => slave.unfreezeSortRequests(),
        renderStaticFrame: () => slave.renderStaticFrame(),
        renderPipelinedFrame: (camera) => slave.renderPipelinedFrame(camera),
        finishGpu: () => slave.finishGpu(),
        getSortAudit: () => slave.getSortAudit(),
        getResolutionAudit: () => slave.getResolutionAudit(),
        getCameraAudit: () => slave.getCameraAudit(),
        getWorkloadAudit: () => slave.getWorkloadAudit(),
        getContextState: () => slave.getContextState(),
        getFrameSerial: () => slave.getFrameSerial(),
        getCanvas: () => slave.getCanvas(),
        getSortWorker: () => slave.getSortWorker(),
        dispose: () => slave.dispose(),
        ensureFirstFrame: () => slave.ensureFirstFrame(),
        beginMeasureWindow: () => slave.beginMeasureWindow(),
        endMeasureWindow: () => slave.endMeasureWindow(),
        getMeasureWindowAudit: () => slave.getMeasureWindowAudit(),
        eventLog: () => slave.eventLog,
        probeAuthority: () => (probeAuthority ? probeAuthority() : null),
        ensureFirstFrameReport: () => slave.getEnsureFirstFrameReport(),
        probe: probe
            ? {
                  openWindow: () => probe.openWindow(),
                  closeWindow: () => probe.closeWindow(),
                  pendingSorts: () => probe.pendingSorts(),
                  beginControlledFrame: (s) => probe.beginControlledFrame(s),
                  endControlledFrame: (s) => probe.endControlledFrame(s),
                  snapshotWindow: () => probe.snapshotWindow(),
              }
            : null,
    };
}

declare global {
    interface Window {
        /** `?slave=1` 时由 bench-case.ts 装配（父控制器通过它驱动一轮测量） */
        __CASE_BENCH__?: CaseSlaveApi;
    }
}
