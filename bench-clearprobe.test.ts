/**
 * `runClearProbe`（pure-clear 探针）与配套工具的单测。
 *
 * 为什么值得测：这个探针要花**用户的手机时间**去跑，而且它的结论（"面积项"是否与 FBO 面积线性）
 * 是第 7 章因子分解的关键输入。一旦"清屏次数/收口调用/归一化"写错，手机上只会得到一个
 * 看起来正常、实际不可比的数字 ⇒ 用假 GL 把调用序列与归一化公式钉死。
 */
import { describe, expect, it } from "vitest";
import {
    bandTag,
    clearProbeResolutionsFromUrl,
    formatClearProbeTags,
    runClearProbe,
} from "./src/renderers/webgl/utils/OffscreenBenchTarget";
import type { GlClearProbeApi } from "./src/renderers/webgl/utils/OffscreenBenchTarget";

/** 极小假 GL：只记调用次数，足够验证探针的调用序列与归一化。 */
function fakeGl(overrides: Partial<GlClearProbeApi> = {}): { gl: GlClearProbeApi; calls: Record<string, number> } {
    const calls: Record<string, number> = { clear: 0, readPixels: 0, finish: 0, created: 0, disposed: 0 };
    let complete = true;
    const gl = {
        FRAMEBUFFER: 0x8d40,
        RENDERBUFFER: 0x8d41,
        COLOR_ATTACHMENT0: 0x8ce0,
        RGBA8: 0x8058,
        FRAMEBUFFER_COMPLETE: 0x8cd5,
        COLOR_BUFFER_BIT: 0x4000,
        RGBA: 0x1908,
        UNSIGNED_BYTE: 0x1401,
        createFramebuffer: () => {
            calls.created++;
            return {} as WebGLFramebuffer;
        },
        bindFramebuffer: () => undefined,
        createRenderbuffer: () => ({}) as WebGLRenderbuffer,
        bindRenderbuffer: () => undefined,
        renderbufferStorage: () => undefined,
        framebufferRenderbuffer: () => undefined,
        checkFramebufferStatus: () => (complete ? 0x8cd5 : 0),
        deleteFramebuffer: () => {
            calls.disposed++;
        },
        deleteRenderbuffer: () => undefined,
        clear: () => {
            calls.clear++;
        },
        readPixels: () => {
            calls.readPixels++;
        },
        finish: () => {
            calls.finish++;
        },
        ...overrides,
    } as unknown as GlClearProbeApi;
    return { gl, calls, set complete(v: boolean) {} } as unknown as {
        gl: GlClearProbeApi;
        calls: Record<string, number>;
    };
}

describe("runClearProbe：pure-clear 探针", () => {
    it("每个分辨率：预热 4 次 + 正式 N 次 clear，末尾只收口一次（finish + readPixels 1×1）", () => {
        const { gl, calls } = fakeGl();
        const out = runClearProbe(gl, [{ width: 800, height: 531 }], 10);
        expect(out).not.toBeNull();
        expect(out!.length).toBe(1);
        expect(calls.clear).toBe(4 + 10);
        expect(calls.finish).toBe(1);
        expect(calls.readPixels).toBe(1);
        expect(out![0].clears).toBe(10);
        expect(out![0].mpx).toBeCloseTo(0.4248, 4);
        expect(out![0].perClearMs).toBeGreaterThanOrEqual(0);
        // 归一化公式：(每次 clear 耗时 + 均摊读回) / 兆像素
        const s = out![0];
        expect(s.perMpxPerClearMs).toBeCloseTo((s.perClearMs + s.readbackWaitMs / 10) / s.mpx, 9);
    });

    it("多分辨率：逐点独立建/销 FBO，样本顺序与传入顺序一致", () => {
        const { gl, calls } = fakeGl();
        const out = runClearProbe(
            gl,
            [
                { width: 400, height: 266 },
                { width: 1600, height: 1063 },
            ],
            5,
        );
        expect(out!.map((s) => `${s.width}x${s.height}`)).toEqual(["400x266", "1600x1063"]);
        expect(calls.created).toBe(2);
        expect(calls.disposed).toBe(2);
        expect(calls.clear).toBe(2 * (4 + 5));
    });

    it("FBO 不完整（上下文丢失）⇒ 跳过该分辨率，不产出脏样本", () => {
        const { gl } = fakeGl({ checkFramebufferStatus: () => 0 } as Partial<GlClearProbeApi>);
        const out = runClearProbe(gl, [{ width: 800, height: 531 }], 5);
        expect(out).toEqual([]);
    });

    it("gl 为空 ⇒ 返回 null（调用方据此写 CLRna，而不是写 0）", () => {
        expect(runClearProbe(null, [{ width: 800, height: 531 }], 5)).toBeNull();
    });
});

describe("clearProbeResolutionsFromUrl：URL 解析", () => {
    it("正常清单 / 空白 / 垃圾项 / 缺参数", () => {
        expect(clearProbeResolutionsFromUrl("?clearprobe=400x266,800x531,1600x1063")).toEqual([
            { width: 400, height: 266 },
            { width: 800, height: 531 },
            { width: 1600, height: 1063 },
        ]);
        expect(clearProbeResolutionsFromUrl("?clearprobe=")).toEqual([]);
        expect(clearProbeResolutionsFromUrl("?clearprobe=abc,800x531,0x10")).toEqual([{ width: 800, height: 531 }]);
        expect(clearProbeResolutionsFromUrl("?frames=20")).toEqual([]);
    });
});

describe("bandTag / formatClearProbeTags：结果标签", () => {
    it("带标签按臂阈值分档（ours 45/35）", () => {
        expect(bandTag(64.6, 45, 35)).toBe("BANDslow");
        expect(bandTag(27.7, 45, 35)).toBe("BANDfast");
        expect(bandTag(40, 45, 35)).toBe("BANDmid");
        expect(bandTag(Number.NaN, 45, 35)).toBe("BAND?");
    });

    it("探针标签：无样本写 CLRna；有样本写 分辨率:ms/Mpx/次 + 读回等待", () => {
        expect(formatClearProbeTags(null)).toBe("CLRna");
        expect(formatClearProbeTags([])).toBe("CLRna");
        const tags = formatClearProbeTags([
            {
                width: 800,
                height: 531,
                mpx: 0.4248,
                clears: 40,
                perClearMs: 0.5,
                readbackWaitMs: 12.5,
                perMpxPerClearMs: 0.2,
            },
        ]);
        expect(tags).toContain("CLR800x531:0.200");
        expect(tags).toContain("CLRrb13");
    });
});
