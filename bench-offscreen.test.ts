/**
 * bench-offscreen.ts 与 OffscreenBenchTarget.ts 的单元测试（`npm test`）。
 *
 * 为什么值得测：这套离屏论文协议的数字要拿去跟论文的 147/151 FPS 比，一旦"预热帧混进了统计"
 * 或"多轮平均实际只跑了一轮"，结果行里的数字**看起来依旧正常**（历史上 `covered=` 就是这么骗过一轮的）。
 * 这里覆盖：
 *   - 协议默认值/模式解析（缺省必须是在屏真实协议 → 现有口径零改动）；
 *   - 离屏渲染目标的创建/绑定/释放（用假 GL 断言调用序列与完整性判定）；
 *   - 非阻塞栅栏门的积压上限与排空（"不无限积压"这条硬约束）；
 *   - 协议循环：预热不计入、每个 run 独立计时、多轮平均与标准差、逐 run 列表、取消语义；
 *   - `offscreenRoundTags()` 的守卫（在屏轮次不打印任何离屏字段）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BENCH_MODE_OFFSCREEN,
    BENCH_MODE_ONSCREEN,
    OFFSCREEN_DEFAULTS,
    benchMode,
    formatMeanStd,
    meanStd,
    offscreenDisclaimerLines,
    offscreenFramesPerRun,
    offscreenMaxFencesInFlight,
    offscreenRoundTags,
    offscreenRunCount,
    offscreenWarmupFrames,
} from "./bench-shared";
import {
    NonBlockingFrameGate,
    OffscreenGpuTimer,
    OffscreenRenderTarget,
    createOffscreenRenderTarget,
} from "./src/renderers/webgl/utils/OffscreenBenchTarget";
import type { GlFenceApi, GlFramebufferApi, GlTimerQueryApi } from "./src/renderers/webgl/utils/OffscreenBenchTarget";
import {
    offscreenAsThroughputStats,
    offscreenFramesWithNoFence,
    resolveOffscreenSyncMode,
    runOffscreenProtocol,
    syncPolicyLabel,
    syncPolicyLabelWithNote,
} from "./bench-offscreen";

afterEach(() => {
    vi.unstubAllGlobals();
});

/** 假 WebGL2 的帧缓冲子集：记录调用序列，`checkFramebufferStatus` 可配置为失败。 */
function fakeFramebufferGl(complete = true) {
    const calls: string[] = [];
    const gl = {
        calls,
        FRAMEBUFFER: 0x8d40,
        RENDERBUFFER: 0x8d41,
        COLOR_ATTACHMENT0: 0x8ce0,
        RGBA8: 0x8058,
        FRAMEBUFFER_COMPLETE: 0x8cd5,
        createFramebuffer: () => ({ id: "fbo" }) as unknown as WebGLFramebuffer,
        bindFramebuffer: (_target: number, fb: WebGLFramebuffer | null) =>
            calls.push(`bindFramebuffer:${fb ? "fbo" : "null"}`),
        createRenderbuffer: () => ({ id: "rbo" }) as unknown as WebGLRenderbuffer,
        bindRenderbuffer: (_target: number, rb: WebGLRenderbuffer | null) =>
            calls.push(`bindRenderbuffer:${rb ? "rbo" : "null"}`),
        renderbufferStorage: (_t: number, _f: number, w: number, h: number) => calls.push(`storage:${w}x${h}`),
        framebufferRenderbuffer: () => calls.push("framebufferRenderbuffer"),
        checkFramebufferStatus: () => (complete ? 0x8cd5 : 0x8cd6),
        deleteFramebuffer: () => calls.push("deleteFramebuffer"),
        deleteRenderbuffer: () => calls.push("deleteRenderbuffer"),
    };
    return gl as unknown as GlFramebufferApi & { calls: string[] };
}

