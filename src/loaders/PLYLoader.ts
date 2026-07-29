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
        const loadStart = performance.now();
        const res: Response = await initiateFetchRequest(url, useCache);
        const plyData = await loadDataIntoBuffer(res, onProgress);

        if (plyData[0] !== 112 || plyData[1] !== 108 || plyData[2] !== 121 || plyData[3] !== 10) {
            throw new Error("Invalid PLY file");
        }

        console.log(`File load: ${plyData.byteLength} B, ${performance.now() - loadStart} ms`);

        return this.LoadFromArrayBuffer(plyData.buffer, scene, format, loadStart);
    }

    static async LoadFromFileAsync(
        file: File,
        scene: Scene,
        onProgress?: (progress: number) => void,
        format: string = "",
    ): Promise<Splat> {
        const loadStart = performance.now();
        const reader = new FileReader();
        let splat = new Splat();

        reader.onload = (e) => {
            console.log(`File read: ${file.size} B, ${performance.now() - loadStart} ms`);
            splat = this.LoadFromArrayBuffer(e.target!.result as ArrayBuffer, scene, format, loadStart);
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

    static LoadFromArrayBuffer(
        arrayBuffer: ArrayBufferLike,
        scene: Scene,
        format: string = "",
        loadStart?: number,
    ): Splat {
        const inputBuffer = arrayBuffer as ArrayBuffer;
        const arrayStart = loadStart ?? performance.now();

        if (IsQPLY(inputBuffer)) {
            const result = ParseQPLYBuffer(inputBuffer);

            const deserializeStart = performance.now();
            const data = SplatData.Deserialize(new Uint8Array(result.splatBuffer));
            console.log(`SplatData deserialize: ${performance.now() - deserializeStart} ms`);

            data.sphericalHarmonics = result.sphericalHarmonics;

            const splat = new Splat(data);
            scene.addObject(splat);

            console.log(`Input size: ${inputBuffer.byteLength} B`);
            console.log(`PLY/QPLY first frame data ready: ${performance.now() - arrayStart} ms`);

            return splat;
        }

        const result = this._ParsePLYBufferWithSH(inputBuffer, format);
        const data = SplatData.Deserialize(new Uint8Array(result.splatBuffer));

        if (result.sphericalHarmonics) {
            data.sphericalHarmonics = result.sphericalHarmonics;
        }

        const splat = new Splat(data);
        scene.addObject(splat);

        console.log(`Input size: ${inputBuffer.byteLength} B`);
        console.log(`PLY/QPLY first frame data ready: ${performance.now() - arrayStart} ms`);

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
