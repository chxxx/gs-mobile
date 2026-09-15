/**
 * bench-controller.test.ts — 唯一状态机的单测（mock adapter ×3 + 事件日志）。
 * 覆盖 §7.1 的 12 条 + 强制验收条件（1 排序队列 / 4 draw 作用域 / 5 rounds=12 与热漂移）。
 * 不 import `./src`、不碰 DOM、不创建 WebGL。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    MAIN_TABLE_ROUNDS,
    METHOD_PERMUTATIONS,
    PRELIM_ROUNDS,
    PROTOCOL_MOVING_PIPELINED,
    PROTOCOL_RAF,
    PROTOCOL_STATIC_FULL_FRAME,
    PROTOCOL_STATIC_RENDER_ONLY,
    aggregateSyncedRounds,
    buildRoundOrder,
    runRafPresentation,
    runSyncedThroughput,
    sceneCanEnterMainTable,
} from "./bench-controller";
import type {
    AdapterCapabilities,
    BenchMethod,
    BenchProbe,
    BenchmarkConfig,
    CameraFrameInput,
    ContextState,
    ControllerDeps,
    SortAppliedProof,
    SortAudit,
    SortToken,
    ThreeWayBenchmarkAdapter,
    VisibilityState,
    WindowCounters,
} from "./bench-controller";
import type { CameraAudit, ResolutionAudit, WorkloadAudit } from "./bench-audit";

class MockClock {
    t = 0;
    now = (): number => this.t;
    advance = (ms: number): void => {
        this.t += ms;
    };
}

class MockProbe implements BenchProbe {
    pending = 0;
    private open = false;
    private scope = 0;
    private c: WindowCounters = this.fresh();

    private fresh(): WindowCounters {
        return {
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
    }
    openWindow(): void {
        this.open = true;
        this.c = this.fresh();
    }
    closeWindow(): void {
        this.open = false;
    }
    pendingSorts(): number {
        return this.pending;
    }
    beginControlledFrame(frameSerial: number): void {
        this.scope = frameSerial;
    }
    endControlledFrame(): void {
        this.scope = 0;
    }
    snapshotWindow(): WindowCounters {
        return { ...this.c, drawCallsPerFrame: [...this.c.drawCallsPerFrame] };
    }

    // ---- 模拟"非 controller 造成"的事件 ----
    draw(instances = 1): void {
        if (!this.open) return;
        this.c.drawCalls++;
        this.c.drawInstances += instances;
        if (this.scope > 0) {
            const i = this.scope - 1;
            this.c.drawCallsPerFrame[i] = (this.c.drawCallsPerFrame[i] ?? 0) + 1;
        } else {
            this.c.unexpectedDrawCalls++;
        }
    }
    rogueRafCallback(): void {
        if (!this.open) return;
        this.c.rafCalls++;
        this.c.unexpectedFrameCallbacks++;
    }
    requestSort(): void {
        this.pending++;
        if (this.open) this.c.sortRequests++;
    }
    completeSort(): void {
        if (this.pending > 0) this.pending--;
        if (this.open) this.c.sortCompleted++;
    }
    uploadIndexBuffer(): void {
        if (this.open) this.c.indexBufferUploads++;
    }
}

interface MockOpts {
    staticRenderOnly?: boolean;
    sortFreezeSupported?: boolean;
    movingSortMode?: "pipelined" | "blocking";
    /** 每帧都发新排序请求（模拟"无法禁止排序"的实现） */
    emitSortPerFrame?: boolean;
    /** 窗口内出现一次非 controller 的 draw */
    rogueDrawInWindow?: boolean;
    /** 窗口内出现一次非法 rAF 回调 */
    rogueRafInWindow?: boolean;
    frameCostMs?: number;
    /** postFinish 的 GPU 排水时间 */
    gpuDrainMs?: number;
    contextLost?: boolean;
    resolutionOverride?: Partial<ResolutionAudit>;
    /** 模拟"force=true 被实现的 dirty 启发式吞掉" ⇒ token.forced=false 且 pendingCount=1 */
    ignoreForce?: boolean;
    /** `waitForSortApplied` 的返回形态 */
    proofMode?: "full" | "incomplete" | "none" | "vendor-heuristic";
    /** 不做 draw 归因（模拟"冻结后没有 warmup draw"或 bridge 未记录 lastDraw） */
    skipDrawAudit?: boolean;
    /** 测量窗口内自己推进 activeSerial（模拟"窗口内又应用了一次排序"） */
    bumpSerialAfterFirstMeasureDraw?: boolean;
}