describe("benchMode / 离屏协议默认值", () => {
    it("缺省模式 = 在屏真实协议（保证现有口径零改动）", () => {
        expect(benchMode()).toBe(BENCH_MODE_ONSCREEN);
    });

    it("`?benchmode=offscreen-paper-match`（含简写 offscreen）切到离屏论文协议", () => {
        vi.stubGlobal("location", { search: "?benchmode=offscreen-paper-match" });
        expect(benchMode()).toBe(BENCH_MODE_OFFSCREEN);
        vi.stubGlobal("location", { search: "?benchmode=offscreen" });
        expect(benchMode()).toBe(BENCH_MODE_OFFSCREEN);
        vi.stubGlobal("location", { search: "?benchmode=whatever" });
        expect(benchMode()).toBe(BENCH_MODE_ONSCREEN);
    });

    it("缺省值：runs=5、warmup=90、frames=300、fences=3（论文口径的工程化取值）", () => {
        expect(OFFSCREEN_DEFAULTS.numRuns).toBe(5);
        expect(OFFSCREEN_DEFAULTS.warmupFrames).toBe(90);
        expect(OFFSCREEN_DEFAULTS.maxFencesInFlight).toBe(3);
        expect(offscreenRunCount()).toBe(5);
        expect(offscreenWarmupFrames()).toBe(90);
        expect(offscreenFramesPerRun()).toBe(300);
        expect(offscreenMaxFencesInFlight()).toBe(3);
    });

    it("URL 覆盖与非法值回落", () => {
        vi.stubGlobal("location", { search: "?runs=3&warmup=0&frames=120&fences=1" });
        expect(offscreenRunCount()).toBe(3);
        expect(offscreenWarmupFrames()).toBe(0);
        expect(offscreenFramesPerRun()).toBe(120);
        expect(offscreenMaxFencesInFlight()).toBe(1);
        vi.stubGlobal("location", { search: "?runs=0&fences=0" });
        expect(offscreenRunCount()).toBe(5);
        expect(offscreenMaxFencesInFlight()).toBe(3);
    });

    it("诚实标注两行（中英各一），都写明「不代表真实屏幕帧率」", () => {
        const lines = offscreenDisclaimerLines();
        expect(lines.length).toBe(2);
        expect(lines[0]).toContain("Onscreen-Realworld FPS");
        expect(lines[1]).toContain("does NOT represent");
    });
});

describe("meanStd / formatMeanStd", () => {
    it("均值/总体标准差/极值/中位数", () => {
        const s = meanStd([2, 4, 4, 4, 5, 5, 7, 9]);
        expect(s.n).toBe(8);
        expect(s.mean).toBe(5);
        expect(s.std).toBe(2);
        expect(s.min).toBe(2);
        expect(s.max).toBe(9);
        expect(s.median).toBe(4.5);
    });

    it("空样本全 0、单样本 std=0；非有限值被过滤", () => {
        expect(meanStd([])).toEqual({ n: 0, mean: 0, std: 0, min: 0, max: 0, median: 0 });
        expect(meanStd([Number.NaN, 10]).n).toBe(1);
        expect(meanStd([3]).std).toBe(0);
        expect(formatMeanStd(meanStd([3]))).toBe("3.0±0.0");
        expect(formatMeanStd(undefined)).toBe("-");
    });
});

describe("offscreenRoundTags：在屏轮次一个离屏字段都不打印", () => {
    it("没有 benchMode（或 =onscreen-realworld）→ 空数组（历史行格式逐字不变）", () => {
        expect(offscreenRoundTags({})).toEqual([]);
        expect(offscreenRoundTags({ benchMode: BENCH_MODE_ONSCREEN, offscreenFpsMean: 150 })).toEqual([]);
    });

    it("离屏轮次的字段名/格式（主指标 = mean±std，含逐 run 列表与栅栏诊断）", () => {
        const tags = offscreenRoundTags({
            benchMode: BENCH_MODE_OFFSCREEN,
            offscreenTarget: "fbo:1600x1063",
            offscreenRuns: 5,
            offscreenFramesPerRun: 300,
            offscreenWarmupFrames: 90,
            offscreenFpsMean: 151.23,
            offscreenFpsStd: 1.84,
            offscreenFpsMin: 148.9,
            offscreenFpsMax: 153.4,
            offscreenFpsMedian: 151.0,
            offscreenFenceWaitMs: 0.12,
            offscreenFencesMax: 2,
            offscreenFencesLimit: 3,
            offscreenDriverFloorMs: 0.15,
            offscreenDriverCapped: false,
            offscreenRunFpsList: "150.1,151.0",
            offscreenSyncPolicy: syncPolicyLabel("each"),
        });
        expect(tags).toContain("bench_mode=offscreen-paper-match");
        expect(tags).toContain("offscreen_target=fbo:1600x1063");
        expect(tags).toContain("offscreen_fps=151.2±1.8");
        expect(tags).toContain("offscreen_run_fps=150.1,151.0");
        expect(tags).toContain("offscreen_fences=2/3");
        expect(tags).toContain("offscreen_driver_capped=0");
        expect(tags).toContain("offscreen_sync_policy=finish_and_readpixels1x1");
        expect(syncPolicyLabel("fence", 5)).toBe("fence_sync_clientwait0_cap5");
        expect(syncPolicyLabel("gputimer")).toBe("gpu_timer_query_ext_disjoint");
    });
});

