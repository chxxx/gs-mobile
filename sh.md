下面给你一套**一次性完整修改方案**，目标是把 `INRIA reduced-3dgs viewer` 里的 **三阶 SH 渲染能力** 迁移进你现在这份 `gsplat.js`。

这套方案分两阶段：

1. **第一阶段：标准 3DGS PLY 三阶 SH 支持**  
   支持 `f_dc_0~2` + `f_rest_0~44`，适合 `baseline_xxx.ply`。这是必须先跑通的核心。

2. **第二阶段：reduced-3dgs QPLY 支持**  
   支持 `vertex_0~vertex_3 + codebook_centers` 的量化 PLY，适合 `quantized_xxx.ply`。这个我会把结构预留好，但建议你先跑通第一阶段。

下面代码按文件组织。你照着改即可。

---

# 0. 修改文件总览

需要新增：

```text
src/utils/HalfFloat.ts
src/splats/SphericalHarmonicsData.ts
```

需要修改：

```text
src/splats/SplatData.ts
src/loaders/PLYLoader.ts
src/renderers/webgl/utils/RenderData.ts
src/renderers/webgl/programs/RenderProgram.ts
src/index.ts
```

---

# 1. 新增：`src/utils/HalfFloat.ts`

```ts
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
    const sign = (bits & 0x8000) ? -1 : 1;
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
```

---

# 2. 新增：`src/splats/SphericalHarmonicsData.ts`

```ts
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
            [
                new Uint32Array(this.rgb[0]),
                new Uint32Array(this.rgb[1]),
                new Uint32Array(this.rgb[2]),
            ],
            this.count,
            new Int32Array(this.bandsIndices),
        );
    }
}

export { SphericalHarmonicsData };
```

---

# 3. 修改：`src/splats/SplatData.ts`

你当前 `SplatData.ts` 很干净，只需要最小侵入式修改。

## 3.1 顶部新增 import

在顶部加：

```ts
import { SphericalHarmonicsData } from "./SphericalHarmonicsData";
```

也就是变成：

```ts
import { Vector3 } from "../math/Vector3";
import { Quaternion } from "../math/Quaternion";
import { Matrix3 } from "../math/Matrix3";
import { SphericalHarmonicsData } from "./SphericalHarmonicsData";
```

---

## 3.2 类字段新增

在：

```ts
private _selection: Uint8Array;
```

下面加：

```ts
private _sphericalHarmonics: SphericalHarmonicsData | null;
```

---

## 3.3 构造函数参数新增

把构造函数从：

```ts
constructor(
    vertexCount: number = 0,
    positions: Float32Array | null = null,
    rotations: Float32Array | null = null,
    scales: Float32Array | null = null,
    colors: Uint8Array | null = null,
) {
```

改成：

```ts
constructor(
    vertexCount: number = 0,
    positions: Float32Array | null = null,
    rotations: Float32Array | null = null,
    scales: Float32Array | null = null,
    colors: Uint8Array | null = null,
    sphericalHarmonics: SphericalHarmonicsData | null = null,
) {
```

然后在：

```ts
this._selection = new Uint8Array(this.vertexCount);
```

下面加：

```ts
this._sphericalHarmonics = sphericalHarmonics;
```

---

## 3.4 新增 getter/setter

在现有 getter 后面，比如 `get selection()` 后面加：

```ts
get sphericalHarmonics() {
    return this._sphericalHarmonics;
}

set sphericalHarmonics(value: SphericalHarmonicsData | null) {
    this._sphericalHarmonics = value;
}

get hasSphericalHarmonics() {
    return this._sphericalHarmonics !== null;
}
```

---

## 3.5 修改 clone

把当前：

```ts
clone() {
    return new SplatData(
        this.vertexCount,
        new Float32Array(this.positions),
        new Float32Array(this.rotations),
        new Float32Array(this.scales),
        new Uint8Array(this.colors),
    );
}
```

替换成：

```ts
clone() {
    return new SplatData(
        this.vertexCount,
        new Float32Array(this.positions),
        new Float32Array(this.rotations),
        new Float32Array(this.scales),
        new Uint8Array(this.colors),
        this.sphericalHarmonics ? this.sphericalHarmonics.clone() : null,
    );
}
```

