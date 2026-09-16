/**
 * bench-flux-adapter.test.ts — 阶段 8B 适配器**行为测试**（fake iframe/原语/事实流，不创建真实 DOM/WebGL）。
 * 覆盖：URL 注入幂等、session fail-closed、能力诚实降级、排序 token 关联、
 *      renderStaticFrame 走 frameStatic、异 session 事实隔离、dispose 清理与幂等、workload 显式失败。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FluxGsAdapter, injectBridgeParams } from "./bench-flux-adapter";
import type { FluxBenchPrimitives, FluxIframeHandle } from "./bench-flux-adapter";
import type { AnchorSet } from "./bench-audit";
import type { BenchmarkConfig } from "./bench-controller";

const VIEW = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const CONFIG: BenchmarkConfig = {
    warmupFrames: 5,
    measureFrames: 30,
    yieldMode: "none",
    batchSize: 1,
    width: 1600,
    height: 1063,
    cameraStatic: true,
};

type Listener = (e: { data: unknown }) => void;
interface FakeWindow {
    devicePixelRatio: number;
    __fxbenchAuthorize?: (input: unknown) => boolean;
    addEventListener: (t: string, h: Listener) => void;
    removeEventListener: (t: string, h: Listener) => void;
    dispatch: (data: unknown) => void;
    listenerCount: () => number;
}

let fakeWin: FakeWindow;
const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
    const listeners: Listener[] = [];
    fakeWin = {
        devicePixelRatio: 2,
        addEventListener: (_t, h) => void listeners.push(h),
        removeEventListener: (_t, h) => {
            const i = listeners.indexOf(h);
            if (i >= 0) listeners.splice(i, 1);
        },
        dispatch: (data) => {
            for (const h of [...listeners]) h({ data });
        },
        listenerCount: () => listeners.length,
    };
    (globalThis as { window?: unknown }).window = fakeWin;
});

afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
});

interface Harness {
    adapter: FluxGsAdapter;
    prims: FluxBenchPrimitives;
    urls: string[];
    posted: Record<string, unknown>[];
    cams: number[][];
    frames: { once: number; static: number; finish: number };
    sortRequestedArgs: Array<{ serial: number; view: number[] }>;
    removed: () => number;
    sessionFromUrl: () => string;
}

function makeHarness(opts?: {
    withFrameStatic?: boolean;
    withFinishGpu?: boolean;
    sessionOverride?: string | null;
    stats?: { vertexCount: number; loaded?: boolean };
}): Harness {
    const urls: string[] = [];
    const posted: Record<string, unknown>[] = [];
    const cams: number[][] = [];
    const frames = { once: 0, static: 0, finish: 0 };
    const sortRequestedArgs: Array<{ serial: number; view: number[] }> = [];
    let removed = 0;
    const prims: FluxBenchPrimitives = {
        session: "unset",
        sortRequested: (serial, view) => {
            sortRequestedArgs.push({ serial, view: [...view] });
            return true;
        },
        frameOnce: (view16) => {
            frames.once++;
            handle.contentWindow?.__FLUXGS_SET_CAM__?.(view16); // 与 vendor:frameOnce 行为一致（设相机 + 单帧）
            return true;
        },
        contextLost: () => true,
        dispose: () => true,
        getViewMatrix: () => [...VIEW],
    };
    if (opts?.withFrameStatic) {
        prims.frameStatic = () => {
            frames.static++;
            // 与 vendor 一致（[H22-A]）：返回**同步归属描述**（本帧真实 draw 的 serial/view），而不是布尔
            const last = sortRequestedArgs[sortRequestedArgs.length - 1];
            return { drawn: true, serial: last ? last.serial : null, viewMatrix: [...VIEW] };
        };
    }
    if (opts?.withFinishGpu) {
        prims.finishGpu = () => {
            frames.finish++;
            return true;
        };
    }
    if (opts && "stats" in opts) {
        const s = opts.stats;
        prims.stats = () => s as { vertexCount: number; loaded?: boolean };
    }
    const handle: FluxIframeHandle = {
        contentWindow: {
            postMessage: (m) => void posted.push(m as Record<string, unknown>),
            __FLUXGS_SET_CAM__: (v) => {
                cams.push([...v]);
                return true;
            },
        },
        remove: () => {
            removed++;
        },
    };
    const sessionFromUrl = (): string => {
        const last = urls[urls.length - 1] ?? "";
        return new URLSearchParams(last.split("?")[1] ?? "").get("fxsession") ?? "";
    };
    const adapter = new FluxGsAdapter({
        sessionId: "parent-session",
        scene: {
            id: "truck",
            dataset: "tnt",
            modelUrl: "flux-gs-project-gh-pages/render_truck/index.html",
            iframeUrl: "bench-case.html?scene=truck",
        },
        modelSource: {
            modelStorageBytes: null,
            networkTransferBytes: null,
            decodedBodyBytes: null,
            modelHash: null,
            modelSourceUrl: null,
            modelSourceCommit: null,
            modelDownloadDate: null,
            rendererSourceCommit: null,
        },
        createIframe: (url) => {
            urls.push(url);
            return handle;
        },
        waitForPrimitives: async () => {
            const s = opts?.sessionOverride === undefined ? sessionFromUrl() : (opts.sessionOverride ?? "");
            prims.session = s;
            return prims;
        },
        hashView: (v) => `h${v[0]}`,
        projectionMatrix: VIEW,
        focalPx: 1159.5880733038064,
        near: 0.1,
        far: 100,
        anchorSet: { file: "test-anchors.json", anchorSetHash: "ah", anchors: [] } as unknown as AnchorSet,
        probe: { bindSortWorker: () => {}, detach: () => {}, getAuthority: () => null },
        readyTimeoutMs: 300,
        log: () => {},
    });
    return { adapter, prims, urls, posted, cams, frames, sortRequestedArgs, removed: () => removed, sessionFromUrl };
}

describe("阶段 8B：FluxGsAdapter 行为（接线与能力）", () => {
    it("1) injectBridgeParams 幂等：bridge=1 / benchres / fxsession 各注入一次", () => {
        const once = injectBridgeParams("bench-case.html?scene=truck", 1600, 1063, "s-1");
        expect(once.split("bridge=1").length - 1).toBe(1);
        expect(once.split("benchres=1600x1063").length - 1).toBe(1);
        expect(once.split("fxsession=s-1").length - 1).toBe(1);
        expect(injectBridgeParams(once, 1600, 1063, "s-1")).toBe(once); // 二次注入不改变
        expect(injectBridgeParams("x.html?bridge=1#tail", 1600, 1063, "s-1")).toContain("#tail");
    });

    it("2) init() 下发父侧 session，并接受匹配的 iframe 原语", async () => {
        const h = makeHarness();
        await h.adapter.init(CONFIG);
        const url = h.urls[0];
        expect(url.split("bridge=1").length - 1).toBe(1);
        expect(url).toContain("benchres=1600x1063");
        expect(url).toContain(`fxsession=${encodeURIComponent(h.sessionFromUrl())}`);
        expect(h.prims.session).toBe(h.sessionFromUrl());
    });

    it("3) session 不一致 ⇒ init() fail closed", async () => {
        const h = makeHarness({ sessionOverride: "another-session" });
        await expect(h.adapter.init(CONFIG)).rejects.toThrow(/session/);
    });

    it("4) capability 诚实降级：无 frameStatic ⇒ staticFrameRenderOnly=false", async () => {
        const noStatic = makeHarness();
        await noStatic.adapter.init(CONFIG);
        expect(noStatic.adapter.capabilities.staticFrameRenderOnly).toBe(false);
        expect(noStatic.adapter.capabilities.sortFreezeSupported).toBe(true);

        const withStatic = makeHarness({ withFrameStatic: true });
        await withStatic.adapter.init(CONFIG);
        expect(withStatic.adapter.capabilities.staticFrameRenderOnly).toBe(true);
    });
});

describe("阶段 8B：FluxGsAdapter 行为（排序/事实/渲染/生命周期）", () => {
    it("5) requestSortOnce 的 serial/view/token 关联一致", async () => {
        const h = makeHarness({ withFrameStatic: true });
        await h.adapter.init(CONFIG);
        const token = await h.adapter.requestSortOnce({
            viewMatrix: VIEW,
            fx: 1159.5880733038064,
            fy: 1159.5880733038064,
        });
        expect(token.forced).toBe(true);
        expect(token.serial).toBeGreaterThan(0);
        expect(token.sortViewProjHash).toBe("h1");
        expect(h.sortRequestedArgs).toHaveLength(1);
        expect(h.sortRequestedArgs[0].serial).toBe(token.serial);
        expect(h.sortRequestedArgs[0].view).toEqual(VIEW);
        const posted = h.posted.find((m) => m.prim === "sort") as { sortSerial: number } | undefined;
        expect(posted).toBeTruthy();
        expect(posted?.sortSerial).toBe(token.serial);
        const audit = h.adapter.getSortAudit();
        expect(audit.requestSerial).toBe(token.serial);
        expect(audit.pendingCount).toBe(1);
        // bridge 模式必须由父侧驱动一次完整帧，worker 才会收到排序请求
        expect(h.frames.once).toBe(1);
        expect(h.cams).toHaveLength(1);
    });

    it("6) renderStaticFrame 走 frameStatic（不得走 frameOnce）；缺 frameStatic 时显式失败", async () => {
        const h = makeHarness({ withFrameStatic: true });
        await h.adapter.init(CONFIG);
        h.adapter.renderStaticFrame();
        expect(h.frames.static).toBe(1);
        expect(h.frames.once).toBe(0);
        expect(h.adapter.getFrameSerial()).toBe(1);

        h.adapter.renderPipelinedFrame();
        expect(h.frames.once).toBe(1);

        const noStatic = makeHarness();
        await noStatic.adapter.init(CONFIG);
        expect(() => noStatic.adapter.renderStaticFrame()).toThrow(/frameStatic/);
    });

    it("7) 异 session 事实不进入 Bridge（不改变任何阶段）", async () => {
        const h = makeHarness({ withFrameStatic: true });
        await h.adapter.init(CONFIG);
        const token = await h.adapter.requestSortOnce({
            viewMatrix: VIEW,
            fx: 1159.5880733038064,
            fy: 1159.5880733038064,
        });
        fakeWin.dispatch({
            __fxbench: true,
            fact: "result-received",
            session: "foreign",
            sortSerial: token.serial,
            viewProj: VIEW,
        });
        const audit = h.adapter.getSortAudit();
        expect(audit.completedSerial).toBe(0);
        expect(audit.uploadedSerial).toBe(0);
        expect(audit.activeSerial).toBe(0);
    });

    it("8) dispose 删除父侧授权函数、移除 iframe 且幂等", async () => {
        const h = makeHarness({ withFrameStatic: true });
        await h.adapter.init(CONFIG);
        expect(typeof fakeWin.__fxbenchAuthorize).toBe("function");
        expect(fakeWin.listenerCount()).toBe(1);
        await h.adapter.dispose();
        expect(fakeWin.__fxbenchAuthorize).toBeUndefined();
        expect(fakeWin.listenerCount()).toBe(0);
        expect(h.removed()).toBe(1);
        await h.adapter.dispose();
        expect(h.removed()).toBe(1); // 幂等：不重复移除
        expect(() => h.adapter.getSortAudit()).not.toThrow();
    });

    it("9) workload 无有效 vertexCount 时显式失败，有值时如实返回", async () => {
        const missing = makeHarness({ withFrameStatic: true, stats: { vertexCount: 0, loaded: true } });
        await missing.adapter.init(CONFIG);
        expect(() => missing.adapter.getWorkloadAudit()).toThrow(/workload/);

        const ok = makeHarness({ withFrameStatic: true, stats: { vertexCount: 12345, loaded: true } });
        await ok.adapter.init(CONFIG);
        expect(ok.adapter.getWorkloadAudit().gaussianTotal).toBe(12345);
    });

    it("10) waitUntilReady 等到 `loaded`/vertexCount 才放行，超时则显式失败", async () => {
        let loaded = false;
        const h = makeHarness({ withFrameStatic: true, stats: { vertexCount: 0, loaded: false } });
        h.prims.stats = () => ({ vertexCount: loaded ? 42 : 0, loaded });
        await h.adapter.init(CONFIG);
        const pending = h.adapter.waitUntilReady();
        setTimeout(() => {
            loaded = true;
        }, 30);
        await expect(pending).resolves.toBeUndefined();

        const never = makeHarness({ withFrameStatic: true, stats: { vertexCount: 0, loaded: false } });
        await never.adapter.init(CONFIG);
        await expect(never.adapter.waitUntilReady()).rejects.toThrow(/超时|loaded/);
    }, 10_000);

    it("11) H17：init 采用 vendor 默认相机；非法 setCamera 保留基线；登记 token 的 view 必为 16 元", async () => {
        const h = makeHarness({ withFrameStatic: true, stats: { vertexCount: 100, loaded: true } });
        await h.adapter.init(CONFIG);
        // 采用 vendor 默认机位（而非空矩阵）
        expect(h.adapter.getCameraAudit().viewMatrix).toEqual(VIEW);

        // controller 首轮会先读 audit 再 setCamera：空矩阵必须被忽略，不得清掉基线
        await h.adapter.setCamera({ viewMatrix: [], fx: 1, fy: 1 });
        expect(h.adapter.getCameraAudit().viewMatrix).toEqual(VIEW);

        // 用 audit 得到的 view 登记 token ⇒ 必须为 16 元且被 vendor 接受
        const auditView = h.adapter.getCameraAudit().viewMatrix;
        const token = await h.adapter.requestSortOnce({ viewMatrix: auditView, fx: 1, fy: 1 });
        expect(h.sortRequestedArgs).toHaveLength(1);
        expect(h.sortRequestedArgs[0].view).toHaveLength(16);
        expect(h.sortRequestedArgs[0].serial).toBe(token.serial);
    });

    it("12) [H22-A] 窗口基线取在 warmup draw **之后**，且 lastDraw 归因**同步**可见（第 1 轮不得误判）", async () => {
        const h = makeHarness({
            withFrameStatic: true,
            withFinishGpu: true,
            stats: { vertexCount: 100, loaded: true },
        });
        await h.adapter.init(CONFIG);
        const token = await h.adapter.requestSortOnce({ viewMatrix: VIEW, fx: 1, fy: 1 });
        // 真实事实序列（非法序列会被 index-uploaded/index-activated 的后验校验 fail-closed）
        for (const fact of ["result-received", "index-uploaded", "index-activated"]) {
            fakeWin.dispatch({
                __fxbench: true,
                fact,
                session: h.prims.session,
                sortSerial: token.serial,
                viewProj: VIEW,
            });
        }
        await h.adapter.freezeSortRequests();
        // 冻结时还没画 ⇒ 基线必须是 fail-closed（不得把"冻结前的 lastDraw"当成本轮 warmup draw）
        expect(h.adapter.getMeasureWindowAudit()?.warmupDrawMissingAtWindowStart).toBe(true);

        h.adapter.renderStaticFrame(); // warmup draw：唯一同步可观测的归因（跨 realm 返回值）
        // controller 在 warmup draw 之后**同步**读这两个值（同一任务、无 await）⇒ 必须已经可见
        const audit = h.adapter.getSortAudit();
        expect(audit.lastDrawSortSerial).toBe(token.serial);
        expect(audit.lastDrawCameraHash).toBe(token.sortViewProjHash);
        const win = h.adapter.getMeasureWindowAudit();
        expect(win?.warmupDrawMissingAtWindowStart).toBe(false);
        expect(win?.activeSortSerialChanged).toBe(false);
        expect(win?.lastDrawSortSerialChanged).toBe(false);
        // 同步归属必须在事实日志留痕（诊断尾部要能一眼看到归因来自同步返回值）
        expect(
            h.adapter.getBridgeEventLog().some((l) => l.includes("draw-completed") && l.includes("sync-return")),
        ).toBe(true);
    });

    it("13) [H22-B] 同步 GPU 排空：缺失 ⇒ fail-closed；存在 ⇒ 真实调用（禁止无 GPU 同步的 fps）", async () => {
        const missing = makeHarness({ withFrameStatic: true });
        await missing.adapter.init(CONFIG);
        expect(() => missing.adapter.finishGpu()).toThrow(/finishGpu/);

        const ok = makeHarness({ withFrameStatic: true, withFinishGpu: true });
        await ok.adapter.init(CONFIG);
        ok.adapter.finishGpu();
        ok.adapter.finishGpu();
        expect(ok.frames.finish).toBe(2); // 每轮 pre/post 各一次，不得退化为 postMessage
    });
});
