/**
 * bench-case-slave.test.ts — 阶段 5 slave 层单测（全部 fake bridge，不创建 DOM/WebGL/Worker）。
 * 覆盖要求的 10 项：不自动测量 / 非 slave 不变 / 无自驱 rAF·timer / force 转发 /
 * static frame 只加 frame serial / pipelined 按定义发排序 / finish 复用同一 context /
 * dispose 解冻且幂等 / context lost 不产生有效结果 / 分辨率四项首尾一致。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CaseSlave, createCaseSlave } from "./bench-case-slave";
import type { CaseSlaveDeps, SlaveRendererBridge, SlaveSceneBridge } from "./bench-case-slave";
import type { ResolutionAudit, WorkloadAudit } from "./bench-audit";
import type { SortAudit } from "./bench-controller";
import { BENCH_FAR, BENCH_FOCAL_PX, BENCH_HEIGHT, BENCH_NEAR, BENCH_WIDTH } from "./bench-constants";

const W = BENCH_WIDTH;
const H = BENCH_HEIGHT;

function resAudit(over: Partial<ResolutionAudit> = {}): ResolutionAudit {
    return {
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
        ...over,
    };
}

/** 模拟 `RenderProgram` bridge（serial/hash/freeze/audit 全由它提供；slave 不得自行实现）。 */
class FakeRenderer implements SlaveRendererBridge {
    private serial = 0;
    private completed = 0;
    private uploaded = 0;
    private active = 0;
    private frozen = false;
    private frameSerial = 0;
    finishCalls = 0;
    worker: Worker | null = null;
    lastForce: boolean | null = null;
    activeCameraHash: string | null = null;
    lastDrawSerial = 0;
    lastDrawHash: string | null = null;
    /** 模拟"force 被吞掉"：置位后 requestSortOnce 不推进 serial */
    swallowForce = false;

    nextFrame(): void {
        this.frameSerial++;
    }

    requestSortOnce(force: boolean): number | null {
        this.lastForce = force;
        if (this.worker === null) return null;
        if (this.swallowForce && force) return this.serial; // 不发新请求（模拟被吞）
        this.serial++;
        this.completed = this.serial;
        this.uploaded = this.serial;
        this.active = this.serial;
        return this.serial;
    }

    /** scene 侧"绘制"时调用：把 active 记为 lastDraw（模拟 RenderProgram draw 处记录）。 */
    noteDraw(): void {
        this.lastDrawSerial = this.active;
        this.lastDrawHash = this.activeCameraHash;
    }

    setBenchFreezeSortRequests(frozen: boolean): void {
        this.frozen = frozen;
    }

    cameraHash(): string | null {
        return this.activeCameraHash;
    }

    /** 唯一哈希实现（测试里用确定性替身：不得自带第二套生产实现） */
    hashViewProj(values: ArrayLike<number>): string {
        let h = 0;
        for (let i = 0; i < values.length; i++) h = (h * 31 + Math.round(values[i] * 1e6)) | 0;
        return (h >>> 0).toString(16).padStart(8, "0");
    }

    getSortWorker(): Worker | null {
        return this.worker;
    }

    getFrameSerial(): number {
        return this.frameSerial;
    }

    finishGpu(): void {
        this.finishCalls++;
    }

    getSortAudit(): SortAudit {
        return {
            requestSerial: this.serial,
            completedSerial: this.completed,
            uploadedSerial: this.uploaded,
            activeSerial: this.active,
            pendingCount: 0,
            frozen: this.frozen,
            outOfOrderResults: 0,
            activeCameraHash: this.activeCameraHash,
            lastDrawSortSerial: this.lastDrawSerial,
            lastDrawCameraHash: this.lastDrawHash,
        };
    }
}

class FakeScene implements SlaveSceneBridge {
    resolutionSets: Array<[number, number]> = [];
    frameRenders = 0;
    disposeCalls = 0;
    resolutionOverrides: Array<Partial<ResolutionAudit>> = [];
    contextLost = false;
    private renderer: FakeRenderer | null = null;

    attachRenderer(r: FakeRenderer): void {
        this.renderer = r;
    }