---

# 4. 修改：`src/loaders/PLYLoader.ts`

这里给你一个**完整替换版 `PLYLoader.ts`**，支持标准三阶 SH PLY。你可以直接用下面代码替换当前文件。

```ts
import { Scene } from "../core/Scene";
import { Vector3 } from "../math/Vector3";
import { Quaternion } from "../math/Quaternion";
import { SplatData } from "../splats/SplatData";
import { Splat } from "../splats/Splat";
import { Converter } from "../utils/Converter";
import { initiateFetchRequest, loadDataIntoBuffer } from "../utils/LoaderUtils";
import { SphericalHarmonicsData } from "../splats/SphericalHarmonicsData";
import { packHalf2x16 } from "../utils/HalfFloat";

type PlyProperty = {
    name: string;
    type: string;
    offset: number;
};

type ParsedPLYResult = {
    splatBuffer: ArrayBuffer;
    sphericalHarmonics: SphericalHarmonicsData | null;
};

class PLYLoader {
    static async LoadAsync(
        url: string,
        scene: Scene,
        onProgress?: (progress: number) => void,
        format: string = "",
        useCache: boolean = false,
    ): Promise<Splat> {
        const res: Response = await initiateFetchRequest(url, useCache);
        const plyData = await loadDataIntoBuffer(res, onProgress);

        if (plyData[0] !== 112 || plyData[1] !== 108 || plyData[2] !== 121 || plyData[3] !== 10) {
            throw new Error("Invalid PLY file");
        }

        return this.LoadFromArrayBuffer(plyData.buffer, scene, format);
    }

    static async LoadFromFileAsync(
        file: File,
        scene: Scene,
        onProgress?: (progress: number) => void,
        format: string = "",
    ): Promise<Splat> {
        const reader = new FileReader();
        let splat = new Splat();

        reader.onload = (e) => {
            splat = this.LoadFromArrayBuffer(e.target!.result as ArrayBuffer, scene, format);
        };

        reader.onprogress = (e) => {
            onProgress?.(e.loaded / e.total);
        };

        reader.readAsArrayBuffer(file);

        await new Promise<void>((resolve) => {
            reader.onloadend = () => {
                resolve();
            };
        });

        return splat;
    }

    static LoadFromArrayBuffer(arrayBuffer: ArrayBufferLike, scene: Scene, format: string = ""): Splat {
        const result = this._ParsePLYBufferWithSH(arrayBuffer as ArrayBuffer, format);
        const data = SplatData.Deserialize(new Uint8Array(result.splatBuffer));

        if (result.sphericalHarmonics) {
            data.sphericalHarmonics = result.sphericalHarmonics;
        }

        const splat = new Splat(data);
        scene.addObject(splat);

        return splat;
    }

    private static _readPLYValue(dataView: DataView, type: string, offset: number): number {
        switch (type) {
            case "float":
                return dataView.getFloat32(offset, true);
            case "double":
                return dataView.getFloat64(offset, true);
            case "int":
                return dataView.getInt32(offset, true);
            case "uint":
                return dataView.getUint32(offset, true);
            case "short":
                return dataView.getInt16(offset, true);
            case "ushort":
                return dataView.getUint16(offset, true);
            case "uchar":
                return dataView.getUint8(offset);
            default:
                throw new Error(`Unsupported property type: ${type}`);
        }
    }

    private static _ParsePLYBufferWithSH(inputBuffer: ArrayBuffer, format: string): ParsedPLYResult {
        const ubuf = new Uint8Array(inputBuffer);
        const headerText = new TextDecoder().decode(ubuf.slice(0, 1024 * 10));
        const headerEnd = "end_header\n";
        const headerEndIndex = headerText.indexOf(headerEnd);

        if (headerEndIndex < 0) {
            throw new Error("Unable to read .ply file header");
        }

        const vertexMatch = /element vertex (\d+)\n/.exec(headerText);

        if (!vertexMatch) {
            throw new Error("Unable to read vertex count from .ply file header");
        }

        const vertexCount = parseInt(vertexMatch[1]);

        let rowOffset = 0;

        const typeByteLength: Record<string, number> = {
            double: 8,
            int: 4,
            uint: 4,
            float: 4,
            short: 2,
            ushort: 2,
            uchar: 1,
        };

        const properties: PlyProperty[] = [];

        for (const prop of headerText
            .slice(0, headerEndIndex)
            .split("\n")
            .filter((k) => k.startsWith("property "))) {
            const [_p, type, name] = prop.split(" ");

            if (!typeByteLength[type]) {
                throw new Error(`Unsupported property type: ${type}`);
            }

            properties.push({
                name,
                type,
                offset: rowOffset,
            });

            rowOffset += typeByteLength[type];
        }

        const propertyMap = properties.reduce<Record<string, PlyProperty>>((acc, property) => {
            acc[property.name] = property;
            return acc;
        }, {});

        const dataView = new DataView(inputBuffer, headerEndIndex + headerEnd.length);
        const buffer = new ArrayBuffer(SplatData.RowLength * vertexCount);

        const qPolycam = Quaternion.FromEuler(new Vector3(Math.PI / 2, 0, 0));

        const hasFullSH =
            !!propertyMap.f_dc_0 &&
            !!propertyMap.f_dc_1 &&
            !!propertyMap.f_dc_2 &&
            !!propertyMap.f_rest_0 &&
            !!propertyMap.f_rest_44;

        const shTextureWidth = 2048;
        const shTextureHeight = Math.ceil((2 * vertexCount) / shTextureWidth);

        const shRgb: [Uint32Array, Uint32Array, Uint32Array] = [
            new Uint32Array(shTextureWidth * shTextureHeight * 4),
            new Uint32Array(shTextureWidth * shTextureHeight * 4),
            new Uint32Array(shTextureWidth * shTextureHeight * 4),
        ];

        const getValue = (vertexIndex: number, propertyName: string): number => {
            const property = propertyMap[propertyName];

            if (!property) {
                return 0;
            }

            return this._readPLYValue(dataView, property.type, property.offset + vertexIndex * rowOffset);
        };

        for (let i = 0; i < vertexCount; i++) {
            const position = new Float32Array(buffer, i * SplatData.RowLength, 3);
            const scale = new Float32Array(buffer, i * SplatData.RowLength + 12, 3);
            const rgba = new Uint8ClampedArray(buffer, i * SplatData.RowLength + 24, 4);
            const rot = new Uint8ClampedArray(buffer, i * SplatData.RowLength + 28, 4);

            let r0 = 255;
            let r1 = 0;
            let r2 = 0;
            let r3 = 0;

            for (const property of properties) {
                const value = getValue(i, property.name);

                switch (property.name) {
                    case "x":
                        position[0] = value;
                        break;
                    case "y":
                        position[1] = value;
                        break;
                    case "z":
                        position[2] = value;
                        break;
                    case "scale_0":
                    case "scaling_0":
                        scale[0] = Math.exp(value);
                        break;
                    case "scale_1":
                    case "scaling_1":
                        scale[1] = Math.exp(value);
                        break;
                    case "scale_2":
                    case "scaling_2":
                        scale[2] = Math.exp(value);
                        break;
                    case "red":
                        rgba[0] = value;
                        break;
                    case "green":
                        rgba[1] = value;
                        break;
                    case "blue":
                        rgba[2] = value;
                        break;
                    case "f_dc_0":
                    case "features_0":
                        rgba[0] = (0.5 + Converter.SH_C0 * value) * 255;
                        break;
                    case "f_dc_1":
                    case "features_1":
                        rgba[1] = (0.5 + Converter.SH_C0 * value) * 255;
                        break;
                    case "f_dc_2":
                    case "features_2":
                        rgba[2] = (0.5 + Converter.SH_C0 * value) * 255;
                        break;
                    case "f_dc_3":
                        rgba[3] = (0.5 + Converter.SH_C0 * value) * 255;
                        break;
                    case "opacity":
                    case "opacity_0":
                        rgba[3] = (1 / (1 + Math.exp(-value))) * 255;
                        break;
                    case "rot_0":
                    case "rotation_0":
                        r0 = value;
                        break;
                    case "rot_1":
                    case "rotation_1":
                        r1 = value;
                        break;
                    case "rot_2":
                    case "rotation_2":
                        r2 = value;
                        break;
                    case "rot_3":
                    case "rotation_3":
                        r3 = value;
                        break;
                }
            }

            let q = new Quaternion(r1, r2, r3, r0);

            switch (format) {
                case "polycam": {
                    const temp = position[1];
                    position[1] = -position[2];
                    position[2] = temp;
                    q = qPolycam.multiply(q);
                    break;
                }
                case "":
                    break;
                default:
                    throw new Error(`Unsupported format: ${format}`);
            }

            q = q.normalize();

            rot[0] = q.w * 128 + 128;
            rot[1] = q.x * 128 + 128;
            rot[2] = q.y * 128 + 128;
            rot[3] = q.z * 128 + 128;

            if (hasFullSH) {
                const coeffR = new Array<number>(16).fill(0);
                const coeffG = new Array<number>(16).fill(0);
                const coeffB = new Array<number>(16).fill(0);

                coeffR[0] = getValue(i, "f_dc_0");
                coeffG[0] = getValue(i, "f_dc_1");
                coeffB[0] = getValue(i, "f_dc_2");

                for (let k = 0; k < 15; k++) {
                    coeffR[k + 1] = getValue(i, `f_rest_${k}`);
                    coeffG[k + 1] = getValue(i, `f_rest_${k + 15}`);
                    coeffB[k + 1] = getValue(i, `f_rest_${k + 30}`);
                }

                for (let k = 0; k < 8; k++) {
                    shRgb[0][8 * i + k] = packHalf2x16(coeffR[2 * k], coeffR[2 * k + 1]);
                    shRgb[1][8 * i + k] = packHalf2x16(coeffG[2 * k], coeffG[2 * k + 1]);
                    shRgb[2][8 * i + k] = packHalf2x16(coeffB[2 * k], coeffB[2 * k + 1]);
                }
            }
        }

        return {
            splatBuffer: buffer,
            sphericalHarmonics: hasFullSH
                ? new SphericalHarmonicsData(
                      shTextureWidth,
                      shTextureHeight,
                      shRgb,
                      vertexCount,
                      new Int32Array([-1, -1, -1]),
                  )
                : null,
        };
    }
}

export { PLYLoader };
```

