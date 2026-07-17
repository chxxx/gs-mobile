const floatView = new Float32Array(1);
const intView = new Int32Array(floatView.buffer);

function float32ToFloat16Bits(value: number): number {
    floatView[0] = value;

    const x = intView[0];
    const sign = (x >> 16) & 0x8000;
    let exponent = ((x >> 23) & 0xff) - 127 + 15;
    let mantissa = x & 0x7fffff;

    if (exponent <= 0) {
        if (exponent < -10) {
            return sign;
        }

        mantissa = (mantissa | 0x800000) >> (1 - exponent);

        if (mantissa & 0x1000) {
            mantissa += 0x2000;
        }

        return sign | (mantissa >> 13);
    }

    if (exponent === 0xff - 127 + 15) {
        if (mantissa === 0) {
            return sign | 0x7c00;
        }

        return sign | 0x7c00 | (mantissa >> 13);
    }

    if (mantissa & 0x1000) {
        mantissa += 0x2000;

        if (mantissa & 0x800000) {
            mantissa = 0;
            exponent += 1;
        }
    }

    if (exponent > 30) {
        return sign | 0x7c00;
    }

    return sign | (exponent << 10) | (mantissa >> 13);
}

function packHalf2x16(a: number, b: number): number {
    return (float32ToFloat16Bits(a) | (float32ToFloat16Bits(b) << 16)) >>> 0;
}

function float16BitsToFloat32(bits: number): number {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const mantissa = bits & 0x03ff;

    if (exponent === 0) {
        return sign * Math.pow(2, -14) * (mantissa / 1024);
    }

    if (exponent === 31) {
        return mantissa ? NaN : sign * Infinity;
    }

    return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
}

export { float32ToFloat16Bits, float16BitsToFloat32, packHalf2x16 };