/** mock 相机哈希：与 renderer bridge 一样必须是"同一个实现"，这里用确定性文本哈希。 */
function mockCameraHash(view: readonly number[]): string {
    let h = 0;
    for (const v of view) h = (h * 31 + Math.round(v * 1e6)) | 0;
    return (h >>> 0).toString(16).padStart(8, "0");
}

const W = 1600;
const H = 1063;

class MockAdapter implements ThreeWayBenchmarkAdapter {
    readonly probe = new MockProbe();
    readonly capabilities: AdapterCapabilities;
    frameSerial = 0;
    renderStaticCalls = 0;
    renderPipelinedCalls = 0;
    sortFrozen = false;
    sortRequestCount = 0;
    sortRequestsWhileFrozen = 0;
    finishGpuCalls = 0;
    unfreezeCalls = 0;
    tokenCameraHash = "";
    readonly audit: SortAudit = {
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
    private drawsSeen = 0;
    resolutionSets: Array<[number, number]> = [];
    cameraSets: number[][] = [];

    constructor(
        public readonly name: BenchMethod,
        private clock: MockClock,
        private o: MockOpts = {},
    ) {
        this.capabilities = {
            staticFrameRenderOnly: o.staticRenderOnly ?? true,
            sortFreezeSupported: o.sortFreezeSupported ?? true,
            movingSortMode: o.movingSortMode ?? "pipelined",
        };
    }

    async init(): Promise<void> {}
    async loadScene(): Promise<void> {}
    async setResolution(width: number, height: number): Promise<void> {
        this.resolutionSets.push([width, height]);
    }
    async setCamera(camera: CameraFrameInput): Promise<void> {
        this.cameraSets.push([...camera.viewMatrix]);
    }
    async waitUntilReady(): Promise<void> {}
    async requestSortOnce(camera: CameraFrameInput, opts?: { force?: boolean }): Promise<SortToken> {
        this.sortRequestCount++;
        this.probe.requestSort();
        this.clock.advance(1);
        this.probe.completeSort();
        const serial = this.sortRequestCount;
        const cameraHash = mockCameraHash(camera.viewMatrix);
        this.audit.requestSerial = serial;
        this.audit.completedSerial = serial;
        this.audit.uploadedSerial = serial;
        this.audit.activeSerial = serial;
        this.audit.activeCameraHash = cameraHash;
        this.audit.pendingCount = 0;
        this.tokenCameraHash = cameraHash;
        // `ignoreForce` 模拟"force 被实现的 dirty 启发式吞掉"
        const forced = this.o.ignoreForce ? false : opts?.force === true;
        if (!forced && this.o.ignoreForce) this.audit.pendingCount = 1;
        return { serial, sortViewProjHash: cameraHash, forced, source: "mock-bridge" };
    }
    async waitForSortApplied(token: SortToken): Promise<SortAppliedProof> {
        const mode = this.o.proofMode ?? "full";
        if (mode === "none") {
            return {
                proven: false,
                serial: token.serial,
                sortViewProjHash: token.sortViewProjHash,
                completed: false,
                uploaded: false,
                activated: false,
                usedByDraw: false,
                evidence: "none",
                reason: "no-result",
            };
        }
        if (mode === "incomplete") {
            return {
                proven: false,
                serial: token.serial,
                sortViewProjHash: token.sortViewProjHash,
                completed: true,
                uploaded: false,
                activated: false,
                usedByDraw: false,
                evidence: "none",
                reason: "upload-not-observed",
            };
        }
        return {
            proven: true,
            serial: token.serial,
            sortViewProjHash: token.sortViewProjHash,
            completed: true,
            uploaded: true,
            activated: true,
            usedByDraw: false,
            evidence: mode === "vendor-heuristic" ? "vendor-equivalence-heuristic" : "renderer-bridge",
            reason: "",
        };
    }
    async freezeSortRequests(): Promise<void> {
        this.sortFrozen = true;
        this.audit.frozen = true;
    }
    async unfreezeSortRequests(): Promise<void> {
        this.sortFrozen = false;
        this.audit.frozen = false;
        this.unfreezeCalls++;
    }
    getSortAudit(): SortAudit {
        return { ...this.audit, frozen: this.sortFrozen };
    }
    async waitForWorkerQuiescence(): Promise<void> {}
    renderStaticFrame(): void {
        this.renderStaticCalls++;
        this.frameSerial++;
        if (this.o.emitSortPerFrame) {
            if (this.sortFrozen) this.sortRequestsWhileFrozen++;
            this.probe.requestSort();
            this.probe.completeSort();
        }
        this.clock.advance(this.o.frameCostMs ?? 0.5);
        this.probe.draw(610000);
        this.noteDrawUsedSort();
    }
    renderPipelinedFrame(): void {
        this.renderPipelinedCalls++;
        this.frameSerial++;
        if (this.o.emitSortPerFrame) {
            this.probe.requestSort();
            this.probe.completeSort();
        }
        this.clock.advance(this.o.frameCostMs ?? 0.5);
        this.probe.draw(610000);
        this.noteDrawUsedSort();
    }

    /** 模拟 renderer bridge 在 draw 处记录 `lastDrawSortSerial/lastDrawCameraHash`。 */
    private noteDrawUsedSort(): void {
        if (!this.o.skipDrawAudit) {
            this.audit.lastDrawSortSerial = this.audit.activeSerial;
            this.audit.lastDrawCameraHash = this.audit.activeCameraHash;
        }
        this.drawsSeen++;
        if (this.o.bumpSerialAfterFirstMeasureDraw && this.drawsSeen === 3) {
            // 模拟"窗口内又应用了一次排序"⇒ activeSerial 在窗口内变化（第 3 次 draw 已是测量帧）
            this.audit.activeSerial++;
        }
    }
    finishGpu(): void {
        this.finishGpuCalls++;
        if (this.o.rogueDrawInWindow && this.finishGpuCalls === 2) this.probe.draw(1);
        if (this.o.rogueRafInWindow && this.finishGpuCalls === 2) this.probe.rogueRafCallback();
        if (this.finishGpuCalls === 2) this.clock.advance(this.o.gpuDrainMs ?? 0);
    }
    getResolutionAudit(): ResolutionAudit {
        const base: ResolutionAudit = {
            requested: [W, H],
            canvas: [W, H],
            drawingBuffer: [W, H],
            viewport: [0, 0, W, H],
            internalFramebuffer: [W, H],
            renderScale: 1,
            adaptiveResolution: false,
            cssWidth: 400,
            cssHeight: 496,
            devicePixelRatio: 3.6,
        };
        return { ...base, ...(this.o.resolutionOverride ?? {}) };
    }
    getCameraAudit(): CameraAudit {
        return {
            viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            projectionMatrix: [0.5, 0, 0, 0, 0, -0.5, 0, 0, 0, 0, 1, 1, 0, 0, -0.1, 0],
            viewProjectionMatrix: [0.5, 0, 0, 0, 0, -0.5, 0, 0, 0, 0, 1, 1, 0, 0, -0.1, 0],
            viewMatrixSha256: "0".repeat(64),
            projectionMatrixSha256: "1".repeat(64),
            viewProjectionMatrixSha256: "2".repeat(64),
            matrixOrder: "row-major",
            viewSemantics: "world-to-camera",
            fx: 1159.5880733038064,
            fy: 1159.5880733038064,
            near: 0.1,
            far: 100,
            width: W,
            height: H,
            modelToCanonicalMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            anchorSetFile: "bench-camera/truck-anchors.json",
            anchorSetHash: "a".repeat(64),
            anchorPixels: [],
        };
    }
    getWorkloadAudit(): WorkloadAudit {
        return {
            model: {
                modelStorageBytes: 1234,
                networkTransferBytes: 1234,
                decodedBodyBytes: 1234,
                modelHash: "h",
                modelSourceUrl: "u",
                modelSourceCommit: null,
                modelDownloadDate: "2026-09-15",
                rendererSourceCommit: null,
            },
            gaussianTotal: 610000,
            gaussianVisibleMean: 610000,
            gaussianSubmittedMean: 610000,
            shDegree: null,
            drawCallsMean: 1,
            sortRequests: null,
            sortCompleted: 1,
            sortWaited: true,
            lodEnabled: false,
            cullingEnabled: false,
            adaptiveQuality: false,
        };
    }
    getContextState(): ContextState {
        return { contextLost: this.o.contextLost ?? false, rendererName: "mock", canvasWidth: W, canvasHeight: H };
    }
    getFrameSerial(): number {
        return this.frameSerial;
    }
    async dispose(): Promise<void> {}
}

function makeDeps(
    clock: MockClock,
    visibility: VisibilityState = "visible",
): { deps: ControllerDeps; events: string[]; yields: () => number } {
    const events: string[] = [];
    let yields = 0;
    return {
        events,
        yields: () => yields,
        deps: {
            now: clock.now,
            yieldToMainThread: async (): Promise<void> => {
                yields++;
                clock.advance(0.5);
            },
            logEvent: (name: string): void => {
                events.push(name);
            },
            getVisibilityState: (): VisibilityState => visibility,
        },
    };
}

const cfg = (over: Partial<BenchmarkConfig> = {}): BenchmarkConfig => ({
    warmupFrames: 5,
    measureFrames: 30,
    yieldMode: "none",
    batchSize: 10,
    width: W,
    height: H,
    cameraStatic: true,
    ...over,
});

/** 把回调排到微任务里，并以 vsync 周期（与渲染耗时无关）给出时间戳。 */
function autoRaf(
    clock: MockClock,
    frameMs: number,
): { requestFrame: (cb: (timestampMs: number) => void) => number; cancelFrame: (id: number) => void } {
    let n = 0;
    return {
        requestFrame: (cb: (timestampMs: number) => void): number => {
            const id = ++n;
            const ts = n * frameMs; // vsync 时间戳：周期性，不含渲染耗时
            void Promise.resolve().then(() => {
                clock.advance(frameMs);
                cb(ts);
            });
            return id;
        },
        cancelFrame: (): void => {},
    };
}

describe("主协议：事件顺序与计时", () => {
    it("1/2) preFinish 在 t0 之前；postFinish 在 t1 之前", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock);
        const { deps, events } = makeDeps(clock);
        await runSyncedThroughput(a, deps, { config: cfg() });
        const iFinishStart = events.indexOf("finish-start");
        const iT0 = events.indexOf("t0");
        const iFinishEnd = events.indexOf("finish-end-return");
        const iT1 = events.indexOf("t1");
        expect(iFinishStart).toBeGreaterThanOrEqual(0);
        expect(iFinishStart).toBeLessThan(iT0);
        expect(iFinishEnd).toBeLessThan(iT1);
        expect(events.indexOf("last-submit")).toBeLessThan(iFinishEnd);
    });

