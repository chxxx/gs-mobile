import SortWorker from "../utils/SortWorker.ts?worker&inline";
const createSortWorker = () => new SortWorker();

import { ShaderProgram } from "./ShaderProgram";
import { ShaderPass } from "../passes/ShaderPass";
import { RenderData } from "../utils/RenderData";
import { Color32 } from "../../../math/Color32";
import { ObjectAddedEvent, ObjectChangedEvent, ObjectRemovedEvent } from "../../../events/Events";
import { Splat } from "../../../splats/Splat";
import { WebGLRenderer } from "../../WebGLRenderer";
import { Scene } from "../../../core/Scene";
import { perf } from "../../../utils/PerfDebug";

const vertexShaderSource = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform highp usampler2D u_texture;
uniform highp sampler2D u_transforms;
uniform highp usampler2D u_transformIndices;
uniform highp sampler2D u_colorTransforms;
uniform highp usampler2D u_colorTransformIndices;
uniform bool u_useSH;
uniform highp usampler2D u_sh_r;
uniform highp usampler2D u_sh_g;
uniform highp usampler2D u_sh_b;
uniform ivec3 u_bandIndex;
uniform mat4 projection, view;
uniform vec2 focal;
uniform vec2 viewport;

uniform bool useDepthFade;
uniform float depthFade;

uniform float u_maxSplatSize;

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

in vec2 position;
in int index;

out vec4 vColor;
out vec2 vPosition;
out float vSize;
out float vSelected;

void main () {
    uvec4 cen = texelFetch(u_texture, ivec2((uint(index) & 0x3ffu) << 1, uint(index) >> 10), 0);
    float selected = float((cen.w >> 24) & 0xffu);

    uint transformIndex = texelFetch(u_transformIndices, ivec2(uint(index) & 0x3ffu, uint(index) >> 10), 0).x;
    mat4 transform = mat4(
        texelFetch(u_transforms, ivec2(0, transformIndex), 0),
        texelFetch(u_transforms, ivec2(1, transformIndex), 0),
        texelFetch(u_transforms, ivec2(2, transformIndex), 0),
        texelFetch(u_transforms, ivec2(3, transformIndex), 0)
    );

    if (selected < 0.5) {
        selected = texelFetch(u_transforms, ivec2(4, transformIndex), 0).x;
    }

    mat4 viewTransform = view * transform;

    vec4 cam = viewTransform * vec4(uintBitsToFloat(cen.xyz), 1);
    vec4 pos2d = projection * cam;

    float clip = 1.2 * pos2d.w;
    if (pos2d.z < -pos2d.w || pos2d.z > pos2d.w || pos2d.x < -clip || pos2d.x > clip || pos2d.y < -clip || pos2d.y > clip) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }

    uvec4 cov = texelFetch(u_texture, ivec2(((uint(index) & 0x3ffu) << 1) | 1u, uint(index) >> 10), 0);
    vec2 u1 = unpackHalf2x16(cov.x), u2 = unpackHalf2x16(cov.y), u3 = unpackHalf2x16(cov.z);
    mat3 Vrk = mat3(u1.x, u1.y, u2.x, u1.y, u2.y, u3.x, u2.x, u3.x, u3.y);

    mat3 J = mat3(
        focal.x / cam.z, 0., -(focal.x * cam.x) / (cam.z * cam.z), 
        0., -focal.y / cam.z, (focal.y * cam.y) / (cam.z * cam.z), 
        0., 0., 0.
    );

    mat3 T = transpose(mat3(viewTransform)) * J;
    mat3 cov2d = transpose(T) * Vrk * T;

    //ref: https://github.com/graphdeco-inria/diff-gaussian-rasterization/blob/main/cuda_rasterizer/forward.cu#L110-L111
    cov2d[0][0] += 0.3;
    cov2d[1][1] += 0.3;

    float mid = (cov2d[0][0] + cov2d[1][1]) / 2.0;
    float radius = length(vec2((cov2d[0][0] - cov2d[1][1]) / 2.0, cov2d[0][1]));
    float lambda1 = mid + radius, lambda2 = mid - radius;

    if (lambda2 < 0.0) return;
    vec2 diagonalVector = normalize(vec2(cov2d[0][1], lambda1 - cov2d[0][0]));
    vec2 majorAxis = min(sqrt(2.0 * lambda1), u_maxSplatSize) * diagonalVector;
    vec2 minorAxis = min(sqrt(2.0 * lambda2), u_maxSplatSize) * vec2(diagonalVector.y, -diagonalVector.x);

    uint colorTransformIndex = texelFetch(u_colorTransformIndices, ivec2(uint(index) & 0x3ffu, uint(index) >> 10), 0).x;
    mat4 colorTransform = mat4(
        texelFetch(u_colorTransforms, ivec2(0, colorTransformIndex), 0),
        texelFetch(u_colorTransforms, ivec2(1, colorTransformIndex), 0),
        texelFetch(u_colorTransforms, ivec2(2, colorTransformIndex), 0),
        texelFetch(u_colorTransforms, ivec2(3, colorTransformIndex), 0)
    );

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

    vPosition = position;
    vSize = length(majorAxis);
    vSelected = selected;

    float scalingFactor = 1.0;

    if (useDepthFade) {
        float depthNorm = (pos2d.z / pos2d.w + 1.0) / 2.0;
        float near = 0.1; float far = 100.0;
        float normalizedDepth = (2.0 * near) / (far + near - depthNorm * (far - near));
        float start = max(normalizedDepth - 0.1, 0.0);
        float end = min(normalizedDepth + 0.1, 1.0);
        scalingFactor = clamp((depthFade - start) / (end - start), 0.0, 1.0);
    }

    vec2 vCenter = vec2(pos2d) / pos2d.w;
    gl_Position = vec4(
        vCenter 
        + position.x * majorAxis * scalingFactor / viewport
        + position.y * minorAxis * scalingFactor / viewport, 0.0, 1.0);
}
`;

const fragmentShaderSource = /* glsl */ `#version 300 es
precision highp float;

