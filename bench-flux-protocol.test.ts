/**
 * bench-flux-protocol.test.ts — 第 9 阶段验收测试（FLUX_FPS_PROTOCOL.md §C.6 的 12 条）。
 *
 * 参考实现 = `flux-gs-project-gh-pages/render_shared/main.js:2303-2339 + 2351-2367`
 * （见 FLUX_VENDOR_DIFF.md）。本文件用**假时钟 + 假调度器**同时驱动：
 *   - `runFluxLoop()`          ← 本方法实际使用的共享 harness
 *   - `runFluxLoopReference()` ← 与参考实现逐行同构的等价实现
 * 并逐条断言 render/timer 顺序、计时起止、FPS 公式完全一致。
 *
 * 本文件是纯逻辑测试：不 import `./src`、不创建 WebGL、不碰 DOM。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    FLUX_DEFAULT_FRAMES,
    FLUX_FOCAL_PX,
    FLUX_GPU_SYNCED,
    FLUX_METRIC,
    FLUX_PAPER_PROTOCOL_VERIFIED,
    FLUX_PRESENTED_FPS,
    FLUX_PROTOCOL_LABEL,
    FLUX_SOURCE_COMMIT,
    FLUX_SOURCE_REPO,
    fluxModificationBreakdown,
    fluxModificationBreakdownFor,
    fluxNativeBufferSize,
    fluxNativeDownsample,
    fluxProtocolSpec,
    fluxProtocolSpecFromSearch,
    fluxProtocolWarning,
    projectionFovHash,
    projectionFovKey,
    projectionFovMatches,
    replicationFocalPx,
    resolutionAuditFrom,
    resolutionAuditKey,
    resolutionAuditMatches,
    runFluxLoop,
    runFluxLoopReference,
    timerClampObservedFrom,
    viewMatrixHash,
    viewMatrixMatches,
} from "./bench-flux-protocol";
import type { FluxLoopHooks, ResolutionAudit } from "./bench-flux-protocol";

/** 假调度器：`schedule` 入队，`runAll` 每次运行前把时钟推进 `timerDelayMs`（= 复刻 setTimeout(0) 的延迟）。 */
class FakeScheduler {
    time = 0;
    timerDelayMs = 1;
    readonly trace: string[] = [];
    private queue: Array<() => void> = [];

    now = (): number => this.time;
    schedule = (cb: () => void): void => {
        this.queue.push(cb);
    };
    /** 每个 render 的真实耗时（毫秒）：用来验证"第 1 帧 render 时间不计入 elapsed"。 */
    renderCostMs = 0.25;
    render = (): void => {
        this.trace.push("render");
        this.time += this.renderCostMs;
    };
    hooks = (shouldAbort?: () => string | null): FluxLoopHooks => {
        const base: FluxLoopHooks = {
            render: this.render,
            schedule: (cb) => {
                this.trace.push("timer");
                this.schedule(cb);
            },
            now: this.now,
        };
        if (shouldAbort) base.shouldAbort = shouldAbort;
        return base;
    };
    runAll(maxTicks = 100000): void {
        let n = 0;
        while (this.queue.length > 0) {
            const cb = this.queue.shift() as () => void;
            this.time += this.timerDelayMs; // 复刻"下一帧要靠一次定时器才能开始"
            cb();
            if (++n > maxTicks) throw new Error("调度次数异常");
        }
    }
}

const spec = (search: string): ReturnType<typeof fluxProtocolSpec> => fluxProtocolSpecFromSearch(search);

