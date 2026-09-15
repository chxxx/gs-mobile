/**
 * bench-audit.ts — 三方法 benchmark 的**纯审计逻辑**（无 DOM / 无 GL / 无 `./src` 依赖）。
 *
 * 覆盖设计文档 THREE_WAY_BENCH_DESIGN.md 的：
 *   §2.2 计数拆分（draw 归因用**作用域**，不用简单相减）
 *   §3.4 改动性质字段
 *   §4.1 分辨率审计
 *   §4.2/§4.2.1 相机与投影：SHA-256（仅追溯）+ 容差比较 + **公共 canonical 锚点**投影验证
 *   §4.3 工作量/质量字段（不含含糊的 `modelBytes`）
 *   §5.5 热漂移判定
 *
 * 约定：矩阵 **行主序（row-major）**，`number[16]`；`clip = viewProj · a`（列向量）；
 * 本文件与两个渲染器的存储约定一致（`CameraData.update` / `getViewMatrix` 同为行主序）。
 */

// ------------------------------------------------------------------ SHA-256（自带实现，便于 node 单测与浏览器同源）
const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

function hex32(x: number): string {
    return (x >>> 0).toString(16).padStart(8, "0");
}

/** 标准 SHA-256（返回 64 位小写 hex）。 */
export function sha256Hex(bytes: Uint8Array): string {
    const len = bytes.length;
    const bitLen = len * 8;
    const total = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
    dv.setUint32(total - 4, bitLen >>> 0, false);

    let h0 = 0x6a09e667,
        h1 = 0xbb67ae85,
        h2 = 0x3c6ef372,
        h3 = 0xa54ff53a;
    let h4 = 0x510e527f,
        h5 = 0x9b05688c,
        h6 = 0x1f83d9ab,
        h7 = 0x5be0cd19;
    const w = new Uint32Array(64);

    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const x = w[i - 15];
            const y = w[i - 2];
            const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
            const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let a = h0,
            b = h1,
            c = h2,
            d = h3,
            e = h4,
            f = h5,
            g = h6,
            h = h7;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }
    return hex32(h0) + hex32(h1) + hex32(h2) + hex32(h3) + hex32(h4) + hex32(h5) + hex32(h6) + hex32(h7);
}

/** 对"矩阵的十进制文本"取哈希：与实现无关的稳定序列化。 */
export function sha256OfNumbers(values: readonly number[], digits = 6): string {
    const text = values.map((v) => (Number.isFinite(v) ? v.toFixed(digits) : "NaN")).join(",");
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return sha256Hex(bytes);
}

// ------------------------------------------------------------------ 矩阵与投影（canonical 锚点）
export type Mat4 = readonly number[]; // row-major, 16 个数
export type Vec3 = readonly [number, number, number];

/** 行主序 4x4 × 4x4（`c[i][j] = Σ_k a[i][k] · b[k][j]`）。 */
export function mulMat4(a: Mat4, b: Mat4): number[] {
    const out = new Array<number>(16).fill(0);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
            out[i * 4 + j] = s;
        }
    }
    return out;
}

/** `clip = m · (x,y,z,1)`（列向量语义；返回 [x,y,z,w]）。 */
export function transformPoint(m: Mat4, p: Vec3): [number, number, number, number] {
    return [
        m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
        m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
        m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
        m[12] * p[0] + m[13] * p[1] + m[14] * p[2] + m[15],
    ];
}

/**
 * 裁剪空间 → 像素：`((c/w) * 0.5 + 0.5) * viewport`（GL 标准约定）。
 * 约定固定即可：跨臂比较的是**差的绝对值**，约定本身不参与判定。
 */
export function projectToPixel(clip: readonly number[], width: number, height: number): [number, number] | null {
    const w = clip[3];
    if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return null;
    const ndcX = clip[0] / w;
    const ndcY = clip[1] / w;
    return [(ndcX * 0.5 + 0.5) * width, (ndcY * 0.5 + 0.5) * height];
}

/** 最大逐元素绝对差（长度不等或含 NaN ⇒ Infinity）。 */
export function maxAbsDiff(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length) return Infinity;
    let worst = 0;
    for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (!Number.isFinite(d)) return Infinity;
        if (d > worst) worst = d;
    }
    return worst;
}

/** 公共锚点集（每场景唯一一份，禁止各臂各自从自己的包围盒生成不同锚点）。 */
export interface AnchorSet {
    /** 文件：`bench-camera/<scene>-anchors.json` */
    file: string;
    scene: string;
    coordinateSystem: "canonical";
    source: string;
    anchors: Vec3[];
    anchorSetHash: string;
}

export function computeAnchorSetHash(anchors: readonly Vec3[]): string {
    return sha256OfNumbers(
        anchors.flatMap((a) => [a[0], a[1], a[2]]),
        6,
    );
}