/** 假 GPU 栅栏 API：`signaledAfterPolls` 控制"第几次轮询之后才算完成"。 */
function fakeFenceGl(signaledAfterPolls = Number.POSITIVE_INFINITY) {
    let pending = 0;
    let polls = 0;
    const order: string[] = [];
    const gl = {
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
        ALREADY_SIGNALED: 0x911a,
        CONDITION_SATISFIED: 0x911b,
        fenceSync: () => {
            pending++;
            order.push("fenceSync");
            return { id: pending } as unknown as WebGLSync;
        },
        flush: () => {
            order.push("flush");
        },
        finish: () => {
            order.push("finish");
        },
        readPixels: () => {
            order.push("readPixels");
        },
        RGBA: 0x1908,
        UNSIGNED_BYTE: 0x1401,
        clientWaitSync: () => {
            polls++;
            order.push("clientWaitSync");
            const done = polls > signaledAfterPolls;
            if (done && pending > 0) pending--;
            return done ? 0x911b : 0x911c; // CONDITION_SATISFIED : TIMEOUT_EXPIRED
        },
        deleteSync: () => {
            /* 无副作用 */
        },
    };
    return { gl: gl as unknown as GlFenceApi, polls: () => polls, pending: () => pending, order: () => order };
}

describe("OffscreenRenderTarget：FBO + 颜色 renderbuffer", () => {
    it("创建成功时 ready/label/完整状态正确，并绑到 GL 的 FRAMEBUFFER 上", () => {
        const gl = fakeFramebufferGl(true);
        const target = new OffscreenRenderTarget(gl, 1600, 1063);
        expect(target.ready).toBe(true);
        expect(target.complete).toBe(true);
        expect(target.label).toBe("fbo:1600x1063");
        expect(gl.calls).toContain("storage:1600x1063");
        expect(gl.calls).toContain("framebufferRenderbuffer");
        // 创建结束必须把 framebuffer 还原成默认（否则后续渲染会意外落到离屏目标上）
        const fbBinds = gl.calls.filter((c) => c.startsWith("bindFramebuffer"));
        expect(fbBinds[fbBinds.length - 1]).toBe("bindFramebuffer:null");
        target.dispose();
    });

    it("FBO 不完整时创建（含便利构造）判定为不可用 → 调用方据此退回在屏协议", () => {
        const gl = fakeFramebufferGl(false);
        const target = new OffscreenRenderTarget(gl, 32, 32);
        expect(target.ready).toBe(false);
        expect(target.reason).toContain("checkFramebufferStatus");
        expect(createOffscreenRenderTarget(gl, 32, 32)).toBeNull();
    });

    it("bind/unbind/withBound 成对，dispose 后 ready=false 且 GL 对象被删除", () => {
        const gl = fakeFramebufferGl(true);
        const target = new OffscreenRenderTarget(gl, 8, 8);
        gl.calls.length = 0;
        target.bind();
        expect(gl.calls).toEqual(["bindFramebuffer:fbo"]);
        gl.calls.length = 0;
        expect(target.withBound(() => 42)).toBe(42);
        expect(gl.calls).toEqual(["bindFramebuffer:fbo", "bindFramebuffer:null"]);
        target.dispose();
        expect(target.ready).toBe(false);
        expect(gl.calls).toContain("deleteFramebuffer");
        expect(gl.calls).toContain("deleteRenderbuffer");
    });
});