    it("3) 结束 finish 的排水计入 elapsed（totalSyncedMs = submitPhase + drainPhase）", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { gpuDrainMs: 40, frameCostMs: 1 });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 10, warmupFrames: 0 }) });
        expect(r.drainPhaseMs).toBeCloseTo(40, 6);
        expect(r.submitPhaseMs).toBeCloseTo(10, 6);
        expect(r.totalSyncedMs).toBeCloseTo(50, 6);
        expect(r.totalSyncedMs).toBeCloseTo(r.submitPhaseMs + r.drainPhaseMs, 9);
        expect(r.fps).toBeCloseTo((10 * 1000) / 50, 6);
    });

    it("6/7) yieldMode=none ⇒ 一次也不 yield（且无 timer/rAF 调度）", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock);
        const { deps, yields } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg({ yieldMode: "none" }) });
        expect(yields()).toBe(0);
        expect(r.yieldCount).toBe(0);
        expect(r.timerSchedulesDuringMeasure).toBe(0);
        expect(r.rafCallsDuringMeasure).toBe(0);
    });

    it("7) yieldMode=messagechannel + batch=10、N=30 ⇒ yield 两次（让出时间计入 elapsed）", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock);
        const { deps, yields } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, {
            config: cfg({ yieldMode: "messagechannel", batchSize: 10, measureFrames: 30 }),
        });
        expect(r.yieldCount).toBe(2);
        expect(yields()).toBe(2);
        expect(r.totalSyncedMs).toBeGreaterThan(30 * 0.5);
    });
});

