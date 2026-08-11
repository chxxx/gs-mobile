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

function readCodebookValue(codebooks: Record<string, Float32Array>, codebookName: string, index: number): number {
    const codebook = codebooks[codebookName];

    if (!codebook) {
        throw new Error(`Missing QPLY codebook: ${codebookName}`);
    }

    return codebook[index];
}

function assertAnyProperty(properties: Record<string, PlyProperty>, names: string[]): PlyProperty {
    for (const name of names) {
        if (properties[name]) {
            return properties[name];
        }
    }

    throw new Error(`Missing QPLY property, tried: ${names.join(", ")}`);
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

function IsQPLY(inputBuffer: ArrayBuffer): boolean {
    const headerText = new TextDecoder().decode(new Uint8Array(inputBuffer).slice(0, 1024 * 10));
    return isQPLYHeader(headerText);
}

function ParseQPLYBuffer(inputBuffer: ArrayBuffer): ParsedQPLYResult {
    const decodeStart = performance.now();
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

    const codebookView = new DataView(inputBuffer, dataStart + vertexDataByteLength, 256 * codebookCount * 2);

    for (let centerIndex = 0; centerIndex < 256; centerIndex++) {
        for (let codebookIndex = 0; codebookIndex < codebookCount; codebookIndex++) {
            const byteOffset = centerIndex * codebookCount * 2 + codebookIndex * 2;
            const bits = codebookView.getInt16(byteOffset, true) & 0xffff;
            codebooks[codebookNames[codebookIndex]][centerIndex] = float16BitsToFloat32(bits);
        }
    }

    console.log(`QPLY header/codebook parse: ${performance.now() - decodeStart} ms`);
    const vertexStart = performance.now();

    const totalVertexCount = counts[0] + counts[1] + counts[2] + counts[3];

    const splatBuffer = new ArrayBuffer(SplatData.RowLength * totalVertexCount);
    const splatFloat = new Float32Array(splatBuffer);
    const splatUint8 = new Uint8ClampedArray(splatBuffer);

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

    const degreeRestCount = [0, 3, 8, 15];

    for (let group = 0; group < 4; group++) {
        const rowLength = groupRowLengths[group];
        const propertyMap = mapProperties(groupProperties[group]);
        const count = counts[group];

        const propX = assertAnyProperty(propertyMap, ["x"]);
        const propY = assertAnyProperty(propertyMap, ["y"]);
        const propZ = assertAnyProperty(propertyMap, ["z"]);

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

        const restProperties = groupProperties[group].filter((property) => property.name.startsWith("f_rest"));

        for (let localIndex = 0; localIndex < count; localIndex++) {
            const base = sourceOffset + localIndex * rowLength;

            const x = readHalfFromDataView(vertexView, base + propX.offset);
            const y = readHalfFromDataView(vertexView, base + propY.offset);
            const z = readHalfFromDataView(vertexView, base + propZ.offset);

            splatFloat[8 * globalIndex + 0] = x;
            splatFloat[8 * globalIndex + 1] = y;
            splatFloat[8 * globalIndex + 2] = z;

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

            const qw = readCodebookValue(codebooks, "rotation_re", vertexView.getUint8(base + propRot0.offset));
            const qx = readCodebookValue(codebooks, "rotation_im", vertexView.getUint8(base + propRot1.offset));
            const qy = readCodebookValue(codebooks, "rotation_im", vertexView.getUint8(base + propRot2.offset));
            const qz = readCodebookValue(codebooks, "rotation_im", vertexView.getUint8(base + propRot3.offset));

            const q = normalizeQuaternion(qw, qx, qy, qz);

            splatUint8[32 * globalIndex + 28 + 0] = q.w * 128 + 128;
            splatUint8[32 * globalIndex + 28 + 1] = q.x * 128 + 128;
            splatUint8[32 * globalIndex + 28 + 2] = q.y * 128 + 128;
            splatUint8[32 * globalIndex + 28 + 3] = q.z * 128 + 128;

            const fdc0 = readCodebookValue(codebooks, "features_dc", vertexView.getUint8(base + propFdc0.offset));
            const fdc1 = readCodebookValue(codebooks, "features_dc", vertexView.getUint8(base + propFdc1.offset));
            const fdc2 = readCodebookValue(codebooks, "features_dc", vertexView.getUint8(base + propFdc2.offset));

            const opacity = readCodebookValue(codebooks, "opacity", vertexView.getUint8(base + propOpacity.offset));

            splatUint8[32 * globalIndex + 24 + 0] = (0.5 + Converter.SH_C0 * fdc0) * 255;
            splatUint8[32 * globalIndex + 24 + 1] = (0.5 + Converter.SH_C0 * fdc1) * 255;
            splatUint8[32 * globalIndex + 24 + 2] = (0.5 + Converter.SH_C0 * fdc2) * 255;
            splatUint8[32 * globalIndex + 24 + 3] = sigmoid(opacity) * 255;

            if (group > 0) {
                const coeffR = new Array<number>(16).fill(0);
                const coeffG = new Array<number>(16).fill(0);
                const coeffB = new Array<number>(16).fill(0);

                coeffR[0] = fdc0;
                coeffG[0] = fdc1;
                coeffB[0] = fdc2;

                /**
                 * QPLY stores rest SH indices in channel-major order:
                 * f_rest_0..14 -> R indices for coeff 1..15
                 * f_rest_15..29 -> G indices for coeff 1..15
                 * f_rest_30..44 -> B indices for coeff 1..15
                 * Each index points into the per-coefficient codebook features_rest_0..14.
                 */
                const restPerChannel = restProperties.length === degreeRestCount[group] * 3;

                for (let localRestIndex = 0; localRestIndex < restProperties.length; localRestIndex++) {
                    let coeffIndex: number;
                    let channel: number;

                    if (restPerChannel) {
                        coeffIndex = localRestIndex % degreeRestCount[group];
                        channel = Math.floor(localRestIndex / degreeRestCount[group]);
                    } else {
                        // Fallback for non-standard layouts: treat each property as a single coefficient
                        // and apply the same value to all channels.
                        coeffIndex = localRestIndex;
                        channel = -1;
                    }

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

                    if (channel === 0 || channel === -1) {
                        coeffR[coeffIndex + 1] = value;
                    }
                    if (channel === 1 || channel === -1) {
                        coeffG[coeffIndex + 1] = value;
                    }
                    if (channel === 2 || channel === -1) {
                        coeffB[coeffIndex + 1] = value;
                    }
                }

                for (let packed = 0; packed < 8; packed++) {
                    shRgb[0][8 * shIndex + packed] = packHalf2x16(coeffR[2 * packed], coeffR[2 * packed + 1]);
                    shRgb[1][8 * shIndex + packed] = packHalf2x16(coeffG[2 * packed], coeffG[2 * packed + 1]);
                    shRgb[2][8 * shIndex + packed] = packHalf2x16(coeffB[2 * packed], coeffB[2 * packed + 1]);
                }

                shIndex++;
            }

            globalIndex++;
        }

        sourceOffset += count * rowLength;
    }

    const vertexElapsed = performance.now() - vertexStart;
    const totalElapsed = performance.now() - decodeStart;
    console.log(`QPLY vertex decode/SH pack: ${vertexElapsed} ms`);
    console.log(`QPLY decode/dequantize total: ${totalElapsed} ms`);

    return {
        splatBuffer,
        sphericalHarmonics: new SphericalHarmonicsData(shWidth, shHeight, shRgb, shCount, bandsIndices),
    };
}

export { IsQPLY, ParseQPLYBuffer, IsLowRankQPLY, ParseLowRankQPLYBuffer };

type PlyElementInfo = {
    name: string;
    count: number;
    properties: PlyProperty[];
    rowLength: number;
};

function isLowRankQPLYHeader(headerText: string): boolean {
    return (
        headerText.includes("element vertex ") &&
        !/element vertex_\d/.test(headerText) &&
        headerText.includes("element codebook_centers 256") &&
        headerText.includes("element sh_basis ") &&
        headerText.includes("f_rank_0") &&
        headerText.includes("f_dc_0")
    );
}

function parseHeaderElements(headerText: string, headerEndIndex: number): PlyElementInfo[] {
    const elements: PlyElementInfo[] = [];
    let current: PlyElementInfo | null = null;

    for (const line of headerText.slice(0, headerEndIndex).split("\n")) {
        if (line.startsWith("element ")) {
            const [_element, name, countString] = line.split(" ");
            current = {
                name,
                count: parseInt(countString, 10),
                properties: [],
                rowLength: 0,
            };
            elements.push(current);
        } else if (line.startsWith("property ") && current) {
            const [_property, type, name] = line.split(" ");

            if (!TYPE_BYTE_LENGTH[type]) {
                throw new Error(`Unsupported QPLY property type: ${type}`);
            }

            current.properties.push({
                name,
                type,
                offset: current.rowLength,
            });

            current.rowLength += TYPE_BYTE_LENGTH[type];
        }
    }

    return elements;
}

function IsLowRankQPLY(inputBuffer: ArrayBuffer): boolean {
    const headerText = new TextDecoder().decode(new Uint8Array(inputBuffer).slice(0, 1024 * 10));
    return isLowRankQPLYHeader(headerText);
}

/**
 * Parses a low-rank quantised PLY file (single `vertex` element + `codebook_centers`
 * + embedded `sh_basis`), e.g. `point_cloud_quantised_half.ply`.
 *
 * Layout:
 *   element vertex N
 *     property short x/y/z              -- half-float positions
 *     property uchar f_dc_0..2          -- indices into the features_dc codebook
 *     property uchar f_rank_0..rank-1   -- indices into the features_rank_* codebooks
 *     property uchar opacity            -- index into the opacity codebook
 *     property uchar scale_0..2         -- indices into the scaling codebook
 *     property uchar rot_0..3           -- indices into rotation_re / rotation_im codebooks
 *   element codebook_centers 256        -- 256 half-float centers per property group
 *   element sh_basis rank               -- shared SH basis (rank rows x 45 columns, half-float)
 *
 * SH rest coefficients are reconstructed per gaussian as `rest45 = C @ B`
 * (C = rank shared coefficients, B = embedded basis) in coeff-major layout:
 * rest45 = [R1, G1, B1, R2, G2, B2, ..., R15, G15, B15].
 */
function ParseLowRankQPLYBuffer(inputBuffer: ArrayBuffer): ParsedQPLYResult {
    const decodeStart = performance.now();
    const bytes = new Uint8Array(inputBuffer);
    const headerText = new TextDecoder().decode(bytes.slice(0, 1024 * 10));

    const headerEndToken = "end_header\n";
    const headerEndIndex = headerText.indexOf(headerEndToken);

    if (headerEndIndex < 0) {
        throw new Error("Unable to read low-rank QPLY header.");
    }

    if (!isLowRankQPLYHeader(headerText)) {
        throw new Error("Invalid low-rank QPLY file.");
    }

    const dataStart = headerEndIndex + headerEndToken.length;
    const elements = parseHeaderElements(headerText, headerEndIndex);

    const vertexElement = elements.find((element) => element.name === "vertex");
    const codebookElement = elements.find((element) => element.name === "codebook_centers");
    const basisElement = elements.find((element) => element.name === "sh_basis");

    if (!vertexElement || !codebookElement || !basisElement) {
        throw new Error(
            `Invalid low-rank QPLY: missing element (vertex=${!!vertexElement}, ` +
                `codebook_centers=${!!codebookElement}, sh_basis=${!!basisElement}).`,
        );
    }

    let cursor = dataStart;
    const vertexDataOffset = cursor;
    cursor += vertexElement.count * vertexElement.rowLength;
    const codebookDataOffset = cursor;
    cursor += codebookElement.count * codebookElement.rowLength;
    const basisDataOffset = cursor;

    // ---- codebook centers ----
    const codebookNames = codebookElement.properties.map((property) => property.name);
    const codebooks: Record<string, Float32Array> = {};

    for (const name of codebookNames) {
        codebooks[name] = new Float32Array(256);
    }

    const codebookView = new DataView(
        inputBuffer,
        codebookDataOffset,
        codebookElement.count * codebookElement.rowLength,
    );

    for (let centerIndex = 0; centerIndex < 256; centerIndex++) {
        for (let propertyIndex = 0; propertyIndex < codebookElement.properties.length; propertyIndex++) {
            const byteOffset = centerIndex * codebookElement.rowLength + codebookElement.properties[propertyIndex].offset;
            const bits = codebookView.getInt16(byteOffset, true) & 0xffff;
            codebooks[codebookNames[propertyIndex]][centerIndex] = float16BitsToFloat32(bits);
        }
    }

    // ---- embedded SH basis (rank rows x 45 columns) ----
    const rank = basisElement.count;
    const restCoefficientCount = basisElement.properties.length;

    const basis = new Float32Array(rank * restCoefficientCount);
    const basisView = new DataView(inputBuffer, basisDataOffset, rank * basisElement.rowLength);

    for (let row = 0; row < rank; row++) {
        for (let column = 0; column < restCoefficientCount; column++) {
            const byteOffset = row * basisElement.rowLength + basisElement.properties[column].offset;
            const bits = basisView.getInt16(byteOffset, true) & 0xffff;
            basis[row * restCoefficientCount + column] = float16BitsToFloat32(bits);
        }
    }

    console.log(`Low-rank QPLY header/codebook/basis parse: ${performance.now() - decodeStart} ms`);
    const vertexStart = performance.now();

    const vertexCount = vertexElement.count;
    const rowLength = vertexElement.rowLength;
    const propertyMap = mapProperties(vertexElement.properties);

    const propX = assertAnyProperty(propertyMap, ["x"]);
    const propY = assertAnyProperty(propertyMap, ["y"]);
    const propZ = assertAnyProperty(propertyMap, ["z"]);

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

    const rankProperties: PlyProperty[] = [];

    for (let i = 0; i < rank; i++) {
        const property = propertyMap[`f_rank_${i}`];

        if (!property) {
            throw new Error(`Missing low-rank QPLY property f_rank_${i}.`);
        }

        rankProperties.push(property);
    }

    const splatBuffer = new ArrayBuffer(SplatData.RowLength * vertexCount);
    const splatFloat = new Float32Array(splatBuffer);
    const splatUint8 = new Uint8ClampedArray(splatBuffer);

    const shWidth = 2048;
    const shHeight = Math.ceil((2 * vertexCount) / shWidth);

    const shRgb: [Uint32Array, Uint32Array, Uint32Array] = [
        new Uint32Array(shWidth * shHeight * 4),
        new Uint32Array(shWidth * shHeight * 4),
        new Uint32Array(shWidth * shHeight * 4),
    ];

    const vertexView = new DataView(inputBuffer, vertexDataOffset, vertexCount * rowLength);

    const coeffR = new Array<number>(16).fill(0);
    const coeffG = new Array<number>(16).fill(0);
    const coeffB = new Array<number>(16).fill(0);

    const rankCoeffs: number[] = [];

    for (let i = 0; i < vertexCount; i++) {
        const base = i * rowLength;

        splatFloat[8 * i + 0] = readHalfFromDataView(vertexView, base + propX.offset);
        splatFloat[8 * i + 1] = readHalfFromDataView(vertexView, base + propY.offset);
        splatFloat[8 * i + 2] = readHalfFromDataView(vertexView, base + propZ.offset);

        const scale0 = Math.exp(
            readCodebookValue(codebooks, "scaling", vertexView.getUint8(base + propScale0.offset)),
        );
        const scale1 = Math.exp(
            readCodebookValue(codebooks, "scaling", vertexView.getUint8(base + propScale1.offset)),
        );
        const scale2 = Math.exp(
            readCodebookValue(codebooks, "scaling", vertexView.getUint8(base + propScale2.offset)),
        );

        splatFloat[8 * i + 3] = scale0;
        splatFloat[8 * i + 4] = scale1;
        splatFloat[8 * i + 5] = scale2;

        const qw = readCodebookValue(codebooks, "rotation_re", vertexView.getUint8(base + propRot0.offset));
        const qx = readCodebookValue(codebooks, "rotation_im", vertexView.getUint8(base + propRot1.offset));
        const qy = readCodebookValue(codebooks, "rotation_im", vertexView.getUint8(base + propRot2.offset));
        const qz = readCodebookValue(codebooks, "rotation_im", vertexView.getUint8(base + propRot3.offset));

        const q = normalizeQuaternion(qw, qx, qy, qz);

        splatUint8[32 * i + 28 + 0] = q.w * 128 + 128;
        splatUint8[32 * i + 28 + 1] = q.x * 128 + 128;
        splatUint8[32 * i + 28 + 2] = q.y * 128 + 128;
        splatUint8[32 * i + 28 + 3] = q.z * 128 + 128;

        const fdc0 = readCodebookValue(codebooks, "features_dc", vertexView.getUint8(base + propFdc0.offset));
        const fdc1 = readCodebookValue(codebooks, "features_dc", vertexView.getUint8(base + propFdc1.offset));
        const fdc2 = readCodebookValue(codebooks, "features_dc", vertexView.getUint8(base + propFdc2.offset));

        const opacity = readCodebookValue(codebooks, "opacity", vertexView.getUint8(base + propOpacity.offset));

        splatUint8[32 * i + 24 + 0] = (0.5 + Converter.SH_C0 * fdc0) * 255;
        splatUint8[32 * i + 24 + 1] = (0.5 + Converter.SH_C0 * fdc1) * 255;
        splatUint8[32 * i + 24 + 2] = (0.5 + Converter.SH_C0 * fdc2) * 255;
        splatUint8[32 * i + 24 + 3] = sigmoid(opacity) * 255;

        rankCoeffs.length = 0;
        for (let j = 0; j < rank; j++) {
            rankCoeffs.push(
                readCodebookValue(
                    codebooks,
                    `features_rank_${j}`,
                    vertexView.getUint8(base + rankProperties[j].offset),
                ),
            );
        }

        coeffR[0] = fdc0;
        coeffG[0] = fdc1;
        coeffB[0] = fdc2;

        for (let k = 1; k < 16; k++) {
            if ((k - 1) * 3 + 2 >= restCoefficientCount) {
                break;
            }

            let r = 0;
            let g = 0;
            let b = 0;

            for (let j = 0; j < rank; j++) {
                const coefficient = rankCoeffs[j];
                r += coefficient * basis[j * restCoefficientCount + (k - 1) * 3 + 0];
                g += coefficient * basis[j * restCoefficientCount + (k - 1) * 3 + 1];
                b += coefficient * basis[j * restCoefficientCount + (k - 1) * 3 + 2];
            }

            coeffR[k] = r;
            coeffG[k] = g;
            coeffB[k] = b;
        }

        for (let packed = 0; packed < 8; packed++) {
            shRgb[0][8 * i + packed] = packHalf2x16(coeffR[2 * packed], coeffR[2 * packed + 1]);
            shRgb[1][8 * i + packed] = packHalf2x16(coeffG[2 * packed], coeffG[2 * packed + 1]);
            shRgb[2][8 * i + packed] = packHalf2x16(coeffB[2 * packed], coeffB[2 * packed + 1]);
        }
    }

    const vertexElapsed = performance.now() - vertexStart;
    const totalElapsed = performance.now() - decodeStart;
    console.log(`Low-rank QPLY vertex decode/SH pack: ${vertexElapsed} ms`);
    console.log(`Low-rank QPLY decode/dequantize total: ${totalElapsed} ms`);

    return {
        splatBuffer,
        sphericalHarmonics: new SphericalHarmonicsData(
            shWidth,
            shHeight,
            shRgb,
            vertexCount,
            new Int32Array([-1, -1, -1]),
        ),
    };
}