describe("NonBlockingFrameGate：同步策略（each 缺省 / fence 可选）", () => {
    it("★ 默认 each：每帧 finish → （离屏目标上）1×1 readPixels —— readPixels 才是真正会等的那一步", () => {
        const { gl, order } = fakeFenceGl(Number.POSITIVE_INFINITY);
        let bound = 0;
        const gate = new NonBlockingFrameGate(gl, 3, "each", {
            withTargetBound: <T>(fn: () => T) => {
                bound++;
                return fn();
            },
        });
        expect(gate.mode).toBe("each");
        gate.afterFrame();
        expect(order()).toEqual(["finish", "readPixels"]);
        expect(bound).toBe(1); // 读回被包在"离屏目标已绑定"里
        expect(gate.inFlight).toBe(0);
    });

    it("each 模式在没有探针时也能工作（退化为纯 finish，不抛错）", () => {
        const { gl, order } = fakeFenceGl(Number.POSITIVE_INFINITY);
        const gate = new NonBlockingFrameGate(gl, 3, "each");
        gate.afterFrame();
        expect(order()).toEqual(["finish", "readPixels"]);
    });

    it("fence 模式：每帧 fenceSync → flush → clientWaitSync（顺序即正确性）", () => {
        const { gl, order } = fakeFenceGl(Number.POSITIVE_INFINITY);
        const gate = new NonBlockingFrameGate(gl, 3, "fence");
        gate.afterFrame();
        expect(order().slice(0, 3)).toEqual(["fenceSync", "flush", "clientWaitSync"]);
    });

    it("fence 模式：在途栅栏数永不超过上限，超限时才阻塞等待最老的那个", () => {
        const { gl } = fakeFenceGl(Number.POSITIVE_INFINITY); // 永不完成 → 只能靠"超限阻塞"回收
        const gate = new NonBlockingFrameGate(gl, 3, "fence");
        for (let i = 0; i < 10; i++) {
            expect(gate.afterFrame()).toBeLessThanOrEqual(3);
        }
        expect(gate.maxInFlightSeen).toBeLessThanOrEqual(3);
        expect(gate.forcedDrains).toBeGreaterThan(0);
    });

    it("fence 模式：GPU 很快时栅栏被就地回收：在途数为 0、不触发阻塞等待", () => {
        const { gl } = fakeFenceGl(0); // 第一次轮询就 SATISFIED
        const gate = new NonBlockingFrameGate(gl, 3, "fence");
        for (let i = 0; i < 5; i++) {
            expect(gate.afterFrame()).toBe(0);
        }
        expect(gate.forcedDrains).toBe(0);
        expect(gate.maxInFlightSeen).toBe(0);
        expect(gate.firstPollSignaled).toBe(5);
    });

    it("fence 模式：drainAll 之后在途数为 0（每个 run 结束时把 GPU 工作等干净）", () => {
        const { gl } = fakeFenceGl(Number.POSITIVE_INFINITY);
        const gate = new NonBlockingFrameGate(gl, 3, "fence");
        gate.afterFrame();
        gate.afterFrame();
        expect(gate.inFlight).toBeGreaterThan(0);
        gate.drainAll();
        expect(gate.inFlight).toBe(0);
    });

    it("★ none（零仪器基准）：afterFrame 与 drainAll 都不碰 GL —— 不 finish / 不 readPixels / 不插栅栏", () => {
        const { gl, order } = fakeFenceGl(Number.POSITIVE_INFINITY);
        let bound = 0;
        const gate = new NonBlockingFrameGate(gl, 3, "none", {
            withTargetBound: <T>(fn: () => T) => {
                bound++;
                return fn();
            },
        });
        expect(gate.mode).toBe("none");
        for (let i = 0; i < 5; i++) {
            expect(gate.afterFrame()).toBe(0);
        }
        gate.drainAll();
        // 关键断言：被测区间内**没有任何** GL 同步调用（这是"+8.2%/+105% 仪器开销"的干净基准）
        expect(order()).toEqual([]);
        expect(bound).toBe(0);
        expect(gate.inFlight).toBe(0);
        expect(gate.waitTotalMs).toBe(0);
    });
});