describe("帧计数与 draw 作用域归因", () => {
    it("4) controllerRenderCalls 与 adapterFrameDelta 都等于 N（batch 1/10/30）", async () => {
        for (const batchSize of [1, 10, 30]) {
            const clock = new MockClock();
            const a = new MockAdapter("ours", clock);
            const { deps } = makeDeps(clock);
            const r = await runSyncedThroughput(a, deps, {
                config: cfg({ measureFrames: 30, yieldMode: "messagechannel", batchSize }),
            });
            expect(r.controllerRenderCalls).toBe(30);
            expect(r.adapterFrameDelta).toBe(30);
            expect(r.valid).toBe(true);
        }
    });

    it("条件 4) controlled frame 内的多个 draw 不算 unexpected；scope 外的 draw 才算", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { rogueDrawInWindow: true });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 5, warmupFrames: 2 }) });
        expect(r.drawCallsDuringMeasure).toBe(6); // 5 帧各 1 次 + 1 次越权
        expect(r.drawCallsPerFrame.filter((c) => c === 1)).toHaveLength(5);
        expect(r.unexpectedDrawCalls).toBe(1);
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toBe("unexpected-draw");
    });

    it("5) 三个 adapter 用同一个 controller（事件序列结构一致）", async () => {
        const names: BenchMethod[] = ["ours", "flux-gs", "reduced-3dgs"];
        const logs: string[][] = [];
        for (const n of names) {
            const clock = new MockClock();
            const a = new MockAdapter(n, clock);
            const { deps, events } = makeDeps(clock);
            const r = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 4, warmupFrames: 2 }) });
            expect(r.method).toBe(n);
            expect(r.controllerRenderCalls).toBe(4);
            logs.push(events.filter((e) => e !== "last-submit" && e !== "t1"));
        }
        expect(logs[1]).toEqual(logs[0]);
        expect(logs[2]).toEqual(logs[0]);
    });
});