---

# 5. 修改：`src/renderers/webgl/utils/RenderData.ts`

`RenderData` 是全局数据汇总层。因为你的 `RenderProgram` 画的是全 scene 的合并数据，不是单个 `Splat`，所以 SH 也必须挂到 `RenderData`。

这里先做**单 Splat 场景优先**的正确实现，适合你论文 demo。多 Splat 合并以后再扩展。

---

## 5.1 顶部新增 import

```ts
import { SphericalHarmonicsData } from "../../../splats/SphericalHarmonicsData";
```

变成：

```ts
import { Scene } from "../../../core/Scene";
import { Splat } from "../../../splats/Splat";
import { SphericalHarmonicsData } from "../../../splats/SphericalHarmonicsData";
```

---

## 5.2 类字段新增

在：

```ts
private _vertexCount: number;
```

下面加：

```ts
private _sphericalHarmonics: SphericalHarmonicsData | null;
```

---

## 5.3 构造函数中初始化

在统计完 splat 之后，也就是这段后面：

```ts
for (const object of scene.objects) {
    if (object instanceof Splat) {
        this._splatIndices.set(object, splatIndex);
        this._offsets.set(object, vertexCount);
        lookup.set(vertexCount, object);
        vertexCount += object.data.vertexCount;
        splatIndex++;
    }
}
```

