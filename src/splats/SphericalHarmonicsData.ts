class SphericalHarmonicsData {
    public width: number;
    public height: number;
    public rgb: [Uint32Array, Uint32Array, Uint32Array];
    public bandsIndices: Int32Array;
    public count: number;

    constructor(
        width: number,
        height: number,
        rgb: [Uint32Array, Uint32Array, Uint32Array],
        count: number,
        bandsIndices: Int32Array = new Int32Array([-1, -1, -1]),
    ) {
        this.width = width;
        this.height = height;
        this.rgb = rgb;
        this.count = count;
        this.bandsIndices = bandsIndices;
    }

    clone(): SphericalHarmonicsData {
        return new SphericalHarmonicsData(
            this.width,
            this.height,
            [new Uint32Array(this.rgb[0]), new Uint32Array(this.rgb[1]), new Uint32Array(this.rgb[2])],
            this.count,
            new Int32Array(this.bandsIndices),
        );
    }
}

export { SphericalHarmonicsData };