describe("排序队列（条件 1）", () => {
    it("render-only：窗口内无排序/索引活动、边界 pending=0 ⇒ valid，协议 = static-render-only", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock);
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg() });
        expect(r.protocol).toBe(PROTOCOL_STATIC_RENDER_ONLY);
        expect(r.sortFrozenBeforeWarmup).toBe(true);
        expect(r.sortRequestsDuringMeasure).toBe(0);
        expect(r.sortCompletedDuringMeasure).toBe(0);
        expect(r.indexBufferUploadsDuringMeasure).toBe(0);
        expect(r.pendingSortsAtStart).toBe(0);
        expect(r.pendingSortsAtEnd).toBe(0);
        expect(r.valid).toBe(true);
    });

    it("无法冻结排序（sortFreezeSupported=false 且每帧发排序）⇒ 降级命名 full-frame，并如实报告", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { emitSortPerFrame: true, sortFreezeSupported: false });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 5, warmupFrames: 0 }) });
        expect(r.protocol).toBe(PROTOCOL_STATIC_FULL_FRAME);
        expect(r.sortRequestsDuringMeasure).toBeGreaterThan(0);
        expect(r.valid).toBe(true); // full-frame 协议不要求排序为 0
    });

    it("只绘制入口不可用（staticFrameRenderOnly=false）⇒ full-frame 协议 + 报告排序活动", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { staticRenderOnly: false, emitSortPerFrame: true });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 5, warmupFrames: 0 }) });
        expect(r.protocol).toBe(PROTOCOL_STATIC_FULL_FRAME);
        expect(r.sortRequestsDuringMeasure).toBe(5);
        expect(r.valid).toBe(true);
    });

    it("声称 render-only 但窗口内仍出现排序活动 ⇒ invalid = sort-activity-during-measure", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { sortFreezeSupported: true });
        const orig = a.renderStaticFrame.bind(a);
        let calls = 0;
        a.renderStaticFrame = (): void => {
            calls++;
            if (calls === 3) a.probe.requestSort(); // 模拟"冻结没生效"（第 1 次是 warmup，之后才是测量窗口）
            orig();
        };
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 5, warmupFrames: 1 }) });
        expect(r.protocol).toBe(PROTOCOL_STATIC_RENDER_ONLY);
        expect(r.sortRequestsDuringMeasure).toBeGreaterThan(0);
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toBe("sort-activity-during-measure");
    });
});