describe("sync=none（零仪器基准）的模式解析与标签", () => {
    it("resolveOffscreenSyncMode('none') → mode='none'，且写下为什么回落到它", () => {
        const decided = resolveOffscreenSyncMode("none", true);
        expect(decided.mode).toBe("none");
        expect(decided.fallback).toContain("zero_instrument");
        expect(decided.fallback).toContain("no_sync_calls");
    });

    it("resolveOffscreenSyncMode('natural') 仍映射到 each（自然模式语义不变）", () => {
        expect(resolveOffscreenSyncMode("natural", true)).toEqual({
            mode: "each",
            fallback: "natural->raf+perframe_1x1_readpixels(no_batching)",
        });
    });

    it("syncPolicyLabel 三档字面量各自唯一，报告可据此区分口径", () => {
        expect(syncPolicyLabel("none")).toBe("zero_instrument_no_sync_calls");
        expect(syncPolicyLabel("batch")).toBe("batch_submit_drain_at_run_end");
        expect(syncPolicyLabel("each")).toBe("finish_and_readpixels1x1");
        expect(syncPolicyLabelWithNote("none", 3, "zero_instrument->x")).toBe(
            "zero_instrument_no_sync_calls|fallback=zero_instrument->x",
        );
    });
});

/** 假 GPU 计时查询 API：每帧 begin/end 都能成功，结果在 N 次探测后可取回。 */
function fakeTimerGl(availableAfterPolls = 1) {
    let polls = 0;
    const order: string[] = [];
    const queries: Array<{ id: number; begin: number; end: number }> = [];
    let live: { id: number; begin: number; end: number } | null = null;
    const gl = {
        QUERY_RESULT_AVAILABLE: 0x8867,
        QUERY_RESULT: 0x8866,
        _calls: order,
        _queries: queries,
        getExtension: () => ({ TIME_ELAPSED_EXT: 0x88bf }),
        createQuery: () => {
            order.push("createQuery");
            const q = { id: queries.length, begin: -1, end: -1 };
            queries.push(q);
            return q as unknown as WebGLQuery;
        },
        beginQuery: (_t: number, q: WebGLQuery) => {
            order.push("beginQuery");
            const target = q as unknown as { begin: number; end: number };
            target.begin = 1;
            live = target as { id: number; begin: number; end: number };
        },
        endQuery: () => {
            order.push("endQuery");
            if (live) {
                live.end = 1;
                live = null;
            }
        },
        getQueryParameter: (_q: WebGLQuery, pname: number) => {
            order.push("getQueryParameter");
            if (pname === 0x8867) {
                polls++;
                return polls > availableAfterPolls;
            }
            return 1_627_000; // 1.627ms in ns
        },
        getParameter: () => false,
        deleteQuery: () => {
            order.push("deleteQuery");
        },
        isContextLost: () => false,
    };
    return { gl, order, queries };
}

