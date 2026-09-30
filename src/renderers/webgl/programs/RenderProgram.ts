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

// [SHPASS 2026-09-30] `?shpass=` 诊断分支（**缺省不生效**，BASE/NOSH 与缺省路径完全不受影响）：
//   pre     = TF_FULL：每帧第一遍 TF 生产 + 同帧主 pass 消费（主 pass 编译为 SHPASS_PRE 变体）
//   produce = TF_PRODUCE_ONLY：每帧跑第一遍 TF，但主 pass **完全走缺省路径**、不读 TF 输出
//   consume = TF_CONSUME_ONLY：**只在首帧生产一次**，随后主 pass 每帧读该输出（固定相机诊断）
//   ⚠️ produce 比 BASE **多算一遍 SH** ⇒ 两者帧时间之差不是"纯 TF 固定开销"；
//      consume 是**静态颜色**诊断 ⇒ 不代表动态相机下画质合格。
const SHPASS_PARAM: string = (() => {
    try {
        return new URLSearchParams(location.search).get("shpass") ?? "";
    } catch {
        return "";
    }
})();
/** 主 pass 是否读 TF 输出（⇒ 编译 `SHPASS_PRE` 变体）：pre / consume。 */
const SHPASS_MAIN_READS_TF: boolean = SHPASS_PARAM === "pre" || SHPASS_PARAM === "consume";
/** 是否**每帧**执行第一遍 TF：pre / produce。 */
const SHPASS_PRODUCE_EVERY_FRAME: boolean = SHPASS_PARAM === "pre" || SHPASS_PARAM === "produce";
/** 是否**只生产一次**（首帧）：consume。 */
const SHPASS_PRODUCE_ONCE: boolean = SHPASS_PARAM === "consume";
/** 是否需要创建 TF program / TF 对象 / 输出缓冲（三臂任一）。 */
const SHPASS_TF_REQUESTED: boolean = SHPASS_MAIN_READS_TF || SHPASS_PRODUCE_EVERY_FRAME;
const SHPASS_WEBGL2_OK: boolean = typeof WebGL2RenderingContext !== "undefined";
/** 编译期：主 pass 走 pre 变体（读实例属性颜色）。 */
const SHPASS_PRE_ENABLED: boolean = SHPASS_MAIN_READS_TF && SHPASS_WEBGL2_OK;
/** 运行期：TF 是否启用（三个 `shpass` 取值共用；不支持 TF 则 console.error 并停用）。 */
const SHPASS_TF_ENABLED: boolean = SHPASS_TF_REQUESTED && SHPASS_WEBGL2_OK;
/** `?shtfprobe=1`：一次性回读 TF 缓冲前 8 字节（**缺省关闭** ⇒ 正式计时窗口内没有任何同步回读）。 */
const SHTFPROBE_REQUESTED: boolean = (() => {
    try {
        return new URLSearchParams(location.search).get("shtfprobe") === "1";
    } catch {
        return false;
    }
})();
/** `?shpass=pre&shpackf16=1`：TF 输出为 2×`packHalf2x16`（8 B/splat）而非 float32 `vec4`（16 B/splat）。 */
const SHPASS_PRE_PACKF16: boolean = (() => {
    try {
        return new URLSearchParams(location.search).get("shpackf16") === "1";
    } catch {
        return false;
    }
})();

// [SHCACHE 2026-09-30] 方案 B 最小原型 `?shcache=frag`：
//   第一遍：**片元** pass（全屏三角形）为每个 splat 计算一次视角相关 SH 颜色，写入 RGBA16F 颜色纹理；
//   第二遍：主 pass 仍按排序结果绘制，但颜色改为 `texelFetch(u_colorTex, 原始 splat 索引)`，
//           不再取样 SH 纹理、不做 SH 求值（SH/colorTransform 声明整段排除）。
//   `&shcachefreeze=1`：**跳过前 2 帧后**不再重算（固定相机下隔离"主 pass 读取成本"的诊断臂，
//   **不代表动态相机可用**）。为什么要"跳过前 2 帧"：旧实现首帧即固化，若首帧纹理/数据尚未就绪
//   （读到 cov=0）会把**空缓存**永久冻住 ⇒ 画面全空、存活探针 ok=0（§30 记录的那次失败）。
//   缺省不生效；BASE / NOSH / TF 各臂 / 缺省路径逐字不变。
const SHCACHE_PARAM: string = (() => {
    try {
        return new URLSearchParams(location.search).get("shcache") ?? "";
    } catch {
        return "";
    }
})();
const SHCACHE_FRAG_REQUESTED: boolean = SHCACHE_PARAM === "frag";
/**
 * [阶段0 2026-09-30] 冻结臂的**生产帧数**：`?shfreeze=N`（N ≥ 1；缺省 0 = 不冻结）。
 *   语义：只在前 N 帧执行片元生产遍，之后每帧复用同一张颜色纹理；主 pass 与 FRAG_FULL **完全相同**
 *   （同样不声明任何 SH sampler）。
 *   为什么允许 N > 1：实测 **N=1 会得到空缓存**（首帧时点/变换纹理尚未绑到采样单元 0–4 ⇒ `cov=0` ⇒
 *   alpha=0 ⇒ 存活探针 ok=0，见 §30）⇒ 最短**可测**版本是 N=2；两者对"生产成本 P"的差别只有"多生产 1 帧"
 *   （100 个计帧里 ≈0.2–0.8%，见阶段 0 报告的误差说明）。
 *   历史别名 `?shcachefreeze=1` 映射为 N=2（保留已验证过的行为）。
 */
const SHFREEZE_FRAMES: number = (() => {
    try {
        const q = new URLSearchParams(location.search);
        const raw = q.get("shfreeze");
        if (raw !== null) {
            const n = parseInt(raw, 10);
            if (Number.isFinite(n) && n > 0) return Math.min(600, n);
            return 0;
        }
        return q.get("shcachefreeze") === "1" ? 2 : 0;
    } catch {
        return 0;
    }
})();
const SHCACHE_FREEZE: boolean = SHFREEZE_FRAMES > 0;

// [阶段1 2026-09-30] `?shcache=frag&lr=1`：**渲染期低秩**。
//   生产遍不再从 6 个 SH 纹素取 48 个系数，而是 ① 1 次 texelFetch 取每点 r 个 rank 系数 `a_j`（RGBA32UI，
//   每点 1 纹素 = 8 half），② 在着色器内用**共享基** B（`rank × 45`，coeff-major）求
//   `color.rgb += Σ_j a_j · Σ_{k=1..15} Y_k(dir) · B[j, k-1, c]`。
//   DC 不参与低秩（它在基础色字节里）⇒ 只加 rest ⇒ 每点 1 次取样（原来是 6 次）。
//   缺省 0 ⇒ 既有分支（含加载期重建 + 6 次取样）逐字不变。
const LR_ENABLED: boolean = (() => {
    try {
        return new URLSearchParams(location.search).get("lr") === "1";
    } catch {
        return false;
    }
})();
/** rank 纹理宽度常量（与 loader 的 `LR_RANK_TEX_WIDTH` 同值；纹理按 2048 宽上传）。 */
const LR_RANK_WIDTH = 2048;
const SHCACHE_ENABLED: boolean = SHCACHE_FRAG_REQUESTED && typeof WebGL2RenderingContext !== "undefined";

/**
 * 从顶点着色器模板里**原样切出**一段：保证方案 B 与 BASE 的 SH 逻辑**逐字相同**（不靠"看起来一样"判断正确）。
 */
function sliceShaderSource(startMarker: string, endMarker: string): string {
    const i = vertexShaderSource.indexOf(startMarker);
    const j = vertexShaderSource.indexOf(endMarker);
    if (i < 0 || j < 0 || j <= i) {
        throw new Error(`[shcache=frag] 无法切出着色器片段（marker 未命中）：${startMarker.slice(0, 48)}`);
    }
    return vertexShaderSource.slice(i, j + endMarker.length);
}

