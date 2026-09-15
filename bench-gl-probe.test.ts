/**
 * bench-gl-probe.test.ts — 探针单测（fake GL / fake Worker / fake window，不创建真实 WebGL 与 Worker）。
 * 覆盖条件 4（作用域归因）与条件 1（排序请求/完成观测）。
 */
import { describe, expect, it } from "vitest";
import { GlProbe, emptyProbeCounters } from "./bench-gl-probe";
import type { ProbeCounters } from "./bench-gl-probe";
import type { WindowCounters } from "./bench-controller";

class FakeGl {
    draws: Array<{ name: string; args: unknown[] }> = [];
    uploads: number[] = [];
    finishCalls = 0;

    drawArraysInstanced(...args: unknown[]): void {
        this.draws.push({ name: "drawArraysInstanced", args });
    }
    drawElementsInstanced(...args: unknown[]): void {
        this.draws.push({ name: "drawElementsInstanced", args });
    }
    drawArrays(...args: unknown[]): void {
        this.draws.push({ name: "drawArrays", args });
    }
    drawElements(...args: unknown[]): void {
        this.draws.push({ name: "drawElements", args });
    }
    bufferData(...args: unknown[]): void {
        const data = args[1];
        this.uploads.push(
            ArrayBuffer.isView(data) || data instanceof ArrayBuffer ? (data as ArrayBufferView).byteLength : 0,
        );
    }
    bufferSubData(...args: unknown[]): void {
        const data = args[2];
        this.uploads.push(
            ArrayBuffer.isView(data) || data instanceof ArrayBuffer ? (data as ArrayBufferView).byteLength : 0,
        );
    }
    finish(): void {
        this.finishCalls++;
    }
}

class FakeWorker {
    private handler: ((ev: { data?: unknown }) => void) | null = null;
    sent: unknown[] = [];

    postMessage(msg: unknown): void {
        this.sent.push(msg);
    }
    get onmessage(): ((ev: { data?: unknown }) => void) | null {
        return this.handler;
    }
    set onmessage(fn: ((ev: { data?: unknown }) => void) | null) {
        this.handler = fn;
    }
}

class FakeWindow {
    rafQueue: Array<(t: number) => void> = [];
    rafRequests = 0;

    requestAnimationFrame(cb: (t: number) => void): number {
        this.rafRequests++;
        this.rafQueue.push(cb);
        return this.rafRequests;
    }
    fireRaf(t = 0): void {
        const q = [...this.rafQueue];
        this.rafQueue = [];
        for (const cb of q) cb(t);
    }
    setTimeout(cb: () => void): number {
        void cb;
        return 1;
    }
}

function makeProbe(): { probe: GlProbe; gl: FakeGl; win: FakeWindow; workerClass: typeof FakeWorker } {
    const probe = new GlProbe();
    const gl = new FakeGl();
    const win = new FakeWindow();
    // 每个测试用**独立的 Worker 类**：避免多个 probe 共享同一个 prototype 造成跨测试污染
    const workerClass = class extends FakeWorker {};
    probe.attach({ gl, workerProto: workerClass.prototype, rafOwner: win, timerOwner: win });
    return { probe, gl, win, workerClass };
}

/** 供"只统计绑定实例"等测试使用的独立 Worker 类。 */
function freshWorkerClass(): { new (): FakeWorker } {
    return class extends FakeWorker {};
}

describe("GlProbe：基本契约", () => {
    it("snapshotWindow 满足 WindowCounters 形状；完整快照含诊断字段", () => {
        const probe = new GlProbe();
        const base: WindowCounters = probe.snapshotWindow();
        expect(Object.keys(base).sort()).toEqual(
            [
                "drawCalls",
                "drawCallsPerFrame",
                "drawInstances",
                "indexBufferUploads",
                "rafCalls",
                "sortCompleted",
                "sortRequests",
                "timerSchedules",
                "unexpectedDrawCalls",
                "unexpectedFrameCallbacks",
            ].sort(),
        );
        const full: ProbeCounters = emptyProbeCounters();
        expect(full.finishCalls).toBe(0);
        expect(full.scopeMismatches).toBe(0);
    });

    it("窗口外的活动不计入（openWindow 重置窗口计数）", () => {
        const { probe, gl, win } = makeProbe();
        gl.drawArraysInstanced(0, 0, 4, 100);
        win.requestAnimationFrame(() => {});
        win.fireRaf();
        probe.openWindow();
        expect(probe.snapshotWindow().drawCalls).toBe(0);
        expect(probe.snapshotWindow().unexpectedFrameCallbacks).toBe(0);
    });
});

