/**
 * bench-three-way.test.ts — 三臂入口**行为测试**（纯逻辑；不创建 DOM/iframe/WebGL）。
 * 覆盖：参数解析与拒绝、五计数器门槛、能力降级、帧数不匹配、context-lost 立即停止、
 *      轮次记录保留 u/method/round/顺序、Adapter 必然 dispose。
 *
 * 说明：`SyncedRoundResult` 用**测试替身**构造（只填 gate 实际读取的字段），
 * 因此这里断言的是**入口判定逻辑**，而非 controller 内部实现。
 */
import { describe, expect, it } from "vitest";
import {
    PARAM_LIMITS,
    THREE_WAY_METHODS,
    buildProjectionRowMajor,
    evaluateRoundGate,
    parseThreeWayParams,
    readSceneEntries,
    roundPermutations,
    runThreeWayPlan,
} from "./bench-three-way";
import type { CapabilitySnapshot, ThreeWayRunConfig } from "./bench-three-way";
import { PROTOCOL_STATIC_FULL_FRAME, PROTOCOL_STATIC_RENDER_ONLY } from "./bench-controller";
import type { BenchmarkConfig, ControllerDeps, SyncedRoundResult, ThreeWayBenchmarkAdapter } from "./bench-controller";

const OK_CAP: CapabilitySnapshot = { staticFrameRenderOnly: true, sortFreezeSupported: true };
const PARSE_OK = (search: string): ThreeWayRunConfig => {
    const r = parseThreeWayParams(search);
    if (!r.ok) throw new Error(`期望解析成功，实际失败：${r.error}`);
    return r.config;
};

const CTRL_DEPS: ControllerDeps = {
    now: () => 0,
    yieldToMainThread: async (): Promise<void> => {},
    logEvent: () => {},
    getVisibilityState: () => "visible",
};

/** 只填 gate 读取字段的测试替身。 */
function mkResult(over: Partial<Record<string, unknown>> = {}, cfg?: ThreeWayRunConfig): SyncedRoundResult {
    const w = cfg?.width ?? 1600;
    const h = cfg?.height ?? 1063;
    const base = {
        valid: true,
        invalidReason: null,
        sortRequestsDuringMeasure: 0,
        sortCompletedDuringMeasure: 0,
        indexBufferUploadsDuringMeasure: 0,
        pendingSortsAtStart: 0,
        pendingSortsAtEnd: 0,
        controllerRenderCalls: 300,
        adapterFrameDelta: 300,
        unexpectedDrawCalls: 0,
        unexpectedFrameCallbacks: 0,
        rafCallsDuringMeasure: 0,
        timerSchedulesDuringMeasure: 0,
        contextLost: false,
        visibilityState: "visible",
        sortFrozenBeforeWarmup: true,
        sortWarmupDrawVerified: true,
        sortToken: { serial: 1, sortViewProjHash: "v1", forced: true, source: "test" },
        sortAppliedProof: { proven: true },
        resolution: {
            requested: [w, h],
            canvas: [w, h],
            drawingBuffer: [w, h],
            viewport: [0, 0, w, h],
            internalFramebuffer: [w, h],
            renderScale: 1,
            adaptiveResolution: false,
            cssWidth: w,
            cssHeight: h,
            devicePixelRatio: 1,
        },
        camera: { viewMatrixSha256: "vm", projectionMatrixSha256: "pm" },
        workload: { gaussianTotal: 100000 },
        measureWindowAudit: {
            resolutionChanged: false,
            invalidReason: "",
            activeSortSerialChanged: false,
            lastDrawSortSerialChanged: false,
            warmupDrawMissingAtWindowStart: false,
        },
        fps: 60,
        completedFrames: 300,
        eventLog: [],
    };
    return { ...base, ...over } as unknown as SyncedRoundResult;
}

function fakeAdapter(): { adapter: ThreeWayBenchmarkAdapter; disposed: () => number } {
    let disposed = 0;
    const adapter = {
        name: "flux-gs",
        capabilities: { staticFrameRenderOnly: true, sortFreezeSupported: true, movingSortMode: "pipelined" },
        probe: {
            openWindow: () => {},
            closeWindow: () => {},
            pendingSorts: () => 0,
            beginControlledFrame: () => {},
            endControlledFrame: () => {},
            snapshotWindow: () => ({}) as never,
        },
        dispose: async (): Promise<void> => {
            disposed++;
        },
    } as unknown as ThreeWayBenchmarkAdapter;
    return { adapter, disposed: () => disposed };
}

