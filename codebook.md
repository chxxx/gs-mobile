太好了，标准三阶 SH 已经跑通，说明最难的 **shader / SH 纹理 / WebGL 管线**都已经没问题了。现在加 `point_cloud_quantised_half.ply` 的支持，重点就只剩一个：

> **把 reduced-3dgs 的 quantised half PLY，也就是 QPLY，解析成你已经跑通的同一套 `SplatData + SphericalHarmonicsData`。**

你现在不需要再动 shader 逻辑，因为上一版已经支持：

```glsl
u_bandIndex
degree 0 / 1 / 2 / 3
shIndex = index - (u_bandIndex[0] + 1)
```

所以这次只需要改 Loader。

---

# 一、QPLY 文件结构回顾

`point_cloud_quantised_half.ply` 一般不是标准：

```text
element vertex N
```

而是：

```text
element vertex_0 N0
element vertex_1 N1
element vertex_2 N2
element vertex_3 N3
element codebook_centers 256
```

含义：

| 分组 | SH 阶数 | 是否有 SH texture |
|---|---:|---|
| `vertex_0` | 0 阶，只用 DC 颜色 | 否 |
| `vertex_1` | 1 阶 | 是 |
| `vertex_2` | 2 阶 | 是 |
| `vertex_3` | 3 阶 | 是 |

最终传给 shader 的边界是：

```ts
bandsIndices = [
    vertex_0_count - 1,
    vertex_0_count + vertex_1_count - 1,
    vertex_0_count + vertex_1_count + vertex_2_count - 1,
];
```

---

# 二、新增文件：`src/loaders/QPLYLoaderUtils.ts`

新建：

```text
src/loaders/QPLYLoaderUtils.ts
```

完整代码如下。