describe("无效条件", () => {
    it("8) 页面隐藏 ⇒ invalid = hidden", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock);
        const { deps } = makeDeps(clock, "hidden");
        const r = await runSyncedThroughput(a, deps, { config: cfg() });
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toBe("hidden(hidden)");
    });

    it("9) context lost ⇒ invalid = context-lost", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { contextLost: true });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg() });
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toBe("context-lost");
    });

    it("10) 分辨率不一致 ⇒ invalid = resolution-mismatch:…", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { resolutionOverride: { drawingBuffer: [1599, 1063] } });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg() });
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toContain("resolution-mismatch:");
        expect(r.invalidReason).toContain("drawingBuffer");
    });

    it("12) 窗口内出现非法 rAF 回调 ⇒ invalid = unexpected-frame-callback", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { rogueRafInWindow: true });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg() });
        expect(r.unexpectedFrameCallbacks).toBe(1);
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toBe("unexpected-frame-callback");
    });

    it("异常 ⇒ invalid = exception:…（仍返回结果对象，不抛出）", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock);
        a.renderStaticFrame = (): void => {
            throw new Error("boom");
        };
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg() });
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toContain("exception:boom");
    });
});

describe("动态相机协议（单列，不与静态混称）", () => {
    const view0 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const view1 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1];

    it("给出 cameraTrace ⇒ moving-camera-pipelined-throughput，每帧用 renderPipelinedFrame", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { movingSortMode: "pipelined" });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, {
            config: cfg({ measureFrames: 4, warmupFrames: 0 }),
            cameraTrace: [
                { viewMatrix: view0, fx: 1159.588, fy: 1159.588 },
                { viewMatrix: view1, fx: 1159.588, fy: 1159.588 },
            ],
        });
        expect(r.protocol).toBe(PROTOCOL_MOVING_PIPELINED);
        expect(a.renderPipelinedCalls).toBe(4);
        expect(a.renderStaticCalls).toBe(0);
        expect(r.controllerRenderCalls).toBe(4);
        expect(r.sortFrozenBeforeWarmup).toBe(false); // 静态的"冻结排序"在 moving 路径不适用
    });

    it("blocking 实现 ⇒ 协议名 moving-camera-blocking-throughput", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { movingSortMode: "blocking" });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, {
            config: cfg({ measureFrames: 2, warmupFrames: 0 }),
            cameraTrace: [{ viewMatrix: view0, fx: 1159.588, fy: 1159.588 }],
        });
        expect(r.protocol).toBe("moving-camera-blocking-throughput");
    });
});

