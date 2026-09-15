/** 阶段 8A 精简单测：CaseSlaveAdapter（共享）+ Flux 未实现占位。 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
    CaseSlaveAdapter,
    FLUX_ADAPTER_NOT_IMPLEMENTED,
    createOursAdapter,
    createReduced3dgsAdapter,
    createUnimplementedAdapter,
} from "./bench-adapters";
import type { CaseSlaveAdapterConfig, IframeSlaveHandle, ProbeBinder } from "./bench-adapters";
import { runSyncedThroughput } from "./bench-controller";
import type { BenchmarkConfig } from "./bench-controller";
import type { ResolutionAudit } from "./bench-audit";
import type { CaseSlaveApi } from "./bench-case-slave";
import { BENCH_FOCAL_PX, BENCH_HEIGHT, BENCH_WIDTH } from "./bench-constants";

const W = BENCH_WIDTH;
const H = BENCH_HEIGHT;

function resAudit(c: [number, number] = [W, H]): ResolutionAudit {
    return {
        requested: [W, H],
        canvas: c,
        drawingBuffer: c,
        viewport: [0, 0, c[0], c[1]],
        internalFramebuffer: c,
        renderScale: 1,
        adaptiveResolution: false,
        cssWidth: 400,
        cssHeight: 496,
        devicePixelRatio: 3.6,
    };
}

function makeFakeSlave(): { api: CaseSlaveApi; calls: string[]; s: Record<string, unknown> } {
    const calls: string[] = [];
    const s: Record<string, unknown> = {
        frozen: false,
        serial: 0,
        lastDrawSerial: 0,
        hash: "aaaa1111",
        resolution: resAudit(),
        resolutionAtEnd: null,
        warmupMissing: false,
        frameSerial: 0,
    };
    const api: Record<string, unknown> = {
        setResolution: () => {
            calls.push("setResolution");
            return s.resolution;
        },
        setCamera: () => {
            calls.push("setCamera");
            return {};
        },
        requestSortOnce: async () => {
            calls.push("requestSortOnce");
            s.serial = (s.serial as number) + 1;
            return { serial: s.serial, sortViewProjHash: s.hash, forced: true, source: "fake" };
        },
        waitForSortApplied: async () => {
            calls.push("waitForSortApplied");
            return {
                proven: true,
                serial: s.serial,
                sortViewProjHash: s.hash,
                completed: true,
                uploaded: true,
                activated: true,
                usedByDraw: false,
                evidence: "renderer-bridge",
                reason: "",
            };
        },
        freezeSortRequests: () => {
            calls.push("freeze");
            s.frozen = true;
        },
        unfreezeSortRequests: () => {
            calls.push("unfreeze");
            s.frozen = false;
        },
        renderStaticFrame: () => {
            calls.push("renderStaticFrame");
            s.frameSerial = (s.frameSerial as number) + 1;
            if (s.frozen) s.lastDrawSerial = s.serial;
        },
        renderPipelinedFrame: () => {
            calls.push("renderPipelinedFrame");
        },
        finishGpu: () => {
            calls.push("finishGpu");
        },
        getSortAudit: () => (
            calls.push("read:sortAudit"),
            {
                requestSerial: s.serial,
                completedSerial: s.serial,
                uploadedSerial: s.serial,
                activeSerial: s.serial,
                pendingCount: 0,
                frozen: s.frozen,
                outOfOrderResults: 0,
                activeCameraHash: s.hash,
                lastDrawSortSerial: s.lastDrawSerial,
                lastDrawCameraHash: s.hash,
            }
        ),
        getResolutionAudit: () => s.resolution,
        getCameraAudit: () => ({}),
        getWorkloadAudit: () => ({ model: {} }),
        getContextState: () => ({ contextLost: false, rendererName: "fake", canvasWidth: W, canvasHeight: H }),
        getFrameSerial: () => (calls.push("read:frameSerial"), s.frameSerial),
        getCanvas: () => ({ width: W, height: H }),
        getSortWorker: () => ({}) as unknown as Worker,
        dispose: async () => {
            calls.push("slave.dispose");
        },
        ensureFirstFrame: () => {
            calls.push("ensureFirstFrame");
            return {};
        },
        ensureFirstFrameReport: () => ({
            frameSerialBeforeEnsure: 0,
            frameSerialAfterEnsure: 1,
            drawCallsDuringEnsure: 1,
            drawInstancesDuringEnsure: 0,
            sortWorkerBeforeEnsure: false,
            sortWorkerAfterEnsure: true,
        }),
        beginMeasureWindow: () => {
            calls.push("beginMeasureWindow");
        },
        endMeasureWindow: () => {
            calls.push("endMeasureWindow");
            const start = s.resolution as ResolutionAudit;
            const end = (s.resolutionAtEnd as ResolutionAudit | null) ?? start;
            const changed = start.canvas.join() !== end.canvas.join();
            return {
                resolutionAtStart: start,
                resolutionAtEnd: end,
                resolutionChanged: changed,
                invalidReason: changed ? "resolution-changed-during-measure" : "",
                frameSerialAtStart: 0,
                frameSerialAtEnd: s.frameSerial,
                sortAuditAtStart: (api.getSortAudit as () => unknown)(),
                sortAuditAtEnd: (api.getSortAudit as () => unknown)(),
                activeSortSerialChanged: false,
                lastDrawSortSerialChanged: false,
                warmupDrawMissingAtWindowStart: s.warmupMissing,
            };
        },
        getMeasureWindowAudit: () => null,
        eventLog: () => calls,
        probeAuthority: () => ({ sortAuditAuthority: "renderer-bridge" }),
        probe: {
            openWindow: () => {},
            closeWindow: () => {},
            pendingSorts: () => 0,
            beginControlledFrame: () => {},
            endControlledFrame: () => {},
            snapshotWindow: () => ({
                sortRequests: 0,
                sortCompleted: 0,
                indexBufferUploads: 0,
                drawCalls: 1,
                drawInstances: 1,
                drawCallsPerFrame: [1],
                unexpectedDrawCalls: 0,
                unexpectedFrameCallbacks: 0,
                rafCalls: 0,
                timerSchedules: 0,
            }),
        },
    };
    return { api: api as unknown as CaseSlaveApi, calls, s };
}

// ------------------------------------------------------------------ 测试夹具
function makeAdapter(over: Partial<CaseSlaveAdapterConfig> = {}): {
    adapter: CaseSlaveAdapter;
    calls: string[];
    s: Record<string, unknown>;
    probeDetach: () => void;
    removed: () => number;
} {
    const fake = makeFakeSlave();
    let removeCalls = 0;
    const probeDetach = vi.fn((): void => {
        fake.calls.push("probe.detach");
    });
    const probe: ProbeBinder = {
        bindSortWorker: (): void => {
            fake.calls.push("probe.bindSortWorker");
        },
        detach: probeDetach,
        getAuthority: (): unknown => ({ sortAuditAuthority: "renderer-bridge" }),
    };
    const handle: IframeSlaveHandle = {
        contentWindow: { __CASE_BENCH__: fake.api },
        remove: (): void => {
            removeCalls++;
            fake.calls.push("iframe.remove");
        },
    };
    const adapter = new CaseSlaveAdapter({
        name: "ours",
        scene: { id: "truck", dataset: "tnt", modelUrl: "m.ply", iframeUrl: "bench-case.html?slave=1" },
        modelSource: {
            modelStorageBytes: 1,
            networkTransferBytes: 2,
            decodedBodyBytes: 3,
            modelHash: "h",
            modelSourceUrl: "u",
            modelSourceCommit: null,
            modelDownloadDate: "2026-09-15",
            rendererSourceCommit: "c",
        },
        createIframe: (): IframeSlaveHandle => handle,
        waitForSlave: async (): Promise<CaseSlaveApi> => fake.api,
        probe,
        sleep: async (): Promise<void> => {},
        log: (): void => {},
        ...over,
    });
    return { adapter, calls: fake.calls, s: fake.s, probeDetach, removed: (): number => removeCalls };
}

const cfg = (): BenchmarkConfig => ({
    warmupFrames: 1,
    measureFrames: 5,
    yieldMode: "none",
    batchSize: 1,
    width: W,
    height: H,
    cameraStatic: true,
});

describe("阶段 8A：CaseSlaveAdapter（Ours/Reduced 共享）", () => {
    it("1) 只转发：init 建 iframe + 等 slave + bindSortWorker；不自己生成 serial/hash、不算 FPS、不调度", async () => {
        const { adapter, calls } = makeAdapter();
        await adapter.init(cfg());
        expect(calls).toContain("ensureFirstFrame");
        expect(calls).toContain("probe.bindSortWorker");
        const src = readFileSync(fileURLToPath(new URL("./bench-adapters.ts", import.meta.url)), "utf-8");
        const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
        expect(code).not.toMatch(/requestAnimationFrame|setInterval/); // 无自驱 rAF/timer 循环
        expect(code).not.toMatch(/sortCameraHash|sha256|createHash/); // 不生成 hash
        expect(code).not.toMatch(/batchSize|yieldToMainThread|yieldMode/); // 无 batch/yield
        expect(code).not.toMatch(/fps|FPS/); // 不算 FPS
    });

    it("2) 冻结后第一次 static draw 才算 warmup：draw 之后才 openMeasureWindow", async () => {
        const { adapter, calls } = makeAdapter();
        await adapter.init(cfg());
        await adapter.freezeSortRequests();
        adapter.renderStaticFrame();
        const iDraw = calls.indexOf("renderStaticFrame");
        const iOpen = calls.indexOf("beginMeasureWindow");
        expect(iDraw).toBeGreaterThanOrEqual(0);
        expect(iOpen).toBe(iDraw + 1); // 顺序：draw → open（不是先开后画）
    });

    it("3) 模型来源元数据由 adapter 补齐（分开字段，无 modelBytes）", async () => {
        const { adapter } = makeAdapter();
        await adapter.init(cfg());
        const w = adapter.getWorkloadAudit();
        expect(w.model.modelStorageBytes).toBe(1);
        expect(w.model.networkTransferBytes).toBe(2);
        expect(w.model.decodedBodyBytes).toBe(3);
        expect(w.model.modelHash).toBe("h");
        expect(Object.keys(w.model)).not.toContain("modelBytes");
    });

    it("4) dispose：unfreeze → probe.detach → slave.dispose → iframe.remove；幂等；异常路径也执行", async () => {
        const { adapter, calls, probeDetach, removed } = makeAdapter();
        await adapter.init(cfg());
        await adapter.freezeSortRequests();
        await expect(
            adapter.runRound(async () => {
                throw new Error("finish 抛错 / 排序超时");
            }),
        ).rejects.toThrow(/finish 抛错/);
        expect(probeDetach).toHaveBeenCalledTimes(1);
        expect(calls).toContain("unfreeze");
        expect(calls).toContain("slave.dispose");
        expect(removed()).toBe(1);
        await adapter.dispose();
        await adapter.dispose();
        expect(removed()).toBe(1); // 幂等
        expect(probeDetach).toHaveBeenCalledTimes(1);
    });

    it("5) 两臂工厂共用同一实现，只差 name", async () => {
        const deps = {
            createIframe: (): IframeSlaveHandle => ({
                contentWindow: { __CASE_BENCH__: makeFakeSlave().api },
                remove: (): void => {},
            }),
            waitForSlave: async (h: IframeSlaveHandle): Promise<CaseSlaveApi> =>
                h.contentWindow?.__CASE_BENCH__ as CaseSlaveApi,
            probe: { bindSortWorker: (): void => {}, detach: (): void => {}, getAuthority: (): unknown => null },
            sleep: async (): Promise<void> => {},
        };
        const profile = {
            name: "ours" as const,
            sceneId: "truck",
            dataset: "tnt",
            modelUrl: "a.ply",
            iframeUrl: "x?slave=1",
            modelSource: {} as never,
        };
        const ours = createOursAdapter(profile, deps);
        const reduced = createReduced3dgsAdapter({ ...profile, modelUrl: "b.ply" }, deps);
        expect(ours).toBeInstanceOf(CaseSlaveAdapter);
        expect(reduced).toBeInstanceOf(CaseSlaveAdapter);
        expect(ours.name).toBe("ours");
        expect(reduced.name).toBe("reduced-3dgs");
        expect(ours.capabilities.staticFrameRenderOnly).toBe(true);
        describe("阶段 8A：Flux 明确未实现 + controller 分辨率守卫", () => {
            it("6) Flux 占位：controller 直接判 invalid=adapter-not-implemented（不降级运行）", async () => {
                const flux = createUnimplementedAdapter("flux-gs", FLUX_ADAPTER_NOT_IMPLEMENTED);
                expect(flux.unimplementedReason).toContain("阶段 6");
                const r = await runSyncedThroughput(
                    flux,
                    {
                        now: () => 0,
                        yieldToMainThread: async (): Promise<void> => {},
                        logEvent: (): void => {},
                        getVisibilityState: (): "visible" => "visible",
                    },
                    { config: cfg() },
                );
                expect(r.valid).toBe(false);
                expect(r.invalidReason).toBe("adapter-not-implemented");
                expect(r.controllerRenderCalls).toBe(0); // 一步都没执行
                expect(r.eventLog.some((e) => e.startsWith("adapter-not-implemented"))).toBe(true);
            });

            it("7) 测量窗口内分辨率四项被改动 ⇒ controller 判 invalid=resolution-changed-during-measure", async () => {
                const { adapter, s } = makeAdapter();
                await adapter.init(cfg());
                // 模拟"窗口内 canvas.width 被改小"：endMeasureWindow 读到的 canvas 与基线不同
                s.resolutionAtEnd = resAudit([800, 531]);
                const audit = adapter.getMeasureWindowAudit();
                expect(audit?.resolutionChanged).toBe(true);
                expect(audit?.invalidReason).toBe("resolution-changed-during-measure");
            });

            it("8) adapter 汇报的窗口审计为 true 时 controller 必须拒绝（消费 CaseMeasureWindowAudit）", async () => {
                const { adapter } = makeAdapter({
                    // 直接注入"窗口审计已失败"的 slave：endMeasureWindow 返回 resolutionChanged=true
                    waitForSlave: async (): Promise<CaseSlaveApi> => {
                        const f = makeFakeSlave();
                        f.s.resolutionAtEnd = resAudit([800, 531]);
                        return f.api;
                    },
                });
                await adapter.init(cfg());
                const audit = adapter.getMeasureWindowAudit();
                expect(audit?.resolutionChanged).toBe(true);
                // controller 侧的消费点：AdapterMeasureWindowAudit.resolutionChanged ⇒ invalid
                const r = await runSyncedThroughput(
                    adapter,
                    {
                        now: () => 0,
                        yieldToMainThread: async (): Promise<void> => {},
                        logEvent: (): void => {},
                        getVisibilityState: (): "visible" => "visible",
                    },
                    { config: cfg() },
                );
                expect(r.valid).toBe(false);
                expect(["resolution-changed-during-measure", "warmup-draw-not-verified", "sort-not-forced"]).toContain(
                    r.invalidReason ?? "",
                );
            });
        });
    });
});

describe("阶段 8A 补充：AdapterDisposeAudit（清理语义分离）", () => {
    it("9) 先保存最终审计（移除 iframe 之前），再 unfreeze/detach/slave.dispose/iframe.remove", async () => {
        const { adapter, calls, s, probeDetach, removed } = makeAdapter();
        await adapter.init(cfg());
        const token = await adapter.requestSortOnce(
            { viewMatrix: new Array(16).fill(0), fx: BENCH_FOCAL_PX, fy: BENCH_FOCAL_PX },
            { force: true },
        );
        await adapter.freezeSortRequests();
        adapter.renderStaticFrame();

        await adapter.dispose();
        const audit = adapter.getDisposeAudit();

        // ① 审计在移除 iframe **之前**取到（finalSortAudit 已包含该 serial 的 lastDraw）
        expect(audit).not.toBeNull();
        expect(audit?.finalSortAudit.lastDrawSortSerial).toBe(token.serial);
        expect(audit?.finalFrameSerial).toBe(s.frameSerial);
        // ② 清理步骤全部完成
        expect(audit?.unfrozenBeforeDispose).toBe(true);
        expect(audit?.probeDetached).toBe(true);
        expect(audit?.slaveDisposeCalled).toBe(true);
        expect(audit?.iframeRemoved).toBe(true); // ← 只有 adapter 能证明 iframe 被移除
        expect(probeDetach).toHaveBeenCalledTimes(1);
        expect(removed()).toBe(1);
        // ③ 顺序：审计读取发生在 slave.dispose 与 iframe.remove 之前
        expect(calls.indexOf("read:sortAudit")).toBeLessThan(calls.indexOf("slave.dispose"));
        expect(calls.indexOf("read:frameSerial")).toBeLessThan(calls.indexOf("slave.dispose"));
        expect(calls.indexOf("slave.dispose")).toBeLessThan(calls.indexOf("iframe.remove"));
        // ④ 移除之后不得再持有 slave（禁止再调用其 getter）
        expect(adapter.slaveApi).toBeNull();
        // ⑤ 幂等：重复 dispose 不重复移除、不改变审计
        await adapter.dispose();
        await adapter.dispose();
        expect(removed()).toBe(1);
        expect(probeDetach).toHaveBeenCalledTimes(1);
        expect(adapter.getDisposeAudit()).toEqual(audit);
    });
});