```ts
import { Quaternion } from "../math/Quaternion";
import { SplatData } from "../splats/SplatData";
import { SphericalHarmonicsData } from "../splats/SphericalHarmonicsData";
import { float16BitsToFloat32, packHalf2x16 } from "../utils/HalfFloat";
import { Converter } from "../utils/Converter";

type PlyProperty = {
    name: string;
    type: string;
    offset: number;
};

type ParsedQPLYResult = {
    splatBuffer: ArrayBuffer;
    sphericalHarmonics: SphericalHarmonicsData;
};

const TYPE_BYTE_LENGTH: Record<string, number> = {
    double: 8,
    int: 4,
    uint: 4,
    float: 4,
    short: 2,
    ushort: 2,
    uchar: 1,
};

function sigmoid(value: number): number {
    return 1 / (1 + Math.exp(-value));
}

function parseProperties(headerBlock: string): {
    properties: PlyProperty[];
    rowLength: number;
} {
    const properties: PlyProperty[] = [];
    let offset = 0;

    for (const line of headerBlock.split("\n").filter((line) => line.startsWith("property "))) {
        const [_property, type, name] = line.split(" ");

        if (!TYPE_BYTE_LENGTH[type]) {
            throw new Error(`Unsupported QPLY property type: ${type}`);
        }

        properties.push({
            name,
            type,
            offset,
        });

        offset += TYPE_BYTE_LENGTH[type];
    }

    return {
        properties,
        rowLength: offset,
    };
}

function mapProperties(properties: PlyProperty[]): Record<string, PlyProperty> {
    return properties.reduce<Record<string, PlyProperty>>((map, property) => {
        map[property.name] = property;
        return map;
    }, {});
}

function normalizeQuaternion(w: number, x: number, y: number, z: number): Quaternion {
    return new Quaternion(x, y, z, w).normalize();
}

function readHalfFromDataView(view: DataView, byteOffset: number): number {
    return float16BitsToFloat32(view.getInt16(byteOffset, true) & 0xffff);
}

function readCodebookValue(
    codebooks: Record<string, Float32Array>,
    codebookName: string,
    index: number,
): number {
    const codebook = codebooks[codebookName];

    if (!codebook) {
        throw new Error(`Missing QPLY codebook: ${codebookName}`);
    }

    return codebook[index];
}

function assertProperty(properties: Record<string, PlyProperty>, name: string): PlyProperty {
    const property = properties[name];

    if (!property) {
        throw new Error(`Missing QPLY property: ${name}`);
    }

    return property;
}

function isQPLYHeader(headerText: string): boolean {
    return (
        headerText.includes("element vertex_0") &&
        headerText.includes("element vertex_1") &&
        headerText.includes("element vertex_2") &&
        headerText.includes("element vertex_3") &&
        headerText.includes("element codebook_centers 256")
    );
}

function parseVertexGroupCounts(headerText: string): {
    counts: number[];
    offsets: number[];
} {
    const matches = headerText.match(/element vertex_(\d+) (\d+)/g) ?? [];

    if (matches.length !== 4) {
        throw new Error(`Invalid QPLY: expected vertex_0..vertex_3, got ${matches.length} groups.`);
    }

    const counts: number[] = [0, 0, 0, 0];
    const offsets: number[] = [0, 0, 0, 0];

    for (const match of matches) {
        const parts = match.split(" ");
        const group = parseInt(parts[1].split("_")[1], 10);
        const count = parseInt(parts[2], 10);

        counts[group] = count;
        offsets[group] = headerText.indexOf(match);
    }

    return {
        counts,
        offsets,
    };
}

/**
 * Detect whether this buffer is INRIA/reduced-3dgs quantised-half PLY.
 */
function IsQPLY(inputBuffer: ArrayBuffer): boolean {
    const headerText = new TextDecoder().decode(new Uint8Array(inputBuffer).slice(0, 1024 * 10));
    return isQPLYHeader(headerText);
}

/**
 * Parse INRIA reduced-3dgs quantised-half PLY.
 *
 * Supports:
 * - vertex_0 / vertex_1 / vertex_2 / vertex_3
 * - codebook_centers 256
 * - adaptive SH degree
 * - half-float positions
 * - uint8 codebook indices for scale / rotation / opacity / SH
 */
function ParseQPLYBuffer(inputBuffer: ArrayBuffer): ParsedQPLYResult {
    const bytes = new Uint8Array(inputBuffer);
    const headerText = new TextDecoder().decode(bytes.slice(0, 1024 * 10));

    const headerEndToken = "end_header\n";
    const headerEndIndex = headerText.indexOf(headerEndToken);

    if (headerEndIndex < 0) {
        throw new Error("Unable to read QPLY header.");
    }

    if (!isQPLYHeader(headerText)) {
        throw new Error("Invalid QPLY file.");
    }

    const dataStart = headerEndIndex + headerEndToken.length;

    const codebookElementText = "element codebook_centers 256\n";
    const codebookHeaderOffset = headerText.indexOf(codebookElementText);

    if (codebookHeaderOffset < 0) {
        throw new Error("Invalid QPLY: missing element codebook_centers 256.");
    }

    const { counts, offsets } = parseVertexGroupCounts(headerText);

    const vertexBlocks: [number, number][] = [
        [offsets[0], offsets[1]],
        [offsets[1], offsets[2]],
        [offsets[2], offsets[3]],
        [offsets[3], codebookHeaderOffset],
    ];

    const groupProperties: PlyProperty[][] = [];
    const groupRowLengths: number[] = [];

    let vertexDataByteLength = 0;

    for (let group = 0; group < 4; group++) {
        const [start, end] = vertexBlocks[group];
        const parsed = parseProperties(headerText.slice(start, end));

        groupProperties[group] = parsed.properties;
        groupRowLengths[group] = parsed.rowLength;

        vertexDataByteLength += counts[group] * parsed.rowLength;
    }

    /**
     * Parse codebook property names.
     */
    const codebookNames: string[] = [];

    for (const line of headerText
        .slice(codebookHeaderOffset, headerEndIndex)
        .split("\n")
        .filter((line) => line.startsWith("property "))) {
        const [_property, _type, name] = line.split(" ");
        codebookNames.push(name);
    }

    const codebookCount = codebookNames.length;

    if (codebookCount === 0) {
        throw new Error("Invalid QPLY: empty codebook_centers element.");
    }

    const codebooks: Record<string, Float32Array> = {};

    for (const name of codebookNames) {
        codebooks[name] = new Float32Array(256);
    }

    /**
     * Codebook storage:
     * 256 rows, each row has codebookCount half-float values.
     */
    const codebookView = new DataView(
        inputBuffer,
        dataStart + vertexDataByteLength,
        256 * codebookCount * 2,
    );

    for (let centerIndex = 0; centerIndex < 256; centerIndex++) {
        for (let codebookIndex = 0; codebookIndex < codebookCount; codebookIndex++) {
            const byteOffset = centerIndex * codebookCount * 2 + codebookIndex * 2;
            const bits = codebookView.getInt16(byteOffset, true) & 0xffff;
            codebooks[codebookNames[codebookIndex]][centerIndex] = float16BitsToFloat32(bits);
        }
    }

    const totalVertexCount = counts[0] + counts[1] + counts[2] + counts[3];

    const splatBuffer = new ArrayBuffer(SplatData.RowLength * totalVertexCount);
    const splatFloat = new Float32Array(splatBuffer);
    const splatUint8 = new Uint8ClampedArray(splatBuffer);

    /**
     * Only vertex_1, vertex_2, vertex_3 have SH texture entries.
     */
    const shCount = counts[1] + counts[2] + counts[3];
    const shWidth = 2048;
    const shHeight = Math.ceil((2 * shCount) / shWidth);

    const shRgb: [Uint32Array, Uint32Array, Uint32Array] = [
        new Uint32Array(shWidth * shHeight * 4),
        new Uint32Array(shWidth * shHeight * 4),
        new Uint32Array(shWidth * shHeight * 4),
    ];

    const bandsIndices = new Int32Array([
        counts[0] - 1,
        counts[0] + counts[1] - 1,
        counts[0] + counts[1] + counts[2] - 1,
    ]);

    const vertexView = new DataView(inputBuffer, dataStart, vertexDataByteLength);

    let sourceOffset = 0;
    let globalIndex = 0;
    let shIndex = 0;

    /**
     * Number of rest coefficients by group:
     * vertex_0: degree 0 => no rest coeffs
     * vertex_1: degree 1 => 3 rest coeffs
     * vertex_2: degree 2 => 8 rest coeffs
     * vertex_3: degree 3 => 15 rest coeffs
     */
    const degreeRestCount = [0, 3, 8, 15];

    for (let group = 0; group < 4; group++) {
        const rowLength = groupRowLengths[group];
        const propertyMap = mapProperties(groupProperties[group]);
        const count = counts[group];

        const propX = assertProperty(propertyMap, "x");
        const propY = assertProperty(propertyMap, "y");
        const propZ = assertProperty(propertyMap, "z");

        const propScale0 = assertProperty(propertyMap, "scale_0");
        const propScale1 = assertProperty(propertyMap, "scale_1");
        const propScale2 = assertProperty(propertyMap, "scale_2");

        const propRot0 = assertProperty(propertyMap, "rot_0");
        const propRot1 = assertProperty(propertyMap, "rot_1");
        const propRot2 = assertProperty(propertyMap, "rot_2");
        const propRot3 = assertProperty(propertyMap, "rot_3");

        const propFdc0 = assertProperty(propertyMap, "f_dc_0");
        const propFdc1 = assertProperty(propertyMap, "f_dc_1");
        const propFdc2 = assertProperty(propertyMap, "f_dc_2");
        const propOpacity = assertProperty(propertyMap, "opacity");

        const restProperties = groupProperties[group].filter((property) => property.name.startsWith("f_rest"));

        for (let localIndex = 0; localIndex < count; localIndex++) {
            const base = sourceOffset + localIndex * rowLength;

            /**
             * Position is stored directly as half floats.
             */
            const x = readHalfFromDataView(vertexView, base + propX.offset);
            const y = readHalfFromDataView(vertexView, base + propY.offset);
            const z = readHalfFromDataView(vertexView, base + propZ.offset);

            splatFloat[8 * globalIndex + 0] = x;
            splatFloat[8 * globalIndex + 1] = y;
            splatFloat[8 * globalIndex + 2] = z;

            /**
             * Scale uses shared scaling codebook.
             */
            const scale0 = Math.exp(
                readCodebookValue(codebooks, "scaling", vertexView.getUint8(base + propScale0.offset)),
            );
            const scale1 = Math.exp(
                readCodebookValue(codebooks, "scaling", vertexView.getUint8(base + propScale1.offset)),
            );
            const scale2 = Math.exp(
                readCodebookValue(codebooks, "scaling", vertexView.getUint8(base + propScale2.offset)),
            );

            splatFloat[8 * globalIndex + 3] = scale0;
            splatFloat[8 * globalIndex + 4] = scale1;
            splatFloat[8 * globalIndex + 5] = scale2;

            /**
             * Rotation:
             * rot_0 uses rotation_re
             * rot_1/2/3 use rotation_im
             */
            const qw = readCodebookValue(
                codebooks,
                "rotation_re",
                vertexView.getUint8(base + propRot0.offset),
            );
            const qx = readCodebookValue(
                codebooks,
                "rotation_im",
                vertexView.getUint8(base + propRot1.offset),
            );
            const qy = readCodebookValue(
                codebooks,
                "rotation_im",
                vertexView.getUint8(base + propRot2.offset),
            );
            const qz = readCodebookValue(
                codebooks,
                "rotation_im",
                vertexView.getUint8(base + propRot3.offset),
            );

            const q = normalizeQuaternion(qw, qx, qy, qz);

            splatUint8[32 * globalIndex + 28 + 0] = q.w * 128 + 128;
            splatUint8[32 * globalIndex + 28 + 1] = q.x * 128 + 128;
            splatUint8[32 * globalIndex + 28 + 2] = q.y * 128 + 128;
            splatUint8[32 * globalIndex + 28 + 3] = q.z * 128 + 128;

            /**
             * DC color and opacity.
             */
            const fdc0 = readCodebookValue(
                codebooks,
                "features_dc",
                vertexView.getUint8(base + propFdc0.offset),
            );
            const fdc1 = readCodebookValue(
                codebooks,
                "features_dc",
                vertexView.getUint8(base + propFdc1.offset),
            );
            const fdc2 = readCodebookValue(
                codebooks,
                "features_dc",
                vertexView.getUint8(base + propFdc2.offset),
            );

            const opacity = readCodebookValue(
                codebooks,
                "opacity",
                vertexView.getUint8(base + propOpacity.offset),
            );

            splatUint8[32 * globalIndex + 24 + 0] = (0.5 + Converter.SH_C0 * fdc0) * 255;
            splatUint8[32 * globalIndex + 24 + 1] = (0.5 + Converter.SH_C0 * fdc1) * 255;
            splatUint8[32 * globalIndex + 24 + 2] = (0.5 + Converter.SH_C0 * fdc2) * 255;
            splatUint8[32 * globalIndex + 24 + 3] = sigmoid(opacity) * 255;

            /**
             * SH texture entries only for vertex_1/2/3.
             */
            if (group > 0) {
                const coeffR = new Array<number>(16).fill(0);
                const coeffG = new Array<number>(16).fill(0);
                const coeffB = new Array<number>(16).fill(0);

                coeffR[0] = fdc0;
                coeffG[0] = fdc1;
                coeffB[0] = fdc2;

                /**
                 * QPLY rest property layout:
                 * localRestIndex cycles through RGB:
                 *
                 * localRestIndex 0 => coeff 0, R
                 * localRestIndex 1 => coeff 0, G
                 * localRestIndex 2 => coeff 0, B
                 * localRestIndex 3 => coeff 1, R
                 * ...
                 *
                 * codebook name:
                 * features_rest_0 ... features_rest_14
                 */
                for (let localRestIndex = 0; localRestIndex < restProperties.length; localRestIndex++) {
                    const coeffIndex = Math.floor(localRestIndex / 3);
                    const channel = localRestIndex % 3;

                    if (coeffIndex >= degreeRestCount[group]) {
                        continue;
                    }

                    const property = restProperties[localRestIndex];
                    const codebookName = `features_rest_${coeffIndex}`;

                    const value = readCodebookValue(
                        codebooks,
                        codebookName,
                        vertexView.getUint8(base + property.offset),
                    );

                    if (channel === 0) {
                        coeffR[coeffIndex + 1] = value;
                    } else if (channel === 1) {
                        coeffG[coeffIndex + 1] = value;
                    } else {
                        coeffB[coeffIndex + 1] = value;
                    }
                }

                for (let packed = 0; packed < 8; packed++) {
                    shRgb[0][8 * shIndex + packed] = packHalf2x16(
                        coeffR[2 * packed],
                        coeffR[2 * packed + 1],
                    );
                    shRgb[1][8 * shIndex + packed] = packHalf2x16(
                        coeffG[2 * packed],
                        coeffG[2 * packed + 1],
                    );
                    shRgb[2][8 * shIndex + packed] = packHalf2x16(
                        coeffB[2 * packed],
                        coeffB[2 * packed + 1],
                    );
                }

                shIndex++;
            }

            globalIndex++;
        }

        sourceOffset += count * rowLength;
    }

    return {
        splatBuffer,
        sphericalHarmonics: new SphericalHarmonicsData(
            shWidth,
            shHeight,
            shRgb,
            shCount,
            bandsIndices,
        ),
    };
}

export { IsQPLY, ParseQPLYBuffer };
```