describe("GlProbe：draw 作用域归因（条件 4）", () => {
    it("每个 draw 记录所属 frameSerial；同一帧多次 draw 合法", () => {
        const { probe, gl } = makeProbe();
        probe.openWindow();
        probe.beginControlledFrame(1);
        gl.drawArraysInstanced(0, 0, 4, 610000);
        gl.drawArraysInstanced(0, 0, 4, 610000);
        probe.endControlledFrame(1);
        probe.beginControlledFrame(2);
        gl.drawArraysInstanced(0, 0, 4, 500000);
        probe.endControlledFrame(2);

        const w = probe.snapshotWindow();
        expect(w.drawCalls).toBe(3);
        expect(w.drawInstances).toBe(610000 * 2 + 500000);
        expect(w.drawCallsPerFrame).toEqual([2, 1]);
        expect(w.unexpectedDrawCalls).toBe(0);
        expect(probe.drawCallsOfFrame(1)).toBe(2);
        expect(probe.drawCallsOfFrame(2)).toBe(1);
        expect(probe.snapshotWindowFull().drawSerials).toEqual([1, 2]);
    });

    it("作用域之外的 draw ⇒ unexpectedDrawCalls（不做简单相减）", () => {
        const { probe, gl } = makeProbe();
        probe.openWindow();
        probe.beginControlledFrame(1);
        gl.drawArraysInstanced(0, 0, 4, 1000);
        probe.endControlledFrame(1);
        gl.drawArraysInstanced(0, 0, 4, 1000); // 越权
        probe.beginControlledFrame(2);
        gl.drawElementsInstanced(0, 6, 0, 0, 7); // 7 个实例
        probe.endControlledFrame(2);

        const w = probe.snapshotWindow();
        expect(w.drawCalls).toBe(3);
        expect(w.unexpectedDrawCalls).toBe(1);
        expect(w.drawCallsPerFrame).toEqual([1, 1]);
        expect(w.drawInstances).toBe(1000 + 1000 + 7);
    });

    it("作用域括号不匹配 ⇒ scopeMismatches（应为 0）", () => {
        const { probe } = makeProbe();
        probe.openWindow();
        probe.endControlledFrame();
        probe.beginControlledFrame(1);
        probe.endControlledFrame(2);
        expect(probe.snapshotWindowFull().scopeMismatches).toBe(2);
    });
});

describe("GlProbe：排序与 GPU 同步（条件 1）", () => {
    it("postMessage=排序请求；带 depthIndex 的入站消息=排序完成；pendingSorts 可见", () => {
        const { probe, workerClass } = makeProbe();
        const worker = new workerClass();
        const received: unknown[] = [];
        worker.onmessage = (ev) => received.push(ev.data);

        probe.openWindow();
        expect(probe.pendingSorts()).toBe(0);
        worker.postMessage({ viewProj: new Float32Array(16) });
        worker.postMessage({ viewProj: new Float32Array(16) });
        expect(probe.pendingSorts()).toBe(2);
        expect(probe.snapshotWindow().sortRequests).toBe(2);

        worker.onmessage?.({ data: { depthIndex: new Uint32Array(3) } });
        expect(probe.pendingSorts()).toBe(1);
        expect(probe.snapshotWindow().sortCompleted).toBe(1);
        expect(received).toHaveLength(1); // 原 handler 仍被调用

        worker.onmessage?.({ data: { somethingElse: 1 } });
        expect(probe.snapshotWindowFull().workerInboundOther).toBe(1);
        expect(probe.pendingSorts()).toBe(1);
    });

    it("bufferData/bufferSubData 计入 indexBufferUploads 与字节数；finish 计入 finishCalls", () => {
        const { probe, gl } = makeProbe();
        probe.openWindow();
        gl.bufferData(0, new Uint32Array(610000), 0);
        gl.bufferSubData(0, 0, new Float32Array(4));
        gl.finish();
        const w = probe.snapshotWindowFull();
        expect(w.indexBufferUploads).toBe(2);
        expect(w.bufferUploadBytes).toBe(610000 * 4 + 16);
        expect(w.finishCalls).toBe(1);
        expect(gl.finishCalls).toBe(1); // 原始调用仍发生
    });

    it("手动上报接口与自动观测等价", () => {
        const p = new GlProbe();
        p.openWindow();
        p.noteSortRequest();
        expect(p.pendingSorts()).toBe(1);
        p.noteSortCompleted();
        expect(p.pendingSorts()).toBe(0);
        expect(p.snapshotWindow().sortRequests).toBe(1);
        expect(p.snapshotWindow().sortCompleted).toBe(1);
    });
});