describe("指标 B（presentation-raf-v1）", () => {
    it("注入的 rAF 驱动：输出 mean fps / 分位数 / dropped / vsyncCapped", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock);
        const { deps } = makeDeps(clock);
        const r = await runRafPresentation(a, deps, { warmupFrames: 3, measureFrames: 8 }, autoRaf(clock, 16.7));
        expect(r.protocol).toBe(PROTOCOL_RAF);
        expect(r.renderedFrames).toBe(8);
        expect(r.medianFrameMs).toBeCloseTo(16.7, 6);
        expect(r.meanFps).toBeCloseTo((8 * 1000) / (8 * 16.7), 3);
        expect(r.p95FrameMs).toBeCloseTo(16.7, 6);
        expect(r.droppedFrames).toBe(0);
        expect(r.vsyncCapped).toBe(true);
        expect(r.screenRefreshHz).toBeCloseTo(1000 / 16.7, 3);
        expect(r.valid).toBe(true);
    });

    it("隐藏页面 ⇒ 指标 B 同样判无效", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock);
        const { deps } = makeDeps(clock, "hidden");
        const r = await runRafPresentation(a, deps, { warmupFrames: 1, measureFrames: 3 }, autoRaf(clock, 16.7));
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toBe("hidden(hidden)");
    });
});

describe("轮次平衡与聚合（条件 5）", () => {
    const key = (p: BenchMethod[]): string => p.join(">");

    it("rounds=12 ⇒ 六种排列各两次；rounds=7 ⇒ 六种 + 1 随机（rng 可注入）", () => {
        const o12 = buildRoundOrder(MAIN_TABLE_ROUNDS);
        expect(o12).toHaveLength(12);
        const counts = new Map<string, number>();
        for (const p of o12) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
        expect(counts.size).toBe(6);
        for (const c of counts.values()) expect(c).toBe(2);

        const o7 = buildRoundOrder(PRELIM_ROUNDS, () => 0);
        expect(o7).toHaveLength(7);
        expect(key(o7[6])).toBe(key(METHOD_PERMUTATIONS[0]));
    });

    it("aggregate：无效轮被剔除；热漂移 ⇒ excluded=thermal-drift", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock);
        const { deps } = makeDeps(clock);
        const valid = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 4, warmupFrames: 2 }) });
        const invalid = { ...valid, valid: false, invalidReason: "hidden(hidden)" };
        const agg = aggregateSyncedRounds([valid, invalid]);
        expect(agg.validRounds).toBe(1);
        expect(agg.totalRounds).toBe(2);
        expect(agg.invalidReasons).toContain("hidden(hidden)");
        expect(agg.excluded).toBe(false);

        const fps = (v: number): typeof valid => ({ ...valid, fps: v });
        const drifted = aggregateSyncedRounds([fps(100), fps(100), fps(89), fps(88)]);
        expect(drifted.thermal.thermalDrift).toBe(true);
        expect(drifted.excluded).toBe(true);
        expect(drifted.excludeReason).toBe("thermal-drift");
    });

    it("sceneCanEnterMainTable：需三方各 12 个有效轮 + 无热漂移 + 锚点/跨臂一致", () => {
        const synth = (method: BenchMethod, values: number[]) =>
            aggregateSyncedRounds(values.map((v) => ({ method, valid: true, fps: v, invalidReason: null })) as never);
        const stable = Array.from({ length: MAIN_TABLE_ROUNDS }, () => 100);
        const aggs = [synth("ours", stable), synth("flux-gs", stable), synth("reduced-3dgs", stable)];
        expect(sceneCanEnterMainTable({ anchorsShared: true, crossJudgments: [true, true], aggregates: aggs })).toEqual(
            {
                ok: true,
                reasons: [],
            },
        );

        const few = Array.from({ length: 6 }, () => 100);
        const bad = sceneCanEnterMainTable({
            anchorsShared: false,
            crossJudgments: [true, false],
            aggregates: [synth("ours", few), ...aggs.slice(1)],
        });
        expect(bad.ok).toBe(false);
        expect(bad.reasons).toContain("anchor-set-not-shared");
        expect(bad.reasons).toContain("cross-arm-mismatch");
        expect(bad.reasons.some((r) => r.startsWith("ours:valid-rounds-6/12"))).toBe(true);
    });
});