---

# 三、修改 `PLYLoader.ts`

现在把 QPLY 分支接到 loader 里。

## 1. 顶部新增 import

在 `PLYLoader.ts` 顶部加：

```ts
import { IsQPLY, ParseQPLYBuffer } from "./QPLYLoaderUtils";
```

也就是顶部类似：

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
import { IsQPLY, ParseQPLYBuffer } from "./QPLYLoaderUtils";
```

---

## 2. 修改 `LoadFromArrayBuffer`

把你现在的：

```ts
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
```

替换成：

```ts
static LoadFromArrayBuffer(arrayBuffer: ArrayBufferLike, scene: Scene, format: string = ""): Splat {
    const inputBuffer = arrayBuffer as ArrayBuffer;

    if (IsQPLY(inputBuffer)) {
        const result = ParseQPLYBuffer(inputBuffer);
        const data = SplatData.Deserialize(new Uint8Array(result.splatBuffer));

        data.sphericalHarmonics = result.sphericalHarmonics;

        const splat = new Splat(data);
        scene.addObject(splat);

        return splat;
    }

    const result = this._ParsePLYBufferWithSH(inputBuffer, format);
    const data = SplatData.Deserialize(new Uint8Array(result.splatBuffer));

    if (result.sphericalHarmonics) {
        data.sphericalHarmonics = result.sphericalHarmonics;
    }

    const splat = new Splat(data);
    scene.addObject(splat);

    return splat;
}
```

---

# 四、确认 `RenderProgram.ts` 里 QPLY 分支已正确

你上一版 shader 里必须是这个逻辑：

```glsl
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
```

这个逻辑对 QPLY 是对的，因为：

- `vertex_0` 没有 SH texture entry，所以 `degree=0`
- `vertex_1/2/3` 的 SH texture index 从 `0` 开始
- 因此：

```glsl
shIndex = index - (u_bandIndex[0] + 1)
```

正好跳过所有 `vertex_0`

---

# 五、一个非常重要的兼容修正

你这个 QPLY loader 依赖属性名：

```text
scale_0
scale_1
scale_2
rot_0
rot_1
rot_2
rot_3
f_dc_0
f_dc_1
f_dc_2
opacity
f_rest_*
```

如果你的 `point_cloud_quantised_half.ply` 里是：

```text
scaling_0
scaling_1
scaling_2
rotation_0
rotation_1
rotation_2
rotation_3
features_dc_0
```

那就需要做别名兼容。

你可以把 QPLY 里的这些行：

```ts
const propScale0 = assertProperty(propertyMap, "scale_0");
const propScale1 = assertProperty(propertyMap, "scale_1");
const propScale2 = assertProperty(propertyMap, "scale_2");