加：

```ts
this._sphericalHarmonics = null;

const splats = Array.from(this._splatIndices.keys());
const splatsWithSH = splats.filter((splat) => splat.data.sphericalHarmonics !== null);

if (splatsWithSH.length === 1 && splats.length === 1) {
    this._sphericalHarmonics = splatsWithSH[0].data.sphericalHarmonics;
} else if (splatsWithSH.length > 0) {
    console.warn(
        "Spherical Harmonics rendering currently supports one SH-enabled Splat per scene. Falling back to base colors.",
    );
}
```

注意：这一步我故意只支持单对象。原因是多对象合并时 `index` 和 `shIndex` 偏移会变复杂，先保证论文 demo 和 reduced-3dgs 单场景稳定。

---

## 5.4 新增 getter

在 getter 区域加：

```ts
get sphericalHarmonics() {
    return this._sphericalHarmonics;
}
```

---

# 6. 修改：`src/renderers/webgl/programs/RenderProgram.ts`

这个文件要改三块：

1. shader 增加 SH 函数和 uniform
2. TypeScript 侧创建 SH 纹理和 uniform
3. 数据变化时上传 SH 纹理

---

## 6.1 修改 vertex shader uniform

在 shader 顶部找到：

```glsl
uniform highp usampler2D u_texture;
uniform highp sampler2D u_transforms;
```