describe("OffscreenGpuTimer：逐步诊断（修复 gpu_samples=0/0 的那条 bug）", () => {
    it("★ 配对正确时：create/begin/end 各 = 帧数，无 overwrite/orphanEnd，且能取回样本", () => {
        const { gl, queries } = fakeTimerGl(0);
        const timer = new OffscreenGpuTimer(gl as unknown as GlTimerQueryApi);
        expect(timer.supported).toBe(true);
        for (let i = 0; i < 5; i++) {
            timer.begin();
            timer.end();
        }
        timer.drain();
        const d = timer.diag();
        expect(d.createCalls).toBe(5);
        expect(d.createErrors + d.createNull).toBe(0);
        expect(d.beginCalls).toBe(5);
        expect(d.beginErrors).toBe(0);
        // 关键：end 必须与 begin 等量（缺失 = 现场那次的 bug 形态）
        expect(d.endCalls).toBe(5);
        expect(d.endErrors).toBe(0);
        expect(d.activeOverwrite).toBe(0);
        expect(d.orphanEnd).toBe(0);
        expect(timer.samples.length).toBe(5);
        expect(timer.samples[0]).toBeCloseTo(1.627, 3);
        expect(queries.every((q) => q.begin === 1 && q.end === 1)).toBe(true);
        expect(timer.diagLine()).toMatch(/end=5\/0/);
    });

    it("★ 只 begin 不 end（现场 bug 的形态）：overwrite 累积、end=0、samples=0 —— 诊断必须能指出来", () => {
        const { gl } = fakeTimerGl(0);
        const timer = new OffscreenGpuTimer(gl as unknown as GlTimerQueryApi);
        for (let i = 0; i < 4; i++) timer.begin(); // 故意不调用 end()
        const d = timer.diag();
        expect(d.beginCalls).toBe(4);
        expect(d.endCalls).toBe(0);
        expect(d.activeOverwrite).toBe(3); // 第 2~4 次 begin 都发现上一帧没结束
        expect(timer.samples.length).toBe(0);
        expect(timer.diagLine()).toContain("end=0/0");
        expect(timer.diagLine()).toContain("overwrite=3");
    });

    it("end 多于 begin（时序错）记 orphanEnd；beginQuery 抛异常时记 beginErrors 并保留错误信息", () => {
        const { gl } = fakeTimerGl(0);
        const timer = new OffscreenGpuTimer(gl as unknown as GlTimerQueryApi);
        timer.end();
        timer.end();
        expect(timer.diag().orphanEnd).toBe(2);

        const broken = fakeTimerGl(0);
        (broken.gl as unknown as { beginQuery: () => void }).beginQuery = () => {
            const err = new Error("INVALID_OPERATION: beginQuery") as Error & { name: string };
            err.name = "InvalidOperationError";
            throw err;
        };
        const t2 = new OffscreenGpuTimer(broken.gl as unknown as GlTimerQueryApi);
        t2.begin();
        t2.end();
        const d2 = t2.diag();
        expect(d2.beginErrors).toBe(1);
        expect(d2.endCalls).toBe(0);
        expect(d2.orphanEnd).toBe(1); // begin 失败 → end 变成"没有 active"
        expect(t2.diagLine()).toContain("beginQuery");
    });

    it("扩展缺失：extNull=1、begin/end 静默跳过（不是异常，而是明确的 diag）", () => {
        const { gl } = fakeTimerGl(0);
        (gl as unknown as { getExtension: () => null }).getExtension = () => null;
        const timer = new OffscreenGpuTimer(gl as unknown as GlTimerQueryApi);
        expect(timer.supported).toBe(false);
        timer.begin();
        timer.end();
        expect(timer.diag().extNull).toBe(1);
        // 2026-09-26 起诊断必须写明"试过哪两个扩展名、各自为什么失败"（真机上这是唯一现场：
        // 手机缺省 sync=gputimer 就是靠这条判断"到底是没有扩展还是接线错了"）
        expect(timer.diagLine()).toContain("tried=2");
        expect(timer.diagLine()).toContain("EXT_disjoint_timer_query_webgl2:null");
    });
});

describe("offscreenFramesWithNoFence：只作警告，不作硬判据", () => {
    it("帧数太少时不触发（轻量场景天然如此）", () => {
        expect(offscreenFramesWithNoFence(20, 20)).toBe(false);
    });

    it("≥100 帧且 90% 以上首轮即 signaled → 触发警告", () => {
        expect(offscreenFramesWithNoFence(1000, 900)).toBe(true);
        expect(offscreenFramesWithNoFence(1000, 500)).toBe(false);
    });
});

