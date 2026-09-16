/**
 * bench-flux-bridge.test.ts — 阶段 6：Flux Worker 侧 bench bridge 的**静态不变量**。
 *
 * 无 Chromium 环境下，这是可复现的确定性证据（不是 smoke，也不冒充 smoke）：
 * 断言 vendor 文件里 bench 分支的命名空间守卫、force 绕过条件、单飞拒绝、
 * serial 回传路径、barrier 异步 ack 的三条件判定，以及默认路径未被改动。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FLUX_FACTS, FluxBenchBridge, type FluxFactMessage } from "./bench-flux-bridge";

const src = readFileSync(
    fileURLToPath(new URL("./flux-gs-project-gh-pages/render_shared/main.js", import.meta.url)),
    "utf8",
).replace(/\r\n/g, "\n");

describe("阶段 6：Flux worker bench bridge 静态不变量", () => {
    it("1) 严格命名空间：bench 分支都在 e.data.type 守卫内；默认 {view}/mobilegs 路径逐字保留", () => {
        expect(src).toMatch(/if \(e\.data\.type === "bench-sort"\) \{/);
        expect(src).toMatch(/if \(e\.data\.type === "bench-barrier"\) \{/);
        // 默认路径（无 type 的旧消息）仍然：赋值 view → 触发排序（中间新增 benchSerial 采集，未启用 bridge 时恒为 null）
        expect(src).toMatch(
            /else if \(e\.data\.view\) \{\n\s+viewProj = e\.data\.view;\n\s+\/\/ bridge 帧消息可携带显式 benchSerial[\s\S]{0,200}?benchFrameSerial = typeof e\.data\.benchSerial === "number" \? e\.data\.benchSerial : null;\n\s+throttledSort\(\);\n\s+\}/,
        );
        expect(src).toMatch(/if \(e\.data\.mobilegs\) \{/);
    });

    it("2) 只有 force 才绕过 dot 早期返回；默认请求仍可提前返回", () => {
        expect(src).toMatch(/if \(!benchForcedThisRun && Math\.abs\(dot - 1\) < 0\.01\) \{/);
        // 旧的"无条件提前 return"必须已消失
        expect(src).not.toMatch(/if \(Math\.abs\(dot - 1\) < 0\.01\) \{\n\s+return;/);
    });

    it("3) 严格单飞：并发 bench sort 明确拒绝且不覆盖前一个", () => {
        expect(src).toMatch(/if \(benchInFlight !== null \|\| benchPendingSerial !== null\) \{/);
        expect(src).toMatch(/reason: "single-flight"/);
        expect(src).toMatch(/reason: "force-required"/);
        expect(src).toMatch(/type: "bench-sort-rejected"/);
    });

    it("4) sortSerial 在成功 / 跳过 / 无 buffer / 拒绝四条路径都会回传", () => {
        expect(src.match(/sortSerial/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
        expect(src).toMatch(/skipped: "dot-equivalent"/);
        expect(src).toMatch(/failure: "no-buffer"/);
        expect(src).toMatch(/sortSerial: benchForcedThisRun \? benchSerial : null,/); // 成功路径
    });

    it("5) barrier 异步 ack，且必须四条件同时满足（不得只查 sortRunning，也不得同步等待）", () => {
        expect(src).toMatch(
            /const benchQuiescent = \(\) =>\n\s+!sortRunning && !sortScheduled && !queuedReplacementPresent && benchInFlight === null;/,
        );
        expect(src).toMatch(/if \(!benchQuiescent\(\)\) return;/);
        expect(src).toMatch(/type: "bench-barrier-ack"/);
        expect(src).toMatch(/benchBarrierQueue\.push\(\{ barrierSerial:/);
        // 不得同步循环等待
        expect(src).not.toMatch(/while \(\s*!benchQuiescent/);
        expect(src).not.toMatch(/do \{\s*\} while/);
    });

    it("8) bench 强制排序绑定到**显式 serial**（引用同一性跨 postMessage 不成立 ⇒ 已纠错）", () => {
        // 身份 = serial：帧消息携带 benchSerial 时按 serial 匹配
        expect(src).toMatch(
            /benchFrameSerial === benchPendingSerial \|\| \(benchFrameSerial === null && benchViewMatches\)/,
        );
        expect(src).toMatch(/const benchForcedThisRun =\n\s+benchPendingSerial !== null &&/);
        // 未携带 serial 时（登记触发的立即 runSort / 排队 replacement 的延迟 runSort）退化为**内容**校验
        expect(src).toMatch(
            /const benchViewMatches =\n\s+benchPendingView !== null &&\n\s+Array\.isArray\(viewProj\) &&\n\s+benchPendingView\.length === viewProj\.length &&\n\s+viewProj\.every\(\(v, i\) => v === benchPendingView\[i\]\);/,
        );
        // 旧的引用同一性判定必须彻底消失（结构化克隆使其恒为假）
        expect(src).not.toMatch(/benchPendingView === viewProj/);
        // 回传 serial 必须来自已登记的 pending serial，而不是无条件信任入参
        expect(src).toMatch(/const benchSerial = benchForcedThisRun \? benchPendingSerial : null;/);
        // worker 侧登记路径仍写入 pending serial / view，并让本次登记触发的 runSort 也按 serial 匹配
        expect(src).toMatch(/benchPendingSerial = e\.data\.sortSerial \?\? null;/);
        expect(src).toMatch(/benchPendingView = e\.data\.view;/);
        expect(src).toMatch(
            /benchFrameSerial = e\.data\.sortSerial \?\? null; \/\/ 本次登记立即触发的 runSort 也按 serial 匹配/,
        );
        // 旧的全局布尔写法必须彻底消失
        expect(src).not.toMatch(/benchForcePending/);
        // 单飞同时检查"在飞"与"已 arm 未运行"，且不覆盖既有 pending
        expect(src).toMatch(/if \(benchInFlight !== null \|\| benchPendingSerial !== null\) \{/);
    });

    it("9) 帧消息携带显式 benchSerial；默认路径消息形状逐字不变；消费后仅按匹配 serial 清理", () => {
        // [H19] 排序输入以父侧登记的 token 视图为**单一基线**（vendor 自身动画重算的 viewProj 会漂移）
        expect(src).toMatch(
            /const __fxSortView =\n\s+__fxTok && Array\.isArray\(__fxTok\.view\) && __fxTok\.view\.length === 16 \? __fxTok\.view : viewProj;/,
        );
        expect(src).toMatch(/worker\.postMessage\(\{ view: __fxSortView, benchSerial: __fxBench\.pendingSerial \}\);/);
        expect(src).not.toMatch(/worker\.postMessage\(\{ view: viewProj, benchSerial: __fxBench\.pendingSerial \}\);/);
        expect(src).toMatch(
            /\} else \{\n\s+\/\/ 默认路径：消息形状逐字保持原样\n\s+worker\.postMessage\(\{ view: viewProj \}\);\n\s+\}/,
        );
        // 父侧登记必须转交 worker（否则 worker 永不登记 pending serial）
        expect(src).toMatch(
            /worker\.postMessage\(\{ type: "bench-sort", sortSerial, view: viewProj\.slice\(\), force: true \}\);/,
        );
        // 消费后精确清理：仅匹配 serial 才清空
        expect(src).toMatch(/if \(__fxBench\.pendingSerial === e\.data\.sortSerial\) __fxBench\.pendingSerial = null;/);
        expect(src).toMatch(/benchFrameSerial = null; \/\/ 一次性消费/);
    });

    it("10) 上传门拒绝必须带**精确检查项**（杜绝 generic `pre-upload-gate`）", () => {
        expect(src).toMatch(/lastAuthReason: null,/);
        expect(src).toMatch(/__fxBench\.lastAuthReason = "vendor:no-token";/);
        expect(src).toMatch(/__fxBench\.lastAuthReason = "vendor:token-settled";/);
        expect(src).toMatch(/__fxBench\.lastAuthReason = "vendor:view-not-16";/);
        // 漂移必须报出"哪一项 + 量级"（1e-6 舍入比较的真实失败点）
        expect(src).toMatch(
            /__fxBench\.lastAuthReason = "vendor:view-drift@" \+ i \+ "=" \+ Math\.abs\(tok\.view\[i\] - viewProj\[i\]\)\.toExponential\(2\);/,
        );
        // 父侧拒绝必须自证原因（[H20] 由 `parent:reject@drift=<max>` 取代无语义的裸 "parent:reject"）
        expect(src).toMatch(/__fxBench\.lastAuthReason = "parent:reject@drift=" \+ __fxDrift\.toExponential\(2\);/);
        expect(src).toMatch(/__fxBench\.lastAuthReason = "parent:throw";/);
        expect(src).toMatch(/reason: "pre-upload-gate:" \+ \(__fxBench\.lastAuthReason \|\| "unknown"\)/);
    });

    it("12) [H20] 上传门主体 = 单一规范视图（`__fxView`）；父侧拒绝自证 drift", () => {
        // 门主体必须是父侧登记/上报的规范视图；不得是 frame 局部重算的 viewProj（含浮点漂移，父侧逐位比较必拒）
        expect(src).toMatch(/!__fxAuthorizeUpload\(__fxSerial, __fxView\)\) \{/);
        expect(src).not.toMatch(/!__fxAuthorizeUpload\(__fxSerial, viewProj\)\) \{/);
        // 父侧拒绝必须自证：带上与登记 token 视图的最大逐项漂移（drift=0 ⇒ 非视图原因）
        expect(src).toMatch(/__fxBench\.lastAuthReason = "parent:reject@drift=" \+ __fxDrift\.toExponential\(2\);/);
        expect(src).not.toMatch(/__fxBench\.lastAuthReason = "parent:reject";/);
    });

    it("6) 默认结果消息字段仍在（新增字段不影响旧解构；transfer 语义不变）", () => {
        expect(src).toMatch(/depthIndex,\n\s+viewProj,\n\s+vertexCount,/);
        expect(src).toMatch(/\[depthIndex\.buffer\],/);
    });

    it("7) 每次调度/完成都更新 sortScheduled 与 queuedReplacementPresent（barrier 判定的前提）", () => {
        expect(src).toMatch(/sortScheduled = true;/);
        expect(src).toMatch(/sortScheduled = false;/);
        expect(src).toMatch(/queuedReplacementPresent = true;/);
        expect(src).toMatch(/queuedReplacementPresent = false;/);
        // ack 只在这两处之后被调用（调度回调 + 消息处理）
        expect(src.match(/ackBenchBarriersIfQuiescent\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    });
});

const VIEW_A = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const VIEW_B = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];
const SESSION = "s-1";

/** 测试薄原语：同步投递事实（模拟 iframe → 父 同栈回调）；glUploads 记录真实上传次数。 */
class FakeTransport {
    readonly posted: Record<string, unknown>[] = [];
    glUploads = 0;
    private handlers: Array<(m: FluxFactMessage) => void> = [];

