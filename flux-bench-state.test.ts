/** 阶段 6 主线程半：可执行状态机测试（覆盖任务书要求的 7 项）。 */
import { describe, expect, it } from "vitest";
import { FluxBenchState, toTerminalReason } from "./flux-bench-state";

const VIEW_A = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const VIEW_B = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];

describe("阶段 6：Flux bridge 主线程状态机", () => {
    it("1) 成功链路：五阶段独立且按序推进", () => {
        const s = new FluxBenchState({ bridgeEnabled: true });
        expect(s.beginSortRequest(7)).toEqual({ ok: true });
        expect(s.onResultReceived({ sortSerial: 7, viewProj: VIEW_A })).toBe("accepted");
        expect(s.markUploaded(7, VIEW_A)).toBe(true);
        expect(s.markActive(7, VIEW_A)).toBe(true);
        s.markDrawAttempt(7, "ok");
        const a = s.getSnapshot();
        expect(a.workerCompletedSerial).toBe(7);
        expect(a.resultReceivedSerial).toBe(7);
        expect(a.uploadedSerial).toBe(7);
        expect(a.activeSerial).toBe(7);
        expect(a.lastDrawSerial).toBe(7);
        expect(a.activeViewProj).toEqual(VIEW_A); // 只保存原始 viewProj 快照
    });

    it("2) draw 失败不更新 lastDraw", () => {
        const s = new FluxBenchState({ bridgeEnabled: true });
        s.beginSortRequest(3);
        s.onResultReceived({ sortSerial: 3, viewProj: VIEW_A });
        s.markUploaded(3, VIEW_A);
        s.markActive(3, VIEW_A);
        s.markDrawAttempt(3, "failed");
        expect(s.getSnapshot().lastDrawSerial).toBe(0);
        expect(s.getSnapshot().drawFailures).toBe(1);
    });

    it("3) 乱序结果被忽略（不得覆盖 active）", () => {
        const s = new FluxBenchState({ bridgeEnabled: true });
        s.beginSortRequest(5);
        s.onResultReceived({ sortSerial: 5, viewProj: VIEW_A });
        s.markUploaded(5, VIEW_A);
        s.markActive(5, VIEW_A);
        // 迟到的旧 serial
        expect(s.onResultReceived({ sortSerial: 4, viewProj: VIEW_B })).toBe("ignored-stale");
        expect(s.markUploaded(4, VIEW_B)).toBe(false); // 未合法接收的 serial ⇒ 不得上传
        expect(s.markActive(4, VIEW_B)).toBe(false);
        expect(s.getSnapshot().activeSerial).toBe(5);
        expect(s.getSnapshot().activeViewProj).toEqual(VIEW_A); // active 未被覆盖
    });

    it("4) dispose 后迟到结果被忽略（不上传、不激活）", () => {
        const s = new FluxBenchState({ bridgeEnabled: true });
        s.beginSortRequest(9);
        s.dispose("context-lost");
        expect(s.onResultReceived({ sortSerial: 9, viewProj: VIEW_A })).toBe("ignored-disposed");
        expect(s.markUploaded(9, VIEW_A)).toBe(false); // dispose 后不得上传
        expect(s.markActive(9, VIEW_A)).toBe(false);
        expect(s.getSnapshot().disposeReason).toBe("context-lost");
        expect(s.getSnapshot().uploadedSerial).toBe(0);
    });

    it("5) static frame 无排序/rAF/timer/DOM/相机积分（副作用全 false）", () => {
        const s = new FluxBenchState({ bridgeEnabled: true });
        const side = s.recordStaticFrame({
            cameraIntegrated: false,
            sortRequested: false,
            domWritten: false,
            rafScheduled: false,
            timerScheduled: false,
        });
        expect(side).toEqual({
            cameraIntegrated: false,
            sortRequested: false,
            domWritten: false,
            rafScheduled: false,
            timerScheduled: false,
        });
        expect(s.scheduledKindCounts.total).toBe(0);
        expect(s.inFlightSerial).toBeNull(); // 未发任何排序请求
    });

    it("6) 退出 slave 最多恢复一个 rAF；非 bridge 模式不恢复", () => {
        const s = new FluxBenchState({ bridgeEnabled: true });
        s.scheduleFrame("raf");
        s.scheduleFrame("raf");
        s.scheduleFrame("timer");
        expect(s.scheduledKindCounts.total).toBe(3);
        expect(s.restoreSingleRaf()).toBe(1);
        expect(s.scheduledKindCounts).toEqual({ raf: 1, timer: 0, total: 1 });

        const legacy = new FluxBenchState({ bridgeEnabled: false });
        expect(legacy.restoreSingleRaf()).toBe(0);
        expect(legacy.scheduledKindCounts.total).toBe(0);
    });

    it("7) 所有 Promise 终态均被清理（rejection / failure / dispose）", () => {
        const s = new FluxBenchState({ bridgeEnabled: true });
        s.trackPromise("sort:1");
        s.beginSortRequest(1);
        s.markRejectedByWorker(1, "single-flight");
        expect(s.pendingPromiseCount).toBe(0);
        expect(s.getSnapshot().rejected).toHaveLength(1);

        s.trackPromise("sort:2");
        s.beginSortRequest(2);
        s.markWorkerFailure(2, "no-buffer");
        expect(s.pendingPromiseCount).toBe(0);
        expect(s.getSnapshot().failures).toHaveLength(1);

        s.trackPromise("sort:3");
        s.trackPromise("barrier:3");
        const r = s.dispose("disposed");
        expect(r.settledPromises).toBe(2);
        expect(s.pendingPromiseCount).toBe(0);
        expect(s.settledPromiseCount).toBe(4); // sort:1:rejection + sort:2:failure + sort:3:dispose + barrier:3:dispose

        // 单飞与冻结语义：bridge 未启用 / 已 dispose 都不允许新请求
        expect(s.beginSortRequest(4)).toEqual({ ok: false, reason: "disposed" });
        const legacy = new FluxBenchState({ bridgeEnabled: false });
        expect(legacy.beginSortRequest(1)).toEqual({ ok: false, reason: "bridge-disabled" });
    });

    it("8) upload/active 必须绑定同 serial 且同 view（禁止只比水位）", () => {
        const s = new FluxBenchState({ bridgeEnabled: true });
        s.beginSortRequest(5);
        // 未合法接收 ⇒ 上传被拒
        expect(s.markUploaded(5, VIEW_A)).toBe(false);
        expect(s.onResultReceived({ sortSerial: 5, viewProj: VIEW_A })).toBe("accepted");
        // 同 serial 但 view 不匹配 ⇒ 上传被拒
        expect(s.markUploaded(5, VIEW_B)).toBe(false);
        expect(s.getSnapshot().uploadedSerial).toBe(0);
        // 同 serial 同 view ⇒ 上传通过
        expect(s.markUploaded(5, VIEW_A)).toBe(true);
        // 未上传的 serial 不得激活；同 serial 但 view 不匹配不得激活
        expect(s.markActive(6, VIEW_A)).toBe(false);
        expect(s.markActive(5, VIEW_B)).toBe(false);
        expect(s.markActive(5, VIEW_A)).toBe(true);
        expect(s.markActive(5, VIEW_A)).toBe(false); // 重复激活拒绝
        expect(s.getSnapshot().activeViewProj).toEqual(VIEW_A);
    });

    it("9) draw 只认 draw 前 active 快照，成功返回才提交 lastDraw", () => {
        const s = new FluxBenchState({ bridgeEnabled: true });
        s.beginSortRequest(11);
        s.onResultReceived({ sortSerial: 11, viewProj: VIEW_A });
        s.markUploaded(11, VIEW_A);
        // 尚无 active ⇒ draw 前快照为空，draw 不得提交 lastDraw
        expect(s.beginDraw()).toBeNull();
        s.markDrawAttempt(11, "ok");
        expect(s.getSnapshot().lastDrawSerial).toBe(0);
        s.markActive(11, VIEW_A);
        // 拿快照后 active 被新 serial 换代 ⇒ 旧快照作废
        const snap = s.beginDraw();
        expect(snap).toEqual({ serial: 11, viewProj: VIEW_A });
        s.markDrawAttempt(10, "ok"); // 非本帧快照 serial
        expect(s.getSnapshot().lastDrawSerial).toBe(0);
        s.markDrawAttempt(11, "ok");
        expect(s.getSnapshot().lastDrawSerial).toBe(11);
        // 失败不提交
        s.beginDraw();
        s.markDrawAttempt(11, "failed");
        expect(s.getSnapshot().drawFailures).toBe(1);
        expect(s.getSnapshot().lastDrawSerial).toBe(11);
    });

    it("11) [H22-A] markDrawnSync：只认当前 active 的**同步**归因（fail-closed），并与事实路径幂等", () => {
        const s = new FluxBenchState({ bridgeEnabled: true });
        s.beginSortRequest(31);
        s.onResultReceived({ sortSerial: 31, viewProj: VIEW_A });
        s.markUploaded(31, VIEW_A);
        // 未 active ⇒ 不记账
        expect(s.markDrawnSync(31)).toBe(false);
        expect(s.getSnapshot().lastDrawSerial).toBe(0);
        s.markActive(31, VIEW_A);
        // 非当前 active 的 serial ⇒ 不记账（禁止把"画了别的一代索引"记为成功 draw）
        expect(s.markDrawnSync(30)).toBe(false);
        expect(s.getSnapshot().lastDrawSerial).toBe(0);
        // 当前 active ⇒ 同任务内立即可见（controller 的 warmup 归因校验依赖这一点）
        expect(s.markDrawnSync(31)).toBe(true);
        expect(s.getSnapshot().lastDrawSerial).toBe(31);
        expect(s.isDrawn(31)).toBe(true);
        // 事实路径（markDrawAttempt）只是幂等确认：不得回退 lastDraw
        s.beginDraw();
        s.markDrawAttempt(31, "ok");
        expect(s.getSnapshot().lastDrawSerial).toBe(31);
    });

    describe("B1：生命周期与精确 pending 计数", () => {
        it("10) getPendingCounts 用阶段差集，历史记录不计为 pending", () => {
            const s = new FluxBenchState({ bridgeEnabled: true });
            s.beginSortRequest(21);
            s.onResultReceived({ sortSerial: 21, viewProj: VIEW_A });
            expect(s.getPendingCounts().acceptedNotUploaded).toBe(1);
            expect(s.getPendingCounts().uploadedNotActive).toBe(0);
            s.markUploaded(21, VIEW_A);
            expect(s.getPendingCounts().acceptedNotUploaded).toBe(0);
            expect(s.getPendingCounts().uploadedNotActive).toBe(1);
            s.markActive(21, VIEW_A);
            expect(s.getPendingCounts().acceptedNotUploaded).toBe(0);
            expect(s.getPendingCounts().uploadedNotActive).toBe(0);
            expect(s.hasAccepted(21, VIEW_A)).toBe(true);
            expect(s.hasUploaded(21, VIEW_A)).toBe(true);
            expect(s.isActive(21, VIEW_A)).toBe(true);
            expect(s.isActive(21, VIEW_B)).toBe(false);
        });

        it("11) isSortQuiescent 用目标 serial 精确阶段，且不要求 lastDraw", () => {
            const s = new FluxBenchState({ bridgeEnabled: true });
            s.trackPromise("sort:31");
            s.beginSortRequest(31);
            s.onResultReceived({ sortSerial: 31, viewProj: VIEW_A });
            s.markUploaded(31, VIEW_A);
            s.markActive(31, VIEW_A);
            expect(s.isSortQuiescent(31, VIEW_A)).toBe(false);
            s.settlePromise("sort:31", "applied");
            expect(s.isSortQuiescent(31, VIEW_A)).toBe(true);
            expect(s.isDrawn(31)).toBe(false);
            s.beginDraw();
            s.markDrawAttempt(31, "ok");
            expect(s.isDrawn(31)).toBe(true);
            expect(s.isSortQuiescent(30, VIEW_A)).toBe(false);
        });

        it("12) dispose 幂等并清空阶段缓存", () => {
            const s = new FluxBenchState({ bridgeEnabled: true });
            s.trackPromise("sort:41");
            s.beginSortRequest(41);
            s.onResultReceived({ sortSerial: 41, viewProj: VIEW_A });
            s.markUploaded(41, VIEW_A);
            s.markActive(41, VIEW_A);
            s.beginDraw();
            s.markDrawAttempt(41, "ok");
            expect(s.isDrawn(41)).toBe(true);
            s.scheduleFrame("timer");
            const first = s.dispose("context-lost");
            expect(first.settledPromises).toBe(1);
            expect(s.getSnapshot().disposeReason).toBe("context-lost");
            expect(s.isDrawn(41)).toBe(false);
            expect(s.getPendingCounts().inFlight).toBeNull();
            expect(s.getPendingCounts().scheduledRaf).toBe(0);
            expect(s.getPendingCounts().scheduledTimers).toBe(0);
            const second = s.dispose("disposed");
            expect(second.settledPromises).toBe(0);
            expect(s.getPendingCounts().acceptedNotUploaded).toBe(0);
            expect(s.markUploaded(41, VIEW_A)).toBe(false);
        });

        it("13) toTerminalReason 显式映射且未知值 fail-closed", () => {
            expect(toTerminalReason("completed")).toBe("applied");
            expect(toTerminalReason("applied")).toBe("applied");
            expect(toTerminalReason("rejection")).toBe("rejected");
            expect(toTerminalReason("failure")).toBe("failed");
            expect(toTerminalReason("protocol-failure")).toBe("protocol-failure");
            expect(toTerminalReason("timeout")).toBe("timeout");
            expect(toTerminalReason("context-lost")).toBe("context-lost");
            expect(toTerminalReason("dispose")).toBe("disposed");
            expect(toTerminalReason("worker-whatever")).toBe("protocol-failure");
            expect(toTerminalReason("unexpected-value")).toBe("protocol-failure");
            const s18 = new FluxBenchState({ bridgeEnabled: true });
            // 编译期边界证据（包在 if (false) 中，Vitest 不执行）
            const compileOnly: boolean = false;
            if (compileOnly) {
                // @ts-expect-error arbitrary strings must not cross the state boundary
                s18.dispose("worker-whatever");
                // @ts-expect-error legacy raw reasons require normalization first
                s18.settleAll("failure");
            }
        });
    });
});