describe("runOffscreenProtocol 的可信性判定", () => {
    it("无栅栏检查（hooks 不提供 afterFrame）时仍然给出读数，但 plausible 只由 FPS 量级决定", async () => {
        const result = await runOffscreenProtocol({
            framesPerRun: 5,
            numRuns: 2,
            warmupFrames: 0,
            driver: "timer",
            hooks: { renderFrame: () => undefined },
        });
        // 没有栅栏诊断 → 不触发"栅栏未生效"的警告路径；FPS 量级正常 → plausible
        expect(result.fencesFirstPollSignaled).toBe(0);
        expect(result.plausible).toBe(true);
        expect(result.implausibleReason).toBe("");
    });
});

describe("runOffscreenProtocol：warm-up 不计入 + 多轮平均", () => {
    it("预热帧照常渲染但不计入统计；每个 run 独立计时并报 mean±std", async () => {
        const rendered: Array<[number, number]> = [];
        let gateCalls = 0;
        const result = await runOffscreenProtocol({
            framesPerRun: 5,
            numRuns: 3,
            warmupFrames: 4,
            driver: "timer", // 测试里用最朴素的时间驱动（msgchannel 在 node 下另有断言，见上）
            hooks: {
                renderFrame: (run, frame) => {
                    rendered.push([run, frame]);
                },
                afterFrame: () => {
                    gateCalls++;
                },
                endRun: () => {
                    /* 排空 */
                },
            },
        });
        // 预热 4 帧（run=-1）+ 3 个 run × 5 帧 = 19 次渲染提交，一次都不能少
        expect(rendered.filter(([run]) => run < 0).length).toBe(4);
        expect(rendered.filter(([run]) => run >= 0).length).toBe(15);
        expect(result.completed).toBe(true);
        expect(result.aborted).toBe(false);
        expect(result.runs.length).toBe(3);
        expect(result.renderedFrames).toBe(15);
        expect(result.requestedFrames).toBe(15);
        // 主指标 = 各 run FPS 的均值（不是某一次瞬时值），标准差另列
        expect(result.fps.n).toBe(3);
        expect(result.fps.mean).toBeGreaterThan(0);
        expect(result.fps.std).toBeGreaterThanOrEqual(0);
        expect(result.framesPerRun).toBe(5);
        expect(result.warmupFrames).toBe(4);
        expect(result.driverFloorMs).toBeGreaterThan(0);
        // 每帧都做过一次进度检查（预热也做：预热期间的 GPU 工作不能攒到 run 0）
        expect(gateCalls).toBe(19);
        // 逐 run 的样本都可回溯
        expect(result.runs.map((r) => r.run)).toEqual([0, 1, 2]);
        expect(result.runs.every((r) => r.frames === 5)).toBe(true);
    });

    it("取消语义：`stopped()` 为真时立刻中断，completed=false 且 note 说明在哪一段被取消", async () => {
        const result = await runOffscreenProtocol({
            framesPerRun: 100,
            numRuns: 3,
            warmupFrames: 1000,
            driver: "timer",
            hooks: { renderFrame: () => undefined, stopped: () => true },
        });
        expect(result.aborted).toBe(true);
        expect(result.completed).toBe(false);
        expect(result.note).toContain("预热");
        expect(result.renderedFrames).toBe(0);
    });

    it("转换到 DriveThroughputStats：fps 取多轮均值、驱动地板按 msgchannel/协议回填", async () => {
        const result = await runOffscreenProtocol({
            framesPerRun: 3,
            numRuns: 2,
            warmupFrames: 0,
            driver: "timer",
            hooks: { renderFrame: () => undefined },
        });
        const stats = offscreenAsThroughputStats(result);
        expect(stats.fps).toBeCloseTo(result.fps.mean, 12);
        expect(stats.driver).toBe("timer");
        expect(stats.frames).toBe(3);
        expect(stats.rendered).toBe(6);
        expect(stats.timerFloorSrc).toBe("empty_drive_timer");
        // 判据与在屏协议同构：1/fps ≤ floor × 1.05
        expect(stats.fpsCapped).toBe(result.driverCapped);
    });
});

