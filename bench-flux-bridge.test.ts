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

const src = readFileSync(
    fileURLToPath(new URL("./flux-gs-project-gh-pages/render_shared/main.js", import.meta.url)),
    "utf8",
).replace(/\r\n/g, "\n");

describe("阶段 6：Flux worker bench bridge 静态不变量", () => {
    it("1) 严格命名空间：bench 分支都在 e.data.type 守卫内；默认 {view}/mobilegs 路径逐字保留", () => {
        expect(src).toMatch(/if \(e\.data\.type === "bench-sort"\) \{/);
        expect(src).toMatch(/if \(e\.data\.type === "bench-barrier"\) \{/);
        // 默认路径（无 type 的旧消息）必须逐字未变
        expect(src).toMatch(/else if \(e\.data\.view\) \{\n\s+viewProj = e\.data\.view;\n\s+throttledSort\(\);\n\s+\}/);
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

    it("8) bench 强制排序绑定到具体 view/serial（legacy/replacement 不得消费）", () => {
        // 绑定校验必须在 runSort 入口处，且用数组同一性比较
        expect(src).toMatch(/const benchForcedThisRun = benchPendingView !== null && benchPendingView === viewProj;/);
        expect(src).toMatch(/const benchSerial = benchForcedThisRun \? benchPendingSerial : null;/);
        // 旧的全局布尔写法必须彻底消失
        expect(src).not.toMatch(/benchForcePending/);
        // 单飞同时检查"在飞"与"已 arm 未运行"
        expect(src).toMatch(/if \(benchInFlight !== null \|\| benchPendingSerial !== null\) \{/);
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
