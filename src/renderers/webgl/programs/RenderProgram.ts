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

/**
 * [DIAG-EXPERIMENT-1] 本文臂的**逐帧分段计时**（与 Flux 臂 `render_shared/main.js` 的 `drawTimings` 对称）。
 *
 * 为什么本臂只有 3 段：本臂**没有** `gl.getError()`（全仓库 0 处），所以没有 Flux 臂那两个 getError 段；
 * 段边界与 Flux 臂的 prep/draw/post **同义**，两臂可并排对照：
 *   - `prep` = `_render()` 入口 → draw 调用之前（needsRebuild、纹理上传检查、`camera.update()`、
 *     `worker.postMessage`、viewport/clear/blend、uniform、属性指针）；
 *   - `draw` = `gl.drawArraysInstanced` 提交；
 *   - `post` = draw 之后 → `_render()` 返回（本臂帧尾没有额外逻辑，所以通常 ≈ 0）。
 *
 * 默认**关闭**（`diagFrameTimingEnabled = false`）：展示/演示路径零开销、行为逐字不变；
 * 只有 bench 测帧内核（`bench-measure.runThroughputFrames`）在测帧前后成对开关，且只取计帧窗口的样本。
 */
export interface DiagFrameTiming {
    prep: number;
    draw: number;
    post: number;
}

let diagFrameTimingEnabled = false;
const diagFrameTimingSamples: DiagFrameTiming[] = [];

/** 打开/关闭采集；**打开时清空**历史样本（避免把测帧前的门禁帧混进统计）。 */
export function setDiagFrameTimingEnabled(on: boolean): void {
    diagFrameTimingEnabled = on;
    if (on) diagFrameTimingSamples.length = 0;
}

/** 已采集的逐帧样本（同一数组引用，调用方自行切片；读完后用 setDiagFrameTimingEnabled(false) 释放）。 */
export function diagFrameTimings(): DiagFrameTiming[] {
    return diagFrameTimingSamples;
}

export function clearDiagFrameTimings(): void {
    diagFrameTimingSamples.length = 0;
}

// [SHFMT 2026-09-29] `?shfmt=f16` 的**唯一判据**，必须放在**模块作用域**（纯函数），不能依赖实例字段：
//   基类 `ShaderProgram` 构造函数会在**派生类字段初始化之前**调用 `_getVertexSource()`，
//   那一刻 `this._shF16` 还是 `undefined` ⇒ `#define SHFMT_F16` 不注入 ⇒ 着色器被编成缺省
//   `usampler2D` 版本，而上传路径又（字段已初始化）往上绑 RGBA16F 纹理 ⇒ draw 被 GL 丢弃：
//   `GL_INVALID_OPERATION: glDrawArraysInstanced: Mismatch between texture format and sampler type`
//   ⇒ 整幅画面画不出来（2026-09-29 桌面端 + 真机复现的根因）。
const SHFMT_PARAM: string = (() => {
    try {
        return new URLSearchParams(location.search).get("shfmt") ?? "";
    } catch {
        return "";
    }
})();
/** `?shfmt=f16`：RGBA16F + 硬件采样（当前实现：每点 12 次 fetch、0 次 unpack，但 12 个 `vec4` 同时存活）。 */
const SHFMT_F16_ENABLED: boolean = SHFMT_PARAM === "f16" || SHFMT_PARAM === "f16_incr";
/**
 * `?shfmt=f16_incr`：**判别实验** —— 与 f16 的取样次数完全相同（12 次），
 *   但改成"边取边写 `shs[]`"（不声明 `rv[4]` 数组、任何时刻只活 1 个 `vec4`）。
 *   用途：把 f16 变慢的两个可能原因分开 ——
 *     回到缺省水平 ⇒ **寄存器/占用率压力**是主因；
 *     仍与 f16 相同  ⇒ **取样次数翻倍**（RGBA16F 每 texel 只能装 4 个 half）是主因。
 */
const SHFMT_F16_INCR: boolean = SHFMT_PARAM === "f16_incr";

