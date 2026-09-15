/**
 * bench-audit.test.ts — 纯审计逻辑单测（SHA-256 / 矩阵 / 锚点 / 分辨率 / 跨臂判定 / 统计 / 热漂移）。
 * 不 import `./src`、不碰 DOM、不创建 WebGL。
 */
import { describe, expect, it } from "vitest";
import {
    buildCameraAudit,
    computeAnchorSetHash,
    computeThermalDrift,
    identityMat4,
    iqr,
    judgeCrossArm,
    maxAbsDiff,
    mean,
    median,
    mulMat4,
    percentile,
    projectToPixel,
    resolutionIsRequested,
    resolutionKey,
    resolutionMatches,
    sha256Hex,
    sha256OfNumbers,
    stddev,
    transformPoint,
} from "./bench-audit";
import type { AnchorSet, CameraAudit, ResolutionAudit, Vec3 } from "./bench-audit";

const enc = (s: string): Uint8Array => {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
};

const ANCHORS: Vec3[] = [
    [0, 0, -3],
    [1, 0.5, -4],
    [-1, -0.5, -5],
];
const anchorSet = (): AnchorSet => ({
    file: "bench-camera/truck-anchors.json",
    scene: "truck",
    coordinateSystem: "canonical",
    source: "scene bbox deciles (canonical, generated once)",
    anchors: ANCHORS,
    anchorSetHash: computeAnchorSetHash(ANCHORS),
});

/** 与两个实现同构的投影（2f/w, -2f/h, far/(far-near), -far·near/(far-near)）。 */
function placementProjection(
    fx = 1159.5880733038064,
    fy = 1159.5880733038064,
    w = 1600,
    h = 1063,
    near = 0.1,
    far = 100,
): number[] {
    // prettier-ignore
    return [
        (2 * fx) / w, 0, 0, 0,
        0, -(2 * fy) / h, 0, 0,
        0, 0, far / (far - near), 1,
        0, 0, -(far * near) / (far - near), 0,
    ];
}

const audit = (over: Partial<Parameters<typeof buildCameraAudit>[0]> = {}): CameraAudit =>
    buildCameraAudit({
        viewMatrix: identityMat4(),
        projectionMatrix: placementProjection(),
        fx: 1159.5880733038064,
        fy: 1159.5880733038064,
        near: 0.1,
        far: 100,
        width: 1600,
        height: 1063,
        anchorSet: anchorSet(),
        ...over,
    });