/**
 * 2026-09-26 真机回归（Snapdragon 8 Gen 2 / Adreno 740 / 微信 XWEB）。
 *
 * 现场事实：手机上缺省 `sync=gputimer` 取不到计时扩展时，原实现回落到 `each`
 * （每帧 `gl.finish()` + 1×1 `readPixels`）→ 实测 `frame_ms=70.2`、整轮 115s、报出 13.8 FPS；
 * 而同一台设备在屏口径有 ~200 FPS。那条回落测的是"每帧全同步延迟"，与论文口径不可比。
 *
 * 这里锁死两条修复：① 自动回落必须是 `fence`（非阻塞，只有在途超限才等）；
 * ② "回落原因"与"两个扩展名都试过"必须出现在结果字段里——否则真机上又是"数字离谱但看不出为什么"。
 */
describe("离屏协议 · 同步策略回落链（真机回归）", () => {
    it("请求 gputimer 但扩展不可用 → 自动回落到 batch（run 末排空，既非提交速率也非每帧全同步）", () => {
        const r = resolveOffscreenSyncMode("gputimer", false);
        expect(r.mode).toBe("batch");
        expect(r.fallback).toContain("gputimer_unavailable");
    });

    it("扩展可用时保持 gputimer；显式 each/fence/batch 不被改写", () => {
        expect(resolveOffscreenSyncMode("gputimer", true)).toEqual({ mode: "gputimer", fallback: "" });
        expect(resolveOffscreenSyncMode("each", false)).toEqual({ mode: "each", fallback: "" });
        expect(resolveOffscreenSyncMode("fence", false)).toEqual({ mode: "fence", fallback: "" });
        expect(resolveOffscreenSyncMode("batch", false)).toEqual({ mode: "batch", fallback: "" });
    });

    it("策略标签：batch 有独立字面量（报告据此判断口径是吞吐而不是提交速率）", () => {
        expect(syncPolicyLabel("batch")).toBe("batch_submit_drain_at_run_end");
        expect(syncPolicyLabelWithNote("batch", 3, "gputimer_unavailable->batch")).toBe(
            "batch_submit_drain_at_run_end|fallback=gputimer_unavailable->batch",
        );
    });

    it("batch 的计时终点必须在排空之后：endRun 的耗时算进 elapsed（否则只量到提交速率）", async () => {
        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
        const withDrain = await runOffscreenProtocol({
            framesPerRun: 3,
            numRuns: 1,
            warmupFrames: 0,
            timingEndAfterDrain: true,
            hooks: {
                renderFrame: () => undefined,
                endRun: () => sleep(60), // 模拟 finish()+readPixels 的真实等待
            },
        });
        expect(withDrain.runs[0].elapsedMs).toBeGreaterThanOrEqual(50);
        expect(withDrain.runs[0].fps).toBeLessThan(200); // 3 帧 / 60ms ≈ 50

        const withoutDrain = await runOffscreenProtocol({
            framesPerRun: 3,
            numRuns: 1,
            warmupFrames: 0,
            hooks: {
                renderFrame: () => undefined,
                endRun: () => sleep(60),
            },
        });
        expect(withoutDrain.runs[0].elapsedMs).toBeLessThan(50); // 排空在取点之后 → 不计入
    });

    it("GPU 计时器：两个扩展名都拿不到时 supported=false，且诊断写明试过哪两个名字", () => {
        const gl = { getExtension: () => null } as unknown as GlTimerQueryApi;
        const timer = new OffscreenGpuTimer(gl);
        expect(timer.supported).toBe(false);
        const line = timer.diagLine();
        expect(line).toContain("tried=2");
        expect(line).toContain("null=1");
        expect(line).toContain("EXT_disjoint_timer_query_webgl2:null");
        expect(line).toContain("EXT_disjoint_timer_query:null");
    });

    it("GPU 计时器：只有旧名可用时也能启用（并记录实际扩展名）", () => {
        const gl = {
            getExtension: (name: string) =>
                name === "EXT_disjoint_timer_query" ? { TIME_ELAPSED_EXT: 0x88bf } : null,
        } as unknown as GlTimerQueryApi;
        const timer = new OffscreenGpuTimer(gl);
        expect(timer.supported).toBe(true);
        expect(timer.diagLine()).toContain("name=EXT_disjoint_timer_query");
    });
});