const vertexShaderSource = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform highp usampler2D u_texture;
uniform highp sampler2D u_transforms;
uniform highp usampler2D u_transformIndices;
uniform highp sampler2D u_colorTransforms;
uniform highp usampler2D u_colorTransformIndices;
// [NOCT 2026-09-29] noct=1 且数据自证颜色变换为恒等（索引全 0 且块 0 = 单位矩阵）时置 0：
//   跳过“每点索引 fetch + 4 个 texel 拼 mat4 + mat4×vec4”这条恒等路径（纯冗余开销）。
//   缺省恒为 1 ⇒ 与历史行为逐字不变。
uniform bool u_colorTransformEnabled;
uniform bool u_useSH;
// [SHDEG 2026-09-29] 诊断门控：允许把 SH 的**阶数**统一压到 N（-1 = 不干预、历史行为）。
//   用途：把 SH 的“算术成本（degree 3 = 48 系数）”与“流量成本（每点固定读 6 个 texel）”分开。
uniform int u_maxSHDegree;
// [SHPROBE 2026-09-29] 诊断门控：shprobe=fixedcoord 时，SH 的**第二组** texel 改读固定坐标
//   （L1 常驻、不再逐点独享）⇒ 指令数 / 解包次数 / 局部数组大小全部不变，
//   只把"每点独享的 48 B 字节流量"移除 ⇒ 用来隔离"字节流量"与"解包/寄存器压力"。
uniform bool u_shFixedCoord;
// [SHFMT 2026-09-29] shfmt=f16 时走这条路：SH 以 RGBA16F 存储，texelFetch 直接得到 float
//   ⇒ 去掉每点 24 次 unpackHalf2x16（精度与 packed half 位模式完全相同）。
//   缺省 u_shF16=0 ⇒ 仍走下面的 usampler2D + 手工解包路径，行为逐字不变。
// [SHFMT 2026-09-29] f16 变体**复用同一套 sampler 槽位**（同名、同单元 5/6/7），只在编译期
//   把类型从 usampler2D 切成 sampler2D ⇒ **不新增任何 sampler**
//   （教训：给顶点着色器加未使用 sampler 会让缺省路径掉 3×，见文档 §25）。
//   缺省编译（无 SHFMT_F16）⇒ 这三行与改动前逐字相同。
#ifdef SHFMT_F16
uniform highp sampler2D u_sh_r;
uniform highp sampler2D u_sh_g;
uniform highp sampler2D u_sh_b;
#else
uniform highp usampler2D u_sh_r;
uniform highp usampler2D u_sh_g;
uniform highp usampler2D u_sh_b;
#endif
uniform ivec3 u_bandIndex;
uniform mat4 projection, view;
uniform vec2 focal;
uniform vec2 viewport;

uniform bool useDepthFade;
uniform float depthFade;

uniform float u_maxSplatSize;
// [FOOT 2026-09-28] 屏幕足迹倍率（URL 参数 foot=K，缺省 1.0 = 原行为）。
// 存在的唯一目的：把「每片元成本」从「每点成本」里分离出来——K 增大 ⇒ 每帧片元总面积按 ≈K² 增长，
// 若离屏排空（ER/SMP）随片元面积线性变化，则归因单位应写成"每片元"而不是"每点"。
uniform float u_footprintScale;

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

#ifdef SHFMT_F16
    // [SHFMT 2026-09-29] RGBA16F 路径：**复用 u_sh_r/g/b**（编译期类型已切成 sampler2D），
    //   每点每通道 4 个 texel（16 个 half，顺序与 packed 完全一致）⇒ texelFetch 直接给 float
    //   ⇒ **0 次 unpackHalf2x16**；sampler 数量与缺省编译完全相同。
    ivec2 c16 = ivec2(((uint(shIndex) & 0x3ffu) << 2), uint(shIndex) >> 10);
#ifdef SHFMT_F16_INCR
    // [SHFMT 2026-09-29] shfmt=f16_incr（判别实验）：取样次数与 f16 **完全相同**（12 次）、
    //   同样 0 次 unpack，但**边取边写** ⇒ 任何时刻只活 1 个 vec4（不声明 rv[4]/gv[4]/bv[4] 数组）。
    //   索引映射与 f16 分支逐位一致：系数 (4k+j)、通道 ch（R=0,G=1,B=2）⇒ shs[(4k+j)*3+ch]。
    vec4 t;
    t = texelFetch(u_sh_r, c16 + ivec2(0, 0), 0);
    shs[0] = t.x; shs[3] = t.y; shs[6] = t.z; shs[9] = t.w;
    t = texelFetch(u_sh_r, c16 + ivec2(1, 0), 0);
    shs[12] = t.x; shs[15] = t.y; shs[18] = t.z; shs[21] = t.w;
    t = texelFetch(u_sh_r, c16 + ivec2(2, 0), 0);
    shs[24] = t.x; shs[27] = t.y; shs[30] = t.z; shs[33] = t.w;
    t = texelFetch(u_sh_r, c16 + ivec2(3, 0), 0);
    shs[36] = t.x; shs[39] = t.y; shs[42] = t.z; shs[45] = t.w;
    t = texelFetch(u_sh_g, c16 + ivec2(0, 0), 0);
    shs[1] = t.x; shs[4] = t.y; shs[7] = t.z; shs[10] = t.w;
    t = texelFetch(u_sh_g, c16 + ivec2(1, 0), 0);
    shs[13] = t.x; shs[16] = t.y; shs[19] = t.z; shs[22] = t.w;
    t = texelFetch(u_sh_g, c16 + ivec2(2, 0), 0);
    shs[25] = t.x; shs[28] = t.y; shs[31] = t.z; shs[34] = t.w;
    t = texelFetch(u_sh_g, c16 + ivec2(3, 0), 0);
    shs[37] = t.x; shs[40] = t.y; shs[43] = t.z; shs[46] = t.w;
    t = texelFetch(u_sh_b, c16 + ivec2(0, 0), 0);
    shs[2] = t.x; shs[5] = t.y; shs[8] = t.z; shs[11] = t.w;
    t = texelFetch(u_sh_b, c16 + ivec2(1, 0), 0);
    shs[14] = t.x; shs[17] = t.y; shs[20] = t.z; shs[23] = t.w;
    t = texelFetch(u_sh_b, c16 + ivec2(2, 0), 0);
    shs[26] = t.x; shs[29] = t.y; shs[32] = t.z; shs[35] = t.w;
    t = texelFetch(u_sh_b, c16 + ivec2(3, 0), 0);
    shs[38] = t.x; shs[41] = t.y; shs[44] = t.z; shs[47] = t.w;