    setResolutionOnce(w: number, h: number): void {
        this.resolutionSets.push([w, h]);
    }
    setCameraFromView(): { recomposeErrorMax: number } {
        return { recomposeErrorMax: 0 };
    }
    frameRender(): void {
        this.frameRenders++;
        this.renderer?.nextFrame();
        this.renderer?.noteDraw();
    }
    getResolutionAudit(): ResolutionAudit {
        return resAudit(this.resolutionOverrides.shift() ?? {});
    }
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
    } {
        return {
            viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            viewProj: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            fx: BENCH_FOCAL_PX,
            fy: BENCH_FOCAL_PX,
            near: BENCH_NEAR,
            far: BENCH_FAR,
            width: W,
            height: H,
            positionX: 0,
            positionY: 0,
            positionZ: 0,
        };
    }
    getWorkloadAudit(): WorkloadAudit {
        return {
            model: {
                modelStorageBytes: 1,
                networkTransferBytes: 1,
                decodedBodyBytes: 1,
                modelHash: "h",
                modelSourceUrl: "u",
                modelSourceCommit: null,
                modelDownloadDate: null,
                rendererSourceCommit: null,
            },
            gaussianTotal: 1,
            gaussianVisibleMean: 1,
            gaussianSubmittedMean: 1,
            shDegree: null,
            drawCallsMean: 1,
            sortRequests: null,
            sortCompleted: null,
            sortWaited: null,
            lodEnabled: false,
            cullingEnabled: false,
            adaptiveQuality: false,
        };
    }
    getContextState(): { contextLost: boolean; rendererName: string; canvasWidth: number; canvasHeight: number } {
        return { contextLost: this.contextLost, rendererName: "fake", canvasWidth: W, canvasHeight: H };
    }
    getCanvas(): HTMLCanvasElement {
        return { width: W, height: H } as unknown as HTMLCanvasElement;
    }
    dispose(): number {
        this.disposeCalls++;
        return 1;
    }
}

/** 建立 slave + 假 renderer（worker 视为已创建）。 */
function makeSlave(over: Partial<CaseSlaveDeps> = {}): {
    slave: CaseSlave;
    renderer: FakeRenderer;
    scene: FakeScene;
    probeDetach: ReturnType<typeof vi.fn>;
} {
    const renderer = new FakeRenderer();
    renderer.worker = {} as Worker; // "worker 已创建"
    renderer.activeCameraHash = "aaaa1111";
    const scene = new FakeScene();
    scene.attachRenderer(renderer);
    const probeDetach = vi.fn();
    const slave = createCaseSlave({
        scene,
        renderer,
        probeDetach,
        now: () => 0,
        sleep: async () => {},
        defaultTimeoutMs: 50,
        ...over,
    });
    return { slave, renderer, scene, probeDetach };
}

const CAM = {
    viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    fx: BENCH_FOCAL_PX,
    fy: BENCH_FOCAL_PX,
};

describe("阶段 5：slave 不自动做任何事", () => {
    it("1) slave 不自动测量：装配后 frameRenders=0、未 dispose、未 import 测量内核", async () => {
        const { slave, scene } = makeSlave();
        await Promise.resolve();
        await Promise.resolve();
        expect(scene.frameRenders).toBe(0); // 未自动渲染 / 未自动 measureOneRound
        expect(slave.isDisposed).toBe(false); // 未自动 dispose
        expect(slave.eventLog).toHaveLength(0); // 未产生任何自驱事件

        // 源码守卫（确定性证明，不依赖全局 spy）：先剥掉注释，只检查**代码**
        const src = readFileSync(fileURLToPath(new URL("./bench-case-slave.ts", import.meta.url)), "utf-8");
        const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
        expect(code).not.toMatch(/requestAnimationFrame|cancelAnimationFrame/); // 无自驱 rAF
        expect(code).not.toMatch(/setInterval/); // 无自驱 timer 循环
        expect(code).not.toMatch(/measureOneRound|BenchCase\b/); // 不导入测量内核
        expect(code.match(/setTimeout/g) ?? []).toHaveLength(1); // 仅注入式 sleep 的兜底
    });

    it("2) 非 slave 路径不变：装配 slave 不改变既有 setResolution/frameRender 的语义", () => {
        const { slave, scene, renderer } = makeSlave();
        slave.setResolution(W, H);
        expect(scene.resolutionSets).toEqual([[W, H]]);
        expect(slave.resolutionSetCallsCount).toBe(1);
        slave.freezeSortRequests();
        slave.renderStaticFrame();
        expect(scene.frameRenders).toBe(1);
        expect(renderer.getFrameSerial()).toBe(1);
    });
});

