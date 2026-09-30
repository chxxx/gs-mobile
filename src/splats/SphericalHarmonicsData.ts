class SphericalHarmonicsData {
    public width: number;
    public height: number;
    public rgb: [Uint32Array, Uint32Array, Uint32Array];
    public bandsIndices: Int32Array;
    public count: number;
    /**
     * [阶段1 2026-09-30] **低秩载荷**：仅 `?lr=1` 时存在（缺省 `undefined` ⇒ 既有路径逐字不变）。
     *
     * `packed`：每点 4×uint = 8 个 half（前 `rank` 个有效，其余补 0），扁平 **2048 宽**布局
     *   （点索引 `idx` ⇒ 纹素 `ivec2(idx % 2048, idx / 2048)`、uint 偏移 `4·idx`）⇒ 可直接
     *   `texImage2D(…, 2048, ⌈N/2048⌉, 0, RGBA_INTEGER, UNSIGNED_INT, packed)`。
     * `basis`：`rank × restCount`，**coeff-major**（`R1,G1,B1,R2,G2,B2,…`，与 loader 的
     *   `rest45 = C @ B` 完全同序）⇒ 渲染期按 `Σ_k Y_k(d)·B[j,k,c]` 累加，不重建 45 维向量。
     */
    public lowRank?: {
        rank: number;
        restCount: number;
        basis: Float32Array;
        packed: Uint32Array;
        width: number;
        height: number;
    };

    constructor(
        width: number,
        height: number,
        rgb: [Uint32Array, Uint32Array, Uint32Array],
        count: number,
        bandsIndices: Int32Array = new Int32Array([-1, -1, -1]),
        lowRank?: SphericalHarmonicsData["lowRank"],
    ) {
        this.width = width;
        this.height = height;
        this.rgb = rgb;
        this.count = count;
        this.bandsIndices = bandsIndices;
        this.lowRank = lowRank;
    }

    clone(): SphericalHarmonicsData {
        return new SphericalHarmonicsData(
            this.width,
            this.height,
            [new Uint32Array(this.rgb[0]), new Uint32Array(this.rgb[1]), new Uint32Array(this.rgb[2])],
            this.count,
            new Int32Array(this.bandsIndices),
            // 低秩载荷在加载后只读 ⇒ 浅拷贝引用即可（避免每轮复制 ~10 MB）
            this.lowRank,
        );
    }
}

export { SphericalHarmonicsData };