    post(msg: Record<string, unknown>): void {
        this.posted.push(msg);
    }

    subscribe(h: (m: FluxFactMessage) => void): () => void {
        this.handlers.push(h);
        return () => {
            this.handlers = this.handlers.filter((x) => x !== h);
        };
    }

    emitRaw(m: FluxFactMessage): void {
        for (const h of [...this.handlers]) h(m);
    }

    emit(fact: FluxFactMessage["fact"], serial: number | null, view?: number[], reason?: string): void {
        this.emitRaw({ __fxbench: true, fact, session: SESSION, sortSerial: serial, viewProj: view, reason });
    }

    get handlerCount(): number {
        return this.handlers.length;
    }
}

const mk = (): { t: FakeTransport; b: FluxBenchBridge } => {
    const t = new FakeTransport();
    const b = new FluxBenchBridge({ transport: t, sessionId: SESSION, width: 1600, height: 1063 });
    return { t, b };
};

/** 模拟 iframe 真实上传路径：先同步请求授权，通过才执行"上传"。 */
const tryUpload = (b: FluxBenchBridge, t: FakeTransport, session: string, serial: number, view: number[]): boolean => {
    const ok = b.authorizeUpload({ session, sortSerial: serial, viewProj: view });
    if (ok) t.glUploads++;
    return ok;
};