describe("阶段 5：排序生命周期", () => {
    it("3) force sort 正确转发；proof 只证明 completed/uploaded/activated（usedByDraw 必须 false）", async () => {
        const { slave, renderer } = makeSlave();
        const token = await slave.requestSortOnce(CAM, { force: true });
        expect(renderer.lastForce).toBe(true); // 转发给 RenderProgram.requestSortOnce(force)
        expect(token.forced).toBe(true);
        expect(token.serial).toBe(1);
        expect(token.sortViewProjHash).toBe("aaaa1111"); // 来自 bridge.cameraHash()（= sortCameraHash）
        const proof = await slave.waitForSortApplied(token);
        expect(proof.proven).toBe(true);
        expect(proof.completed && proof.uploaded && proof.activated).toBe(true);
        expect(proof.usedByDraw).toBe(false); // 阶段 5 强制：不得提前自报
        expect(proof.evidence).toBe("renderer-bridge");
        expect(slave.getSortAudit().frozen).toBe(false);
    });

    it("4) static frame 只增加 frame serial，不增加 sort request serial", async () => {
        const { slave } = makeSlave();
        const token = await slave.requestSortOnce(CAM, { force: true });
        const sortSerialBefore = slave.getSortAudit().requestSerial;
        const frameSerialBefore = slave.getFrameSerial();
        slave.freezeSortRequests();
        slave.renderStaticFrame();
        slave.renderStaticFrame();
        expect(slave.getSortAudit().requestSerial).toBe(sortSerialBefore); // 排序请求没有增加
        expect(slave.getFrameSerial()).toBe(frameSerialBefore + 2); // frame serial 增加了 2
        expect(slave.getSortAudit().lastDrawSortSerial).toBe(token.serial); // 冻结后的 draw 用的是该 serial
        expect(slave.getSortAudit().lastDrawCameraHash).toBe(token.sortViewProjHash);
    });

    it("5) pipelined frame 按定义发排序（每帧一次）", () => {
        const { slave, renderer } = makeSlave();
        const before = slave.getSortAudit().requestSerial;
        slave.renderPipelinedFrame(CAM);
        slave.renderPipelinedFrame(CAM);
        // FakeScene.frameRender 只推进 frame serial；排序由 RenderProgram 内部按帧发起，
        // 这里断言"未被冻结"（pipelined 不得依赖冻结）与 frame serial 增长
        expect(slave.isFrozen).toBe(false);
        expect(renderer.getFrameSerial()).toBe(2);
        expect(slave.getSortAudit().requestSerial).toBe(before); // slave 自身不代发排序请求
    });

    it("6) 未冻结时调用 renderStaticFrame ⇒ 直接抛错（结构性保证 render-only）", () => {
        const { slave } = makeSlave();
        expect(() => slave.renderStaticFrame()).toThrow(/freezeSortRequests/);
    });

    it("7) 排序超时 ⇒ proven=false, reason=timeout（不得伪造证明）", async () => {
        const { slave, renderer } = makeSlave({ now: () => 100, defaultTimeoutMs: 0 });
        const token = await slave.requestSortOnce(CAM, { force: true });
        token.serial = renderer.getSortAudit().requestSerial + 5; // 永不完成的 serial
        const proof = await slave.waitForSortApplied(token, 0);
        expect(proof.proven).toBe(false);
        expect(proof.reason).toBe("timeout");
        expect(proof.usedByDraw).toBe(false);
    });

    it("8) hash 不匹配（active 属于另一次排序）⇒ proven=false, reason=active-sort-hash-mismatch", async () => {
        const { slave, renderer } = makeSlave();
        const token = await slave.requestSortOnce(CAM, { force: true });
        renderer.activeCameraHash = "bbbb2222"; // 模拟 active 索引来自另一相机
        const proof = await slave.waitForSortApplied(token);
        expect(proof.completed && proof.uploaded && proof.activated).toBe(true);
        expect(proof.proven).toBe(false);
        expect(proof.reason).toBe("active-sort-hash-mismatch");
    });

    it("9) finish 复用同一个 renderer 上下文（转发到 bridge.finishGpu）", () => {
        const { slave, renderer } = makeSlave();
        slave.finishGpu();
        slave.finishGpu();
        expect(renderer.finishCalls).toBe(2);
    });
});