uniform float outlineThickness;
uniform vec4 outlineColor;

in vec4 vColor;
in vec2 vPosition;
in float vSize;
in float vSelected;

out vec4 fragColor;

void main () {
    float A = -dot(vPosition, vPosition);

    if (A < -4.0) discard;

    if (vSelected < 0.5) {
        float B = exp(A) * vColor.a;
        fragColor = vec4(B * vColor.rgb, B);
        return;
    }

    float outlineThreshold = -4.0 + (outlineThickness / vSize);

    if (A < outlineThreshold) {
        fragColor = outlineColor;
    } 
    else {
        float B = exp(A) * vColor.a;
        fragColor = vec4(B * vColor.rgb, B);
    }
}
`;

class RenderProgram extends ShaderProgram {
    private _outlineThickness: number = 10.0;
    // Max on-screen splat footprint in px. Measured on a mobile GPU at 280K
    // splats: capping 1024->256 keeps scale-6 overdraw in check with negligible
    // visual impact (only >256px giant splats lose their outer tail). Runtime
    // override: ?splatPx=n  or  __PERF__.setMaxSplatSize(n).
    private _maxSplatSize: number = 256;
    private _outlineColor: Color32 = new Color32(255, 165, 0, 255);
    private _renderData: RenderData | null = null;
    private _depthIndex: Uint32Array = new Uint32Array();
    private _splatTexture: WebGLTexture | null = null;
    private _shTextures: [WebGLTexture | null, WebGLTexture | null, WebGLTexture | null] = [null, null, null];
    private _worker: Worker | null = null;
    private _lastSortRequestAt: number = -1;
    private _cullEnabled = true;
    private _lastCullKept = 0;
    private _lastCullTotal = 0;
    private _cullSampleCount = 0;

    protected _initialize: () => void;
    protected _resize: () => void;
    protected _render: () => void;
    protected _dispose: () => void;

    private _setOutlineThickness: (value: number) => void;
    private _setMaxSplatSize: (value: number) => void;
    private _setOutlineColor: (value: Color32) => void;

    constructor(renderer: WebGLRenderer, passes: ShaderPass[]) {
        super(renderer, passes);

        const canvas = renderer.canvas;
        const gl = renderer.gl;

        let u_projection: WebGLUniformLocation;
        let u_viewport: WebGLUniformLocation;
        let u_focal: WebGLUniformLocation;
        let u_view: WebGLUniformLocation;
        let u_texture: WebGLUniformLocation;
        let u_transforms: WebGLUniformLocation;
        let u_transformIndices: WebGLUniformLocation;
        let u_colorTransforms: WebGLUniformLocation;
        let u_colorTransformIndices: WebGLUniformLocation;

        let u_useSH: WebGLUniformLocation;
        let u_sh_r: WebGLUniformLocation;
        let u_sh_g: WebGLUniformLocation;
        let u_sh_b: WebGLUniformLocation;
        let u_bandIndex: WebGLUniformLocation;

        let u_outlineThickness: WebGLUniformLocation;
        let u_outlineColor: WebGLUniformLocation;
        let u_maxSplatSize: WebGLUniformLocation;

        let positionAttribute: number;
        let indexAttribute: number;

        let transformsTexture: WebGLTexture;
        let transformIndicesTexture: WebGLTexture;

        let colorTransformsTexture: WebGLTexture;
        let colorTransformIndicesTexture: WebGLTexture;

        let vertexBuffer: WebGLBuffer;
        const indexBuffers: WebGLBuffer[] = [];
        let activeDepthBuffer = 0;

        try {
            // Opt-in frustum-culling prototype inside the sort worker.
            // Disabled by default: screen-edge correctness depends on
            // sortData.positions matching the shader's packed centers, which is
            // NOT guaranteed for all scenes (it caused visible black edges).
            // Enable explicitly with ?cull=1 for A/B measurement.
            this._cullEnabled =
                typeof location !== "undefined" && new URLSearchParams(location.search).get("cull") === "1";
        } catch {
            this._cullEnabled = false;
        }

        this._resize = () => {
            if (!this._camera) return;

            this._camera.data.setSize(canvas.width, canvas.height);
            this._camera.update();

            u_projection = gl.getUniformLocation(this.program, "projection") as WebGLUniformLocation;
            gl.uniformMatrix4fv(u_projection, false, this._camera.data.projectionMatrix.buffer);

            u_viewport = gl.getUniformLocation(this.program, "viewport") as WebGLUniformLocation;
            gl.uniform2fv(u_viewport, new Float32Array([canvas.width, canvas.height]));
        };

        const createWorker = () => {
            this._worker = createSortWorker();
            this._worker!.onmessage = (e) => {
                if (e.data.depthIndex) {
                    const { depthIndex, workerMs, keptCount, totalCount } = e.data as {
                        depthIndex: Uint32Array;
                        workerMs?: number;
                        keptCount?: number;
                        totalCount?: number;
                    };

                    if (typeof keptCount === "number" && typeof totalCount === "number" && totalCount > 0) {
                        this._lastCullKept = keptCount;
                        this._lastCullTotal = totalCount;
                        this._cullSampleCount++;
                    }

                    if (perf.enabled) {
                        if (typeof workerMs === "number") {
                            perf.sample("sort.worker.ms", workerMs);
                        }
                        if (this._lastSortRequestAt >= 0) {
                            perf.sample("sort.latency.ms", performance.now() - this._lastSortRequestAt);
                        }
                    }

                    this._depthIndex = depthIndex;
                    const uploadStart = performance.now();
                    // Upload into a buffer that the just-submitted frame is NOT
                    // reading, then make it the buffer drawn from next frame.
                    // Depth order only changes when a sort result arrives, so we
                    // never re-upload on frames that reuse the previous order.
                    const target = (activeDepthBuffer + 1) % indexBuffers.length;
                    gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffers[target]);
                    gl.bufferData(gl.ARRAY_BUFFER, depthIndex, gl.DYNAMIC_DRAW);
                    gl.bindBuffer(gl.ARRAY_BUFFER, null);
                    activeDepthBuffer = target;
                    if (perf.enabled) {
                        perf.sample("gl.depthIndexUpload.ms", performance.now() - uploadStart);
                    }
                }
            };
        };

        this._initialize = () => {
            if (!this._scene || !this._camera) {
                console.error("Cannot render without scene and camera");
                return;
            }

            this._resize();

            this._scene.addEventListener("objectAdded", handleObjectAdded);
            this._scene.addEventListener("objectRemoved", handleObjectRemoved);
            for (const object of this._scene.objects) {
                if (object instanceof Splat) {
                    object.addEventListener("objectChanged", handleObjectChanged);
                }
            }

            this._renderData = new RenderData(this._scene);

            u_focal = gl.getUniformLocation(this.program, "focal") as WebGLUniformLocation;
            gl.uniform2fv(u_focal, new Float32Array([this._camera.data.fx, this._camera.data.fy]));

            u_view = gl.getUniformLocation(this.program, "view") as WebGLUniformLocation;
            gl.uniformMatrix4fv(u_view, false, this._camera.data.viewMatrix.buffer);

            u_outlineThickness = gl.getUniformLocation(this.program, "outlineThickness") as WebGLUniformLocation;
            gl.uniform1f(u_outlineThickness, this.outlineThickness);

            u_outlineColor = gl.getUniformLocation(this.program, "outlineColor") as WebGLUniformLocation;
            gl.uniform4fv(u_outlineColor, new Float32Array(this.outlineColor.flatNorm()));

            u_maxSplatSize = gl.getUniformLocation(this.program, "u_maxSplatSize") as WebGLUniformLocation;
            gl.uniform1f(u_maxSplatSize, this.maxSplatSize);

            this._splatTexture = gl.createTexture() as WebGLTexture;
            u_texture = gl.getUniformLocation(this.program, "u_texture") as WebGLUniformLocation;
            gl.uniform1i(u_texture, 0);

            transformsTexture = gl.createTexture() as WebGLTexture;
            u_transforms = gl.getUniformLocation(this.program, "u_transforms") as WebGLUniformLocation;
            gl.uniform1i(u_transforms, 1);

            transformIndicesTexture = gl.createTexture() as WebGLTexture;
            u_transformIndices = gl.getUniformLocation(this.program, "u_transformIndices") as WebGLUniformLocation;
            gl.uniform1i(u_transformIndices, 2);

            colorTransformsTexture = gl.createTexture() as WebGLTexture;
            u_colorTransforms = gl.getUniformLocation(this.program, "u_colorTransforms") as WebGLUniformLocation;
            gl.uniform1i(u_colorTransforms, 3);

            colorTransformIndicesTexture = gl.createTexture() as WebGLTexture;
            u_colorTransformIndices = gl.getUniformLocation(
                this.program,
                "u_colorTransformIndices",
            ) as WebGLUniformLocation;
            gl.uniform1i(u_colorTransformIndices, 4);

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

            vertexBuffer = gl.createBuffer() as WebGLBuffer;
            gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]), gl.STATIC_DRAW);

            positionAttribute = gl.getAttribLocation(this.program, "position");
            gl.enableVertexAttribArray(positionAttribute);
            gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, 0, 0);

            if (indexBuffers.length === 0) {
                for (let i = 0; i < 3; i++) {
                    indexBuffers.push(gl.createBuffer() as WebGLBuffer);
                }
            }
            activeDepthBuffer = 0;
            indexAttribute = gl.getAttribLocation(this.program, "index");
            gl.enableVertexAttribArray(indexAttribute);
            gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffers[activeDepthBuffer]);

            createWorker();
        };

        const handleObjectAdded = (event: Event) => {
            const e = event as ObjectAddedEvent;

            if (e.object instanceof Splat) {
                e.object.addEventListener("objectChanged", handleObjectChanged);
            }

            resetSplatData();
        };

        const handleObjectRemoved = (event: Event) => {
            const e = event as ObjectRemovedEvent;

            if (e.object instanceof Splat) {
                e.object.removeEventListener("objectChanged", handleObjectChanged);
            }

            resetSplatData();
        };

        const handleObjectChanged = (event: Event) => {
            const e = event as ObjectChangedEvent;

            if (e.object instanceof Splat && this._renderData) {
                this._renderData.markDirty(e.object);
            }
        };

        const resetSplatData = () => {
            this._renderData?.dispose();
            this._renderData = new RenderData(this._scene as Scene);

            this._worker?.terminate();
            createWorker();
        };

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

        this._render = () => {
            if (!this._scene || !this._camera || !this.renderData) {
                console.error("Cannot render without scene and camera");
                return;
            }

            if (this.renderData.needsRebuild) {
                this.renderData.rebuild();
            }

            const splatDataUploadStart = performance.now();
            if (
                this.renderData.dataChanged ||
                this.renderData.transformsChanged ||
                this.renderData.colorTransformsChanged
            ) {
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

                if (this.renderData.transformsChanged) {
                    gl.activeTexture(gl.TEXTURE1);
                    gl.bindTexture(gl.TEXTURE_2D, transformsTexture);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                    gl.texImage2D(
                        gl.TEXTURE_2D,
                        0,
                        gl.RGBA32F,
                        this.renderData.transformsWidth,
                        this.renderData.transformsHeight,
                        0,
                        gl.RGBA,
                        gl.FLOAT,
                        this.renderData.transforms,
                    );

                    gl.activeTexture(gl.TEXTURE2);
                    gl.bindTexture(gl.TEXTURE_2D, transformIndicesTexture);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                    gl.texImage2D(
                        gl.TEXTURE_2D,
                        0,
                        gl.R32UI,
                        this.renderData.transformIndicesWidth,
                        this.renderData.transformIndicesHeight,
                        0,
                        gl.RED_INTEGER,
                        gl.UNSIGNED_INT,
                        this.renderData.transformIndices,
                    );
                }

                if (this.renderData.colorTransformsChanged) {
                    gl.activeTexture(gl.TEXTURE3);
                    gl.bindTexture(gl.TEXTURE_2D, colorTransformsTexture);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                    gl.texImage2D(
                        gl.TEXTURE_2D,
                        0,
                        gl.RGBA32F,
                        this.renderData.colorTransformsWidth,
                        this.renderData.colorTransformsHeight,
                        0,
                        gl.RGBA,
                        gl.FLOAT,
                        this.renderData.colorTransforms,
                    );

                    gl.activeTexture(gl.TEXTURE4);
                    gl.bindTexture(gl.TEXTURE_2D, colorTransformIndicesTexture);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                    gl.texImage2D(
                        gl.TEXTURE_2D,
                        0,
                        gl.R32UI,
                        this.renderData.colorTransformIndicesWidth,
                        this.renderData.colorTransformIndicesHeight,
                        0,
                        gl.RED_INTEGER,
                        gl.UNSIGNED_INT,
                        this.renderData.colorTransformIndices,
                    );
                }

                const detachedPositions = new Float32Array(this.renderData.positions.slice().buffer);
                const detachedTransforms = new Float32Array(this.renderData.transforms.slice().buffer);
                const detachedTransformIndices = new Uint32Array(this.renderData.transformIndices.slice().buffer);
                this._worker?.postMessage(
                    {
                        sortData: {
                            positions: detachedPositions,
                            transforms: detachedTransforms,
                            transformIndices: detachedTransformIndices,
                            vertexCount: this.renderData.vertexCount,
                        },
                    },
                    [detachedPositions.buffer, detachedTransforms.buffer, detachedTransformIndices.buffer],
                );

                this.renderData.dataChanged = false;
                this.renderData.transformsChanged = false;
                this.renderData.colorTransformsChanged = false;
            }
            if (perf.enabled) {
                perf.sample("gl.splatDataUpload.ms", performance.now() - splatDataUploadStart);
            }

            const cameraStart = performance.now();
            this._camera.update();
            if (perf.enabled) {
                perf.sample("cpu.camera.update.ms", performance.now() - cameraStart);
            }

            if (perf.enabled) {
                this._lastSortRequestAt = performance.now();
            }
            this._worker?.postMessage({ viewProj: this._camera.data.viewProj.buffer, cullEnabled: this._cullEnabled });

            const drawSetupStart = performance.now();
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);

            gl.disable(gl.DEPTH_TEST);
            gl.enable(gl.BLEND);
            gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
            gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);

            gl.uniformMatrix4fv(u_projection, false, this._camera.data.projectionMatrix.buffer);
            gl.uniformMatrix4fv(u_view, false, this._camera.data.viewMatrix.buffer);

            gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
            gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, 0, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffers[activeDepthBuffer]);
            gl.vertexAttribIPointer(indexAttribute, 1, gl.INT, 0, 0);
            gl.vertexAttribDivisor(indexAttribute, 1);

            const drawSubmitStart = performance.now();
            gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, this.depthIndex.length);
            if (perf.enabled) {
                perf.sample("gl.drawSubmit.ms", performance.now() - drawSubmitStart);
                perf.sample("cpu.drawSetup.ms", performance.now() - drawSetupStart);
            }
        };

        this._dispose = () => {
            if (!this._scene || !this._camera || !this.renderData) {
                console.error("Cannot dispose without scene and camera");
                return;
            }

            this._scene.removeEventListener("objectAdded", handleObjectAdded);
            this._scene.removeEventListener("objectRemoved", handleObjectRemoved);
            for (const object of this._scene.objects) {
                if (object instanceof Splat) {
                    object.removeEventListener("objectChanged", handleObjectChanged);
                }
            }

            this._worker?.terminate();
            this.renderData.dispose();

            gl.deleteTexture(this.splatTexture);
            gl.deleteTexture(transformsTexture);
            gl.deleteTexture(transformIndicesTexture);

            for (const texture of this._shTextures) {
                if (texture) {
                    gl.deleteTexture(texture);
                }
            }

            for (const buffer of indexBuffers) {
                gl.deleteBuffer(buffer);
            }
            indexBuffers.length = 0;
            gl.deleteBuffer(vertexBuffer);
        };

        this._setOutlineThickness = (value: number) => {
            this._outlineThickness = value;
            if (this._initialized) {
                gl.uniform1f(u_outlineThickness, value);
            }
        };

        this._setOutlineColor = (value: Color32) => {
            this._outlineColor = value;
            if (this._initialized) {
                gl.uniform4fv(u_outlineColor, new Float32Array(value.flatNorm()));
            }
        };

        this._setMaxSplatSize = (value: number) => {
            this._maxSplatSize = value;
            if (this._initialized) {
                gl.useProgram(this.program);
                gl.uniform1f(u_maxSplatSize, value);
            }
        };
    }

    get renderData() {
        return this._renderData;
    }

    get depthIndex() {
        return this._depthIndex;
    }

    get splatTexture() {
        return this._splatTexture;
    }

    get outlineThickness() {
        return this._outlineThickness;
    }

    set outlineThickness(value: number) {
        this._setOutlineThickness(value);
    }

    get outlineColor() {
        return this._outlineColor;
    }

    set outlineColor(value: Color32) {
        this._setOutlineColor(value);
    }

    get maxSplatSize() {
        return this._maxSplatSize;
    }

    set maxSplatSize(value: number) {
        this._setMaxSplatSize(value);
    }

    get worker() {
        return this._worker;
    }

    get cullEnabled(): boolean {
        return this._cullEnabled;
    }

    /** Latest frustum-culling outcome reported by the sort worker. */
    get cullStats(): { keptRatio: number; total: number; samples: number } {
        return {
            keptRatio: this._lastCullTotal > 0 ? this._lastCullKept / this._lastCullTotal : 1,
            total: this._lastCullTotal,
            samples: this._cullSampleCount,
        };
    }

    resetCullStats(): void {
        this._cullSampleCount = 0;
    }

    protected _getVertexSource() {
        return vertexShaderSource;
    }

    protected _getFragmentSource() {
        return fragmentShaderSource;
    }
}

export { RenderProgram };