const propRot0 = assertProperty(propertyMap, "rot_0");
const propRot1 = assertProperty(propertyMap, "rot_1");
const propRot2 = assertProperty(propertyMap, "rot_2");
const propRot3 = assertProperty(propertyMap, "rot_3");
```

换成带别名版本：

```ts
function assertAnyProperty(properties: Record<string, PlyProperty>, names: string[]): PlyProperty {
    for (const name of names) {
        if (properties[name]) {
            return properties[name];
        }
    }

    throw new Error(`Missing QPLY property, tried: ${names.join(", ")}`);
}
```

然后改为：

```ts
const propScale0 = assertAnyProperty(propertyMap, ["scale_0", "scaling_0"]);
const propScale1 = assertAnyProperty(propertyMap, ["scale_1", "scaling_1"]);
const propScale2 = assertAnyProperty(propertyMap, ["scale_2", "scaling_2"]);

const propRot0 = assertAnyProperty(propertyMap, ["rot_0", "rotation_0"]);
const propRot1 = assertAnyProperty(propertyMap, ["rot_1", "rotation_1"]);
const propRot2 = assertAnyProperty(propertyMap, ["rot_2", "rotation_2"]);
const propRot3 = assertAnyProperty(propertyMap, ["rot_3", "rotation_3"]);