describe("GlProbe：rAF / timer 观测", () => {
    it("窗口内触发 rAF 回调 ⇒ unexpectedFrameCallbacks；新申请计入 rafSchedules", () => {
        const { probe, win } = makeProbe();
        probe.openWindow();
        win.requestAnimationFrame(() => {});
        win.fireRaf(16);
        const w = probe.snapshotWindowFull();
        expect(w.rafSchedules).toBe(1);
        expect(w.rafCalls).toBe(1);
        expect(w.unexpectedFrameCallbacks).toBe(1);
    });

    it("新申请 rAF（自挂）会被单独报告", () => {
        const { probe, win } = makeProbe();
        probe.openWindow();
        expect(probe.snapshotWindowFull().rafSchedules).toBe(0);
        expect(win.requestAnimationFrame(() => {})).toBe(1);
        expect(probe.snapshotWindowFull().rafSchedules).toBe(1);
        expect(probe.snapshotWindowFull().unexpectedFrameCallbacks).toBe(0);
    });

    it("setTimeout 调度计入 timerSchedules", () => {
        const { probe, win } = makeProbe();
        probe.openWindow();
        win.setTimeout(() => {});
        expect(probe.snapshotWindow().timerSchedules).toBe(1);
    });
});

describe("GlProbe：权威等级（阶段 7A）", () => {
    it("排序有效性权威 = renderer-bridge；realm 由 attach 指定", () => {
        const probe = new GlProbe();
        probe.attach({ gl: new FakeGl(), realm: "case-iframe" });
        const auth = probe.getAuthority();
        expect(auth.sortAuditAuthority).toBe("renderer-bridge");
        expect(auth.probeRealmMatched).toBe(true);
        expect(auth.probeBoundToSortWorkerInstance).toBe(false);
        expect(auth.probeInstalledBeforeWorkerCreation).toBe(false);
        expect(auth.note).toContain("renderer bridge");

        const parentProbe = new GlProbe();
        parentProbe.attach({ gl: new FakeGl(), realm: "parent" });
        expect(parentProbe.getAuthority().probeRealmMatched).toBe(false); // 装错 realm ⇒ 无效
    });

    it("bindSortWorker 只统计被绑定的实例（不误计其它 worker）", () => {
        const workerClass = freshWorkerClass();
        const probe = new GlProbe();
        probe.attach({
            gl: new FakeGl(),
            workerProto: workerClass.prototype,
            rafOwner: new FakeWindow(),
            timerOwner: new FakeWindow(),
            realm: "case-iframe",
            nowMs: () => 100,
            workerCreatedAtMs: 200,
        });
        const sortWorker = new workerClass();
        const dataWorker = new workerClass();
        sortWorker.onmessage = (): void => {}; // 先注册，再绑定（模拟 renderer 的常规顺序）
        probe.bindSortWorker(sortWorker, { createdAtMs: 200 });
        probe.openWindow();

        sortWorker.postMessage({ view: 1 });
        dataWorker.postMessage({ sortData: 1 }); // 未绑定 ⇒ 不应计入
        sortWorker.onmessage?.({ data: { depthIndex: new Uint32Array(2) } });

        const w = probe.snapshotWindow();
        expect(w.sortRequests).toBe(1);
        expect(w.sortCompleted).toBe(1);
        const auth = probe.getAuthority();
        expect(auth.probeBoundToSortWorkerInstance).toBe(true);
        expect(auth.boundWorkerCount).toBe(1);
        expect(auth.sortWorkerRequestsObserved).toBe(1);
        expect(auth.sortWorkerCompletionsObserved).toBe(1);
        expect(auth.probeInstalledBeforeWorkerCreation).toBe(true); // 100 ≤ 200
    });

    it("迟到绑定：已注册的 onmessage 会被重新挂接并纳入计数（probeReattachedExistingHandler）", () => {
        const workerClass = freshWorkerClass();
        const probe = new GlProbe();
        probe.attach({
            gl: new FakeGl(),
            workerProto: workerClass.prototype,
            realm: "case-iframe",
            nowMs: () => 500,
        });
        const worker = new workerClass();
        const seen: unknown[] = [];
        worker.onmessage = (ev) => seen.push(ev.data); // 先注册（模拟 renderer 在探针绑定前已赋值）

        probe.bindSortWorker(worker, { createdAtMs: 100 }); // worker 创建早于探针 ⇒ 安装过晚
        probe.openWindow();
        worker.onmessage?.({ data: { depthIndex: new Uint32Array(1) } });

        expect(seen).toHaveLength(1); // 原 handler 仍然工作
        expect(probe.snapshotWindow().sortCompleted).toBe(1); // 且已被纳入计数
        const auth = probe.getAuthority();
        expect(auth.probeReattachedExistingHandler).toBe(true);
        expect(auth.probeInstalledBeforeWorkerCreation).toBe(false);
    });

    it("绑定实例 + 原型包装共存时不重复计数；detach 后权威状态复位", () => {
        const workerClass = freshWorkerClass();
        const probe = new GlProbe();
        probe.attach({
            gl: new FakeGl(),
            workerProto: workerClass.prototype,
            realm: "case-iframe",
            nowMs: () => 0,
        });
        const worker = new workerClass();
        probe.bindSortWorker(worker, { createdAtMs: 0 });
        probe.openWindow();
        worker.postMessage({ view: 1 });
        expect(probe.snapshotWindow().sortRequests).toBe(1); // 不是 2

        probe.detach();
        const auth = probe.getAuthority();
        expect(auth.probeBoundToSortWorkerInstance).toBe(false);
        expect(auth.boundWorkerCount).toBe(0);
        expect(auth.probeRealmMatched).toBe(false);
    });
});