#else
    vec4 rv0 = texelFetch(u_sh_r, c16 + ivec2(0, 0), 0);
    vec4 rv1 = texelFetch(u_sh_r, c16 + ivec2(1, 0), 0);
    vec4 rv2 = texelFetch(u_sh_r, c16 + ivec2(2, 0), 0);
    vec4 rv3 = texelFetch(u_sh_r, c16 + ivec2(3, 0), 0);
    vec4 gv0 = texelFetch(u_sh_g, c16 + ivec2(0, 0), 0);
    vec4 gv1 = texelFetch(u_sh_g, c16 + ivec2(1, 0), 0);
    vec4 gv2 = texelFetch(u_sh_g, c16 + ivec2(2, 0), 0);
    vec4 gv3 = texelFetch(u_sh_g, c16 + ivec2(3, 0), 0);
    vec4 bv0 = texelFetch(u_sh_b, c16 + ivec2(0, 0), 0);
    vec4 bv1 = texelFetch(u_sh_b, c16 + ivec2(1, 0), 0);
    vec4 bv2 = texelFetch(u_sh_b, c16 + ivec2(2, 0), 0);
    vec4 bv3 = texelFetch(u_sh_b, c16 + ivec2(3, 0), 0);
        vec4 rv[4] = vec4[4](rv0, rv1, rv2, rv3);
        vec4 gv[4] = vec4[4](gv0, gv1, gv2, gv3);
        vec4 bv[4] = vec4[4](bv0, bv1, bv2, bv3);
        for (int k = 0; k < 4; k++) {
            shs[(4 * k + 0) * 3 + 0] = rv[k].x;
            shs[(4 * k + 0) * 3 + 1] = gv[k].x;
            shs[(4 * k + 0) * 3 + 2] = bv[k].x;
            shs[(4 * k + 1) * 3 + 0] = rv[k].y;
            shs[(4 * k + 1) * 3 + 1] = gv[k].y;
            shs[(4 * k + 1) * 3 + 2] = bv[k].y;
            shs[(4 * k + 2) * 3 + 0] = rv[k].z;
            shs[(4 * k + 2) * 3 + 1] = gv[k].z;
            shs[(4 * k + 2) * 3 + 2] = bv[k].z;
            shs[(4 * k + 3) * 3 + 0] = rv[k].w;
            shs[(4 * k + 3) * 3 + 1] = gv[k].w;
            shs[(4 * k + 3) * 3 + 2] = bv[k].w;
        }
#endif
#else
    {
        ivec2 shCoord0 = ivec2(((uint(shIndex) & 0x3ffu) << 1), uint(shIndex) >> 10);
        // [SHPROBE] 第二组 texel：探针开启时读固定坐标（全点共享 ⇒ 常驻缓存），否则与历史逐字相同
        ivec2 shCoord1 = u_shFixedCoord
            ? ivec2(0, 0)
            : ivec2(((uint(shIndex) & 0x3ffu) << 1) | 1u, uint(shIndex) >> 10);

        uvec4 packedR0 = texelFetch(u_sh_r, shCoord0, 0);
        uvec4 packedR1 = texelFetch(u_sh_r, shCoord1, 0);

        uvec4 packedG0 = texelFetch(u_sh_g, shCoord0, 0);
        uvec4 packedG1 = texelFetch(u_sh_g, shCoord1, 0);

        uvec4 packedB0 = texelFetch(u_sh_b, shCoord0, 0);
        uvec4 packedB1 = texelFetch(u_sh_b, shCoord1, 0);

        fillSHFromPacked(packedR0, packedR1, 0, shs);
        fillSHFromPacked(packedG0, packedG1, 1, shs);
        fillSHFromPacked(packedB0, packedB1, 2, shs);
    }