/** 某臂把"自己的模型坐标系"映射到 canonical 坐标系的 4x4（无变换时为单位矩阵）。 */
export function identityMat4(): number[] {
    // prettier-ignore
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

// ------------------------------------------------------------------ §4.1 分辨率审计
export interface ResolutionAudit {
    requested: [number, number];
    canvas: [number, number];
    drawingBuffer: [number, number];
    viewport: [number, number, number, number];
    internalFramebuffer: [number, number];
    renderScale: number;
    adaptiveResolution: boolean;
    cssWidth: number;
    cssHeight: number;
    devicePixelRatio: number;
}

/** 判定键：只有这四项相等才算"分辨率一致"（CSS 尺寸与 DPR 不参与）。 */
export function resolutionKey(a: ResolutionAudit): string {
    return [a.canvas.join("x"), a.drawingBuffer.join("x"), a.internalFramebuffer.join("x"), a.viewport.join(",")].join(
        "|",
    );
}

export function resolutionMatches(a: ResolutionAudit, b: ResolutionAudit): boolean {
    return resolutionKey(a) === resolutionKey(b);
}

export function resolutionIsRequested(a: ResolutionAudit): { ok: boolean; reason: string } {
    const [w, h] = a.requested;
    const bad: string[] = [];
    if (a.canvas[0] !== w || a.canvas[1] !== h) bad.push("canvas");
    if (a.drawingBuffer[0] !== w || a.drawingBuffer[1] !== h) bad.push("drawingBuffer");
    if (a.internalFramebuffer[0] !== w || a.internalFramebuffer[1] !== h) bad.push("internalFramebuffer");
    if (a.viewport[0] !== 0 || a.viewport[1] !== 0 || a.viewport[2] !== w || a.viewport[3] !== h) bad.push("viewport");
    if (a.renderScale !== 1) bad.push("renderScale");
    if (a.adaptiveResolution !== false) bad.push("adaptiveResolution");
    return { ok: bad.length === 0, reason: bad.length === 0 ? "" : `resolution-mismatch:${bad.join(",")}` };
}

// ------------------------------------------------------------------ §4.2 相机 / 投影审计
export type MatrixOrder = "row-major" | "column-major";
export type MatrixSemantics = "world-to-camera" | "camera-to-world";

export interface CameraAudit {
    viewMatrix: number[];
    projectionMatrix: number[];
    viewProjectionMatrix: number[];
    viewMatrixSha256: string;
    projectionMatrixSha256: string;
    viewProjectionMatrixSha256: string;
    matrixOrder: MatrixOrder;
    viewSemantics: MatrixSemantics;
    fx: number;
    fy: number;
    near: number;
    far: number;
    width: number;
    height: number;
    /** 该臂模型坐标系 → canonical（无变换 = 单位矩阵） */
    modelToCanonicalMatrix: number[];
    anchorSetFile: string;
    anchorSetHash: string;
    /** 每个锚点在**同一 canonical 锚点集**上算出的像素坐标 */
    anchorPixels: Array<[number, number] | null>;
}

export function buildCameraAudit(input: {
    viewMatrix: number[];
    projectionMatrix: number[];
    fx: number;
    fy: number;
    near: number;
    far: number;
    width: number;
    height: number;
    modelToCanonicalMatrix?: number[];
    anchorSet: AnchorSet;
}): CameraAudit {
    const viewProj = mulMat4(input.projectionMatrix, input.viewMatrix);
    const m2c = input.modelToCanonicalMatrix ?? identityMat4();
    const vpForAnchors = mulMat4(viewProj, m2c);
    const anchorPixels = input.anchorSet.anchors.map((a) =>
        projectToPixel(transformPoint(vpForAnchors, a), input.width, input.height),
    );
    return {
        viewMatrix: [...input.viewMatrix],
        projectionMatrix: [...input.projectionMatrix],
        viewProjectionMatrix: viewProj,
        viewMatrixSha256: sha256OfNumbers(input.viewMatrix),
        projectionMatrixSha256: sha256OfNumbers(input.projectionMatrix),
        viewProjectionMatrixSha256: sha256OfNumbers(viewProj),
        matrixOrder: "row-major",
        viewSemantics: "world-to-camera",
        fx: input.fx,
        fy: input.fy,
        near: input.near,
        far: input.far,
        width: input.width,
        height: input.height,
        modelToCanonicalMatrix: m2c,
        anchorSetFile: input.anchorSet.file,
        anchorSetHash: input.anchorSet.anchorSetHash,
        anchorPixels,
    };
}

// ------------------------------------------------------------------ 跨臂判定（§4.2.1 / §5.2）
export const MATRIX_TOLERANCE = 1e-6;
/** 锚点像素误差上限：只有 ≤ 该值才算投影等价。 */
export const PROJECTION_ANCHOR_TOLERANCE_PX = 1.0;

export interface CrossArmJudgment {
    sameAnchorSet: boolean;
    maxAbsDiffView: number;
    maxAbsDiffProjection: number;
    maxAbsDiffViewProjection: number;
    maxProjectedAnchorErrorPx: number;
    comparableAnchorCount: number;
    projectionEquivalent: boolean;
    crossCameraMatched: boolean;
    crossProjectionMatched: boolean;
    crossViewProjectionMatched: boolean;
    reasons: string[];
}

/** 以 reference（通常 ours）为基准判定另一臂是否可以进主表。 */
export function judgeCrossArm(reference: CameraAudit, candidate: CameraAudit): CrossArmJudgment {
    const reasons: string[] = [];
    const sameAnchorSet = reference.anchorSetHash === candidate.anchorSetHash;
    if (!sameAnchorSet) reasons.push("anchor-set-mismatch");

    const maxAbsDiffView = maxAbsDiff(reference.viewMatrix, candidate.viewMatrix);
    const maxAbsDiffProjection = maxAbsDiff(reference.projectionMatrix, candidate.projectionMatrix);
    const maxAbsDiffViewProjection = maxAbsDiff(reference.viewProjectionMatrix, candidate.viewProjectionMatrix);

    let worstPx = 0;
    let comparable = 0;
    for (let i = 0; i < reference.anchorPixels.length; i++) {
        const a = reference.anchorPixels[i];
        const b = candidate.anchorPixels[i];
        if (!a || !b) continue;
        comparable++;
        worstPx = Math.max(worstPx, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    }
    if (comparable === 0) reasons.push("no-comparable-anchors");

    const projectionToleranceOk = maxAbsDiffProjection <= MATRIX_TOLERANCE;
    const anchorOk = comparable > 0 && worstPx <= PROJECTION_ANCHOR_TOLERANCE_PX;
    const projectionEquivalent = sameAnchorSet && projectionToleranceOk && anchorOk;
    if (!projectionToleranceOk) reasons.push("projection-tolerance-exceeded");
    if (comparable > 0 && !anchorOk) reasons.push("anchor-error-exceeded");

    return {
        sameAnchorSet,
        maxAbsDiffView,
        maxAbsDiffProjection,
        maxAbsDiffViewProjection,
        maxProjectedAnchorErrorPx: worstPx,
        comparableAnchorCount: comparable,
        projectionEquivalent,
        crossCameraMatched: sameAnchorSet && maxAbsDiffView <= MATRIX_TOLERANCE,
        crossProjectionMatched: projectionEquivalent,
        crossViewProjectionMatched: sameAnchorSet && maxAbsDiffViewProjection <= MATRIX_TOLERANCE && anchorOk,
        reasons,
    };
}

// ------------------------------------------------------------------ §4.3 工作量 / 模型来源
export interface ModelSourceAudit {
    modelStorageBytes: number | null;
    networkTransferBytes: number | null;
    decodedBodyBytes: number | null;
    modelHash: string | null;
    modelSourceUrl: string | null;
    modelSourceCommit: string | null;
    modelDownloadDate: string | null;
    rendererSourceCommit: string | null;
}

export interface WorkloadAudit {
    model: ModelSourceAudit;
    gaussianTotal: number | null;
    gaussianVisibleMean: number | null;
    gaussianSubmittedMean: number | null;
    shDegree: number | null;
    drawCallsMean: number | null;
    sortRequests: number | null;
    sortCompleted: number | null;
    sortWaited: boolean | null;
    lodEnabled: boolean | null;
    cullingEnabled: boolean | null;
    adaptiveQuality: boolean | null;
}

// ------------------------------------------------------------------ 统计（§5.5）
export function median(nums: readonly number[]): number {
    if (nums.length === 0) return NaN;
    const a = [...nums].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function mean(nums: readonly number[]): number {
    return nums.length === 0 ? NaN : nums.reduce((s, v) => s + v, 0) / nums.length;
}

export function stddev(nums: readonly number[]): number {
    if (nums.length < 2) return 0;
    const m = mean(nums);
    return Math.sqrt(nums.reduce((s, v) => s + (v - m) * (v - m), 0) / (nums.length - 1));
}

/** 分位数（nearest-rank，p ∈ [0,1]）。 */
export function percentile(nums: readonly number[], p: number): number {
    if (nums.length === 0) return NaN;
    const a = [...nums].sort((x, y) => x - y);
    const rank = Math.min(a.length, Math.max(1, Math.ceil(p * a.length)));
    return a[rank - 1];
}

/** IQR = P75 − P25。 */
export function iqr(nums: readonly number[]): number {
    return percentile(nums, 0.75) - percentile(nums, 0.25);
}

export interface ThermalDrift {
    thermalDrift: boolean;
    firstTwoMedian: number;
    lastTwoMedian: number;
    deltaPct: number;
}

/** §5.5：最后两轮相对前两轮的中位性能下降 > 10% ⇒ thermalDrift=true（该组需冷却后重测）。 */
export function computeThermalDrift(fpsPerRound: readonly number[]): ThermalDrift {
    if (fpsPerRound.length < 4) {
        return { thermalDrift: false, firstTwoMedian: NaN, lastTwoMedian: NaN, deltaPct: 0 };
    }
    const first = median(fpsPerRound.slice(0, 2));
    const last = median(fpsPerRound.slice(-2));
    const deltaPct = first > 0 ? ((last - first) / first) * 100 : 0;
    return { thermalDrift: deltaPct < -10, firstTwoMedian: first, lastTwoMedian: last, deltaPct };
}
