import { describe, expect, it } from "vitest";
import { IsQPLY } from "./QPLYLoaderUtils";
import { float16BitsToFloat32, float32ToFloat16Bits } from "../utils/HalfFloat";

function makeHeader(text: string): ArrayBuffer {
    const encoder = new TextEncoder();
    return encoder.encode(text).buffer;
}

describe("QPLY detection", () => {
    it("returns true for a QPLY header", () => {
        const header = `ply
format binary_little_endian 1.0
element vertex_0 100
element vertex_1 50
element vertex_2 20
element vertex_3 10
element codebook_centers 256
property float x
end_header
`;
        expect(IsQPLY(makeHeader(header))).toBe(true);
    });

    it("returns false for a standard PLY header", () => {
        const header = `ply
format binary_little_endian 1.0
element vertex 1000
property float x
property float y
property float z
end_header
`;
        expect(IsQPLY(makeHeader(header))).toBe(false);
    });
});

describe("Half-float conversion", () => {
    it("round-trips common values", () => {
        const values = [0, 1, -1, 0.5, -0.5, 3.14159265, -3.14159265, 1000.5, -1000.5];
        for (const value of values) {
            const bits = float32ToFloat16Bits(value);
            const recovered = float16BitsToFloat32(bits);
            // Half-float has ~3 decimal digits of precision; use 2 for tolerance.
            expect(recovered).toBeCloseTo(value, 2);
        }
    });
});