const propFdc0 = assertAnyProperty(propertyMap, ["f_dc_0", "features_dc_0", "features_0"]);
const propFdc1 = assertAnyProperty(propertyMap, ["f_dc_1", "features_dc_1", "features_1"]);
const propFdc2 = assertAnyProperty(propertyMap, ["f_dc_2", "features_dc_2", "features_2"]);

const propOpacity = assertAnyProperty(propertyMap, ["opacity", "opacity_0"]);
```

建议你直接加这个兼容函数，稳一点。

---

# 六、测试代码

用你的文件：

```ts
await SPLAT.PLYLoader.LoadAsync(
    "/path/to/point_cloud_quantised_half.ply",
    scene,
    (progress) => console.log(progress),
);
```

或者本地拖拽：

```ts
const file = input.files![0];

await SPLAT.PLYLoader.LoadFromFileAsync(
    file,
    scene,
    (progress) => console.log(progress),
);
```

---

# 七、如果渲染黑屏，按这个顺序排查

## 1. 先看是不是识别到 QPLY

在 `PLYLoader.ts` 里临时加：

```ts
console.log("IsQPLY:", IsQPLY(inputBuffer));
```

如果是 `false`，说明 header 文本和预期不同。

---

## 2. 打印 group count

在 `ParseQPLYBuffer` 里加：

```ts
console.log("QPLY vertex groups:", counts);
console.log("QPLY bands:", bandsIndices);
console.log("QPLY SH count:", shCount);
```

应该类似：

```text
QPLY vertex groups: [N0, N1, N2, N3]
QPLY bands: [N0-1, N0+N1-1, N0+N1+N2-1]
QPLY SH count: N1+N2+N3
```

---

## 3. 检查 codebook 名字

加：

```ts
console.log("QPLY codebooks:", codebookNames);
```

你至少应该看到：

```text
scaling
rotation_re
rotation_im
features_dc
opacity
features_rest_0
...
features_rest_14
```

如果名字不一样，告诉我实际输出，我帮你做映射。

---

## 4. 检查 SH texture 是否上传

在 `RenderProgram.ts` 的 `uploadSphericalHarmonics()` 加：

```ts
console.log("Uploading SH:", sh.width, sh.height, sh.count, sh.bandsIndices);
```

---

# 八、如果画面颜色怪异，优先改这两个点

## 1. QPLY rest property 顺序

我现在实现的是：

```text
f_rest_0, f_rest_1, f_rest_2 => coeff0 RGB
f_rest_3, f_rest_4, f_rest_5 => coeff1 RGB
...
```

这是 reduced-3dgs viewer 里的 QPLY 逻辑。

如果你的文件不是这个顺序，而是：

```text
f_rest_0..14 = R
f_rest_15..29 = G
f_rest_30..44 = B
```

那就要换成标准 full PLY 的通道布局。

判断方法：看 QPLY header 里 `vertex_3` 有多少个 `f_rest_*`：

- 如果 `vertex_3` 只有 **45 个 f_rest**，可能是标准 RGB 分片
- 如果 `vertex_3` 是按 group 的 `3 × coeffCount` 排列，也可能还是当前逻辑

你可以把 header 里 `vertex_3` 的 property 列表贴我，我能一眼判断。

---

## 2. 位置 half-float 是否有符号问题

如果点云形状炸开，说明：

```ts
readHalfFromDataView()
```

位置解码方式不对。

但根据 INRIA viewer 原代码：

```js
ht(new Int16Array([p.getInt16(...)]),0,1)[0]
```

我们现在的：

```ts
float16BitsToFloat32(view.getInt16(...) & 0xffff)
```

是等价的。

---

# 九、总结

现在你要做的只有两步：

1. 新增：

```text
src/loaders/QPLYLoaderUtils.ts
```

2. 修改 `PLYLoader.ts` 的 `LoadFromArrayBuffer()`：

```ts
if (IsQPLY(inputBuffer)) {
    const result = ParseQPLYBuffer(inputBuffer);
    ...
}
```

你的渲染管线不用再改。  
因为你已经跑通标准 SH，QPLY 本质上只是把：

```text
codebook index + half position
```

还原成：

```text
SplatData + SphericalHarmonicsData
```

然后复用同一套 WebGL shader。