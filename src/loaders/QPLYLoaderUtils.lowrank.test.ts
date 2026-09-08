import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IsLowRankQPLY, ParseLowRankQPLYBuffer } from "./QPLYLoaderUtils";
import { float16BitsToFloat32 } from "../utils/HalfFloat";
import { SplatData } from "../splats/SplatData";

const plyPath = new URL("../../test-fixtures/low_rank_r3.ply", import.meta.url);
const expectedPath = new URL("../../test-fixtures/low_rank_r3_expected.json", import.meta.url);

// test-fixtures/ 目录尚未纳入版本管理；fixtures 缺失时跳过本套件，
// 避免在 CI/其他机器上因找不到文件而导致整个 npm run test 失败。
// 将来把 low_rank_r3.ply / low_rank_r3_expected.json 提交进 test-fixtures/ 后测试会自动启用。
const fixturesPresent = existsSync(plyPath) && existsSync(expectedPath);

function loadArrayBuffer(url: URL): ArrayBuffer {
    const raw = readFileSync(url);
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
}

function loadFixture() {
    const input = loadArrayBuffer(plyPath);
    const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as {
        N: number;
        rank: number;
        xyz: number[][];
        f_dc: number[][];
        scale: number[][];
        color: number[][];
        opacity_sigmoid: number[][];
        rot: number[][];
        rest45: number[][];
    };
    return { input, expected };
}

function unpackChannel(packed: Uint32Array, index: number, coeffs: number[]): void {
    for (let p = 0; p < 8; p++) {
        const bits = packed[8 * index + p];
        coeffs[2 * p] = float16BitsToFloat32(bits & 0xffff);
        coeffs[2 * p + 1] = float16BitsToFloat32((bits >>> 16) & 0xffff);
    }
}

describe.skipIf(!fixturesPresent)("low-rank QPLY loader", () => {
    const { input, expected } = loadFixture();

    it("detects the low-rank QPLY header", () => {
        expect(IsLowRankQPLY(input)).toBe(true);
    });

    it("parses positions, scales, rotations and base colors", () => {
        const { splatBuffer } = ParseLowRankQPLYBuffer(input);
        const data = SplatData.Deserialize(new Uint8Array(splatBuffer));

        expect(data.vertexCount).toBe(expected.N);

        for (let i = 0; i < expected.N; i++) {
            expect(data.positions[i * 3 + 0]).toBeCloseTo(expected.xyz[i][0], 3);
            expect(data.positions[i * 3 + 1]).toBeCloseTo(expected.xyz[i][1], 3);
            expect(data.positions[i * 3 + 2]).toBeCloseTo(expected.xyz[i][2], 3);

            expect(data.scales[i * 3 + 0]).toBeCloseTo(expected.scale[i][0], 3);
            expect(data.scales[i * 3 + 1]).toBeCloseTo(expected.scale[i][1], 3);
            expect(data.scales[i * 3 + 2]).toBeCloseTo(expected.scale[i][2], 3);

            // SplatData.Deserialize 已解码为 (u8-128)/128 的归一化四元数
            const rot = data.rotations;
            expect(rot[i * 4 + 0]).toBeCloseTo(expected.rot[i][0], 3);
            expect(rot[i * 4 + 1]).toBeCloseTo(expected.rot[i][1], 3);
            expect(rot[i * 4 + 2]).toBeCloseTo(expected.rot[i][2], 3);
            expect(rot[i * 4 + 3]).toBeCloseTo(expected.rot[i][3], 3);

            const rgba = data.colors;
            expect(rgba[i * 4 + 0] / 255).toBeCloseTo(expected.color[i][0], 3);
            expect(rgba[i * 4 + 1] / 255).toBeCloseTo(expected.color[i][1], 3);
            expect(rgba[i * 4 + 2] / 255).toBeCloseTo(expected.color[i][2], 3);
            expect(rgba[i * 4 + 3] / 255).toBeCloseTo(expected.opacity_sigmoid[i][0], 3);
        }
    });

    it("reconstructs 3rd-order SH rest coefficients from C@B (embedded sh_basis)", () => {
        const { sphericalHarmonics } = ParseLowRankQPLYBuffer(input);

        expect(sphericalHarmonics.count).toBe(expected.N);
        expect(Array.from(sphericalHarmonics.bandsIndices)).toEqual([-1, -1, -1]);

        for (let i = 0; i < expected.N; i++) {
            const coeffR = new Array<number>(16).fill(0);
            const coeffG = new Array<number>(16).fill(0);
            const coeffB = new Array<number>(16).fill(0);

            unpackChannel(sphericalHarmonics.rgb[0], i, coeffR);
            unpackChannel(sphericalHarmonics.rgb[1], i, coeffG);
            unpackChannel(sphericalHarmonics.rgb[2], i, coeffB);

            // DC
            expect(coeffR[0]).toBeCloseTo(expected.f_dc[i][0], 3);
            expect(coeffG[0]).toBeCloseTo(expected.f_dc[i][1], 3);
            expect(coeffB[0]).toBeCloseTo(expected.f_dc[i][2], 3);

            // rest coeff k (1..15) -> rest45 index (k-1)*3 + channel
            for (let k = 1; k < 16; k++) {
                const idx = (k - 1) * 3;
                expect(coeffR[k]).toBeCloseTo(expected.rest45[i][idx + 0], 2);
                expect(coeffG[k]).toBeCloseTo(expected.rest45[i][idx + 1], 2);
                expect(coeffB[k]).toBeCloseTo(expected.rest45[i][idx + 2], 2);
            }
        }
    });
});