describe("B2：Flux 生产 bridge（事实驱动）", () => {
    it("1) 五阶段确定性链 + 上传前同步授权门", async () => {
        const { t, b } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        // [H21] 门是**同步**的：iframe 在同一任务内"先 postMessage 送事实、再同栈调用门" ⇒
        // 父侧此时**不可能**已处理 result-received，因此门只能依据"登记"授权（此处必须为 true）。
        // "结果是否被合法接收"改由 index-uploaded 的处理点后验校验（见 #12/#13）。
        expect(b.authorizeUpload({ session: SESSION, sortSerial: serial, viewProj: VIEW_A })).toBe(true);
        t.emit("worker-completed", serial, VIEW_A);
        t.emit("result-received", serial, VIEW_A);
        expect(tryUpload(b, t, SESSION, serial, VIEW_B)).toBe(false); // 异 view
        expect(tryUpload(b, t, "other-session", serial, VIEW_A)).toBe(false); // 异 session
        expect(tryUpload(b, t, SESSION, serial + 99, VIEW_A)).toBe(false); // 异 serial
        expect(tryUpload(b, t, SESSION, serial, VIEW_A)).toBe(true); // 合法 token
        t.emit("index-uploaded", serial, VIEW_A);
        t.emit("index-activated", serial, VIEW_A);
        await b.waitForSortApplied(serial, VIEW_A);
        await b.waitForSortQuiescence(serial, VIEW_A); // active 后、draw 前即可静止
        expect(b.sortAudit.lastDrawSerial).toBe(0);
        expect(b.sortAudit.uploadedSerial).toBe(serial);
        expect(b.sortAudit.activeSerial).toBe(serial);
        t.emit("draw-completed", serial, VIEW_A);
        await b.waitForDrawn(serial);
        expect(b.getDrawCount(serial)).toBe(1);
        t.emit("draw-completed", serial, VIEW_A); // 同 serial 合法多帧
        expect(b.getDrawCount(serial)).toBe(2);
        expect(t.glUploads).toBe(1);
        const facts = b
            .getEventLog()
            .filter((e) => e.serial === serial)
            .map((e) => e.fact);
        // 权威五阶段链：过滤辅助事件（worker-completed 不得替代严格顺序断言）
        const CORE = ["sort-requested", "result-received", "index-uploaded", "index-activated", "draw-completed"];
        const coreTypes = facts.filter((ft) => CORE.includes(ft));
        expect(coreTypes.slice(0, 5)).toEqual([
            "sort-requested",
            "result-received",
            "index-uploaded",
            "index-activated",
            "draw-completed",
        ]);
        expect(facts).toContain("worker-completed"); // 辅助事实允许存在，但不参与权威链
        expect(facts.filter((ft) => ft === "draw-completed")).toHaveLength(2);
        expect(b.getDrawCount(serial)).toBe(2);
    });

    it("2) 同 payload 幂等、异 payload 协议失败（不得伪装为 duplicate）", () => {
        const { t, b } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        t.emit("worker-completed", serial, VIEW_A);
        t.emit("worker-completed", serial, VIEW_A);
        expect(b.getEventLog().filter((e) => e.verdict === "ignored-duplicate")).toHaveLength(1);
        t.emit("worker-completed", serial, VIEW_B);
        expect(b.getEventLog()[b.getEventLog().length - 1].verdict).toBe("protocol-failure");
        expect(b.sortAudit.failures.some((f) => f.reason.includes("payload-mismatch"))).toBe(true);
    });

    it("3) force + dot-equivalent ⇒ 立即协议失败", () => {
        const { t, b } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        t.emit("result-received", serial, VIEW_A);
        t.emit("sort-failed", serial, VIEW_A, "dot-equivalent");
        expect(b.getEventLog().some((e) => e.verdict === "protocol-failure:dot-equivalent")).toBe(true);
        expect(b.sortAudit.failures.some((f) => f.reason === "protocol-failure:dot-equivalent")).toBe(true);
    });

    it("4) barrier-ack 不推进 uploaded/active", () => {
        const { t, b } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        t.emit("barrier-ack", serial);
        expect(b.sortAudit.barrierAcks).toBe(1);
        expect(b.sortAudit.uploadedSerial).toBe(0);
        expect(b.sortAudit.activeSerial).toBe(0);
    });

    it("5) 异 session 事实被忽略且不改变任何状态", () => {
        const { t, b } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        t.emitRaw({ __fxbench: true, fact: "result-received", session: "other", sortSerial: serial, viewProj: VIEW_A });
        expect(b.getEventLog().some((e) => e.verdict === "ignored-session")).toBe(true);
        expect(b.sortAudit.resultReceivedSerial).toBe(0);
        // [H21] 门依据**登记**而非事实（异 session 事实被忽略**不**影响门的可达性）；异 session 的**门调用**仍必须被拒
        expect(b.authorizeUpload({ session: SESSION, sortSerial: serial, viewProj: VIEW_A })).toBe(true);
        expect(b.authorizeUpload({ session: "other", sortSerial: serial, viewProj: VIEW_A })).toBe(false);
    });

    it("6) context-lost 后迟到结果被拒、GL 上传保持 0、缓存清空且 dispose 幂等", () => {
        const { t, b } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        t.emit("context-lost", serial);
        expect(b.sortAudit.disposed).toBe(true);
        expect(t.handlerCount).toBe(0); // 事实订阅已解除
        expect(tryUpload(b, t, SESSION, serial, VIEW_A)).toBe(false);
        t.emit("result-received", serial, VIEW_A); // 迟到事实不得推进状态
        t.emit("index-uploaded", serial, VIEW_A);
        expect(b.sortAudit.uploadedSerial).toBe(0);
        expect(b.sortAudit.activeSerial).toBe(0);
        expect(t.glUploads).toBe(0);
        expect(b.snapshotCount).toBe(0); // 事实快照缓存已清理
        expect(b.dispose("disposed").settledPromises).toBe(0); // 二次 dispose 幂等
    });

    it("7) dispose 使未满足的等待条件立即 reject（不留悬挂 timer）", async () => {
        const { b } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        const pending = b.waitForSortQuiescence(serial, VIEW_A);
        b.dispose("disposed");
        await expect(pending).rejects.toBeTruthy();
    });

    it("8) [H19] 终态事实立即中止条件等待者（不得把精确失败伪装成 30s 超时）", async () => {
        const { b, t } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        const pending = b.waitForSortQuiescence(serial, VIEW_A);
        // 上传门漂移拒绝 ⇒ 必须以**原因**立即 reject，而不是等 awaitCondition 超时
        t.emit("sort-failed", serial, VIEW_A, "pre-upload-gate:vendor:view-drift@2=3.5e-7");
        await expect(pending).rejects.toContain("pre-upload-gate:vendor:view-drift@2=3.5e-7");
        // 终态事实必须入账（不得静默丢弃）
        expect(b.getEventLog().some((e) => e.fact === "sort-failed" && e.verdict === "failed")).toBe(true);
    });

    it("11) [H20] 父侧授权门逐位严格，且拒绝必须在父侧日志自证原因（authorize-rejected）", () => {
        const { t, b } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        t.emit("result-received", serial, VIEW_A);
        // ① 规范视图（= 登记视图 = 上报视图）⇒ 通过
        expect(b.authorizeUpload({ session: SESSION, sortSerial: serial, viewProj: VIEW_A })).toBe(true);
        // ② 仅在低位漂移 1e-12 ⇒ 仍必须拒绝（父侧是**逐位**严格比较；vendor 侧 1e-6 舍入比较不得替代此门）
        const drifted = [...VIEW_A];
        drifted[12] = VIEW_A[12] + 1e-12;
        expect(b.authorizeUpload({ session: SESSION, sortSerial: serial, viewProj: drifted })).toBe(false);
        const last = b.getEventLog()[b.getEventLog().length - 1];
        expect(last.fact).toBe("sort-rejected");
        expect(last.verdict).toBe("authorize-rejected");
        expect(last.reason).toBe("view-mismatch");
        expect(last.serial).toBe(serial);
        // ③ 其余拒绝路径同样自证（不得只回布尔让上游二次猜测）
        expect(b.authorizeUpload({ session: "other", sortSerial: serial, viewProj: VIEW_A })).toBe(false);
        expect(b.getEventLog()[b.getEventLog().length - 1].reason).toBe("session-mismatch");
        expect(b.authorizeUpload({ session: SESSION, sortSerial: serial + 1, viewProj: VIEW_A })).toBe(false);
        expect(b.getEventLog()[b.getEventLog().length - 1].reason).toBe("not-in-flight");
        expect(b.authorizeUpload({ session: SESSION, sortSerial: serial, viewProj: VIEW_A.slice(0, 15) })).toBe(false);
        expect(b.getEventLog()[b.getEventLog().length - 1].reason).toBe("view-not-16");
        // ④ 未 force 的 serial（非当前 bridge 请求）⇒ not-forced（单飞：另起一个 bridge）
        const { t: t2, b: b2 } = mk();
        const plain = b2.requestSortOnce(VIEW_A); // 未 force
        t2.emit("result-received", plain, VIEW_A);
        expect(b2.authorizeUpload({ session: SESSION, sortSerial: plain, viewProj: VIEW_A })).toBe(false);
        expect(b2.getEventLog()[b2.getEventLog().length - 1].reason).toBe("not-forced");
    });

    it("12) [H21] 同步门不依赖异步事实（登记即可授权）；后验校验在 index-uploaded 处 fail-closed", async () => {
        const { t, b } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        // ① 关键回归：**任何事实都还没送达父侧**时即允许上传（iframe 先 postMessage、再同栈调门）
        expect(b.authorizeUpload({ session: SESSION, sortSerial: serial, viewProj: VIEW_A })).toBe(true);
        // ② 与登记视图不逐位相等（仅 1e-12 低位漂移）⇒ 必须拒绝并自证
        const drifted = [...VIEW_A];
        drifted[12] += 1e-12;
        expect(b.authorizeUpload({ session: SESSION, sortSerial: serial, viewProj: drifted })).toBe(false);
        expect(b.getEventLog()[b.getEventLog().length - 1].reason).toBe("view-mismatch");
        // ③ 真实事实顺序（result-received → index-uploaded → index-activated）后验通过并达静止
        t.emit("result-received", serial, VIEW_A);
        t.emit("index-uploaded", serial, VIEW_A);
        expect(b.sortAudit.uploadedSerial).toBe(serial);
        t.emit("index-activated", serial, VIEW_A);
        expect(b.sortAudit.activeSerial).toBe(serial);
        await b.waitForSortQuiescence(serial, VIEW_A);
    });

    it("13) [H21] 后验校验失败 ⇒ 精确原因立即终态（不得退化为 30s 超时）", async () => {
        const { t, b } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        const pending = b.waitForSortQuiescence(serial, VIEW_A);
        t.emit("result-received", serial, VIEW_A);
        // 伪造"与已接收结果不一致"的上传 ⇒ 父侧后验拒绝（acceptedResults 与 view 不匹配）
        t.emit("index-uploaded", serial, VIEW_B);
        await expect(pending).rejects.toContain("protocol-failure:upload-not-accepted");
        expect(b.sortAudit.failures.some((f) => f.reason === "protocol-failure:upload-not-accepted")).toBe(true);
        expect(b.getEventLog().some((e) => e.fact === "index-uploaded" && e.verdict === "failed")).toBe(true);
    });

    it("14) [H21] iframe 回显的 `sort-requested` 不得被记为 failed（FLUX_FACTS 已声明该事实）", () => {
        const { t, b } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        t.emit("sort-requested", serial, VIEW_A); // iframe 侧回显（vendor 的 sortRequested 原语）
        const logs = b.getEventLog().filter((e) => e.fact === "sort-requested");
        expect(logs).toHaveLength(2); // 父侧登记 + iframe 回显
        expect(logs[0].verdict).toBe("ok");
        expect(logs[1].verdict).toBe("ok");
        expect(b.getEventLog().some((e) => e.verdict === "failed")).toBe(false); // 不得制造假失败信号
    });

    it("16) [H22-A] 同步绘制归属：不依赖任何事实即可推进 lastDraw（否则 warmup 校验必读到 0）", () => {
        const { t, b } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        t.emit("result-received", serial, VIEW_A);
        t.emit("index-uploaded", serial, VIEW_A);
        t.emit("index-activated", serial, VIEW_A);
        expect(b.sortAudit.lastDrawSerial).toBe(0); // 尚无任何 draw
        // 跨 realm 调用的返回值（同一任务）：vendor 明确告知本帧真实画的是哪个 serial
        b.noteStaticDrawSync({ drawn: true, serial, viewMatrix: [...VIEW_A] });
        expect(b.sortAudit.lastDrawSerial).toBe(serial); // **同步可见** ⇒ controller 紧随其后的读取成立
        expect(b.getDrawCount(serial)).toBe(1);
        // 多帧同 serial：只计数、不重复留痕（避免 30 行同构日志淹没诊断尾部）
        b.noteStaticDrawSync({ drawn: true, serial, viewMatrix: [...VIEW_A] });
        expect(b.getDrawCount(serial)).toBe(2);
        expect(b.getEventLog().filter((e) => e.reason?.startsWith("sync-return"))).toHaveLength(1);
        // 异步事实只是**幂等确认**：不得把帧级计数翻倍，也不得改变 lastDraw
        t.emit("draw-completed", serial, VIEW_A);
        expect(b.getDrawCount(serial)).toBe(2);
        expect(b.sortAudit.lastDrawSerial).toBe(serial);
    });

    it("17) [H22-A] 同步归属 fail-closed：未 draw / 无 serial / serial≠active 一律不记账并留精确原因", () => {
        const { t, b } = mk();
        const serial = b.requestSortOnce(VIEW_A, { force: true });
        t.emit("result-received", serial, VIEW_A);
        t.emit("index-uploaded", serial, VIEW_A);
        t.emit("index-activated", serial, VIEW_A);
        const drawFailedReasons = (): Array<string | null> =>
            b
                .getEventLog()
                .filter((e) => e.fact === "draw-failed")
                .map((e) => e.reason);
        b.noteStaticDrawSync({ drawn: false, serial }); // 未真实 draw（例如 vertexCount<=0 的 early return）
        b.noteStaticDrawSync(true); // 旧 vendor 的布尔返回：画了但**无法归属**（不得猜）
        b.noteStaticDrawSync({ drawn: true, serial: serial + 7, viewMatrix: [...VIEW_A] }); // 非当前 active
        expect(b.sortAudit.lastDrawSerial).toBe(0);
        expect(b.getDrawCount(serial)).toBe(0);
        expect(drawFailedReasons()).toEqual(["sync-not-drawn", "sync-no-attribution", "sync-stale-serial"]);
        // fail-closed 之后仍可正常归因
        b.noteStaticDrawSync({ drawn: true, serial, viewMatrix: [...VIEW_A] });
        expect(b.sortAudit.lastDrawSerial).toBe(serial);
    });

    it("18) [H22-B] 同步 GPU 排空与同步 draw 归属必须由 vendor 原语提供（禁止无人消费的 prim 消息）", () => {
        // ① vendor 必须暴露**同步** finishGpu（父侧 t1 必须含真实 GPU 排空）
        expect(src).toMatch(/finishGpu: \(\) => \{\n\s+gl\.finish\(\);\n\s+return true;\n\s+\},/);
        // ② frameStatic 必须返回**归属描述**（布尔无法归属 serial ⇒ 只能 fail-closed）
        expect(src).toMatch(/serial: __fxDrawnStatic && __fxA \? __fxA\.serial : null,/);
        expect(src).toMatch(/viewMatrix: __fxDrawnStatic && __fxA \? __fxA\.viewMatrix\.slice\(\) : null,/);
        expect(src).not.toMatch(
            /if \(!__fxBench \|\| !__fxBench\.active \|\| !__fxBench\.active\.viewMatrix\) return false;/,
        );
        // ③ 父侧不得再用"无人消费的 prim 消息"冒充 finish；同步归属入口必须存在
        const bridgeTs = readFileSync(fileURLToPath(new URL("./bench-flux-bridge.ts", import.meta.url)), "utf8");
        expect(bridgeTs).not.toContain('prim: "finish-gpu"');
        expect(bridgeTs).toContain("noteStaticDrawSync");
    });

    it("19) [H21] FLUX_FACTS 中每个事实都必须被 onFact 显式处理（禁止落到 default 被记为 failed）", () => {
        const srcTs = readFileSync(fileURLToPath(new URL("./bench-flux-bridge.ts", import.meta.url)), "utf8");
        for (const fact of FLUX_FACTS) {
            expect(srcTs).toContain(`case "${fact}":`);
        }
    });
});