#endif

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
    vec2 majorAxis = min(sqrt(2.0 * lambda1) * u_footprintScale, u_maxSplatSize) * diagonalVector;
    vec2 minorAxis = min(sqrt(2.0 * lambda2) * u_footprintScale, u_maxSplatSize) * vec2(diagonalVector.y, -diagonalVector.x);

    mat4 colorTransform = mat4(1.0);
    if (u_colorTransformEnabled) {
        uint colorTransformIndex = texelFetch(u_colorTransformIndices, ivec2(uint(index) & 0x3ffu, uint(index) >> 10), 0).x;
        colorTransform = mat4(
            texelFetch(u_colorTransforms, ivec2(0, colorTransformIndex), 0),
            texelFetch(u_colorTransforms, ivec2(1, colorTransformIndex), 0),
            texelFetch(u_colorTransforms, ivec2(2, colorTransformIndex), 0),
            texelFetch(u_colorTransforms, ivec2(3, colorTransformIndex), 0)
        );
    }

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

        if (u_maxSHDegree >= 0 && degree > uint(u_maxSHDegree)) {
            degree = uint(u_maxSHDegree);
        }

        if (degree > 0u || u_bandIndex[0] < 0) {
            vec3 worldPosition = (transform * vec4(uintBitsToFloat(cen.xyz), 1.0)).xyz;
            vec3 cameraPosition = inverse(view)[3].xyz;
            vec3 dir = normalize(worldPosition - cameraPosition);

            color.rgb = evalSHRGB(shIndex, degree, dir);
        }
    }

    vColor = u_colorTransformEnabled ? colorTransform * color : color;

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
    // Max on-screen splat footprint in px. Default 1024 = effectively uncapped
    // (cap disabled). The cap may be enabled for A/B or by the future adaptive
    // quality controller via ?splatPx=n / __PERF__.setMaxSplatSize(n).
    // [SPLATPX 2026-09-29] 该上限此前**只有注释提到、没有任何 URL 解析**（`?splatPx=` 是空的）⇒
    //   之前那条 "splatPx=64 无变化" 属**未生效的假阴性**。现在按 `foot` 同款写法真正接线：
    //   缺省 1024 = 与历史逐字一致（"effectively uncapped"）。
    private _maxSplatSize: number = (() => {
        try {
            const v = parseFloat(new URLSearchParams(location.search).get("splatPx") || "");
            return Number.isFinite(v) && v >= 8 && v <= 4096 ? v : 1024;
        } catch {
            return 1024;
        }
    })();
    // [FOOT 2026-09-28] 屏幕足迹倍率：`?foot=K`（缺省 1 = **与历史结果逐位一致的原式**）。
    //   用途：把"每点成本"与"每片元成本"分开——K↑ ⇒ 每帧片元总面积 ≈ K²↑。
    //   放在字段初始化里（内联）是为了 bench / demo / 离屏目标三条路径都自动生效，不需要跨文档传参。
    private _footprintScale: number = (() => {
        try {
            const v = parseFloat(new URLSearchParams(location.search).get("foot") || "");
            return Number.isFinite(v) && v > 0 ? v : 1;
        } catch {
            return 1;
        }
    })();
    private _outlineColor: Color32 = new Color32(255, 165, 0, 255);
    private _renderData: RenderData | null = null;
    private _depthIndex: Uint32Array = new Uint32Array();
    // [DEPTHUP 2026-09-29] 深度序上传模式：`?depthup=sub` ⇒ **预分配一次 + 每帧 `bufferSubData`**（不再重分配/孤儿化）；
    //   缺省（不带该参数）= 历史行为**逐位不变**。`_depthUploads` 用于自证"这条路径在当前协议下到底有没有被执行"
    //   （若为 0 ⇒ 候选① 的实验对象根本没被触发，可直接判定它不是主因）。
    private _depthUpSub: boolean = (() => {
        try {
            return new URLSearchParams(location.search).get("depthup") === "sub";
        } catch {
            return false;
        }
    })();
    private _depthUploads = 0;
    private _depthBufBytes: number[] = [];
    // [DRAWFRAC 2026-09-29] **点数抽样（纯诊断）**：`?drawfrac=K`（0<K<1；缺省 1 = 不抽样、行为逐字不变）。
    //   把排序后的索引数组按**等间隔**抽样到 `round(len·K)` 条 ⇒ 绘制实例数随之下降（`drawArraysInstanced` 用
    //   `depthIndex.length`）。抽样在**排序位置上均匀** ⇒ 保留整体深度分布，不是"只留最近的点"。
    //   用途：分离"点数下降"与"相机转动"两个混杂变量（静止机位 + 降点数 的对照臂）。
    private _drawFraction: number = (() => {
        try {
            const v = parseFloat(new URLSearchParams(location.search).get("drawfrac") || "");
            return Number.isFinite(v) && v > 0 && v < 1 ? v : 1;
        } catch {
            return 1;
        }
    })();
    // [NOCT 2026-09-29] 诊断门控（缺省关）：`?noct=1` ⇒ `u_colorTransformEnabled = 0`，
    //   跳过每点「颜色变换索引 fetch + 4×texel 拼 mat4 + mat4×vec4」这条**恒等**路径
    //   （`RenderData` 只用块 0 且块 0 为单位矩阵 ⇒ 输出逐像素不变）。
    //   缺省（无该参数）恒为 1 ⇒ 与历史行为逐字不变。
    private _noctRequested: boolean = (() => {
        try {
            return new URLSearchParams(location.search).get("noct") === "1";
        } catch {
            return false;
        }
    })();
    // [NOSH 2026-09-29] 诊断门控（缺省关）：`?nosh=1` ⇒ 强制 `u_useSH = 0`（不取 SH 纹理、不算 SH），
    //   用于判别"SH 路径（每点 6 次 16B fetch + 最多 degree 3 运算）"是不是每点成本的主要来源。
    //   注意：这是**纯计时诊断**，画面会退化为只有 DC 颜色；缺省不变（历史行为逐字相同）。
    private _noshRequested: boolean = (() => {
        try {
            return new URLSearchParams(location.search).get("nosh") === "1";
        } catch {
            return false;
        }
    })();
    // [SHDEG 2026-09-29] 诊断门控（缺省 -1 = 不干预）：`?shdeg=N` 把 SH 阶数统一压到 N（0..3）。
    //   用于分离 SH 的“算术成本”（degree 3 = 48 系数 vs 1 = 12）与“流量成本”（每点固定 6 个 texel）。
    private _maxSHDegree: number = (() => {
        try {
            const v = parseInt(new URLSearchParams(location.search).get("shdeg") || "", 10);
            return Number.isFinite(v) && v >= 0 && v <= 3 ? v : -1;
        } catch {
            return -1;
        }
    })();
    // [SHPROBE 2026-09-29] 诊断门控（缺省关）：`?shprobe=fixedcoord` ⇒ SH 的第二组 texel 读固定坐标
    //   （移除"每点独享 48 B"的流量，指令/解包/寄存器不变）⇒ 隔离"字节流量 vs 解包/寄存器压力"。
    private _shFixedCoordProbe: boolean = (() => {
        try {
            return new URLSearchParams(location.search).get("shprobe") === "fixedcoord";
        } catch {
            return false;
        }
    })();
    // [SHFMT 2026-09-29] `?shfmt=f16`：SH 系数纹理改用 **RGBA16F**（半精度浮点，与现在 unpackHalf2x16
    //   还原出的半精度**位模式完全相同 ⇒ 零精度损失**），着色器 texelFetch 直接得到 float ⇒
    //   **去掉每点 24 次 unpackHalf2x16**（实测已经证明成本就在这里，见文档 §24）。
    //   边界（务必不要误解）：这只改"解压后数据如何存进 GPU 显存供着色器采样"这一步；
    //   **不涉及训练、不涉及模型资产格式、不影响磁盘层面的低秩量化压缩方案**。
    //   缺省（无该参数）⇒ 与历史行为逐字不变（仍是 RGBA32UI + 手工 unpack 路径）。
    //   ⚠️ 取值必须来自模块作用域常量 `SHFMT_F16_ENABLED`：编译期（`_getVertexSource()` 在基类构造里
    //   就被调用）与运行期（纹理上传）必须用**同一个**判据，否则会出现"着色器 usampler2D + 纹理 RGBA16F"。
    private _shF16: boolean = SHFMT_F16_ENABLED;
    /** `?shfmt=f16` 时额外创建的 3 张 RGBA16F SH 纹理（与 packed 纹理并存，缺省为 null）。 */
    private _shTextures16: [WebGLTexture | null, WebGLTexture | null, WebGLTexture | null] = [null, null, null];
    // ---- [LAB 2026-09-26] 排序/相机变化诊断计数器（只为测量口径诊断，不影响渲染行为）----
    /** 每帧向 sort worker 发送 viewProj 的次数（= 渲染帧数） */
    private _labSortPosts = 0;
    /** worker 回包次数（worker 只在真正执行了排序后才回包）⇒ = 实际排序次数 */
    private _labSortReplies = 0;
    /** 相邻两帧 viewProj 16 个元素的最大绝对差（逐元素比较，不是 `includes`） */
    private _labVpMaxDelta = 0;
    /** viewProj 与上一帧**不完全逐元素相等**的帧数 */
    private _labVpChangedFrames = 0;
    private _labLastVp: Float32Array | null = null;
    private _labFrames = 0;
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
        let u_colorTransformEnabled: WebGLUniformLocation;
        let u_maxSHDegree: WebGLUniformLocation;
        let u_shFixedCoord: WebGLUniformLocation;

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
                    // [LAB] worker 只在真正跑过排序后才回包 ⇒ 这个计数就是"实际排序次数"
                    this._labSortReplies++;
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

                    // [DRAWFRAC 2026-09-29] 诊断抽样：把排序结果等间隔抽到 `round(len·K)` 条
                    //   （K 的缺省 1 = 不抽样 ⇒ 与历史行为逐字相同）。抽样后长度即绘制实例数。
                    let depthUse: Uint32Array = depthIndex;
                    if (this._drawFraction < 1 && depthIndex.length > 1) {
                        const take = Math.max(1, Math.round(depthIndex.length * this._drawFraction));
                        const picked = new Uint32Array(take);
                        for (let i = 0; i < take; i++) {
                            picked[i] = depthIndex[Math.floor((i * depthIndex.length) / take)];
                        }
                        depthUse = picked;
                    }
                    this._depthIndex = depthUse;
                    const uploadStart = performance.now();
                    // Upload into a buffer that the just-submitted frame is NOT
                    // reading, then make it the buffer drawn from next frame.
                    // Depth order only changes when a sort result arrives, so we
                    // never re-upload on frames that reuse the previous order.
                    const target = (activeDepthBuffer + 1) % indexBuffers.length;
                    gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffers[target]);
                    if (this._depthUpSub) {
                        // [DEPTHUP 2026-09-29] 修复路径：每个槽位只分配一次（点数变化才重分配），
                        //   其余帧只做 `bufferSubData` 局部更新 ⇒ 消除每帧 2.4 MB 的重分配/孤儿化。
                        if (this._depthBufBytes[target] !== depthUse.byteLength) {
                            gl.bufferData(gl.ARRAY_BUFFER, depthUse.byteLength, gl.DYNAMIC_DRAW);
                            this._depthBufBytes[target] = depthUse.byteLength;
                        }
                        gl.bufferSubData(gl.ARRAY_BUFFER, 0, depthUse);
                    } else {
                        gl.bufferData(gl.ARRAY_BUFFER, depthUse, gl.DYNAMIC_DRAW);
                    }
                    gl.bindBuffer(gl.ARRAY_BUFFER, null);
                    activeDepthBuffer = target;
                    this._depthUploads++; // [DEPTHUP] 自证计数（0 ⇒ 该路径从未执行）
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
            // [FOOT 2026-09-28] 足迹倍率（缺省 1.0 ⇒ 与原行为一致；仅线性度实验时由 `?foot=K` 改变）
            gl.uniform1f(gl.getUniformLocation(this.program, "u_footprintScale"), this._footprintScale);

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
            // [NOCT 2026-09-29] 缺省恒为 1（历史行为逐字不变）；`?noct=1` 时置 0（诊断：跳过恒等颜色变换路径）
            u_colorTransformEnabled = gl.getUniformLocation(
                this.program,
                "u_colorTransformEnabled",
            ) as WebGLUniformLocation;
            gl.uniform1i(u_colorTransformEnabled, this._noctRequested ? 0 : 1);
            // [SHDEG 2026-09-29] 缺省 -1 = 不干预（历史行为逐字不变）；`?shdeg=N` 时压到 N 阶
            u_maxSHDegree = gl.getUniformLocation(this.program, "u_maxSHDegree") as WebGLUniformLocation;
            gl.uniform1i(u_maxSHDegree, this._maxSHDegree);
            // [SHPROBE 2026-09-29] 缺省 false = 不干预（历史行为逐字不变）
            u_shFixedCoord = gl.getUniformLocation(this.program, "u_shFixedCoord") as WebGLUniformLocation;
            gl.uniform1i(u_shFixedCoord, this._shFixedCoordProbe ? 1 : 0);
            // [SHFMT 2026-09-29] f16 变体**复用单元 5/6/7**（类型已在编译期切成 sampler2D）
            //   ⇒ 不需要任何额外 uniform 或额外 sampler；缺省路径与改动前逐字相同。

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
            if (!this.renderData || !this.renderData.sphericalHarmonics || this._noshRequested) {
                gl.uniform1i(u_useSH, 0);
                return;
            }

            const sh = this.renderData.sphericalHarmonics;

            gl.uniform1i(u_useSH, 1);
            gl.uniform3iv(u_bandIndex, sh.bandsIndices);

            for (let channel = 0; channel < 3; channel++) {
                if (!this._shF16) {
                    // [SHFMT 2026-09-29] 缺省路径**逐字不变**（RGBA32UI packed + 手工解包）。
                    //   f16 模式下这张 packed 纹理不会被任何东西采样（着色器编译期已切到 sampler2D + RGBA16F）
                    //   ⇒ 不再重复上传：省掉每通道 ~19.5 MB（610k 点、3 通道合计 ~58 MB）。
                    //   移动端显存本就紧张，重复占位可能让后续分配失败（症状正是"整幅画面画不出来"）。
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

                if (this._shF16) {
                    // [SHFMT 2026-09-29] 同一份 packed-half 位模式，按"每点 16 个 half = 4 个 texel"重排：
                    //   因为 packed 是 2048 宽 × 4 uint/texel（=16 B/texel，每点 2 texel = 32 B），
                    //   RGBA16F 是 4096 宽 × 4 half/texel（=8 B/texel，每点 4 texel = 32 B）⇒ **每点字节数与
                    //   字节顺序完全一致** ⇒ 只把 Uint32Array 重解释为 Uint16Array、行宽 ×2、高度不变
                    //   ⇒ **零拷贝、且与 unpackHalf2x16 得到的半精度位模式完全相同（零精度损失）**。
                    if (!this._shTextures16[channel]) {
                        this._shTextures16[channel] = gl.createTexture() as WebGLTexture;
                    }
                    gl.activeTexture(gl.TEXTURE5 + channel);
                    gl.bindTexture(gl.TEXTURE_2D, this._shTextures16[channel]);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

                    const packed = sh.rgb[channel];
                    const halves = new Uint16Array(packed.buffer, packed.byteOffset, packed.length * 2);
                    // 上传前先清空既有错误：否则上游遗留的 GL 错误会被误判成"这张纹理上传失败"。
                    while (gl.getError() !== gl.NO_ERROR) {
                        /* drain */
                    }
                    gl.texImage2D(
                        gl.TEXTURE_2D,
                        0,
                        gl.RGBA16F,
                        sh.width * 2,
                        sh.height,
                        0,
                        gl.RGBA,
                        gl.HALF_FLOAT,
                        halves,
                    );
                    // [SHFMT-DIAG 2026-09-29] 上传失败（显存不足 / 格式不支持 / 尺寸越界）在真机上
                    //   只会表现为"整幅画面画不出来"，所以 f16 实验期间把它升级为异常 ⇒ 落进报告的 `err=`。
                    //   缺省路径完全不经过这里 ⇒ 零回归面。
                    const uploadErr = gl.getError();
                    if (uploadErr !== gl.NO_ERROR) {
                        throw new Error(
                            `[shfmt=f16] RGBA16F SH upload failed :: glError=0x${uploadErr.toString(16)} ` +
                                `(ch=${channel}, ${sh.width * 2}x${sh.height}, bytes=${halves.byteLength})`,
                        );
                    }

                    // f16 模式下单元 5/6/7 最终绑的是 RGBA16F 版本（sampler 类型也在编译期切成 sampler2D）
                    // ⇒ 不再需要恢复 packed 绑定，也不存在 sampler/格式不匹配。
                }
            }

            gl.activeTexture(gl.TEXTURE0);
        };

        this._render = () => {
            if (!this._scene || !this._camera || !this.renderData) {
                console.error("Cannot render without scene and camera");
                return;
            }

            // [DIAG-EXPERIMENT-1] prep 段起点（默认关闭时恒为 0，不参与任何计算）
            const tPrep = diagFrameTimingEnabled ? performance.now() : 0;

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
            // [LAB] 逐帧记录：发送次数 + viewProj 的**逐元素**变化幅度（与 worker 里那个 `includes` 判定无关）
            this._labSortPosts++;
            this._labFrames++;
            {
                const vp = this._camera.data.viewProj.buffer as unknown as Float32Array;
                if (this._labLastVp && vp && vp.length === this._labLastVp.length) {
                    let maxD = 0;
                    let changed = false;
                    for (let i = 0; i < vp.length; i++) {
                        const d = Math.abs(vp[i] - this._labLastVp[i]);
                        if (d > maxD) maxD = d;
                        if (d !== 0) changed = true;
                    }
                    if (maxD > this._labVpMaxDelta) this._labVpMaxDelta = maxD;
                    if (changed) this._labVpChangedFrames++;
                }
                if (vp) this._labLastVp = new Float32Array(vp);
            }

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
            // [DIAG-EXPERIMENT-1] draw 段边界（默认关闭时恒为 0）
            const tDrawStart = diagFrameTimingEnabled ? performance.now() : 0;
            gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, this.depthIndex.length);
            const tDrawEnd = diagFrameTimingEnabled ? performance.now() : 0;
            if (perf.enabled) {
                perf.sample("gl.drawSubmit.ms", performance.now() - drawSubmitStart);
                perf.sample("cpu.drawSetup.ms", performance.now() - drawSetupStart);
            }
            // [DIAG-EXPERIMENT-1] 帧尾：落一份逐帧样本。`window.__THESIS_FRAME_TIMING__` 供流式读数/人工排查；
            //   数组样本由 bench-measure 在测帧结束后按 `slice(-rendered)` 取计帧窗口（排除预热帧）。
            if (diagFrameTimingEnabled) {
                const tPost = performance.now();
                const sample: DiagFrameTiming = {
                    prep: tDrawStart - tPrep,
                    draw: tDrawEnd - tDrawStart,
                    post: tPost - tDrawEnd,
                };
                (window as unknown as { __THESIS_FRAME_TIMING__?: DiagFrameTiming }).__THESIS_FRAME_TIMING__ = sample;
                diagFrameTimingSamples.push(sample);
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
            // 颜色变换用的两张纹理同样由本程序创建，_dispose 必须成对删除：
            // 漏掉它们会让"每轮新建上下文"的用法（bench-case 的 iframe）在 GPU 侧逐轮累积句柄。
            if (colorTransformsTexture) {
                gl.deleteTexture(colorTransformsTexture);
            }
            if (colorTransformIndicesTexture) {
                gl.deleteTexture(colorTransformIndicesTexture);
            }

            for (const texture of this._shTextures) {
                if (texture) {
                    gl.deleteTexture(texture);
                }
            }

            // [SHFMT 2026-09-29] `?shfmt=f16` 额外创建的 3 张 RGBA16F SH 纹理也必须成对删除：
            //   否则"每轮新建上下文"的用法（bench-case 的 iframe）会在 GPU 侧逐轮累积句柄。
            for (const texture of this._shTextures16) {
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

    /**
     * [LAB 2026-09-26] 排序/相机变化诊断快照（**只用于测量口径诊断**，不参与渲染）：
     * `posts` = 每帧发给 worker 的 viewProj 次数（=渲染帧数）；
     * `sorts` = worker 回包次数（worker 只在真跑了排序后回包）⇒ 实际排序次数；
     * `vpMaxDelta` = 相邻帧 viewProj 逐元素最大绝对差（0 = 逐帧数值完全相同）；
     * `vpChanged` = 逐元素不完全相等的帧数。
     */
    get labStats(): { posts: number; sorts: number; frames: number; vpMaxDelta: number; vpChanged: number } {
        return {
            posts: this._labSortPosts,
            sorts: this._labSortReplies,
            frames: this._labFrames,
            vpMaxDelta: this._labVpMaxDelta,
            vpChanged: this._labVpChangedFrames,
        };
    }

    resetLabStats(): void {
        this._labSortPosts = 0;
        this._labSortReplies = 0;
        this._labVpMaxDelta = 0;
        this._labVpChangedFrames = 0;
        this._labFrames = 0;
        this._labLastVp = null;
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
        // [SHFMT 2026-09-29] 只有 `?shfmt=f16` 时，才把 f16 那段（sampler 类型切换 + 单分支）**编译进**着色器；
        //   缺省（不传 shfmt）⇒ 源码与改动前逐字相同 ⇒ **缺省路径的着色器二进制也相同**（零回归面）。
        //   ⚠️ 必须用模块级 `SHFMT_F16_ENABLED`（不能用 `this._shF16`）：本函数在**基类构造函数**里
        //   就被调用，那时派生类字段还没初始化（`this._shF16 === undefined`）⇒ 会编成缺省着色器。
        //   ⚠️ 另外：`#define` 必须插在 `#version 300 es` **之后**（`#version` 必须是第一条有效语句）。
        if (!SHFMT_F16_ENABLED) return vertexShaderSource;
        const define = SHFMT_F16_INCR
            ? "#define SHFMT_F16 1\n#define SHFMT_F16_INCR 1\n"
            : "#define SHFMT_F16 1\n";
        return vertexShaderSource.replace("#version 300 es", "#version 300 es\n" + define);
    }

    protected _getFragmentSource() {
        return fragmentShaderSource;
    }
}

export { RenderProgram };