describe("GlProbe：包装可完全还原", () => {
    it("detach 后 GL / Worker / window 恢复原状且不再计数", () => {
        // 原实现必须在 attach 之前取（attach 会覆盖原型方法）
        const workerClass = freshWorkerClass();
        const protoPostMessage = workerClass.prototype.postMessage;
        const protoOnMessage = Object.getOwnPropertyDescriptor(FakeWorker.prototype, "onmessage");
        const protoRaf = FakeWindow.prototype.requestAnimationFrame;

        const probe = new GlProbe();
        const gl = new FakeGl();
        const win = new FakeWindow();
        probe.attach({ gl, workerProto: workerClass.prototype, rafOwner: win, timerOwner: win });
        expect(Object.getOwnPropertyDescriptor(gl, "drawArraysInstanced")).toBeDefined();
        expect(Object.getOwnPropertyDescriptor(win, "requestAnimationFrame")).toBeDefined();
        expect(workerClass.prototype.postMessage).not.toBe(protoPostMessage);
        expect(Object.getOwnPropertyDescriptor(workerClass.prototype, "onmessage")).toBeDefined();
        expect(protoOnMessage).toBeDefined();

        probe.detach();
        // 实例级/原型级包装全部撤掉，回落到原型实现
        expect(Object.getOwnPropertyDescriptor(gl, "drawArraysInstanced")).toBeUndefined();
        expect(Object.getOwnPropertyDescriptor(win, "requestAnimationFrame")).toBeUndefined();
        expect(win.requestAnimationFrame).toBe(protoRaf);
        expect(workerClass.prototype.postMessage).toBe(protoPostMessage);
        expect(Object.getOwnPropertyDescriptor(workerClass.prototype, "onmessage")).toBeUndefined();
        expect(Object.getOwnPropertyDescriptor(FakeWorker.prototype, "onmessage")).toEqual(protoOnMessage);

        const worker = new workerClass();
        const seen: unknown[] = [];
        worker.onmessage = (ev) => seen.push(ev.data);
        probe.openWindow();
        worker.postMessage({ viewProj: 1 });
        worker.onmessage?.({ data: { depthIndex: 1 } });
        gl.drawArraysInstanced(0, 0, 4, 10);
        win.requestAnimationFrame(() => {});
        win.fireRaf();
        expect(probe.snapshotWindow().sortRequests).toBe(0);
        expect(probe.snapshotWindow().drawCalls).toBe(0);
        expect(probe.snapshotWindow().unexpectedFrameCallbacks).toBe(0);
        expect(seen).toHaveLength(1);
        expect(worker.sent).toHaveLength(1);
        expect(probe.isAttached).toBe(false);
    });

    it("重复 attach 会先还原上一次（不叠加包装）", () => {
        const probe = new GlProbe();
        const gl1 = new FakeGl();
        probe.attach({ gl: gl1 });
        probe.attach({ gl: gl1 });
        probe.openWindow();
        gl1.drawArraysInstanced(0, 0, 4, 5);
        expect(probe.snapshotWindow().drawCalls).toBe(1); // 双重包装会变成 2
    });
});