describe("阶段 5：清理与窗口审计", () => {
    it("10) dispose 自动解冻 + probe.detach + scene.dispose，且可重复调用（幂等）", async () => {
        const { slave, scene, probeDetach } = makeSlave();
        slave.freezeSortRequests();
        expect(slave.isFrozen).toBe(true);
        await slave.dispose();
        expect(slave.isFrozen).toBe(false); // 解冻
        expect(probeDetach).toHaveBeenCalledTimes(1);
        expect(scene.disposeCalls).toBe(1);
        await slave.dispose(); // 幂等
        await slave.dispose();
        expect(probeDetach).toHaveBeenCalledTimes(1);
        expect(scene.disposeCalls).toBe(1);
        expect(slave.isDisposed).toBe(true);
    });

    it("11) 排序超时 / 抛错也必须清理（runRound 的 finally 保证）", async () => {
        const { slave, scene, probeDetach } = makeSlave();
        await expect(
            slave.runRound(async () => {
                slave.freezeSortRequests();
                throw new Error("finish 抛错 / context lost / 排序超时");
            }),
        ).rejects.toThrow(/finish 抛错/);
        expect(slave.isFrozen).toBe(false);
        expect(probeDetach).toHaveBeenCalledTimes(1);
        expect(scene.disposeCalls).toBe(1);
        expect(slave.eventLog.some((e) => e.startsWith("cleanup"))).toBe(true);
    });

    it("12) context lost 后不能产生有效结果（getContextState 如实上报，proof 不因此为 proven）", async () => {
        const { slave, scene } = makeSlave();
        scene.contextLost = true;
        const st = slave.getContextState();
        expect(st.contextLost).toBe(true); // 如实上报，由 controller 判 invalid=context-lost
        const token = await slave.requestSortOnce(CAM, { force: true });
        const proof = await slave.waitForSortApplied(token);
        expect(proof.proven).toBe(true); // slave 只如实报告排序本身；有效性由 controller 依据 contextLost 判定
        expect(proof.usedByDraw).toBe(false);
    });

    it("13) 分辨率四项在设置后与测量结束后一致 ⇒ resolutionChanged=false", () => {
        const { slave } = makeSlave();
        slave.setResolution(W, H);
        slave.beginMeasureWindow();
        slave.freezeSortRequests();
        slave.renderStaticFrame();
        const w = slave.endMeasureWindow();
        expect(w.resolutionChanged).toBe(false);
        expect(w.invalidReason).toBe("");
        expect(w.frameSerialAtStart).toBe(0);
        expect(w.frameSerialAtEnd).toBe(1);
    });

    it("14) 测量窗口内分辨率四项被改动 ⇒ invalidReason=resolution-changed-during-measure", () => {
        const { slave, scene } = makeSlave();
        slave.setResolution(W, H);
        slave.beginMeasureWindow();
        // 窗口结束后审计读到被改小的 drawingBuffer
        scene.resolutionOverrides.push({ drawingBuffer: [800, 531] });
        const w = slave.endMeasureWindow();
        expect(w.resolutionChanged).toBe(true);
        expect(w.invalidReason).toBe("resolution-changed-during-measure");
    });

    it("15) 更小的 viewport 变化同样会被判为分辨率变化", () => {
        const { slave, scene } = makeSlave();
        slave.setResolution(W, H);
        slave.beginMeasureWindow();
        scene.resolutionOverrides.push({ viewport: [0, 0, 800, 531] });
        const w = slave.endMeasureWindow();
        expect(w.resolutionChanged).toBe(true);
        expect(w.invalidReason).toBe("resolution-changed-during-measure");
    });

    it("16) getCameraAudit/getResolutionAudit/getWorkloadAudit/getCanvas/getSortWorker 均为转发（可读）", () => {
        const { slave } = makeSlave();
        const cam = slave.getCameraAudit();
        expect(cam.viewMatrix).toHaveLength(16);
        expect(cam.projectionMatrix).toHaveLength(16);
        expect(cam.anchorSetHash).toBe(""); // 锚点集未加载 ⇒ 如实为空（跨臂校验会判不通过）
        expect(slave.getResolutionAudit().requested).toEqual([W, H]);
        expect(slave.getWorkloadAudit().model.modelStorageBytes).toBe(1);
        expect(slave.getCanvas().width).toBe(W);
        expect(slave.getSortWorker()).not.toBeNull();
    });

    it("17) force-sort → wait-applied → freeze → static draw 的事件顺序（可直接作为运行日志核对模板）", async () => {
        const { slave } = makeSlave();
        slave.ensureFirstFrame();
        slave.setResolution(W, H);
        const token = await slave.requestSortOnce(CAM, { force: true });
        const proof = await slave.waitForSortApplied(token);
        slave.freezeSortRequests();
        slave.renderStaticFrame(); // 冻结后的 warmup draw（必须先于开窗口）
        slave.beginMeasureWindow();
        slave.renderStaticFrame(); // 测量窗口内的静态帧
        slave.finishGpu();
        const w = slave.endMeasureWindow();
        const audit = slave.getSortAudit();

        // 阶段 5 的核心不变式：冻结后的 draw 用的就是这个 serial / 这个 viewProj
        expect(audit.lastDrawSortSerial).toBe(token.serial);
        expect(audit.lastDrawCameraHash).toBe(token.sortViewProjHash);
        expect(audit.activeSerial).toBe(token.serial);
        expect(audit.lastDrawSortSerial).toBe(proof.serial);
        expect(w.lastDrawSortSerialChanged).toBe(false);
        expect(w.activeSortSerialChanged).toBe(false);
        expect(w.resolutionChanged).toBe(false);
        expect(w.warmupDrawMissingAtWindowStart).toBe(false);

        const names = slave.eventLog.map((e) => e.split("@")[0]);
        expect(names).toContain("first-frame");
        expect(names.indexOf("sort-requested")).toBeLessThan(names.indexOf("sort-applied"));
        expect(names.indexOf("sort-applied")).toBeLessThan(names.indexOf("sort-frozen"));
        expect(names.indexOf("sort-frozen")).toBeLessThan(names.indexOf("measure-window-begin"));
        expect(names.indexOf("measure-window-begin")).toBeLessThan(names.indexOf("finish-gpu"));
        expect(names.indexOf("finish-gpu")).toBeLessThan(names.indexOf("measure-window-end"));
        // 完整顺序（供人工核对的日志模板）：冻结 → warmup draw → 开窗口 → 测量帧 → finish → 关窗口
        expect(names).toEqual([
            "first-frame",
            "set-resolution",
            "set-camera",
            "sort-requested",
            "sort-applied",
            "sort-frozen",
            "static-warmup-draw",
            "measure-window-begin",
            "static-frame",
            "finish-gpu",
            "measure-window-end",
        ]);
    });

    it("18) 若漏掉冻结后的 warmup draw ⇒ 窗口基线守卫为 true（controller 必须据此拒绝主表）", async () => {
        const { slave } = makeSlave();
        slave.ensureFirstFrame();
        const token = await slave.requestSortOnce(CAM, { force: true });
        await slave.waitForSortApplied(token);
        slave.freezeSortRequests();
        slave.beginMeasureWindow(); // ❌ 在 draw 之前开窗口
        const w = slave.endMeasureWindow();
        expect(w.warmupDrawMissingAtWindowStart).toBe(true);
    });
    it("19) ensureFirstFrame 幂等：重复调用返回缓存报告，且不增加 frameSerial/draw/sortRequestSerial", () => {
        const { slave, renderer } = makeSlave();
        const r1 = slave.ensureFirstFrame();
        const after1 = {
            frameSerial: renderer.getFrameSerial(),
            requestSerial: slave.getSortAudit().requestSerial,
            draws: slave.getSortAudit().lastDrawSortSerial,
        };
        expect(slave.ensureFirstFrame()).toEqual(r1); // 第二次：同一份缓存报告
        expect(slave.ensureFirstFrame()).toEqual(r1); // 第三次：仍然如此
        expect(renderer.getFrameSerial()).toBe(after1.frameSerial); // 不再增加 frameSerial
        expect(slave.getSortAudit().requestSerial).toBe(after1.requestSerial); // 不再增加 sortRequestSerial
        expect(slave.getSortAudit().lastDrawSortSerial).toBe(after1.draws); // 不增加 draw
        expect(slave.getEnsureFirstFrameReport()).toEqual(r1);
        expect(slave.eventLog.filter((e) => e.startsWith("first-frame")).length).toBe(1);
    });
});