改成：

```glsl
uniform highp usampler2D u_texture;
uniform highp sampler2D u_transforms;
uniform bool u_useSH;
uniform highp usampler2D u_sh_r;
uniform highp usampler2D u_sh_g;
uniform highp usampler2D u_sh_b;
uniform ivec3 u_bandIndex;
```

---

## 6.2 在 vertex shader 的 `out` 前插入 SH 函数

也就是在：

```glsl
in vec2 position;
in int index;

out vec4 vColor;
```

中间插入下面完整代码：

```glsl
const float SH_C0 = 0.28209479177387814;
const float SH_C1 = 0.4886025119029199;

const float SH_C2[5] = float[](
    1.0925484305920792,
    -1.0925484305920792,
    0.31539156525252005,
    -1.0925484305920792,
    0.5462742152960396
);

const float SH_C3[7] = float[](
    -0.5900435899266435,
    2.890611442640554,
    -0.4570457994644658,
    0.3731763325901154,
    -0.4570457994644658,
    1.445305721320277,
    -0.5900435899266435
);

void fillSHFromPacked(in uvec4 packed0, in uvec4 packed1, in int offset, inout float shs[48]) {
    float sorted[16];

    int ind = 0;

    for (int i = 0; i < 4; i++) {
        vec2 v = unpackHalf2x16(packed0[i]);
        sorted[ind] = v.x;
        sorted[ind + 1] = v.y;
        ind += 2;
    }

    for (int i = 0; i < 4; i++) {
        vec2 v = unpackHalf2x16(packed1[i]);
        sorted[ind] = v.x;
        sorted[ind + 1] = v.y;
        ind += 2;
    }

    for (int i = 0; i < 16; i++) {
        shs[offset + i * 3] = sorted[i];
    }
}

vec3 evalSHRGB(int shIndex, uint degree, vec3 dir) {
    float shs[48];

    uvec4 packedR0 = texelFetch(u_sh_r, ivec2(((uint(shIndex) & 0x3ffu) << 1), uint(shIndex) >> 10), 0);
    uvec4 packedR1 = texelFetch(u_sh_r, ivec2(((uint(shIndex) & 0x3ffu) << 1) | 1u, uint(shIndex) >> 10), 0);

    uvec4 packedG0 = texelFetch(u_sh_g, ivec2(((uint(shIndex) & 0x3ffu) << 1), uint(shIndex) >> 10), 0);
    uvec4 packedG1 = texelFetch(u_sh_g, ivec2(((uint(shIndex) & 0x3ffu) << 1) | 1u, uint(shIndex) >> 10), 0);

    uvec4 packedB0 = texelFetch(u_sh_b, ivec2(((uint(shIndex) & 0x3ffu) << 1), uint(shIndex) >> 10), 0);
    uvec4 packedB1 = texelFetch(u_sh_b, ivec2(((uint(shIndex) & 0x3ffu) << 1) | 1u, uint(shIndex) >> 10), 0);

    fillSHFromPacked(packedR0, packedR1, 0, shs);
    fillSHFromPacked(packedG0, packedG1, 1, shs);
    fillSHFromPacked(packedB0, packedB1, 2, shs);

    vec3 result = SH_C0 * vec3(shs[0], shs[1], shs[2]);

    if (degree > 0u) {
        float x = dir.x;
        float y = dir.y;
        float z = dir.z;

        result -=
            SH_C1 * y * vec3(shs[3], shs[4], shs[5]) +
            SH_C1 * z * vec3(shs[6], shs[7], shs[8]) -
            SH_C1 * x * vec3(shs[9], shs[10], shs[11]);

        if (degree > 1u) {
            float xx = x * x;
            float yy = y * y;
            float zz = z * z;
            float xy = x * y;
            float yz = y * z;
            float xz = x * z;

            result +=
                SH_C2[0] * xy * vec3(shs[12], shs[13], shs[14]) +
                SH_C2[1] * yz * vec3(shs[15], shs[16], shs[17]) +
                SH_C2[2] * (2.0 * zz - xx - yy) * vec3(shs[18], shs[19], shs[20]) +
                SH_C2[3] * xz * vec3(shs[21], shs[22], shs[23]) +
                SH_C2[4] * (xx - yy) * vec3(shs[24], shs[25], shs[26]);

            if (degree > 2u) {
                result +=
                    SH_C3[0] * y * (3.0 * xx - yy) * vec3(shs[27], shs[28], shs[29]) +
                    SH_C3[1] * xy * z * vec3(shs[30], shs[31], shs[32]) +
                    SH_C3[2] * y * (4.0 * zz - xx - yy) * vec3(shs[33], shs[34], shs[35]) +
                    SH_C3[3] * z * (2.0 * zz - 3.0 * xx - 3.0 * yy) * vec3(shs[36], shs[37], shs[38]) +
                    SH_C3[4] * x * (4.0 * zz - xx - yy) * vec3(shs[39], shs[40], shs[41]) +
                    SH_C3[5] * z * (xx - yy) * vec3(shs[42], shs[43], shs[44]) +
                    SH_C3[6] * x * (xx - 3.0 * yy) * vec3(shs[45], shs[46], shs[47]);
            }
        }
    }

    result += 0.5;

    return clamp(result, vec3(0.0), vec3(1.0));
}
```