describe("SHA-256 与数值哈希", () => {
    it("已知向量：空串 / abc", () => {
        expect(sha256Hex(enc(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        expect(sha256Hex(enc("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    it("sha256OfNumbers 稳定且与输入顺序相关", () => {
        expect(sha256OfNumbers([1, 2, 3])).toBe(sha256OfNumbers([1, 2, 3]));
        expect(sha256OfNumbers([1, 2, 3])).not.toBe(sha256OfNumbers([3, 2, 1]));
    });
});

describe("矩阵与投影", () => {
    it("单位矩阵不改变点；mulMat4 与手算一致", () => {
        expect(transformPoint(identityMat4(), [1, 2, 3])).toEqual([1, 2, 3, 1]);
        const t = [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7, 0, 0, 0, 1];
        expect(transformPoint(t, [1, 2, 3])).toEqual([6, 8, 10, 1]);
        expect(mulMat4(t, identityMat4())).toEqual(t);
    });

    it("projectToPixel：中心点映射到画布中心；w≈0 返回 null", () => {
        expect(projectToPixel([0, 0, 0, 1], 1600, 1063)).toEqual([800, 531.5]);
        expect(projectToPixel([1, 0, 0, 1], 1600, 1063)).toEqual([1600, 531.5]);
        expect(projectToPixel([0, 0, 0, 0], 1600, 1063)).toBeNull();
    });

    it("maxAbsDiff", () => {
        expect(maxAbsDiff([1, 2], [1, 2])).toBe(0);
        expect(maxAbsDiff([1, 2], [1, 2.5])).toBe(0.5);
        expect(maxAbsDiff([1], [1, 2])).toBe(Infinity);
    });
});

describe("分辨率审计（CSS/DPR 不参与判定）", () => {
    const res = (over: Partial<ResolutionAudit> = {}): ResolutionAudit => ({
        requested: [1600, 1063],
        canvas: [1600, 1063],
        drawingBuffer: [1600, 1063],
        viewport: [0, 0, 1600, 1063],
        internalFramebuffer: [1600, 1063],
        renderScale: 1,
        adaptiveResolution: false,
        cssWidth: 400,
        cssHeight: 496,
        devicePixelRatio: 3.6,
        ...over,
    });

    it("四项全等才算一致；CSS/DPR 不同不影响", () => {
        expect(resolutionKey(res())).toBe("1600x1063|1600x1063|1600x1063|0,0,1600,1063");
        expect(resolutionMatches(res(), res({ cssWidth: 0, cssHeight: 0, devicePixelRatio: 0 }))).toBe(true);
        expect(resolutionMatches(res(), res({ drawingBuffer: [1599, 1063] }))).toBe(false);
        expect(resolutionMatches(res(), res({ viewport: [0, 0, 800, 531] }))).toBe(false);
    });

    it("resolutionIsRequested 指出具体不一致项", () => {
        expect(resolutionIsRequested(res())).toEqual({ ok: true, reason: "" });
        const bad = resolutionIsRequested(res({ canvas: [800, 531], adaptiveResolution: true }));
        expect(bad.ok).toBe(false);
        expect(bad.reason).toContain("canvas");
        expect(bad.reason).toContain("adaptiveResolution");
        expect(bad.reason.startsWith("resolution-mismatch:")).toBe(true);
    });
});

describe("相机/投影跨臂判定（D2：容差 + canonical 锚点，不靠哈希相等）", () => {
    it("完全相同的臂 ⇒ 全部 matched", () => {
        const j = judgeCrossArm(audit(), audit());
        expect(j.maxAbsDiffView).toBe(0);
        expect(j.maxProjectedAnchorErrorPx).toBe(0);
        expect(j.projectionEquivalent).toBe(true);
        expect(j.crossCameraMatched && j.crossProjectionMatched && j.crossViewProjectionMatched).toBe(true);
    });

    it("view 平移差 1e-4 ⇒ crossCameraMatched=false，但投影仍等价", () => {
        const shifted = audit();
        const view = [...shifted.viewMatrix];
        view[12] += 1e-4;
        const j = judgeCrossArm(audit(), audit({ viewMatrix: view }));
        expect(j.crossCameraMatched).toBe(false);
        expect(j.projectionEquivalent).toBe(true);
    });

    it("near/far 不同 ⇒ 投影容差超限 ⇒ projectionEquivalent=false（即使 FOV 相同）", () => {
        const other = audit({
            projectionMatrix: placementProjection(1159.5880733038064, 1159.5880733038064, 1600, 1063, 0.2, 200),
            near: 0.2,
            far: 200,
        });
        const j = judgeCrossArm(audit(), other);
        expect(j.maxAbsDiffProjection).toBeGreaterThan(1e-6);
        expect(j.projectionEquivalent).toBe(false);
        expect(j.reasons).toContain("projection-tolerance-exceeded");
    });

    it("锚点集不同 ⇒ 不可比（必须三方同一份 canonical 锚点）", () => {
        const other = buildCameraAudit({
            viewMatrix: identityMat4(),
            projectionMatrix: placementProjection(),
            fx: 1159.5880733038064,
            fy: 1159.5880733038064,
            near: 0.1,
            far: 100,
            width: 1600,
            height: 1063,
            anchorSet: { ...anchorSet(), anchors: [[9, 9, -9]], anchorSetHash: computeAnchorSetHash([[9, 9, -9]]) },
        });
        const j = judgeCrossArm(audit(), other);
        expect(j.sameAnchorSet).toBe(false);
        expect(j.crossCameraMatched).toBe(false);
        expect(j.projectionEquivalent).toBe(false);
        expect(j.reasons).toContain("anchor-set-mismatch");
    });

    it("modelToCanonicalMatrix 参与锚点投影（坐标系不同由 adapter 变换）", () => {
        const shift = [1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const j = judgeCrossArm(audit(), audit({ modelToCanonicalMatrix: shift }));
        expect(j.maxProjectedAnchorErrorPx).toBeGreaterThan(1);
        expect(j.projectionEquivalent).toBe(false);
    });
});

describe("统计与热漂移", () => {
    it("median / mean / stddev / iqr / percentile", () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 2, 3])).toBe(2.5);
        expect(mean([1, 2, 3])).toBeCloseTo(2, 12);
        expect(stddev([1, 2, 3])).toBeCloseTo(1, 12);
        expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
        expect(iqr([1, 2, 3, 4])).toBe(2);
    });

    it("最后两轮比前两轮低 >10% ⇒ thermalDrift=true", () => {
        expect(computeThermalDrift([100, 100, 100, 100]).thermalDrift).toBe(false);
        expect(computeThermalDrift([100, 100, 89, 88]).thermalDrift).toBe(true);
        expect(computeThermalDrift([100, 90, 95, 94]).thermalDrift).toBe(false); // 只降 4.5%
        expect(computeThermalDrift([100, 100, 200, 210]).thermalDrift).toBe(false); // 变快不算
        expect(computeThermalDrift([1, 2, 3]).thermalDrift).toBe(false); // 轮数不足
    });
});