describe("排序证明（阶段 7A 新增强制约束）", () => {
    it("正常路径：force token + 四项证明 + warmup draw 归因 + 冻结 + pendingCount=0", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock);
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 10, warmupFrames: 2 }) });
        expect(r.valid).toBe(true);
        expect(r.sortToken?.forced).toBe(true);
        expect(r.sortAppliedProof?.evidence).toBe("renderer-bridge");
        expect(r.sortAppliedProof?.completed).toBe(true);
        expect(r.sortAppliedProof?.uploaded).toBe(true);
        expect(r.sortAppliedProof?.activated).toBe(true);
        expect(r.sortWarmupDrawVerified).toBe(true);
        expect(r.sortAuditAtStart?.frozen).toBe(true);
        expect(r.sortAuditAtStart?.pendingCount).toBe(0);
        expect(r.sortAuditAtEnd?.activeSerial).toBe(r.sortAuditAtStart?.activeSerial);
        expect(a.unfreezeCalls).toBe(1); // 轮末必须解冻
        expect(a.getSortAudit().frozen).toBe(false);
    });

    it("force 被实现吞掉（token.forced=false）⇒ invalid = sort-not-forced", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { ignoreForce: true });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 5, warmupFrames: 2 }) });
        expect(r.sortToken?.forced).toBe(false);
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toBe("sort-not-forced");
    });

    it("证明缺 uploaded/activated ⇒ invalid = sort-not-proven", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { proofMode: "incomplete" });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 5, warmupFrames: 2 }) });
        expect(r.sortAppliedProof?.uploaded).toBe(false);
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toBe("sort-not-proven");
    });

    it("vendor 启发式（equivalent-camera-no-new-sort）不得作为主表证明", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { proofMode: "vendor-heuristic" });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 5, warmupFrames: 2 }) });
        expect(r.sortAppliedProof?.evidence).toBe("vendor-equivalence-heuristic");
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toBe("sort-proof-heuristic-not-accepted");
    });

    it("冻结后的 warmup draw 未证明 lastDraw 归因 ⇒ invalid = warmup-draw-not-verified", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { skipDrawAudit: true });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 5, warmupFrames: 2 }) });
        expect(r.sortWarmupDrawVerified).toBe(false);
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toBe("warmup-draw-not-verified");
    });

    it("窗口内 activeSerial 变化 ⇒ invalid = active-sort-changed", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock, { bumpSerialAfterFirstMeasureDraw: true });
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 5, warmupFrames: 2 }) });
        expect(r.sortAuditAtEnd?.activeSerial).not.toBe(r.sortAuditAtStart?.activeSerial);
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toBe("active-sort-changed");
    });

    it("静态协议下 warmupFrames=0 ⇒ invalid = warmup-frames-too-few-for-sort-proof", async () => {
        const clock = new MockClock();
        const a = new MockAdapter("ours", clock);
        const { deps } = makeDeps(clock);
        const r = await runSyncedThroughput(a, deps, { config: cfg({ measureFrames: 5, warmupFrames: 0 }) });
        expect(r.valid).toBe(false);
        expect(r.invalidReason).toBe("warmup-frames-too-few-for-sort-proof");
    });
});

describe("源码守卫（纯逻辑约束）", () => {
    const src = readFileSync(fileURLToPath(new URL("./bench-controller.ts", import.meta.url)), "utf-8");

    it("controller 不得自带 DOM / 定时器 / rAF（全部经 deps 注入）", () => {
        expect(src).not.toMatch(/setTimeout\s*\(/);
        expect(src).not.toMatch(/requestAnimationFrame\s*\(/);
        expect(src).not.toMatch(/document\./);
        expect(src).not.toMatch(/window\./);
        expect(src).not.toMatch(/innerHTML/);
    });

    it("controller 不得 import ./src（渲染器）", () => {
        expect(src).not.toMatch(/from "\.\/src/);
    });
});