---

## 6.3 替换 shader 颜色计算部分

找到：

```glsl
vec4 color = vec4((cov.w) & 0xffu, (cov.w >> 8) & 0xffu, (cov.w >> 16) & 0xffu, (cov.w >> 24) & 0xffu) / 255.0;
vColor = colorTransform * color;
```

替换为：

```glsl
vec4 color = vec4(
    (cov.w) & 0xffu,
    (cov.w >> 8) & 0xffu,
    (cov.w >> 16) & 0xffu,
    (cov.w >> 24) & 0xffu
) / 255.0;

if (u_useSH) {
    int shIndex = index;
    uint degree = 3u;

    if (u_bandIndex[0] >= 0) {
        if (index <= u_bandIndex[0]) {
            degree = 0u;
        }
        else if (index <= u_bandIndex[1]) {
            degree = 1u;
            shIndex = index - (u_bandIndex[0] + 1);
        }
        else if (index <= u_bandIndex[2]) {
            degree = 2u;
            shIndex = index - (u_bandIndex[0] + 1);
        }
        else {
            degree = 3u;
            shIndex = index - (u_bandIndex[0] + 1);
        }
    }

    if (degree > 0u || u_bandIndex[0] < 0) {
        vec3 worldPosition = (transform * vec4(uintBitsToFloat(cen.xyz), 1.0)).xyz;
        vec3 cameraPosition = inverse(view)[3].xyz;
        vec3 dir = normalize(worldPosition - cameraPosition);

        color.rgb = evalSHRGB(shIndex, degree, dir);
    }
}

vColor = colorTransform * color;
```

---

## 6.4 TypeScript 类字段新增

在：

```ts
private _splatTexture: WebGLTexture | null = null;
private _worker: Worker | null = null;
```

下面加：