describe("三臂入口：参数解析", () => {
    it("1) 正常解析全部参数", () => {
        const cfg = PARSE_OK(
            "?methods=ours,flux-gs,reduced-3dgs&protocol=gpu-sync&yieldMode=none&res=1600x1063&frames=300&warmup=120&rounds=12&u=main-table&only=truck",
        );
        expect(cfg.methods).toEqual(["ours", "flux-gs", "reduced-3dgs"]);
        expect(cfg.width).toBe(1600);
        expect(cfg.height).toBe(1063);
        expect(cfg.frames).toBe(300);
        expect(cfg.warmup).toBe(120);
        expect(cfg.rounds).toBe(12);
        expect(cfg.label).toBe("main-table");
        expect(cfg.only).toBe("truck");
    });

    it("2) 非法 res / 零值 / 超限 / 非整数一律拒绝", () => {
        for (const bad of [
            "?methods=ours",
            "?methods=ours&res=1600",
            "?methods=ours&res=1600x",
            "?methods=ours&res=0x100",
        ]) {
            expect(parseThreeWayParams(bad).ok).toBe(false);
        }
        expect(parseThreeWayParams("?methods=ours&res=1600x1063&frames=0").ok).toBe(false);
        expect(parseThreeWayParams("?methods=ours&res=1600x1063&frames=-5").ok).toBe(false);
        expect(parseThreeWayParams("?methods=ours&res=1600x1063&frames=1.5").ok).toBe(false);
        expect(parseThreeWayParams(`?methods=ours&res=1600x1063&frames=${PARAM_LIMITS.frames + 1}`).ok).toBe(false);
        expect(parseThreeWayParams(`?methods=ours&res=1600x1063&rounds=${PARAM_LIMITS.rounds + 1}`).ok).toBe(false);
    });

    it("3) 未知 method 与未声明别名一律拒绝", () => {
        expect(parseThreeWayParams("?methods=ours,magic").ok).toBe(false);
        const alias = parseThreeWayParams("?methods=flux");
        expect(alias.ok).toBe(false);
        if (!alias.ok) expect(alias.error).toContain("flux-gs");
        expect(parseThreeWayParams("?methods=ours&protocol=raf").ok).toBe(false);
        expect(parseThreeWayParams("?methods=ours&yieldMode=raf").ok).toBe(false);
    });

    it("4) 六种排列：rounds=12 ⇒ 每种排列出现两次", () => {
        const perms = roundPermutations(12, THREE_WAY_METHODS);
        expect(perms).toHaveLength(12);
        const seen = new Map<string, number>();
        for (const p of perms) seen.set(p.join(">"), (seen.get(p.join(">")) ?? 0) + 1);
        expect(seen.size).toBe(6);
        for (const [, n] of seen) expect(n).toBe(2);
    });

    it("5) 投影为标准行主序透视（近平面 z→-1、远平面 z→+1）", () => {
        const p = buildProjectionRowMajor(1159.5880733038064, 1159.5880733038064, 0.1, 100, 1600, 1063);
        expect(p).toHaveLength(16);
        const zOf = (z: number): number => (p[10] * z + p[14]) / -z;
        expect(zOf(-0.1)).toBeCloseTo(-1, 5);
        expect(zOf(-100)).toBeCloseTo(1, 5);
    });

    it("6) readSceneEntries 容错（数组/对象；缺字段用保守默认）", () => {
        expect(readSceneEntries([{ id: "truck", dataset: "tnt" }])[0].iframeUrl).toBe(
            "flux-gs-project-gh-pages/render_truck/index.html",
        );
        expect(readSceneEntries({ scenes: [{ id: "garden" }] })).toHaveLength(1);
        expect(readSceneEntries({ nope: 1 })).toEqual([]);
    });
});