/** [方案 B] 第一遍的顶点着色器：全屏大三角形（3 顶点、无属性、由 gl_VertexID 生成）。 */
const shCacheFullscreenVertexSource = /* glsl */ `#version 300 es
precision highp float;

void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * [方案 B] 第一遍的片元着色器：把"逐 splat 颜色"写到 RGBA16F 颜色纹理。
 *   - 片元 ↔ splat 原始索引（整数规则明确）：`ivec2(gl_FragCoord.xy)` ⇒ `idx = p.y * u_colorTexWidth + p.x`；
 *   - `idx >= u_splatCount` 的片元**不读取任何点数据**；
 *   - SH 常量 / `fillSHFromPacked` / `evalSHRGB` 与 BASE **同一份文本**（运行时从顶点模板切出）。
 */
/**
 * [阶段1 2026-09-30] 生产遍源码（含低秩臂的定义注入）。
 *   `lr=1` 时才注入 `LR_*` 常量；缺省直接返回 `buildShCacheFragmentSource()` 的原文 ⇒ 逐字不变。
 */
function buildShCacheFragmentSourceForArm(): string {
    const src = buildShCacheFragmentSource();
    if (!LR_ENABLED) return src;
    // LR_RANK_MAX = 7（该数据集 rank；loader 对不足的槽位补 0 ⇒ 定长循环不引入误差）
    // LR_REST = 45（每行基的列数 = 15 个 rest 系数 × 3 通道）
    // LR_UBO_VEC4 = ⌈7×45/4⌉ = 79 个 vec4 = 1,264 B
    const defines = ["#define LR_RANK_MAX 7", "#define LR_REST 45", "#define LR_UBO_VEC4 79"].join("\n");
    return src.replace("#version 300 es", "#version 300 es\n" + defines);
}

/**
 * [阶段1 2026-09-30] 低秩臂注入的 GLSL：rank 纹理取样 + 共享基累加（`Y_k` 与 `evalSHRGB` 逐行同源）。
 *   - `Y_k`（k=1..15）直接从 `evalSHRGB` 的同一段公式转录（`shs[3k+c]` 的系数序 = 低秩的
 *     `[R1,G1,B1,R2,…]` coeff-major 序 ✓）；
 *   - 循环边界 `LR_RANK_MAX` 是**编译期常量**（该数据集 rank=7；loader 对 rank<7 的槽位补 0
 *     ⇒ 定长循环不会引入误差）；`LR_REST`=45、UBO 槽位 = ⌈7×45/4⌉ = 79 个 vec4 = 1,264 B。
 *   - 基按 **channel-major** 存（`off(j,c,k-1) = j*45 + c*15 + (k-1)`，TS 侧重排）⇒ `Σ_k` 连续访问。
 */
const LR_SH_GLSL = /* glsl */ `
// ---- [阶段1] 渲染期低秩：每点 1 次取样 + 共享基累加 ----
uniform highp usampler2D u_lrRank;
uniform int u_lrW;
uniform LrBasisBlock { vec4 u_lrB[LR_UBO_VEC4]; };
float lrB(int j, int c, int k) {
    int i = j * LR_REST + c * 15 + (k - 1);
    return u_lrB[i >> 2][i & 3];
}
vec3 lrRestRGB(uint idx, vec3 d) {
    // 每点 **2 个纹素**：纹素 0 = r 个 rank 系数、纹素 1 = DC 的 3 个 half。
    //   寻址沿用"每点 2 纹素"的位技巧（`(idx & 0x3ff) << 1`），与 2048 宽 × ⌈2N/2048⌉ 高的布局一致。
    ivec2 c0 = ivec2(int((idx & 0x3ffu) << 1u), int(idx >> 10u));
    uvec4 p = texelFetch(u_lrRank, c0, 0);
    uvec4 q = texelFetch(u_lrRank, c0 + ivec2(1, 0), 0);
    vec2 h0 = unpackHalf2x16(p.x);
    vec2 h1 = unpackHalf2x16(p.y);
    vec2 h2 = unpackHalf2x16(p.z);
    vec2 h3 = unpackHalf2x16(p.w);
    vec2 dcd = unpackHalf2x16(q.x);
    vec2 dce = unpackHalf2x16(q.y);
    float a[LR_RANK_MAX];
    a[0] = h0.x; a[1] = h0.y; a[2] = h1.x; a[3] = h1.y;
    a[4] = h2.x; a[5] = h2.y; a[6] = h3.x;
    float x = d.x; float y = d.y; float z = d.z;
    float xx = x * x; float yy = y * y; float zz = z * z;
    float xy = x * y; float yz = y * z; float xz = x * z;
    float Y[15];
    Y[0] = -SH_C1 * y;
    Y[1] = -SH_C1 * z;
    Y[2] = SH_C1 * x;
    Y[3] = SH_C2[0] * xy;
    Y[4] = SH_C2[1] * yz;
    Y[5] = SH_C2[2] * (2.0 * zz - xx - yy);
    Y[6] = SH_C2[3] * xz;
    Y[7] = SH_C2[4] * (xx - yy);
    Y[8] = SH_C3[0] * y * (3.0 * xx - yy);
    Y[9] = SH_C3[1] * xy * z;
    Y[10] = SH_C3[2] * y * (4.0 * zz - xx - yy);
    Y[11] = SH_C3[3] * z * (2.0 * zz - 3.0 * xx - 3.0 * yy);
    Y[12] = SH_C3[4] * x * (4.0 * zz - xx - yy);
    Y[13] = SH_C3[5] * z * (xx - yy);
    Y[14] = SH_C3[6] * x * (xx - 3.0 * yy);
    // DC 与 BASE 同精度（half，取自纹素 1）⇒ 这里返回的是**完整颜色（DC + rest）**，
    //   调用方用 `=` 赋值（不是 `+=`）。
    vec3 out3 = SH_C0 * vec3(dcd.x, dcd.y, dce.x) + 0.5;
    for (int j = 0; j < LR_RANK_MAX; ++j) {
        float aj = a[j];
        if (aj == 0.0) { continue; }
        float s0 = 0.0; float s1 = 0.0; float s2 = 0.0;
        for (int k = 1; k <= 15; ++k) {
            float yk = Y[k - 1];
            s0 += yk * lrB(j, 0, k);
            s1 += yk * lrB(j, 1, k);
            s2 += yk * lrB(j, 2, k);
        }
        out3 += aj * vec3(s0, s1, s2);
    }
    return out3;
}
`;

/** [阶段1] 生产遍在低秩臂下的 SH 段落：低秩返回值已是**完整颜色（DC + rest）** ⇒ 用 `=` 覆盖基础色。 */
const LR_SH_BLOCK = /* glsl */ `            color.rgb = lrRestRGB(uint(idx), dir);`;

function buildShCacheFragmentSource(): string {
    const uniformBlock = sliceShaderSource(
        "#if (!defined(SHPASS_PRE) && !defined(SHCACHE_FRAG)) || defined(SHPASS_TF)\nuniform bool u_colorTransformEnabled;",
        "#endif // !SHPASS_PRE || SHPASS_TF（SH / colorTransform 相关声明到此为止）",
    );
    const shFunctions = sliceShaderSource(
        "#if (!defined(SHPASS_PRE) && !defined(SHCACHE_FRAG)) || defined(SHPASS_TF)\nconst float SH_C0",
        "#endif // !SHPASS_PRE || SHPASS_TF（SH 常量 + 两个辅助函数）",
    );
    // [SHCACHE 方案 B 修复 2026-09-30] 采样器声明**整段切出**，不再手写：
    //   顶点模板里 `u_colorTransforms` / `u_colorTransformIndices` 是**无条件声明**（第 292-296 行，
    //   在 `#if (!SHPASS_PRE && !SHCACHE_FRAG) || SHPASS_TF` 块**之外**）。此前这里手写了 3 个采样器、
    //   漏了这两个 ⇒ 桌面 D3D11 第一遍片元着色器直接编译失败：
    //   `ERROR: 0:288: 'u_colorTransformIndices' : undeclared identifier`，离屏 FPS 均值 = 0.0。
    //   这 5 行现在与 BASE **逐字同源** ⇒ 结构上不可能再漏声明。
    const samplerDecls = sliceShaderSource(
        "uniform highp usampler2D u_texture;",
        "uniform highp usampler2D u_colorTransformIndices;",
    );
    // [阶段1 2026-09-30] 低秩臂的源码变体：`lr=1` 时那 3 张 SH 纹理**根本不存在** ⇒
    //   必须把它们的声明整段去掉（否则会走"声明未使用/未绑定 sampler"的路径，污染 P_lr 归因）；
    //   两个辅助函数（`fillSHFromPacked`/`evalSHRGB`）也要去掉（它们引用那些 sampler），
    //   只保留 `SH_C0..SH_C3` 常量供 `lrRestRGB` 使用。
    // [阶段1 修复] 这段声明必须**整段**去掉（含 `#ifdef/#else/#endif`），否则预处理器会因缺少 `#endif`
    //   报 `'if' : unexpected end of file found in conditional block`。用正则（容忍 CRLF）而不是精确字符串：
    //   源码是 CRLF、模板串里是 `\n`，精确匹配会静默失败（实测就是这么炸的）。
    const uniformBlockForArm = LR_ENABLED
        ? uniformBlock.replace(/#ifdef SHFMT_F16[\s\S]*?#endif\r?\n/, "")
        : uniformBlock;
    const shFunctionsForArm = (() => {
        if (!LR_ENABLED) return shFunctions;
        // 截到**第一个函数定义**之前 = 只留常量表，再接低秩 GLSL。
        // ⚠️ 切片本身以 `#if (...)` 开头、以 `#endif` 收尾；从中间截断会**丢掉那个 `#endif`**
        //    ⇒ 预处理器报 `'if' : unexpected end of file found in conditional block`（实测两次踩到：
        //    第一次以为是 CRLF 匹配失败，其实是这里漏了收尾）。必须把 `#endif` 补回去。
        const cut = /\n(?:void|vec3|vec4|float|uint|uvec4|mat4)\s+[A-Za-z_]\w*\s*\(/.exec(shFunctions);
        const constants = cut ? shFunctions.slice(0, cut.index) : shFunctions;
        return constants + "\n#endif\n" + LR_SH_GLSL;
    })();
    return (
        /* glsl */ `#version 300 es
precision highp float;
precision highp int;

` +
        samplerDecls +
        /* glsl */ `
uniform mat4 view;
uniform int u_splatCount;
uniform int u_colorTexWidth;

` +
        uniformBlockForArm +
        "\n" +
        shFunctionsForArm +
        /* glsl */ `

out vec4 fragColor;

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy); // 像素中心 (x+0.5,y+0.5) 截断 ⇒ 整数格 (x,y)
    int idx = p.y * u_colorTexWidth + p.x;
    if (idx >= u_splatCount) { // 超出 N 的片元：不读点数据，写 0
        fragColor = vec4(0.0);
        return;
    }

    // ---- 以下与 BASE 顶点着色器逐行同源（cen/cov → dir → evalSHRGB → colorTransform）----
    uint uidx = uint(idx);
    uvec4 cen = texelFetch(u_texture, ivec2((uidx & 0x3ffu) << 1, uidx >> 10), 0);
    uint transformIndex = texelFetch(u_transformIndices, ivec2(uidx & 0x3ffu, uidx >> 10), 0).x;
    uvec4 cov = texelFetch(u_texture, ivec2(((uidx & 0x3ffu) << 1) | 1u, uidx >> 10), 0);

    vec4 color = vec4(
        (cov.w) & 0xffu,
        (cov.w >> 8) & 0xffu,
        (cov.w >> 16) & 0xffu,
        (cov.w >> 24) & 0xffu
    ) / 255.0;

    if (u_useSH) {
        int shIndex = idx;
        uint degree = 3u;

        if (u_bandIndex[0] >= 0) {
            if (idx <= u_bandIndex[0]) {
                degree = 0u;
            }
            else if (idx <= u_bandIndex[1]) {
                degree = 1u;
                shIndex = idx - (u_bandIndex[0] + 1);
            }
            else if (idx <= u_bandIndex[2]) {
                degree = 2u;
                shIndex = idx - (u_bandIndex[0] + 1);
            }
            else {
                degree = 3u;
                shIndex = idx - (u_bandIndex[0] + 1);
            }
        }

        if (u_maxSHDegree >= 0 && degree > uint(u_maxSHDegree)) {
            degree = uint(u_maxSHDegree);
        }

        if (degree > 0u || u_bandIndex[0] < 0) {
            mat4 transform = mat4(
                texelFetch(u_transforms, ivec2(0, transformIndex), 0),
                texelFetch(u_transforms, ivec2(1, transformIndex), 0),
                texelFetch(u_transforms, ivec2(2, transformIndex), 0),
                texelFetch(u_transforms, ivec2(3, transformIndex), 0)
            );
            vec3 worldPosition = (transform * vec4(uintBitsToFloat(cen.xyz), 1.0)).xyz;
            vec3 cameraPosition = inverse(view)[3].xyz;
            vec3 dir = normalize(worldPosition - cameraPosition);

            // [阶段1 2026-09-30] lr=1 时改为"基础色(=DC 项) + 低秩 rest"（每点 1 次取样，原来是 6 次）；
            //   缺省分支仍输出同一行原文（逐字不变）。注意：模板串里不能出现反引号。
${LR_ENABLED ? LR_SH_BLOCK : "            color.rgb = evalSHRGB(shIndex, degree, dir);"}
        }
    }

    if (u_colorTransformEnabled) {
        uint colorTransformIndex = texelFetch(u_colorTransformIndices, ivec2(uidx & 0x3ffu, uidx >> 10), 0).x;
        mat4 colorTransform = mat4(
            texelFetch(u_colorTransforms, ivec2(0, colorTransformIndex), 0),
            texelFetch(u_colorTransforms, ivec2(1, colorTransformIndex), 0),
            texelFetch(u_colorTransforms, ivec2(2, colorTransformIndex), 0),
            texelFetch(u_colorTransforms, ivec2(3, colorTransformIndex), 0)
        );
        color = colorTransform * color;
    }

    fragColor = color;
}
`
    );
}

/**
 * [SHPASS-PRE 阶段一] 第一遍（TF）program 的顶点源码：与主 pass **共用同一份 `vertexShaderSource`**，
 * 只注入 `SHPASS_TF` 选中那个极小的 `main()` ⇒ `evalSHRGB` / `fillSHFromPacked` 不重复实现，
 * 两遍的"逐 splat 颜色"代码逐行同源（等价性的结构性保证）。
 */
function buildTransformFeedbackVertexSource(): string {
    const defines = ["#define SHPASS_TF 1"];
    if (SHPASS_PRE_PACKF16) defines.push("#define SHPASS_PRE_PACKF16 1");
    return vertexShaderSource.replace("#version 300 es", "#version 300 es\n" + defines.join("\n") + "\n");
}

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
// [SHPASS-PRE 阶段一] 第二遍主 pass（SHPASS_PRE 且**非**第一遍 TF）既不采样 SH、也不做 colorTransform
//   ⇒ 这一整段声明必须**整段排除**：否则会重演 §25 的「未使用 sampler 惩罚」
//   （顶点着色器里多几个未使用的 sampler 就能让缺省路径掉 3×）。
// [SHCACHE] 方案 B 的主 pass 同样不采样 SH、也不做 colorTransform（颜色来自颜色纹理）⇒ 一并整段排除
#if (!defined(SHPASS_PRE) && !defined(SHCACHE_FRAG)) || defined(SHPASS_TF)
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
#endif // !SHPASS_PRE || SHPASS_TF（SH / colorTransform 相关声明到此为止）
uniform mat4 projection, view;
uniform vec2 focal;
uniform vec2 viewport;
// [SHCACHE 方案 B] 第一遍写出的"逐 splat 颜色"纹理（仅该臂声明；缺省与其他臂不受影响）
#ifdef SHCACHE_FRAG
uniform highp sampler2D u_colorTex;
uniform int u_colorTexWidth;
#endif

uniform bool useDepthFade;
uniform float depthFade;

uniform float u_maxSplatSize;
// [FOOT 2026-09-28] 屏幕足迹倍率（URL 参数 foot=K，缺省 1.0 = 原行为）。
// 存在的唯一目的：把「每片元成本」从「每点成本」里分离出来——K 增大 ⇒ 每帧片元总面积按 ≈K² 增长，
// 若离屏排空（ER/SMP）随片元面积线性变化，则归因单位应写成"每片元"而不是"每点"。
uniform float u_footprintScale;

// [SHPASS-PRE 阶段一] SH 常量与两个 SH 辅助函数：**缺省编译**与**第一遍 TF program** 需要；
//   第二遍主 pass（SHPASS_PRE）已完全不需要 SH ⇒ 一并排除（函数体会引用上面那些 sampler）。
#if (!defined(SHPASS_PRE) && !defined(SHCACHE_FRAG)) || defined(SHPASS_TF)
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
#endif // !SHPASS_PRE || SHPASS_TF（SH 常量 + 两个辅助函数）

// =====================================================================================
// [SHPASS-PRE 阶段一] 第一遍（Transform Feedback）：每个 splat 只算 **1 次颜色**
//   本 program 由 #define SHPASS_TF 1 选中（与主 pass 共用同一份源码，因此
//   evalSHRGB / fillSHFromPacked 不重复）；绘制方式 = gl.POINTS + RASTERIZER_DISCARD，
//   一个顶点就是一个 splat。
//   计算内容与主 pass 的「逐 splat 颜色」部分**逐行等价**，行号对应主 pass 原实现。
//   注意：本遍**不做**视锥与 lambda2 < 0 的提前 return —— 那两处只决定「画不画」，
//   提前判定完整保留在第二遍主 pass（语义「整体一起画/一起丢」不变）。
// =====================================================================================
#ifdef SHPASS_TF
in int index; // 逐顶点属性：本例一个顶点 = 一个 splat（属性缓冲与主 pass 的 instance 属性同源）
#ifdef SHPASS_PRE_PACKF16
flat out uvec2 tfColorPacked; // 8 B/splat（2 × packHalf2x16）
#else
out vec4 tfColor;             // 16 B/splat（float32，等价性基准版本）
#endif

void main () {
    // 任何提前返回/异常路径都要写入确定值，避免 TF 缓冲里留下未定义内容被第二遍读到
#ifdef SHPASS_PRE_PACKF16
    tfColorPacked = uvec2(0u, 0u);
#else
    tfColor = vec4(0.0);
#endif

    uvec4 cen = texelFetch(u_texture, ivec2((uint(index) & 0x3ffu) << 1, uint(index) >> 10), 0);              // ← 主 pass L316
    uint transformIndex = texelFetch(u_transformIndices, ivec2(uint(index) & 0x3ffu, uint(index) >> 10), 0).x; // ← L319
    uvec4 cov = texelFetch(u_texture, ivec2(((uint(index) & 0x3ffu) << 1) | 1u, uint(index) >> 10), 0);       // ← L342

    vec4 color = vec4(                                                                                      // ← L379-384
        (cov.w) & 0xffu,
        (cov.w >> 8) & 0xffu,
        (cov.w >> 16) & 0xffu,
        (cov.w >> 24) & 0xffu
    ) / 255.0;

    if (u_useSH) {                                                                                          // ← L386
        int shIndex = index;
        uint degree = 3u;

        if (u_bandIndex[0] >= 0) {                                                                          // ← L390-406
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

        if (u_maxSHDegree >= 0 && degree > uint(u_maxSHDegree)) {                                           // ← L408-410
            degree = uint(u_maxSHDegree);
        }

        if (degree > 0u || u_bandIndex[0] < 0) {                                                            // ← L412
            mat4 transform = mat4(                                                                          // ← L320-325
                texelFetch(u_transforms, ivec2(0, transformIndex), 0),
                texelFetch(u_transforms, ivec2(1, transformIndex), 0),
                texelFetch(u_transforms, ivec2(2, transformIndex), 0),
                texelFetch(u_transforms, ivec2(3, transformIndex), 0)
            );
            vec3 worldPosition = (transform * vec4(uintBitsToFloat(cen.xyz), 1.0)).xyz;                      // ← L413
            vec3 cameraPosition = inverse(view)[3].xyz;                                                      // ← L414
            vec3 dir = normalize(worldPosition - cameraPosition);                                            // ← L415

            color.rgb = evalSHRGB(shIndex, degree, dir);                                                     // ← L417
        }
    }

    if (u_colorTransformEnabled) {                                                                          // ← L368-377 + L421
        uint colorTransformIndex = texelFetch(u_colorTransformIndices, ivec2(uint(index) & 0x3ffu, uint(index) >> 10), 0).x;
        mat4 colorTransform = mat4(
            texelFetch(u_colorTransforms, ivec2(0, colorTransformIndex), 0),
            texelFetch(u_colorTransforms, ivec2(1, colorTransformIndex), 0),
            texelFetch(u_colorTransforms, ivec2(2, colorTransformIndex), 0),
            texelFetch(u_colorTransforms, ivec2(3, colorTransformIndex), 0)
        );
        color = colorTransform * color;
    }

#ifdef SHPASS_PRE_PACKF16
    tfColorPacked = uvec2(packHalf2x16(color.xy), packHalf2x16(color.zw));
#else
    tfColor = color;
#endif
}
#elif defined(SHPASS_PRE)
// [SHPASS-PRE 阶段一] 第二遍主 pass：颜色直接取**第一遍 TF 的实例属性** ⇒ 本分支不采样 SH 纹理、
//   不解包、不 evalSHRGB（那些声明已在上面整段排除，避免 §25 的未使用 sampler 惩罚）。
//   投影/协方差/长轴短轴仍按原样逐顶点计算（阶段一不搬这部分，保持变量单一）。
//   实例属性由 TF buffer 以 interleaved 方式绑定（stride 16 B 或 8 B，divisor = 1）。
in vec2 position; // 角点（逐顶点，无 divisor）
in int index;     // 逐实例（divisor = 1）——cen/cov/selected 仍需按 splat 索引取
#ifndef SHCACHE_FRAG
#ifdef SHPASS_PRE_PACKF16
in uvec2 a_colorPacked; // 实例属性：8 B/splat（2 × packHalf2x16）
#else
in vec4 a_color; // 实例属性：16 B/splat（float32，基准版本）
#endif
#endif

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

    cov2d[0][0] += 0.3;
    cov2d[1][1] += 0.3;

    float mid = (cov2d[0][0] + cov2d[1][1]) / 2.0;
    float radius = length(vec2((cov2d[0][0] - cov2d[1][1]) / 2.0, cov2d[0][1]));
    float lambda1 = mid + radius, lambda2 = mid - radius;

    if (lambda2 < 0.0) return;
    vec2 diagonalVector = normalize(vec2(cov2d[0][1], lambda1 - cov2d[0][0]));
    vec2 majorAxis = min(sqrt(2.0 * lambda1) * u_footprintScale, u_maxSplatSize) * diagonalVector;
    vec2 minorAxis = min(sqrt(2.0 * lambda2) * u_footprintScale, u_maxSplatSize) * vec2(diagonalVector.y, -diagonalVector.x);

    // 颜色来源：[SHCACHE 方案 B] 按**原始 splat 索引** texelFetch 颜色纹理 / TF 实例属性 / 缺省
#ifdef SHCACHE_FRAG
    vColor = texelFetch(u_colorTex, ivec2(index % u_colorTexWidth, index / u_colorTexWidth), 0);
#elif defined(SHPASS_PRE_PACKF16)
    vColor = vec4(unpackHalf2x16(a_colorPacked.x), unpackHalf2x16(a_colorPacked.y));
#else
    vColor = a_color;
#endif

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

#else

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
#endif // SHPASS_TF / SHPASS_PRE / 缺省（三选一）
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

    // ---- [SHPASS-PRE 阶段一] Transform Feedback（只缓存颜色）运行时状态；缺省不生效（`_shPassPre=false`）----
    /** `?shpass=pre|produce|consume` 是否启用 TF：编译期判据 + 运行期能力复查（不支持则置 false）。 */
    private _shPassPre: boolean = SHPASS_TF_ENABLED;
    /** `consume` 臂专用：第一遍是否已经生产过（保证计时窗口内不再生产）。 */
    private _tfProducedOnce = false;
    /** 第一遍 TF program（与主 pass 共用源码 + `#define SHPASS_TF`）。 */
    private _tfProgram: WebGLProgram | null = null;
    private _tfShaders: WebGLShader[] = [];
    private _tf: WebGLTransformFeedback | null = null;
    private _tfBuffer: WebGLBuffer | null = null;
    /** TF buffer 当前容量对应的 splat 数（点数变化 ⇒ 重分配）。 */
    private _tfSplatCount = -1;
    /** 第一遍 program 的 uniform 位置（按名索引，缺省空对象）。 */
    private _tfU: Record<string, WebGLUniformLocation | null> = {};
    /** 第一遍 program 的 `index` 属性位置（-1 = 无）。 */
    private _tfIndexAttr = -1;
    /** 第二遍主 pass 的实例颜色属性位置（`a_color` 或 `a_colorPacked`；-1 = 未启用/不存在）。 */
    private _colorAttr = -1;

    // ---- [SHCACHE 方案 B] `?shcache=frag`：颜色纹理 + 离屏 FBO + 第一遍（片元）program ----
    private _shCache: boolean = SHCACHE_ENABLED;
    /** `&shcachefreeze=1`：跳过前 2 帧后不再重算（固定相机下隔离主 pass 读取成本的诊断臂）。 */
    private _shCacheFrozen = SHCACHE_FREEZE;
    /** 第一遍**已执行**次数：冻结臂用它跳过前 N 帧（不冻结时只自增，无行为影响）。 */
    private _shCacheProduceCount = 0;
    /** [阶段0 2026-09-30] 生效臂标签只发布一次（见 `publishEffectiveArm`）。 */
    private _armPublished = false;
    // ---- [阶段1 2026-09-30] 低秩臂（`?lr=1`）资源：rank 纹理 + 共享基 UBO（仅 LR_ENABLED 时创建）----
    private _lrRankTex: WebGLTexture | null = null;
    private _lrRankW = 0;
    private _lrRankH = 0;
    private _lrBasisUbo: WebGLBuffer | null = null;
    /** UBO 绑定槽（固定 0；主 pass 不用 UBO ⇒ 不冲突）。 */
    private static readonly LR_BASIS_BINDING = 0;

    /**
     * [阶段0 2026-09-30] 把**实际生效**的臂标签与开关回显发布到 `window.__CH7_ARM__`，由 bench 侧写进报告。
     *
     * 为什么不由报告侧按 URL 推断：URL 只是"请求" —— 请求的开关可能因为**不受支持**（无 WebGL2 ⇒ TF 不可用）、
     * **冲突硬失败**（`shcache` × `shfmt=f16`）、或 program 没建成功而**没有生效**。臂标签必须反映
     * "真的跑了什么"。本轮出现过 3 份 `u=` 标 base 实则跑 frag 的错标 ⇒ 从此判臂只看 `arm=`。
     */
    private publishEffectiveArm(): void {
        if (this._armPublished) return;
        this._armPublished = true;
        const shCacheActive = this._shCache && this._shCacheProgram !== null;
        const tfActive = this._shPassPre && this._tfProgram !== null;
        let arm = "base";
        if (SHCACHE_FRAG_REQUESTED) arm = shCacheActive ? (SHCACHE_FREEZE ? "frozen" : "frag") : "frag-failed";
        else if (SHPASS_PARAM === "consume") arm = tfActive ? "tf_consume" : "tf_consume-failed";
        else if (SHPASS_PARAM === "produce") arm = tfActive ? "tf_produce" : "tf_produce-failed";
        else if (SHPASS_PARAM === "pre") arm = tfActive ? "tf_full" : "tf_full-failed";
        if (this._noshRequested) arm += "+nosh";
        const switches = [
            `shcache=${SHCACHE_FRAG_REQUESTED ? SHCACHE_PARAM : "-"}`,
            `shfreeze=${SHCACHE_FREEZE ? SHFREEZE_FRAMES : 0}`,
            `shpass=${SHPASS_PARAM || "-"}`,
            `nosh=${this._noshRequested ? 1 : 0}`,
            `noct=${this._noctRequested ? 1 : 0}`,
            `shdeg=${this._maxSHDegree}`,
            `shfmt=${this._shF16 ? (SHFMT_F16_INCR ? "f16_incr" : "f16") : "-"}`,
            `shprobe=${this._shFixedCoordProbe ? "fixedcoord" : "-"}`,
            `webgl2=${typeof WebGL2RenderingContext !== "undefined" ? 1 : 0}`,
        ].join("|");
        (window as unknown as { __CH7_ARM__?: { arm: string; switches: string } }).__CH7_ARM__ = {
            arm,
            switches,
        };
    }
    private _colorTex: WebGLTexture | null = null;
    private _colorFbo: WebGLFramebuffer | null = null;
    private _shCacheProgram: WebGLProgram | null = null;
    private _shCacheShaders: WebGLShader[] = [];
    private _shCacheWidth = 0;
    private _shCacheHeight = 0;
    private _shCacheU: Record<string, WebGLUniformLocation | null> = {};
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

            // ---- [SHCACHE 方案 B] 第一遍（片元）program + 颜色纹理/FBO 对象（`?shcache=frag`）----
            //   纹理与 FBO 的**分配**在 `_render` 里按点数/尺寸变化触发（此处只创建对象与位置缓存）。
            if (this._shCache) {
                // [SHCACHE 方案 B 修复 2026-09-30] 组合冲突一律**硬失败**（静默画错比报错更危险）。
                //   `?shcache=frag` 依赖一个前提：第一遍与主 pass 对**同一批纹理**的声明类型一致、且只有一套第一遍。
                if (SHFMT_F16_ENABLED) {
                    const log =
                        "[shcache=frag] 与 shfmt=f16 组合不受支持：第一遍片元 program 走 packed-half 路径" +
                        "（usampler2D + unpackHalf2x16），而主 pass 会按 sampler2D(RGBA16F) 采样同一批 SH 纹理" +
                        " ⇒ 两遍类型不一致，颜色会**静默出错**。请两者只用其一。";
                    console.error(log);
                    throw new Error(log);
                }
                if (SHPASS_TF_REQUESTED) {
                    const log =
                        "[shcache=frag] 与 shpass=pre|produce|consume 组合不受支持：会出现两套第一遍" +
                        "（TF 生产 + 片元生产）同时运行 ⇒ 计时被叠加、归因失效，且二者产物不同。" +
                        "请两者只用其一。";
                    console.error(log);
                    throw new Error(log);
                }
                const vs = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
                gl.shaderSource(vs, shCacheFullscreenVertexSource);
                gl.compileShader(vs);
                const fs = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
                gl.shaderSource(fs, buildShCacheFragmentSourceForArm());
                gl.compileShader(fs);
                if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
                    const log = "第一遍顶点着色器编译失败：" + gl.getShaderInfoLog(vs);
                    console.error("[shcache=frag] " + log);
                    throw new Error("[shcache=frag] " + log);
                }
                if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
                    const log = "第一遍片元着色器编译失败：" + gl.getShaderInfoLog(fs);
                    console.error("[shcache=frag] " + log);
                    throw new Error("[shcache=frag] " + log);
                }
                const prog = gl.createProgram() as WebGLProgram;
                gl.attachShader(prog, vs);
                gl.attachShader(prog, fs);
                gl.linkProgram(prog);
                if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                    const log = "第一遍 program 链接失败：" + gl.getProgramInfoLog(prog);
                    console.error("[shcache=frag] " + log);
                    throw new Error("[shcache=frag] " + log);
                }
                this._shCacheProgram = prog;
                this._shCacheShaders = [vs, fs];
                this._colorTex = gl.createTexture() as WebGLTexture;
                this._colorFbo = gl.createFramebuffer() as WebGLFramebuffer;
                gl.useProgram(prog);
                // 采样器单元与主 pass 完全一致（0..7）⇒ pass 之间无需重绑纹理
                const units: Array<[string, number]> = [
                    ["u_texture", 0],
                    ["u_transforms", 1],
                    ["u_transformIndices", 2],
                    ["u_colorTransforms", 3],
                    ["u_colorTransformIndices", 4],
                    ["u_sh_r", 5],
                    ["u_sh_g", 6],
                    ["u_sh_b", 7],
                ];
                for (const [name, unit] of units) {
                    const loc = gl.getUniformLocation(prog, name);
                    this._shCacheU[name] = loc;
                    gl.uniform1i(loc, unit);
                }
                for (const name of [
                    "view",
                    "u_splatCount",
                    "u_colorTexWidth",
                    "u_useSH",
                    "u_maxSHDegree",
                    "u_shFixedCoord",
                    "u_bandIndex",
                    "u_colorTransformEnabled",
                ]) {
                    this._shCacheU[name] = gl.getUniformLocation(prog, name);
                }
                // ---- [阶段1 2026-09-30] `lr=1`：低秩臂的资源（rank 纹理 + 共享基 UBO）----
                if (LR_ENABLED) {
                    // 组合冲突：与 `shfmt=f16`（SH 纹理类型不同、且 lr 下不建 SH 纹理）或 TF 各臂同时用会语义混乱
                    if (SHFMT_F16_ENABLED || SHPASS_TF_REQUESTED) {
                        throw new Error(
                            "[lr=1] 与 shfmt=f16 / shpass=* 组合不受支持（低秩臂不建 SH 纹理）；请只用其一。",
                        );
                    }
                    this._lrRankTex = gl.createTexture() as WebGLTexture;
                    this._lrBasisUbo = gl.createBuffer() as WebGLBuffer;
                    const blockIndex = gl.getUniformBlockIndex(prog, "LrBasisBlock");
                    if (blockIndex === gl.INVALID_INDEX) {
                        const log = "[lr=1] 生产遍里没有 LrBasisBlock uniform block（着色器未编成低秩臂）";
                        console.error(log);
                        throw new Error(log);
                    }
                    // UBO 槽位固定 0：主 pass 不用 UBO ⇒ 无冲突；prog = 第一遍（生产遍）program
                    gl.uniformBlockBinding(prog, blockIndex, RenderProgram.LR_BASIS_BINDING);
                    gl.useProgram(prog);
                    const lrRankLoc = gl.getUniformLocation(prog, "u_lrRank");
                    this._shCacheU["lrRank"] = lrRankLoc;
                    this._shCacheU["u_lrW"] = gl.getUniformLocation(prog, "u_lrW");
                    gl.uniform1i(lrRankLoc, 9); // 单元 9（8 已被颜色纹理占用；5/6/7 是 SH 单元，lr 下不用）
                }
                // 主 pass 的两个 uniform 位置（缓存，避免逐帧 getUniformLocation 影响计时）
                this._shCacheU["colorTex"] = gl.getUniformLocation(this.program, "u_colorTex");
                this._shCacheU["colorTexWidth"] = gl.getUniformLocation(this.program, "u_colorTexWidth");
                gl.useProgram(this.program);
            }

            // ---- [SHPASS-PRE 阶段一] 第一遍 TF program / TF 对象 / buffer（仅 `?shpass=pre` 且运行期支持 TF）----
            if (this._shPassPre) {
                if (typeof gl.createTransformFeedback !== "function") {
                    // 方案甲：不改造基类做真回退 ⇒ 明确报错 + 停用第一遍（不静默失败）
                    console.error(
                        "[shpass=pre] 本上下文不支持 Transform Feedback（需 WebGL2）⇒ 已停用第一遍；" +
                            "请用不带该参数的页面测缺省路径",
                    );
                    this._shPassPre = false;
                } else {
                    const tfVs = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
                    gl.shaderSource(tfVs, buildTransformFeedbackVertexSource());
                    gl.compileShader(tfVs);
                    if (!gl.getShaderParameter(tfVs, gl.COMPILE_STATUS)) {
                        console.error("[shpass=pre] 第一遍顶点着色器编译失败 :: " + gl.getShaderInfoLog(tfVs));
                        this._shPassPre = false;
                    } else {
                        const tfFs = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
                        gl.shaderSource(tfFs, "#version 300 es\nprecision mediump float;\nvoid main() {}\n");
                        gl.compileShader(tfFs);
                        const prog = gl.createProgram() as WebGLProgram;
                        gl.attachShader(prog, tfVs);
                        gl.attachShader(prog, tfFs);
                        // 必须在 linkProgram **之前**声明捕获的 varying（阶段一只有一个）
                        gl.transformFeedbackVaryings(
                            prog,
                            [SHPASS_PRE_PACKF16 ? "tfColorPacked" : "tfColor"],
                            gl.INTERLEAVED_ATTRIBS,
                        );
                        gl.linkProgram(prog);
                        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                            console.error("[shpass=pre] 第一遍 program 链接失败 :: " + gl.getProgramInfoLog(prog));
                            this._shPassPre = false;
                        } else {
                            this._tfProgram = prog;
                            this._tfShaders = [tfVs, tfFs];
                            this._tf = gl.createTransformFeedback() as WebGLTransformFeedback;
                            this._tfBuffer = gl.createBuffer() as WebGLBuffer;

                            // 采样器单元与主 pass **完全一致**（0..7）⇒ 两遍复用同一批纹理绑定，无需在 pass 间重绑
                            const samplerNames = [
                                "u_texture",
                                "u_transforms",
                                "u_transformIndices",
                                "u_colorTransforms",
                                "u_colorTransformIndices",
                                "u_sh_r",
                                "u_sh_g",
                                "u_sh_b",
                            ];
                            gl.useProgram(prog);
                            for (let i = 0; i < samplerNames.length; i++) {
                                const loc = gl.getUniformLocation(prog, samplerNames[i]);
                                this._tfU[samplerNames[i]] = loc;
                                gl.uniform1i(loc, i);
                            }
                            for (const name of [
                                "view",
                                "u_useSH",
                                "u_maxSHDegree",
                                "u_shFixedCoord",
                                "u_bandIndex",
                                "u_colorTransformEnabled",
                            ]) {
                                this._tfU[name] = gl.getUniformLocation(prog, name);
                            }
                            gl.uniform3iv(this._tfU.u_bandIndex ?? null, new Int32Array([-1, -1, -1]));
                            gl.useProgram(this.program);

                            this._tfIndexAttr = gl.getAttribLocation(prog, "index");
                            if (this._tfIndexAttr >= 0) {
                                gl.enableVertexAttribArray(this._tfIndexAttr);
                            }

                            // 第二遍主 pass 的"实例颜色"属性（只有 pre 变体存在此属性）
                            this._colorAttr = gl.getAttribLocation(
                                this.program,
                                SHPASS_PRE_PACKF16 ? "a_colorPacked" : "a_color",
                            );
                            if (this._colorAttr >= 0) {
                                gl.enableVertexAttribArray(this._colorAttr);
                                gl.vertexAttribDivisor(this._colorAttr, 1);
                            }
                        }
                    }
                }
            }

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

            // [阶段1 2026-09-30] `lr=1`：SH 纹理**根本不存在**（加载期不产出 48-half 打包）⇒
            //   只置 `u_useSH` 与 `u_bandIndex`（生产遍的低秩分支要用），**不**碰那 3 张 SH 纹理。
            //   `u_bandIndex=(-1,-1,-1)`：让生产遍里 `if (degree > 0u || u_bandIndex[0] < 0)` 恒为真。
            if (LR_ENABLED) {
                gl.uniform1i(u_useSH, 1);
                gl.uniform3iv(u_bandIndex, new Int32Array([-1, -1, -1]));
                return;
            }

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

            // [阶段0 2026-09-30] 发布"实际生效"的臂标签（第一帧一次）⇒ 报告里的 `arm=` 不可能与实跑分叉
            this.publishEffectiveArm();

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

            // ---- [SHPASS-PRE 阶段一] 第一遍：TF pass（每 splat 一个顶点；POINTS + RASTERIZER_DISCARD）----
            //   输入：**已经排好序的** index 属性（逐顶点，divisor=0）⇒ 输出顺序 = 主 pass 实例顺序，天然对齐。
            //   输出：每 splat 一个颜色（float32 vec4 = 16 B，或 packHalf2x16 ×2 = 8 B）。
            // ---- [SHCACHE 方案 B] 第一遍：片元 pass 把"逐 splat 颜色"写入 RGBA16F 颜色纹理 ----
            if (this._shCache && this._shCacheProgram && this._colorTex && this._colorFbo) {
                const count = this.renderData.vertexCount;
                const w = 2048;
                const h = Math.max(1, Math.ceil(count / w));
                if (w !== this._shCacheWidth || h !== this._shCacheHeight) {
                    // [SHCACHE 方案 B 修复 2 2026-09-30] **必须在分配/挂载 RGBA16F 之前启用扩展**：
                    //   WebGL2 里 RGBA16F 是"可采样、但默认**不可渲染**"的尺寸格式；若 `EXT_color_buffer_float`
                    //   尚未启用就把该纹理挂成颜色附件，`checkFramebufferStatus` 必得
                    //   `FRAMEBUFFER_INCOMPLETE_ATTACHMENT(0x8CD6)`。桌面 D3D11 首次实测即如此：status=0x8cd6，
                    //   而失败分支里**事后**查询扩展却=1 —— 因为扩展是在那里才被启用的，成了自相矛盾的自证。
                    //   半精度亦可由 `EXT_color_buffer_half_float` 提供；两者皆无 ⇒ 明确失败，**不**静默降精度。
                    const extFloat = gl.getExtension("EXT_color_buffer_float") !== null;
                    const extHalf = gl.getExtension("EXT_color_buffer_half_float") !== null;
                    if (!extFloat && !extHalf) {
                        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
                        const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "(unknown)";
                        throw new Error(
                            "[shcache=frag] 本上下文不支持 RGBA16F 颜色附件（EXT_color_buffer_float 与 " +
                                "EXT_color_buffer_half_float 均不可用）⇒ 停止该臂（不退回 RGBA8，避免颜色语义被改写）" +
                                ` renderer=${renderer}`,
                        );
                    }
                    // 只在点数/尺寸变化时分配（不逐帧重建）
                    this._shCacheWidth = w;
                    this._shCacheHeight = h;
                    gl.bindTexture(gl.TEXTURE_2D, this._colorTex);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
                    const savedFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
                    gl.bindFramebuffer(gl.FRAMEBUFFER, this._colorFbo);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._colorTex, 0);
                    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, savedFbo);
                    if (status !== gl.FRAMEBUFFER_COMPLETE) {
                        // 按约定：**不**退回会改变颜色语义的 RGBA8；报出真实状态与设备信息后停止该臂。
                        //   注：此处 extF/extH 表示"**已成功启用**"（启用发生在挂载之前）⇒ 若仍不完整，
                        //   那就是设备/驱动侧的 16F 附件限制，而非"扩展没启用"。
                        const extF = extFloat ? 1 : 0;
                        const extH = extHalf ? 1 : 0;
                        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
                        const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "(unknown)";
                        throw new Error(
                            `[shcache=frag] RGBA16F 颜色附件 FBO 不完整 :: status=0x${status.toString(16)} ` +
                                `fbo=${w}x${h} count=${count} EXT_color_buffer_float=${extF} ` +
                                `EXT_color_buffer_half_float=${extH} renderer=${renderer}`,
                        );
                    }
                    this._shCacheProduceCount = 0; // 尺寸变化 ⇒ 重新生产
                }
                // [方案B 收口 2026-09-30] 冻结臂改为**跳过前 2 帧再固化**：旧实现首帧即固化，撞上"首帧
                //   纹理/数据尚未就绪（cov=0）"就会把空缓存永久冻住（§30 的 ok=0 即此因）。计数只在冻结臂
                //   生效，不冻结时恒为 true ⇒ FRAG_FULL 路径逐字不变。
                const produceNow = !this._shCacheFrozen || this._shCacheProduceCount++ < SHFREEZE_FRAMES;
                if (produceNow) {
                    const savedFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
                    gl.bindFramebuffer(gl.FRAMEBUFFER, this._colorFbo);
                    gl.viewport(0, 0, this._shCacheWidth, this._shCacheHeight);
                    const blendWas = gl.isEnabled(gl.BLEND);
                    gl.disable(gl.BLEND);
                    gl.useProgram(this._shCacheProgram);
                    // [SHCACHE 方案 B 修复 3 2026-09-30] 第一遍必须**自己**把 SH 纹理绑到单元 5/6/7：
                    //   本 pass 的 `u_sh_r/g/b` 是 `usampler2D`（读 packed RGBA32UI），而 `uploadSphericalHarmonics()`
                    //   只在**数据变化**时绑定一次；此前主 pass 又把 RGBA16F 颜色纹理留在单元 5 ⇒ 从第 2 帧起，
                    //   第一遍每帧采样都会触发 "Mismatch between texture format and sampler type" +
                    //   `GL_INVALID_OPERATION`（桌面实测 124 次 ≈ 预热 20 + 计时 100 帧 ⇒ **每一帧的第一遍 draw 全废**，
                    //   颜色缓存里是残留数据，而 `covered` 只反映几何/alpha ⇒ **看不出这个错**）。
                    //   每帧 3 次幂等 `bindTexture`，开销可忽略。
                    const shBands = this.renderData.sphericalHarmonics;
                    const shActive = !!shBands && !this._noshRequested;
                    if (shActive) {
                        for (let c = 0; c < 3; c++) {
                            gl.activeTexture(gl.TEXTURE5 + c);
                            gl.bindTexture(gl.TEXTURE_2D, this._shTextures[c]);
                        }
                        gl.activeTexture(gl.TEXTURE0);
                    }
                    gl.uniformMatrix4fv(this._shCacheU.view ?? null, false, this._camera.data.viewMatrix.buffer);
                    gl.uniform1i(this._shCacheU.u_splatCount ?? null, count);
                    gl.uniform1i(this._shCacheU.u_colorTexWidth ?? null, this._shCacheWidth);
                    gl.uniform1i(
                        this._shCacheU.u_useSH ?? null,
                        this.renderData.sphericalHarmonics && !this._noshRequested ? 1 : 0,
                    );
                    gl.uniform1i(this._shCacheU.u_maxSHDegree ?? null, this._maxSHDegree);
                    gl.uniform1i(this._shCacheU.u_shFixedCoord ?? null, this._shFixedCoordProbe ? 1 : 0);
                    gl.uniform1i(this._shCacheU.u_colorTransformEnabled ?? null, this._noctRequested ? 0 : 1);
                    // [SHCACHE 方案 B 修复 2026-09-30] `u_bandIndex` 必须与主 pass **同一来源**
                    //   （主 pass 在 `uploadSphericalHarmonics()` 里用 `sh.bandsIndices`）。
                    //   此前这里漏设 ⇒ 默认 (0,0,0) 使 band 分支误判为"有分层"（`u_bandIndex[0] >= 0` 为真）
                    //   ⇒ `shIndex` 全部偏移、degree 被压到 1 ⇒ 颜色必错，而且**不报任何错**（比编译失败更危险）。
                    //   逐帧取用与主 pass 相同的数组 ⇒ 语义对齐。
                    if (shBands) {
                        gl.uniform3iv(this._shCacheU.u_bandIndex ?? null, shBands.bandsIndices);
                    }
                    // ---- [阶段1 2026-09-30] `lr=1`：上传/绑定 rank 纹理与共享基 UBO（生产遍用）----
                    if (LR_ENABLED && this._lrRankTex && this._lrBasisUbo) {
                        const lr = this.renderData.sphericalHarmonics?.lowRank;
                        if (!lr) {
                            throw new Error(
                                "[lr=1] 低秩载荷缺失（sphericalHarmonics.lowRank）：`lr=1` 必须同时作用于加载阶段" +
                                    "（加载器读的是页面 URL；请确认链接里带 lr=1）",
                            );
                        }
                        if (lr.rank > 7) {
                            throw new Error(`[lr=1] rank=${lr.rank} > LR_RANK_MAX=7：着色器按 7 编译，需提升常量后重编`);
                        }
                        if (this._lrRankW !== lr.width || this._lrRankH !== lr.height) {
                            this._lrRankW = lr.width;
                            this._lrRankH = lr.height;
                            gl.bindTexture(gl.TEXTURE_2D, this._lrRankTex);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                            // 每点 4×uint = 1 纹素 ⇒ loader 产出的扁平 2048 宽布局可直接上传（行尾补 0）
                            gl.texImage2D(
                                gl.TEXTURE_2D,
                                0,
                                gl.RGBA32UI,
                                lr.width,
                                lr.height,
                                0,
                                gl.RGBA_INTEGER,
                                gl.UNSIGNED_INT,
                                lr.packed,
                            );
                            // 共享基 → UBO：**channel-major 重排**（让 Σ_k 连续访问），⌈rank×45/4⌉ 个 vec4 = 1,264 B
                            const vec4Count = Math.ceil((lr.rank * lr.restCount) / 4);
                            const ubo = new Float32Array(vec4Count * 4);
                            for (let j = 0; j < lr.rank; j++) {
                                for (let c = 0; c < 3; c++) {
                                    for (let k = 1; k <= 15; k++) {
                                        const src = j * lr.restCount + (k - 1) * 3 + c;
                                        const dst = j * lr.restCount + c * 15 + (k - 1);
                                        ubo[dst] = lr.basis[src] ?? 0;
                                    }
                                }
                            }
                            gl.bindBuffer(gl.UNIFORM_BUFFER, this._lrBasisUbo);
                            gl.bufferData(gl.UNIFORM_BUFFER, ubo, gl.STATIC_DRAW);
                            gl.bindBuffer(gl.UNIFORM_BUFFER, null);
                        }
                        gl.bindBufferBase(gl.UNIFORM_BUFFER, RenderProgram.LR_BASIS_BINDING, this._lrBasisUbo);
                        gl.activeTexture(gl.TEXTURE9);
                        gl.bindTexture(gl.TEXTURE_2D, this._lrRankTex);
                        gl.activeTexture(gl.TEXTURE0);
                        gl.useProgram(this._shCacheProgram);
                        gl.uniform1i(this._shCacheU["u_lrW"] ?? null, lr.width);
                        // [阶段1 修复3] **不能**在这里切回主 pass 程序：紧跟其后的 `gl.drawArrays` 是**生产遍**的
                        //   绘制（渲染目标 = 颜色 FBO）。若此时绑定的是主 pass 程序，就变成"主 pass 往它自己要
                        //   采样的颜色纹理上画"（feedback loop）⇒ 每帧 `GL_INVALID_OPERATION`、draw 被跳过
                        //   ⇒ 颜色缓存全 0 ⇒ 主 pass alpha=0 ⇒ 画面为空（存活探针 ok=0）。实测 22 次正是这个。
                        //   生产遍结束后由下面的既有 `gl.useProgram(this.program)` 恢复。
                    }
                    gl.drawArrays(gl.TRIANGLES, 0, 3);
                    if (blendWas) gl.enable(gl.BLEND);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, savedFbo);
                    gl.viewport(0, 0, canvas.width, canvas.height);
                    gl.useProgram(this.program);
                }
                // 主 pass 读取颜色：绑到**单元 8**（[SHCACHE 修复 3] 不能用 5/6/7 —— 那是第一遍
                //   `usampler2D` 的 SH 单元，浮点颜色纹理留在那里会造成 sampler/格式不匹配）。
                //   主 pass 的顶点侧采样器共 16 个单元可用 ⇒ 8 安全。
                gl.activeTexture(gl.TEXTURE8);
                gl.bindTexture(gl.TEXTURE_2D, this._colorTex);
                gl.activeTexture(gl.TEXTURE0);
                gl.uniform1i(this._shCacheU.colorTex ?? null, 8);
                gl.uniform1i(this._shCacheU.colorTexWidth ?? null, this._shCacheWidth);
            }

            // [SHPASS] 第一遍执行条件：pre/produce **每帧**；consume **只在首帧**（此后计时窗口内不再生产）
            const runTfPass =
                this._shPassPre &&
                this._tfProgram !== null &&
                this._tf !== null &&
                this._tfBuffer !== null &&
                this.depthIndex.length > 0 &&
                (SHPASS_PRODUCE_EVERY_FRAME || (SHPASS_PRODUCE_ONCE && !this._tfProducedOnce));
            if (runTfPass) {
                this._tfProducedOnce = true;
                const splatCount = this.depthIndex.length;
                const bytesPerSplat = SHPASS_PRE_PACKF16 ? 8 : 16;
                gl.bindBuffer(gl.ARRAY_BUFFER, this._tfBuffer);
                if (this._tfSplatCount !== splatCount) {
                    gl.bufferData(gl.ARRAY_BUFFER, splatCount * bytesPerSplat, gl.DYNAMIC_COPY);
                    this._tfSplatCount = splatCount;
                }
                // ⚠️ 关键：必须先把 ARRAY_BUFFER 解绑，再把它挂成 TF 写入目标。
                //   同一个 buffer 同时挂在"TF 写入目标"与"非 TF 目标（ARRAY_BUFFER）"上时，
                //   TF 期间的 `glDrawArrays` 会报：
                //     GL_INVALID_OPERATION: A transform feedback buffer that would be written to is also
                //     bound to a non-transform-feedback target, which would cause undefined behavior.
                //   ⇒ 第一遍的写入被整体丢弃 ⇒ 第二遍读到全 0 ⇒ vColor.a=0 ⇒ 画面全空（本文档 §26 同类教训）。
                gl.bindBuffer(gl.ARRAY_BUFFER, null);

                gl.useProgram(this._tfProgram);
                gl.uniformMatrix4fv(this._tfU.view ?? null, false, this._camera.data.viewMatrix.buffer);
                gl.uniform1i(
                    this._tfU.u_useSH ?? null,
                    this.renderData.sphericalHarmonics && !this._noshRequested ? 1 : 0,
                );
                gl.uniform1i(this._tfU.u_maxSHDegree ?? null, this._maxSHDegree);
                gl.uniform1i(this._tfU.u_shFixedCoord ?? null, this._shFixedCoordProbe ? 1 : 0);
                gl.uniform1i(this._tfU.u_colorTransformEnabled ?? null, this._noctRequested ? 0 : 1);

                gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this._tf);
                gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this._tfBuffer);
                gl.enable(gl.RASTERIZER_DISCARD);

                gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffers[activeDepthBuffer]);
                if (this._tfIndexAttr >= 0) {
                    gl.vertexAttribIPointer(this._tfIndexAttr, 1, gl.INT, 0, 0);
                    gl.vertexAttribDivisor(this._tfIndexAttr, 0);
                }

                // ⚠️ TF draw 期间不仅要禁用、还要**把实例颜色属性指离 tfBuffer**：
                //   实测（Edge/ANGLE-D3D11）单靠 `disableVertexAttribArray` 不够 —— 该实现会检查
                //   **已存储的属性指针所引用的 buffer**，只要它等于 TF 写入目标就报
                //   `GL_INVALID_OPERATION: … also bound to a non-transform-feedback target` 并**丢弃整次写入**
                //   ⇒ 第二遍读到全 0 ⇒ alpha=0 ⇒ 画面全空。这里先临时指向 index buffer（非 TF 目标），
                //   TF 结束后由下方第二遍块每帧重新指回 tfBuffer（见"第二遍：TF 输出绑为实例属性"）。
                if (this._colorAttr >= 0) {
                    gl.disableVertexAttribArray(this._colorAttr);
                    gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffers[activeDepthBuffer]);
                    gl.vertexAttribPointer(this._colorAttr, 4, gl.FLOAT, false, 16, 0);
                }
                gl.beginTransformFeedback(gl.POINTS);
                gl.drawArrays(gl.POINTS, 0, splatCount);
                gl.endTransformFeedback();
                if (this._colorAttr >= 0) {
                    gl.enableVertexAttribArray(this._colorAttr); // 恢复 enabled；指针由第二遍重新绑定
                }

                gl.disable(gl.RASTERIZER_DISCARD);
                gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
                gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

                // [SHPASS-PRE 阶段一·自证] 首次执行后**回读** TF buffer 的前 8 字节：
                //   预期是首个 splat 的颜色（例如 R/G/B≈0.5、A≈0.9）；若为全 0 则第一遍确实没写入。
                //   ⚠️ 必须**在解除 TF 绑定之后**读：否则 `getBufferSubData` 会报
                //     `buffer is bound to an indexed transform feedback binding point and some other binding point`
                //     并**读回全 0** ⇒ 把"没写入"与"读不了"混为一谈（上一版就是这样误判的）。
                {
                    const w = window as unknown as { __SHPASS_PRE_PROBED__?: boolean };
                    if (SHTFPROBE_REQUESTED && !w.__SHPASS_PRE_PROBED__) {
                        w.__SHPASS_PRE_PROBED__ = true;
                        const raw = new Uint32Array(2);
                        gl.bindBuffer(gl.ARRAY_BUFFER, this._tfBuffer);
                        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, raw);
                        const asF = new Float32Array(raw.buffer);
                        console.log(
                            "[shpass=pre] TF probe: disableAttr=1 " +
                                `packf16=${SHPASS_PRE_PACKF16 ? 1 : 0} count=${splatCount} ` +
                                `colorAttr=${this._colorAttr} tfIndexAttr=${this._tfIndexAttr} ` +
                                `u32=[0x${raw[0].toString(16)},0x${raw[1].toString(16)}] ` +
                                `f32=[${asF[0]},${asF[1]}]`,
                        );
                        gl.bindBuffer(gl.ARRAY_BUFFER, null);
                    }
                }

                gl.useProgram(this.program);
            }

            gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
            gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, 0, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffers[activeDepthBuffer]);
            gl.vertexAttribIPointer(indexAttribute, 1, gl.INT, 0, 0);
            gl.vertexAttribDivisor(indexAttribute, 1);

            // ---- [SHPASS-PRE 阶段一] 第二遍：TF 输出绑为**实例属性**（divisor=1，interleaved，stride 16/8 B）----
            if (this._shPassPre && this._colorAttr >= 0 && this._tfBuffer) {
                gl.bindBuffer(gl.ARRAY_BUFFER, this._tfBuffer);
                if (SHPASS_PRE_PACKF16) {
                    gl.vertexAttribIPointer(this._colorAttr, 2, gl.UNSIGNED_INT, 8, 0);
                } else {
                    gl.vertexAttribPointer(this._colorAttr, 4, gl.FLOAT, false, 16, 0);
                }
                gl.vertexAttribDivisor(this._colorAttr, 1);
            }

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

            // ---- [SHPASS-PRE 阶段一] 第一遍 TF 资源成对删除（buffer / TF 对象 / program / shader）----
            if (this._tfBuffer) {
                gl.deleteBuffer(this._tfBuffer);
                this._tfBuffer = null;
            }
            if (this._tf) {
                gl.deleteTransformFeedback(this._tf);
                this._tf = null;
            }
            if (this._tfProgram) {
                gl.deleteProgram(this._tfProgram);
                this._tfProgram = null;
            }
            for (const shader of this._tfShaders) {
                gl.deleteShader(shader);
            }
            this._tfShaders = [];
            this._tfSplatCount = -1;

            // ---- [SHCACHE 方案 B] 颜色纹理 / FBO / 第一遍 program 及其 shader 成对删除 ----
            if (this._colorFbo) {
                gl.deleteFramebuffer(this._colorFbo);
                this._colorFbo = null;
            }
            if (this._colorTex) {
                gl.deleteTexture(this._colorTex);
                this._colorTex = null;
            }
            if (this._shCacheProgram) {
                gl.deleteProgram(this._shCacheProgram);
                this._shCacheProgram = null;
            }
            for (const shader of this._shCacheShaders) {
                gl.deleteShader(shader);
            }
            this._shCacheShaders = [];
            this._shCacheProduceCount = 0;

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
        const defines: string[] = [];
        if (SHFMT_F16_ENABLED) {
            defines.push("#define SHFMT_F16 1");
            if (SHFMT_F16_INCR) defines.push("#define SHFMT_F16_INCR 1");
        }
        // [SHPASS-PRE 阶段一] 第二遍主 pass：颜色改由第一遍 TF 输出提供
        //   （对应的 shader 分支已整段排除 SH 声明与辅助函数，避免"未使用 sampler"惩罚）
        if (SHPASS_PRE_ENABLED) {
            defines.push("#define SHPASS_PRE 1");
            if (SHPASS_PRE_PACKF16) defines.push("#define SHPASS_PRE_PACKF16 1");
        }
        // [SHCACHE 方案 B] 复用 SHPASS_PRE 分支的"逐顶点几何/协方差"主体，颜色来源由 SHCACHE_FRAG 分支
        //   切换为 u_colorTex（按原始 splat 索引 texelFetch）⇒ 主 pass 不再取样 SH 纹理、不做 SH 求值。
        if (SHCACHE_ENABLED) {
            defines.push("#define SHPASS_PRE 1", "#define SHCACHE_FRAG 1");
        }
        if (defines.length === 0) return vertexShaderSource;
        return vertexShaderSource.replace("#version 300 es", "#version 300 es\n" + defines.join("\n") + "\n");
    }

    protected _getFragmentSource() {
        return fragmentShaderSource;
    }
}

export { RenderProgram };