```ts
private _shTextures: [WebGLTexture | null, WebGLTexture | null, WebGLTexture | null] = [null, null, null];
```

---

## 6.5 constructor 里新增 uniform 变量

找到：

```ts
let u_colorTransformIndices: WebGLUniformLocation;
```

下面加：

```ts
let u_useSH: WebGLUniformLocation;
let u_sh_r: WebGLUniformLocation;
let u_sh_g: WebGLUniformLocation;
let u_sh_b: WebGLUniformLocation;
let u_bandIndex: WebGLUniformLocation;
```

---

## 6.6 `_initialize` 里初始化 SH uniform 和 texture

找到：

```ts
gl.uniform1i(u_colorTransformIndices, 4);
```

后面加：

```ts
u_useSH = gl.getUniformLocation(this.program, "u_useSH") as WebGLUniformLocation;
gl.uniform1i(u_useSH, 0);

u_sh_r = gl.getUniformLocation(this.program, "u_sh_r") as WebGLUniformLocation;
u_sh_g = gl.getUniformLocation(this.program, "u_sh_g") as WebGLUniformLocation;
u_sh_b = gl.getUniformLocation(this.program, "u_sh_b") as WebGLUniformLocation;

gl.uniform1i(u_sh_r, 5);
gl.uniform1i(u_sh_g, 6);
gl.uniform1i(u_sh_b, 7);

u_bandIndex = gl.getUniformLocation(this.program, "u_bandIndex") as WebGLUniformLocation;
gl.uniform3iv(u_bandIndex, new Int32Array([-1, -1, -1]));

this._shTextures = [
    gl.createTexture() as WebGLTexture,
    gl.createTexture() as WebGLTexture,
    gl.createTexture() as WebGLTexture,
];
```

---

## 6.7 constructor 内新增上传函数

在 `resetSplatData` 附近加：

```ts
const uploadSphericalHarmonics = () => {
    if (!this.renderData || !this.renderData.sphericalHarmonics) {
        gl.uniform1i(u_useSH, 0);
        return;
    }

    const sh = this.renderData.sphericalHarmonics;

    gl.uniform1i(u_useSH, 1);
    gl.uniform3iv(u_bandIndex, sh.bandsIndices);

    for (let channel = 0; channel < 3; channel++) {
        gl.activeTexture(gl.TEXTURE5 + channel);
        gl.bindTexture(gl.TEXTURE_2D, this._shTextures[channel]);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA32UI,
            sh.width,
            sh.height,
            0,
            gl.RGBA_INTEGER,
            gl.UNSIGNED_INT,
            sh.rgb[channel],
        );
    }

    gl.activeTexture(gl.TEXTURE0);
};
```

---

## 6.8 在 dataChanged 时上传 SH

找到 `_render()` 里的：

```ts
if (this.renderData.dataChanged) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.splatTexture);
    ...
    gl.texImage2D(...);
}
```

在这个 `if` 的末尾加：

```ts
uploadSphericalHarmonics();
```

变成：

```ts
if (this.renderData.dataChanged) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.splatTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32UI,
        this.renderData.width,
        this.renderData.height,
        0,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_INT,
        this.renderData.data,
    );

    uploadSphericalHarmonics();
}
```

---

## 6.9 dispose 时删除 SH 纹理

在 `_dispose` 里找到：

```ts
gl.deleteTexture(this.splatTexture);
gl.deleteTexture(transformsTexture);
gl.deleteTexture(transformIndicesTexture);
```

后面加：

```ts
for (const texture of this._shTextures) {
    if (texture) {
        gl.deleteTexture(texture);
    }
}
```

---

# 7. 修改：`src/index.ts`

加导出：

```ts
export { SphericalHarmonicsData } from "./splats/SphericalHarmonicsData";
```

如果你想导出半精度工具，也可以加：

```ts
export { float32ToFloat16Bits, float16BitsToFloat32, packHalf2x16 } from "./utils/HalfFloat";
```

---

# 8. 当前方案支持什么？

完成以上改动后：

## 支持