describe("三臂入口：硬门槛与门控", () => {
    const CFG = (): ThreeWayRunConfig => PARSE_OK("?methods=ours&res=1600x1063&frames=300");

    it("7) 五计数器任一非零 ⇒ 轮次无效且排除主表", () => {
        const cfg = CFG();
        const cases: Array<Partial<Record<string, unknown>>> = [
            { sortRequestsDuringMeasure: 1 },
            { sortCompletedDuringMeasure: 1 },
            { indexBufferUploadsDuringMeasure: 1 },
            { pendingSortsAtStart: 1 },
            { pendingSortsAtEnd: 1 },
        ];
        for (const c of cases) {
            const gate = evaluateRoundGate(mkResult(c, cfg), cfg, OK_CAP);
            expect(gate.valid).toBe(false);
            expect(gate.excludeFromMainTable).toBe(true);
        }
        const clean = evaluateRoundGate(mkResult({}, cfg), cfg, OK_CAP);
        expect(clean.valid).toBe(true);
        expect(clean.protocol).toBe(PROTOCOL_STATIC_RENDER_ONLY);
        expect(clean.excludeFromMainTable).toBe(false);
    });

    it("8) 能力降级 ⇒ 不得输出新协议名（回落到 static-full-frame）", () => {
        const cfg = PARSE_OK("?methods=flux-gs&res=1600x1063&frames=300");
        const gate = evaluateRoundGate(mkResult({}, cfg), cfg, {
            staticFrameRenderOnly: false,
            sortFreezeSupported: true,
        });
        expect(gate.protocol).toBe(PROTOCOL_STATIC_FULL_FRAME);
        expect(gate.protocol).not.toBe(PROTOCOL_STATIC_RENDER_ONLY);
        expect(gate.valid).toBe(false);
        expect(gate.excludeFromMainTable).toBe(true);
    });

    it("9) 帧数/上下文/异常 draw 计数不一致 ⇒ 无效", () => {
        const cfg = CFG();
        expect(evaluateRoundGate(mkResult({ controllerRenderCalls: 299 }, cfg), cfg, OK_CAP).valid).toBe(false);
        expect(evaluateRoundGate(mkResult({ adapterFrameDelta: 301 }, cfg), cfg, OK_CAP).valid).toBe(false);
        expect(evaluateRoundGate(mkResult({ contextLost: true }, cfg), cfg, OK_CAP).valid).toBe(false);
        expect(evaluateRoundGate(mkResult({ unexpectedFrameCallbacks: 2 }, cfg), cfg, OK_CAP).valid).toBe(false);
        expect(evaluateRoundGate(mkResult({ workload: { gaussianTotal: null } }, cfg), cfg, OK_CAP).valid).toBe(false);
    });
});

describe("三臂入口：计划执行与清理", () => {
    const makePlanner = (
        ran: string[],
        runRound: () => Promise<SyncedRoundResult>,
    ): Parameters<typeof runThreeWayPlan>[0] => ({
        config: PARSE_OK("?methods=ours,flux-gs,reduced-3dgs&res=1600x1063&frames=300&rounds=12&u=main-table"),
        capabilitiesOf: () => OK_CAP,
        createAdapter: async (method) => {
            ran.push(method);
            return fakeAdapter().adapter;
        },
        controllerDeps: CTRL_DEPS,
        runRound: async (adapter, _cfg: BenchmarkConfig) => {
            void adapter;
            return runRound();
        },
    });

    it("10) 每轮记录保留 u/method/round/顺序，且 Adapter 必然 dispose", async () => {
        const ran: string[] = [];
        const cfg = PARSE_OK("?methods=ours&res=1600x1063&frames=300");
        const outcome = await runThreeWayPlan(makePlanner(ran, async () => mkResult({}, cfg)));
        expect(outcome.records.length).toBe(36); // 12 轮 × 3 臂
        expect(outcome.disposed.length).toBe(36);
        expect(ran.length).toBe(36);
        const first = outcome.records[0];
        expect(first.round).toBe(1);
        expect(first.label).toBe("main-table");
        expect(first.method).toBe("ours");
        expect(first.order.join(">")).toBe("ours>flux-gs>reduced-3dgs");
        expect(outcome.records[3].round).toBe(2);
        expect(outcome.stoppedReason).toBeNull();
    });

    it("11) context lost ⇒ 立即停止，已完成轮次仍被记录", async () => {
        const ran: string[] = [];
        const cfg = PARSE_OK("?methods=ours&res=1600x1063&frames=300");
        let n = 0;
        const outcome = await runThreeWayPlan(
            makePlanner(ran, async () => {
                n++;
                return mkResult({ contextLost: n === 2 }, cfg);
            }),
        );
        expect(outcome.stoppedReason).toBe("context-lost");
        expect(outcome.records.length).toBe(2);
        expect(outcome.disposed.length).toBe(2);
    });

    it("12) runRound 抛错 ⇒ 该轮不记录、Adapter 仍 dispose、计划停止", async () => {
        const ran: string[] = [];
        const outcome = await runThreeWayPlan(
            makePlanner(ran, async () => {
                throw new Error("boom");
            }),
        );
        expect(outcome.records).toHaveLength(0);
        expect(outcome.disposed.length).toBe(1);
        expect(outcome.stoppedReason ?? "").toContain("round-failed:ours");
    });
});