// ─────────────────────────────────────────────────────────── 1
describe("proto=flux 的协议解析", () => {
    it("1) proto=flux 默认得到 driver=timer（无需另传 driver）", () => {
        const s = spec("?proto=flux");
        expect(s.driver).toBe("timer");
        expect(s.driverSource).toBe("flux-protocol");
        expect(s.protocol).toBe("flux");
        expect(s.protocolMatched).toBe(true);
        expect(s.fluxCompatible).toBe(true);
        expect(s.label).toBe(FLUX_PROTOCOL_LABEL);
    });

    it("1b) 协议自带的其它默认值：frames=300 / warmup=0 / 相机冻结 / 关自适应 / flux-native", () => {
        const s = spec("?proto=flux");
        expect(s.frames).toBe(FLUX_DEFAULT_FRAMES);
        expect(s.warmup).toBe(0);
        expect(s.cameraFrozen).toBe(true);
        expect(s.adaptiveResolution).toBe(false);
        expect(s.resolutionMode).toBe("flux-native");
        expect(s.forcedRes).toBeNull();
        expect(s.focalPx).toBeCloseTo(FLUX_FOCAL_PX, 6);
        expect(s.overrides).toEqual([]);
        expect(s.conflicts).toEqual([]);
        expect(s.sourceRepo).toBe(FLUX_SOURCE_REPO);
        expect(s.sourceCommit).toBe(FLUX_SOURCE_COMMIT);
        // 改动拆分（不再用单一 rendering_modifications=none）
        expect(s.modifications.algorithmModified).toBe(false); // shader/排序/剔除/解码/draw 未改
        expect(s.modifications.benchmarkLoopModified).toBe(true); // 计时循环已改
        expect(s.modifications.resolutionModified).toBe(false); // 本次会话未强制分辨率
        expect(s.modifications.cameraModified).toBe(false); // 用 auto 机位
        expect(s.cameraMode).toBe("auto");
        expect(s.protocolSource).toContain("runFluxBenchmark");
        expect(s.label).toContain("vendored-copy"); // 不得暗示"论文协议"
    });

    it("1c2) 指标命名：未同步 GPU、非呈现帧率、论文口径未验证", () => {
        const s = spec("?proto=flux");
        expect(s.metric).toBe("unsynchronized-webgl-frame-submission-throughput");
        expect(s.metric).toBe(FLUX_METRIC);
        expect(s.gpuSynced).toBe(false);
        expect(s.gpuSynced).toBe(FLUX_GPU_SYNCED);
        expect(s.presentedFps).toBe(false);
        expect(s.presentedFps).toBe(FLUX_PRESENTED_FPS);
        expect(s.paperProtocolVerified).toBe(false);
        expect(s.paperProtocolVerified).toBe(FLUX_PAPER_PROTOCOL_VERIFIED);
    });

    it("1c3) 改动拆分按会话计算（force ⇒ resolution、cam/fluxcam ⇒ camera）", () => {
        const fixed = spec("?proto=flux&force=1600x1063");
        expect(fixed.modifications.resolutionModified).toBe(true);
        expect(fixed.modifications.cameraModified).toBe(false);
        const fluxCam = spec("?proto=flux&cam=flux");
        expect(fluxCam.cameraMode).toBe("flux-default");
        expect(fluxCam.modifications.cameraModified).toBe(true);
        const hard = spec("?proto=flux&fluxcam=3");
        expect(hard.cameraMode).toBe("flux-hardcoded");
        expect(hard.modifications.cameraModified).toBe(true);
        // 纯 native + auto：只有计时循环被改
        expect(fluxModificationBreakdown(spec("?proto=flux"))).toEqual(
            fluxModificationBreakdownFor("flux-native", "auto"),
        );
        expect(fluxModificationBreakdownFor("flux-native", "auto").notes.join(" ")).toContain("benchmarkLoop");
    });

    it("1c) proto=flux 时 URL 显式参数可覆盖 warmup/frames 并记为 override", () => {
        const s = spec("?proto=flux&warmup=7&frames=500");
        expect(s.warmup).toBe(7);
        expect(s.frames).toBe(500);
        expect(s.overrides).toEqual(["frames=500", "warmup=7"]);
        expect(s.protocolMatched).toBe(true);
        expect(s.fluxCompatible).toBe(true);
    });

    it("1d) 未传 proto 时保持旧口径（driver=raf / warmup=10 / res 默认 1600x1063）", () => {
        const s = spec("");
        expect(s.protocol).toBe("custom");
        expect(s.driver).toBe("raf");
        expect(s.driverSource).toBe("default");
        expect(s.warmup).toBe(10);
        expect(s.frames).toBe(FLUX_DEFAULT_FRAMES);
        expect(s.resolutionMode).toBe("flux-fixed");
        expect(s.forcedRes).toEqual({ w: 1600, h: 1063 });
        expect(s.protocolMatched).toBe(false);
    });

    it("2) proto=flux&driver=raf 是协议冲突：按用户要求跑 raf，但标记协议不匹配", () => {
        const s = spec("?proto=flux&driver=raf");
        expect(s.driver).toBe("raf");
        expect(s.driverSource).toBe("explicit-override");
        expect(s.conflicts).toContain("driver=raf");
        expect(s.protocolMatched).toBe(false);
        expect(s.fluxCompatible).toBe(false);
        expect(fluxProtocolWarning(s)).toContain("driver=raf");
        expect(fluxProtocolWarning(spec("?proto=flux"))).toBe("");
    });

    it("2b) proto=flux&driver=timer 不是冲突", () => {
        const s = spec("?proto=flux&driver=timer");
        expect(s.conflicts).toEqual([]);
        expect(s.protocolMatched).toBe(true);
        expect(s.fluxCompatible).toBe(true);
    });

    it("10) 任何 rAF 口径都不可能被标记为 flux-compatible", () => {
        expect(spec("?proto=flux&driver=raf").fluxCompatible).toBe(false);
        expect(spec("?driver=raf").fluxCompatible).toBe(false);
        expect(spec("?proto=flux&driver=RAF").fluxCompatible).toBe(false); // 非 timer 字样一律按 raf
        expect(spec("?proto=flux").fluxCompatible).toBe(true);
        expect(spec("?proto=flux&driver=timer").fluxCompatible).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────── 3~7（时序对拍）
describe("参考循环逐行复刻（与 runFluxLoopReference 对拍）", () => {
    const FRAMES = 300;

    it("3) 两侧都恰好发生 300 次真实 render", async () => {
        const a = new FakeScheduler();
        const b = new FakeScheduler();
        const got = await (async () => {
            const p = runFluxLoop(FRAMES, 0, a.hooks());
            a.runAll();
            return p;
        })();
        const want = await (async () => {
            const p = runFluxLoopReference(FRAMES, 0, b.hooks());
            b.runAll();
            return p;
        })();
        expect(got.frames).toBe(FRAMES);
        expect(want.frames).toBe(FRAMES);
        expect(a.trace.filter((t) => t === "render")).toHaveLength(FRAMES);
        expect(b.trace.filter((t) => t === "render")).toHaveLength(FRAMES);
        expect(got.requested).toBe(FRAMES);
    });

    it("4) 两侧预热都是 0：第一帧 render 结束即计时起点，且无额外预热帧", async () => {
        expect(spec("?proto=flux").warmup).toBe(0);
        const a = new FakeScheduler();
        const p = runFluxLoop(5, 0, a.hooks());
        a.runAll();
        const res = await p;
        // 首次调度的时刻 1ms + 首帧 render 0.25ms = 1.25；没有预热帧（否则会更大）
        expect(res.startMs).toBeCloseTo(1.25, 6);
        expect(a.trace.filter((t) => t === "render")).toHaveLength(5);
        // 传 warmup>0 时确实多渲染（与参考臂"额外跑一轮"的语义一致）
        const b = new FakeScheduler();
        const p2 = runFluxLoop(5, 3, b.hooks());
        b.runAll();
        const res2 = await p2;
        expect(res2.frames).toBe(5);
        expect(b.trace.filter((t) => t === "render")).toHaveLength(8);
        expect(res2.startMs).toBeCloseTo(1.25 + 3 * 1.25, 6); // 3 个预热帧之后再进计时区间
        // 预热位置必须与参考实现完全一致（warmup = 额外完整跑一轮，且同样由 timer 起步）
        const c = new FakeScheduler();
        const p3 = runFluxLoopReference(5, 3, c.hooks());
        c.runAll();
        const want2 = await p3;
        expect(want2.startMs).toBeCloseTo(res2.startMs, 9);
        expect(c.trace).toEqual(b.trace);
    });

    it("5) 两侧 timer/render 顺序完全一致：先 render 再排 timer，严格交替", async () => {
        const a = new FakeScheduler();
        const b = new FakeScheduler();
        const p1 = runFluxLoop(4, 0, a.hooks());
        a.runAll();
        await p1;
        const p2 = runFluxLoopReference(4, 0, b.hooks());
        b.runAll();
        await p2;
        const expected = ["timer", "render", "timer", "render", "timer", "render", "timer", "render"];
        expect(a.trace).toEqual(expected);
        expect(b.trace).toEqual(expected);
        // 关键点：每次 render 之后紧跟一次定时器（而不是"先等定时器再 render"）
        expect(a.trace.join(",")).not.toMatch(/^render/); // 起点是 schedule（main.js:2366）
    });

    it("6) 两侧 elapsed 起止位置一致：从第 1 帧 render 结束 到 第 N 帧 render 结束", async () => {
        const FR = 10;
        const a = new FakeScheduler();
        const b = new FakeScheduler();
        const p1 = runFluxLoop(FR, 0, a.hooks());
        a.runAll();
        const got = await p1;
        const p2 = runFluxLoopReference(FR, 0, b.hooks());
        b.runAll();
        const want = await p2;
        const cycle = a.timerDelayMs + a.renderCostMs; // 1.25
        expect(got.startMs).toBeCloseTo(cycle, 6); // 不含首帧 render 耗时
        expect(got.endMs).toBeCloseTo(FR * cycle, 6);
        expect(got.elapsedMs).toBeCloseTo((FR - 1) * cycle, 6); // 只覆盖 N-1 个周期
        expect(got.startMs).toBeCloseTo(want.startMs, 9);
        expect(got.endMs).toBeCloseTo(want.endMs, 9);
        expect(got.elapsedMs).toBeCloseTo(want.elapsedMs, 9);
    });

    it("7) 两侧 FPS 公式一致：fps = frames / (elapsed/1000)", async () => {
        const FR = 10;
        const cycle = 1.25;
        const a = new FakeScheduler();
        const b = new FakeScheduler();
        const p1 = runFluxLoop(FR, 0, a.hooks());
        a.runAll();
        const got = await p1;
        const p2 = runFluxLoopReference(FR, 0, b.hooks());
        b.runAll();
        const want = await p2;
        expect(got.fps).toBeCloseTo(FR / (((FR - 1) * cycle) / 1000), 9);
        expect(got.fps).toBeCloseTo(want.fps, 9);
        expect(got.frames / (got.elapsedMs / 1000)).toBeCloseTo(got.fps, 9);
    });

    it("12) 页面隐藏 / 上下文丢失时该轮作废（frames 少于请求值且带 abortedReason）", async () => {
        for (const [reason, stopAfter] of [
            ["hidden", 5],
            ["context-lost", 7],
        ] as const) {
            const a = new FakeScheduler();
            const p = runFluxLoop(
                300,
                0,
                a.hooks(() => (a.trace.filter((t) => t === "render").length >= stopAfter ? reason : null)),
            );
            a.runAll();
            const res = await p;
            expect(res.abortedReason).toBe(reason);
            expect(res.frames).toBe(stopAfter);
            expect(res.frames).toBeLessThan(res.requested);
        }
    });

    it("11) 测量窗口内不接触 DOM：harness 只能读到 render/schedule/now/shouldAbort", async () => {
        const a = new FakeScheduler();
        const baseHooks = a.hooks();
        const touched = new Set<string>();
        const guarded = new Proxy(baseHooks, {
            get(target, prop) {
                if (typeof prop === "string") {
                    touched.add(prop);
                    if (prop === "document" || prop === "window" || prop === "innerHTML" || prop === "style") {
                        throw new Error(`harness 不得访问 ${prop}`);
                    }
                }
                return Reflect.get(target, prop) as unknown;
            },
        });
        const p = runFluxLoop(6, 0, guarded);
        a.runAll();
        await p;
        expect([...touched].sort()).toEqual(["now", "render", "schedule", "shouldAbort"]);
        const src = readFileSync(fileURLToPath(new URL("./bench-flux-protocol.ts", import.meta.url)), "utf-8");
        // 允许的 DOM 访问：**只读** visibilityState（用于 hidden ⇒ 本轮作废）。
        // 禁止的是任何 DOM **写**：因此这里守卫的是写操作模式，而不是出现 "document." 字样。
        expect(src).not.toMatch(
            /innerHTML|\.style\b|createElement|getElementById|appendChild|textContent\s*=|body\.|document\.write/,
        );
    });
});

// ─────────────────────────────────────────────────────────── 8（分辨率）
describe("分辨率协议（flux-native / flux-fixed）", () => {
    it("8a) force=1600x1063 → flux-fixed，且强制尺寸被记录", () => {
        const s = spec("?proto=flux&force=1600x1063");
        expect(s.resolutionMode).toBe("flux-fixed");
        expect(s.forcedRes).toEqual({ w: 1600, h: 1063 });
        expect(s.overrides).toContain("force=1600x1063");
        expect(s.protocolMatched).toBe(true); // 帧数/分辨率属协议允许变体
    });

    it("8b) 显式 res=1600x1063 也进入 flux-fixed；不给则保持 flux-native", () => {
        expect(spec("?proto=flux&res=1600x1063").resolutionMode).toBe("flux-fixed");
        expect(spec("?proto=flux&res=1600x1063").overrides).toContain("res=1600x1063");
        expect(spec("?proto=flux").resolutionMode).toBe("flux-native");
    });

    it("8c) flux-native 复刻官方画布策略：字节/32 > 500000 → 1×CSS，否则 CSS×DPR", () => {
        // 官方 main.js:1551-1552：downsample = rows > 500000 ? 1 : 1/dpr
        expect(fluxNativeDownsample(10_000_000, 2)).toBeCloseTo(0.5, 12); // 312500 行 → 降采样
        expect(fluxNativeDownsample(20_000_000, 2)).toBe(1); // 625000 行 → 不降采样
        expect(fluxNativeDownsample(16_000_000, 3)).toBeCloseTo(1 / 3, 12); // 恰好 500000 行 → 官方是严格 `>`，故仍降采样
        expect(fluxNativeDownsample(16_000_032, 3)).toBe(1); // 500001 行 → 不降采样
        expect(fluxNativeBufferSize(400, 800, 10_000_000, 2)).toEqual({ w: 800, h: 1600 });
        expect(fluxNativeBufferSize(400, 800, 20_000_000, 2)).toEqual({ w: 400, h: 800 });
        expect(spec("?proto=flux").adaptiveResolution).toBe(false); // 本方法没有自适应分辨率
    });

    it("8d) 焦距口径：fixed 直接用 Flux 焦距；native 按 bufferW/cssW 缩放（保证 FOV 相同）", () => {
        const fixed = spec("?proto=flux&force=1600x1063");
        expect(replicationFocalPx(fixed, 1600, 1600)).toBeCloseTo(FLUX_FOCAL_PX, 9);
        const native = spec("?proto=flux");
        expect(replicationFocalPx(native, 800, 400)).toBeCloseTo(FLUX_FOCAL_PX * 2, 9);
        expect(replicationFocalPx(native, 400, 400)).toBeCloseTo(FLUX_FOCAL_PX, 9);
    });

    it("8e) 分辨率审计块字段齐全，且判定只比较渲染分辨率（CSS 不参与）", () => {
        const audit: ResolutionAudit = resolutionAuditFrom(
            { width: 1600, height: 1063, clientWidth: 800, clientHeight: 531 },
            { drawingBufferWidth: 1600, drawingBufferHeight: 1063, viewport: [0, 0, 1600, 1063] },
            2,
            "flux-fixed",
        );
        expect(audit).toEqual({
            canvasWidth: 1600,
            canvasHeight: 1063,
            drawingBufferWidth: 1600,
            drawingBufferHeight: 1063,
            viewport: [0, 0, 1600, 1063],
            cssWidth: 800,
            cssHeight: 531,
            devicePixelRatio: 2,
            internalRenderScale: 1,
            adaptiveResolution: false,
            resolutionMode: "flux-fixed",
        });
        const sameBufferOtherCss: ResolutionAudit = { ...audit, cssWidth: 0, cssHeight: 0, devicePixelRatio: 0 };
        expect(resolutionAuditMatches(audit, sameBufferOtherCss)).toBe(true);
        const otherBuffer: ResolutionAudit = { ...audit, drawingBufferWidth: 1599 };
        expect(resolutionAuditMatches(audit, otherBuffer)).toBe(false);
        const otherViewport: ResolutionAudit = { ...audit, viewport: [0, 0, 800, 531] };
        expect(resolutionAuditMatches(audit, otherViewport)).toBe(false);
    });

    it("8f) 示例：两边都是 1600×1063 的审计块逐字段相等", () => {
        const make = (cssW: number, dpr: number): ResolutionAudit =>
            resolutionAuditFrom(
                { width: 1600, height: 1063, clientWidth: cssW, clientHeight: 0 },
                { drawingBufferWidth: 1600, drawingBufferHeight: 1063, viewport: [0, 0, 1600, 1063] },
                dpr,
                "flux-fixed",
            );
        expect(resolutionAuditMatches(make(1600, 1), make(1600, 0))).toBe(true);
        expect(resolutionAuditKey(make(1600, 1))).toBe("1600x1063x1600x1063x0,0,1600,1063");
    });
});

// ─────────────────────────────────────────────────────────── 9（相机哈希）
describe("相机对齐（view matrix 哈希）", () => {
    const cameraFile = JSON.parse(
        readFileSync(fileURLToPath(new URL("./bench-flux-camera.json", import.meta.url)), "utf-8"),
    ) as { focal_px: number; default_view: { view_matrix: number[] } };

    it("9a) 资产里的焦距就是 Flux 源码里的 COLMAP 焦距", () => {
        expect(cameraFile.focal_px).toBeCloseTo(FLUX_FOCAL_PX, 9);
        expect(cameraFile.default_view.view_matrix).toHaveLength(16);
    });

    it("9b) 相同矩阵 → 相同哈希；1e-4 的扰动 → 不同哈希", () => {
        const v = cameraFile.default_view.view_matrix;
        expect(viewMatrixHash(v)).toBe(viewMatrixHash([...v]));
        expect(viewMatrixHash(v)).toBeLessThan(2 ** 32);
        const drifted = [...v];
        drifted[12] += 1e-4; // 平移分量动了 0.0001（远小于 1e-3，仍应相同）
        expect(viewMatrixHash(drifted)).toBe(viewMatrixHash(v));
        const moved = [...v];
        moved[12] += 0.01; // 动了 0.01 → 必须不同
        expect(viewMatrixHash(moved)).not.toBe(viewMatrixHash(v));
    });

    it("9c) viewMatrixMatches：逐项 1e-3 容差判定（两边哈希不同即该轮无效）", () => {
        const v = cameraFile.default_view.view_matrix;
        expect(viewMatrixMatches(v, [...v])).toBe(true);
        expect(
            viewMatrixMatches(
                v,
                v.map((x, i) => (i === 0 ? x + 5e-4 : x)),
            ),
        ).toBe(true);
        expect(
            viewMatrixMatches(
                v,
                v.map((x, i) => (i === 0 ? x + 5e-3 : x)),
            ),
        ).toBe(false);
        expect(viewMatrixMatches(v.slice(0, 15), v)).toBe(false);
    });

    it("9d) 相机冻结在协议里是硬性的（proto=flux ⇒ cameraFrozen=true）", () => {
        expect(spec("?proto=flux").cameraFrozen).toBe(true);
        expect(spec("?proto=flux&driver=raf").cameraFrozen).toBe(true);
    });
});

// ─────────────────────────────────────────────────────── 13（timer 节拍条件判定 + 投影 FOV 对齐）
describe("timer 节拍（条件判定）与投影 FOV 对齐", () => {
    it("13a) timerClampObserved 只在**实测到** ~4ms 聚集时为 true", async () => {
        expect(timerClampObservedFrom([])).toBe(false);
        expect(timerClampObservedFrom(new Array(29).fill(4))).toBe(false); // 样本不足（<30）
        expect(timerClampObservedFrom(new Array(300).fill(4))).toBe(true);
        expect(timerClampObservedFrom(new Array(300).fill(1))).toBe(false); // 没观测到节拍
        expect(timerClampObservedFrom([...new Array(150).fill(4), ...new Array(150).fill(16)])).toBe(true); // 恰好 50%
        expect(timerClampObservedFrom([...new Array(140).fill(4), ...new Array(160).fill(16)])).toBe(false);

        const clamped = new FakeScheduler();
        clamped.timerDelayMs = 4;
        const p1 = runFluxLoop(300, 0, clamped.hooks());
        clamped.runAll();
        const r1 = await p1;
        expect(r1.timerClampObserved).toBe(true);
        expect(r1.gapCount).toBe(299);
        expect(r1.gapMedMs).toBeCloseTo(4.25, 6);
        expect(r1.gapP95Ms).toBeCloseTo(4.25, 6);

        const slow = new FakeScheduler();
        slow.timerDelayMs = 16;
        const p2 = runFluxLoop(300, 0, slow.hooks());
        slow.runAll();
        const r2 = await p2;
        expect(r2.timerClampObserved).toBe(false); // 没有 4ms 聚集 ⇒ 不得标 timerClampObserved
        expect(r2.gapMedMs).toBeCloseTo(16.25, 6);
    });

    it("13b) 两份实现的 gap 统计一致（同一诊断口径，不参与计时）", async () => {
        const a = new FakeScheduler();
        const b = new FakeScheduler();
        const p1 = runFluxLoop(50, 0, a.hooks());
        a.runAll();
        const got = await p1;
        const p2 = runFluxLoopReference(50, 0, b.hooks());
        b.runAll();
        const want = await p2;
        expect(got.gapCount).toBe(want.gapCount);
        expect(got.gapMedMs).toBeCloseTo(want.gapMedMs, 9);
        expect(got.gapP95Ms).toBeCloseTo(want.gapP95Ms, 9);
        expect(got.timerClampObserved).toBe(want.timerClampObserved);
    });

    it("13c) 投影对齐只比 FOV 项（整矩阵因两边 near/far 不同必然不可比）", () => {
        const f = FLUX_FOCAL_PX;
        expect(projectionFovKey(f, f, 1600, 1063)).toBe(
            `${((2 * f) / 1600).toFixed(6)},${((2 * f) / 1063).toFixed(6)}`,
        );
        expect(projectionFovKey(f, f, 1600, 1063).split(",")).toHaveLength(2); // key 结构里不含 near/far
        expect(projectionFovMatches(projectionFovKey(f, f, 1600, 1063), projectionFovKey(f, f, 1600, 1063))).toBe(true);
        expect(projectionFovMatches(projectionFovKey(f, f, 1600, 1063), projectionFovKey(f, f, 1599, 1063))).toBe(
            false,
        );
        expect(projectionFovHash(f, f, 1600, 1063)).toBe(projectionFovHash(f, f, 1600, 1063));
        expect(projectionFovHash(f, f, 1600, 1063)).not.toBe(projectionFovHash(f, f, 1600, 1062));
        // native 模式下本方法把焦距按 bufferW/cssW 缩放，FOV 项与官方（CSS 基准）严格相同
        const native = spec("?proto=flux");
        const scaled = replicationFocalPx(native, 800, 400);
        expect(projectionFovKey(scaled, scaled, 800, 800)).toBe(projectionFovKey(f, f, 400, 400));
    });
});

// ─────────────────────────────────────────────────── 14（父页面字段传递：防止新增字段被静默丢掉）
describe("父页面结果传递（回归守卫：曾出现 res=x / view_hash= 空值）", () => {
    const benchSrc = readFileSync(fileURLToPath(new URL("./bench.ts", import.meta.url)), "utf-8");

    it("14a) 子页面结果必须**整体覆盖**到父页面结果对象，而不是逐字段列举", () => {
        expect(benchSrc).toContain("Object.assign(out, clean);");
        // 旧的逐字段写法一旦回归，新增口径字段就会再次变成空值
        expect(benchSrc).not.toMatch(/out\.resW = clean\.resW;/);
        expect(benchSrc).not.toMatch(/out\.firstFrameCoveredPct = clean\.firstFrameCoveredPct;/);
    });

    it("14b) 新口径字段都在 sanitize 白名单里（否则会被 sanitize 丢掉）", () => {
        for (const key of [
            "canvasW",
            "drawingBufferW",
            "viewport",
            "viewHash",
            "camFrozen",
            "focalPx",
            "projectionFovKey",
            "projectionFovHash",
            "timerGapMedMs",
            "timerGapP95Ms",
            "visibilityState",
            "metric",
        ]) {
            expect(benchSrc).toContain(`"${key}"`);
        }
    });
});