```text
标准 3DGS PLY:
- x y z
- scale_0 scale_1 scale_2
- rot_0 rot_1 rot_2 rot_3
- opacity
- f_dc_0 f_dc_1 f_dc_2
- f_rest_0 ... f_rest_44
```

也就是 baseline PLY 里的**完整三阶 SH**。

---

## 暂不完整支持

```text
reduced-3dgs quantized QPLY:
- vertex_0
- vertex_1
- vertex_2
- vertex_3
- codebook_centers
```

但我们已经把 `SphericalHarmonicsData.bandsIndices` 设计好了，shader 也已经支持：

```glsl
u_bandIndex
```

也就是说，之后加 QPLY loader 时不需要再动 shader，只要 loader 正确生成：

```ts
new SphericalHarmonicsData(width, height, rgb, shCount, bandsIndices)
```

即可。

---

# 9. 测试方式

建议先用 baseline PLY 测试。

例如：

```ts
import * as SPLAT from "gsplat";

const scene = new SPLAT.Scene();
const camera = new SPLAT.Camera();
const renderer = new SPLAT.WebGLRenderer();
const controls = new SPLAT.OrbitControls(camera, renderer.canvas);

async function main() {
    await SPLAT.PLYLoader.LoadAsync(
        "https://repo-sam.inria.fr/fungraph/reduced_3dgs/scenes/bonsai/baseline_bonsai.ply",
        scene,
        (progress) => console.log(progress),
    );

    function frame() {
        controls.update();
        renderer.render(scene, camera);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main();
```

如果 SH 正常，你会看到：

- 颜色随视角变化
- 高光方向会变化
- 不是简单的固定 RGB

---

# 10. 如果 shader 编译失败，优先查这三个点

## 1. `inverse(view)` 是否被 WebGL2 编译器接受

如果移动端报错，可以改成传 `cameraPosition` uniform，避免 shader 里求逆。

临时替换：

```glsl
vec3 cameraPosition = inverse(view)[3].xyz;
```

为：

```glsl
vec3 cameraPosition = vec3(0.0); // 测试用
```

如果这样能编译，说明是 `inverse(view)` 的兼容性问题。

---

## 2. `float shs[48]` 是否过大

大多数 WebGL2 设备没问题。如果移动端编译器爆寄，可以把函数拆成 R/G/B 分别计算，不过第一版先不做。

---

## 3. texture unit 冲突

你当前已经用了：

```text
TEXTURE0: u_texture
TEXTURE1: u_transforms
TEXTURE2: u_transformIndices
TEXTURE3: u_colorTransforms
TEXTURE4: u_colorTransformIndices
```

所以 SH 必须从：

```text
TEXTURE5, TEXTURE6, TEXTURE7
```

开始。不要覆盖原来的 0~4。

---

# 11. 下一步：QPLY 支持怎么接

等标准 full SH PLY 跑通后，再把 INRIA `_ParseQPLYBuffer` 迁入 `PLYLoader.ts`，逻辑是：

```ts
if (isQPLY(inputBuffer)) {
    const result = parseQPLY(inputBuffer);
    const data = SplatData.Deserialize(new Uint8Array(result.splatBuffer));
    data.sphericalHarmonics = result.sphericalHarmonics;
    return new Splat(data);
}
```

QPLY 的解析不需要再动 `RenderProgram.ts`，因为：

- `u_bandIndex` 已支持
- `shIndex` 偏移已支持
- degree 0/1/2/3 自适应已支持
- SH 纹理格式已统一为 `RGBA32UI`

---

# 12. 最终结论

你这条路线现在已经非常明确：

```text
gsplat.js 原始管线
    +
标准 PLY 三阶 SH 解析
    +
RGBA32UI SH 纹理
    +
shader 中 evalSHRGB
    +
之后接入 QPLY codebook 解压
```

这是比改 `GaussianSplats3D` 更贴近 INRIA viewer 的方案，因为你现在的 `RenderProgram.ts` 本来就和 INRIA viewer 的 WebGL2 管线高度同源。  
先按上面方案跑通 `baseline_bonsai.ply`，再加 `quantized_bonsai.ply` 的 QPLY loader。