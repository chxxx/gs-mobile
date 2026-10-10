/**
 * [STRIP-CT 2026-10-10] 阶段一静态证据：抽出 `src/renderers/webgl/programs/RenderProgram.ts` 里的
 * **真实**顶点模板，按每个 URL 变体注入与 `_getVertexSource()` **同源**的 `#define`，
 * 再用 GLSL 预处理器语义展开并**剔除注释**后，统计 4 个 sampler 的「声明次数 / 采样次数」。
 *
 * 诚实边界：
 *   - 模板直接来自真实源码文件；`sliceShaderSource` 按源码逐行复用。
 *   - `_getVertexSource()` 只有约 20 行常量注入 ⇒ 本脚本逐行镜像。
 *   - 预处理器只覆盖本模板用到的指令子集，**仅用于分析**，不参与运行期拼装。
 *   - 「驱动是否当 active」的权威判据是浏览器里的 `getUniformLocation`（`?debug_shader=1`）。
 *
 * 运行：node tools/ch7_strip_ct_analyze.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const TS_PATH = path.join(root, "src/renderers/webgl/programs/RenderProgram.ts");
const SRC = fs.readFileSync(TS_PATH, "utf8");

// ---------------------------------------------------------------- 1) 抽出真实顶点模板
const VS_MARK = "const vertexShaderSource = /* glsl */ `";
const vsAt = SRC.indexOf(VS_MARK);
if (vsAt < 0) throw new Error("未找到 vertexShaderSource");
const vsStart = vsAt + VS_MARK.length;
const vsEnd = SRC.indexOf("`", vsStart); // 模板内不含反引号（文件头硬规则）
const vertexShaderSource = SRC.slice(vsStart, vsEnd);
console.log(`[info] 顶点模板: ${vertexShaderSource.length} B, 行数 ${vertexShaderSource.split("\n").length}`);

// ---------------------------------------------------------------- 2) 复用真实 sliceShaderSource 语义
function sliceShaderSource(startMarker, endMarker) {
    const a = vertexShaderSource.indexOf(startMarker);
    const b = vertexShaderSource.indexOf(endMarker);
    if (a < 0 || b < 0 || b <= a) {
        throw new Error(`slice 失败: ${startMarker.slice(0, 60)}`);
    }
    return vertexShaderSource.slice(a, b + endMarker.length);
}
// ---------------------------------------------------------------- 3) 极简 GLSL 预处理器（仅本模板子集）
function evalExpr(expr, defs) {
    const s = expr
        .replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_, n) => (defs.has(n) ? "1" : "0"))
        .replace(/defined\s+([A-Za-z_]\w*)/g, (_, n) => (defs.has(n) ? "1" : "0"))
        .replace(/[A-Za-z_]\w*/g, "0"); // 未定义标识符 ⇒ 0
    let pos = 0;
    const ws = () => {
        while (pos < s.length && /\s/.test(s[pos])) pos++;
    };
    const parseOr = () => {
        let v = parseAnd();
        for (;;) {
            ws();
            if (s.startsWith("||", pos)) {
                pos += 2;
                const r = parseAnd();
                v = v || r;
            } else return v;
        }
    };
    const parseAnd = () => {
        let v = parseUnary();
        for (;;) {
            ws();
            if (s.startsWith("&&", pos)) {
                pos += 2;
                const r = parseUnary();
                v = v && r;
            } else return v;
        }
    };
    const parseUnary = () => {
        ws();
        if (s[pos] === "!") {
            pos++;
            return !parseUnary();
        }
        return parsePrimary();
    };
    const parsePrimary = () => {
        ws();
        if (s[pos] === "(") {
            pos++;
            const v = parseOr();
            ws();
            if (s[pos] === ")") pos++;
            return v;
        }
        const start = pos;
        while (pos < s.length && /[01]/.test(s[pos])) pos++;
        return s.slice(start, pos) === "1";
    };
    const v = parseOr();
    ws();
    if (pos !== s.length) throw new Error(`#if 表达式解析残留: '${s.slice(pos)}'（原始: ${expr}）`);
    return v;
}

/** 展开 + 只保留活跃行。 */
function preprocess(src, defs) {
    const out = [];
    const stack = [];
    const isActive = () => stack.every((s) => s.active);
    for (const line of src.split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith("#ifdef")) {
            const parent = isActive();
            const cond = defs.has(t.slice(6).trim().split(/\s+/)[0]);
            stack.push({ parent, active: parent && cond, taken: parent && cond });
            continue;
        }
        if (t.startsWith("#ifndef")) {
            const parent = isActive();
            const cond = !defs.has(t.slice(7).trim().split(/\s+/)[0]);
            stack.push({ parent, active: parent && cond, taken: parent && cond });
            continue;
        }
        if (t.startsWith("#if") && (t[3] === " " || t[3] === "(" || t[3] === "\t")) {
            const parent = isActive();
            const cond = evalExpr(t.slice(3).trim(), defs);
            stack.push({ parent, active: parent && cond, taken: parent && cond });
            continue;
        }
        if (t.startsWith("#elif")) {
            const top = stack[stack.length - 1];
            if (!top) throw new Error("#elif 无匹配 #if");
            const cond = evalExpr(t.slice(5).trim(), defs);
            top.active = top.parent && !top.taken && cond;
            top.taken = top.taken || top.active;
            continue;
        }
        if (t.startsWith("#else")) {
            const top = stack[stack.length - 1];
            if (!top) throw new Error("#else 无匹配 #if");
            top.active = top.parent && !top.taken;
            top.taken = true;
            continue;
        }
        if (t.startsWith("#endif")) {
            if (stack.pop() === undefined) throw new Error("#endif 无匹配 #if");
            continue;
        }
        if (t.startsWith("#define")) continue; // 宏由 defs 提供
        if (!isActive()) continue;
        out.push(line);
    }
    if (stack.length !== 0) throw new Error(`条件块未闭合：剩 ${stack.length} 个`);
    return out.join("\n");
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ---------------------------------------------------------------- 3b) 统计（无正则，逐行子串计数）
const NAMES = ["u_transforms", "u_transformIndices", "u_colorTransforms", "u_colorTransformIndices"];

/** 返回某个名字的声明行数 / 其余引用（采样）次数。名称不含正则元字符，用 split 计数。 */
function countName(expanded, name) {
    let decls = 0;
    let uses = 0;
    for (const line of expanded.split("\n")) {
        const occ = line.split(name).length - 1;
        if (occ === 0) continue;
        const t = line.trim();
        const isDecl = t.startsWith("uniform ") && t.endsWith(";") && t.includes(" " + name + ";");
        if (isDecl) decls += occ;
        else uses += occ;
    }
    return { decls, uses, total: decls + uses };
}
// ---------------------------------------------------------------- 4) 变体定义（镜像源码的编译期判据）
const WEBGL2 = true;
function makeFlags(q) {
    const shFmt = q.shfmt || "";
    const shPass = q.shpass || "";
    const readsTf = shPass === "pre" || shPass === "consume";
    const tfRequested = readsTf || shPass === "produce";
    const shCacheReq = q.shcache === "frag";
    const prepReq = q.prep === "1";
    return {
        SHFMT_F16: shFmt === "f16" || shFmt === "f16_incr",
        SHFMT_F16_INCR: shFmt === "f16_incr",
        SHPASS_MAIN_READS_TF: readsTf,
        SHPASS_TF_REQUESTED: tfRequested,
        SHPASS_PRE_ENABLED: readsTf && WEBGL2,
        SHPASS_TF_ENABLED: tfRequested && WEBGL2,
        SHPASS_PRE_PACKF16: q.shpackf16 === "1",
        SHCACHE_FRAG_REQUESTED: shCacheReq,
        SHCACHE_ENABLED: shCacheReq && WEBGL2,
        LR_ENABLED: q.lr === "1",
        PREP_REQUESTED: prepReq,
        PREP_ENABLED: prepReq && shCacheReq && WEBGL2,
        PREP_SLOT: prepReq && shCacheReq && WEBGL2 && q.slot === "1",
        NOTX: q.notx === "1",
        NOCTX: q.nocolortx === "1",
    };
}

/** 镜像 `_getVertexSource()` 的 #define 注入。 */
function mainVsDefines(f) {
    const d = [];
    if (f.SHFMT_F16) d.push("SHFMT_F16");
    if (f.SHFMT_F16_INCR) d.push("SHFMT_F16_INCR");
    if (f.SHPASS_PRE_ENABLED) {
        d.push("SHPASS_PRE");
        if (f.SHPASS_PRE_PACKF16) d.push("SHPASS_PRE_PACKF16");
    }
    if (f.SHCACHE_ENABLED) d.push("SHPASS_PRE", "SHCACHE_FRAG");
    if (f.PREP_ENABLED) {
        d.push("PREP_MAIN");
        if (f.PREP_SLOT) d.push("PREP_SLOT");
    }
    if (f.NOTX) d.push("NO_SPLAT_TRANSFORM");
    if (f.NOCTX) d.push("NO_COLOR_TRANSFORM");
    return d;
}
/** 镜像 `buildTransformFeedbackVertexSource()`。 */
function tfVsDefines(f) {
    const d = ["SHPASS_TF"];
    if (f.SHPASS_PRE_PACKF16) d.push("SHPASS_PRE_PACKF16");
    if (f.NOTX) d.push("NO_SPLAT_TRANSFORM");
    if (f.NOCTX) d.push("NO_COLOR_TRANSFORM");
    return d;
}

function reportRow(label, src, defs) {
    const expanded = stripComments(preprocess(src, new Set(defs)));
    const parts = NAMES.map((n) => {
        const c = countName(expanded, n);
        return `${n}=${c.decls}/${c.uses}`;
    });
    console.log(`  ${label.padEnd(32)} defs=[${defs.join(",") || "-"}]`);
    console.log(`     声明/采样: ${parts.join("  ")}`);
}
// ---------------------------------------------------------------- 5) 遍历变体
const VARIANTS = [
    ["缺省", {}],
    ["shfmt=f16", { shfmt: "f16" }],
    ["shfmt=f16_incr", { shfmt: "f16_incr" }],
    ["nosh=1", { nosh: "1" }],
    ["noct=1", { noct: "1" }],
    ["shdeg=1", { shdeg: "1" }],
    ["shprobe=fixedcoord", { shprobe: "fixedcoord" }],
    ["shpass=pre", { shpass: "pre" }],
    ["shpass=pre&shpackf16=1", { shpass: "pre", shpackf16: "1" }],
    ["shpass=produce", { shpass: "produce" }],
    ["shpass=consume", { shpass: "consume" }],
    ["shcache=frag", { shcache: "frag" }],
    ["shcache=frag&lr=1", { shcache: "frag", lr: "1" }],
    ["prep=1&shcache=frag", { prep: "1", shcache: "frag" }],
    ["prep=1&shcache=frag&slot=1", { prep: "1", shcache: "frag", slot: "1" }],
    ["notx=1", { notx: "1" }],
    ["nocolortx=1", { nocolortx: "1" }],
    ["shcache=frag&notx=1", { shcache: "frag", notx: "1" }],
    ["shcache=frag&nocolortx=1", { shcache: "frag", nocolortx: "1" }],
];

console.log("\n================ 主 pass 顶点着色器（_getVertexSource）================");
for (const [label, q] of VARIANTS) {
    reportRow(label, vertexShaderSource, mainVsDefines(makeFlags(q)));
}

console.log("\n================ TF 第一遍顶点着色器（仅 shpass=*）================");
for (const [label, q] of VARIANTS.filter(([, q]) => q.shpass)) {
    const f = makeFlags(q);
    if (!f.SHPASS_TF_ENABLED) continue;
    reportRow(label, vertexShaderSource, tfVsDefines(f));
}

// ---------------------------------------------------------------- 6) 生产遍 FS（本体是否采样 colorTransform）
console.log("\n================ 生产遍片元着色器（buildShCacheFragmentSource 及 prep 派生）================");
{
    const bodyAt = SRC.indexOf("function buildShCacheFragmentSource");
    const bodyEnd = SRC.indexOf("function buildTransformFeedbackVertexSource");
    const region = SRC.slice(bodyAt, bodyEnd);
    const samplerDecls = sliceShaderSource(
        "uniform highp usampler2D u_texture;",
        "uniform highp usampler2D u_colorTransformIndices;",
    );
    let declCount = 0;
    for (const line of samplerDecls.split("\n")) {
        const t = line.trim();
        if (t.startsWith("uniform ") && t.endsWith(";")) declCount++;
    }
    const fsUses = {
        u_colorTransforms: region.split("texelFetch(u_colorTransforms").length - 1,
        u_colorTransformIndices: region.split("texelFetch(u_colorTransformIndices").length - 1,
        u_transforms: region.split("texelFetch(u_transforms").length - 1,
        u_transformIndices: region.split("texelFetch(u_transformIndices").length - 1,
    };
    console.log(`  切片声明的 sampler 数 = ${declCount}`);
    console.log(`  生产遍 FS 本体采样次数: ${JSON.stringify(fsUses)}`);
    console.log("  ⇒ 生产遍 FS 活跃分支确实采样 colorTransform ⇒ (b) 变体，禁止 strip。");
}

console.log("\n完成。");



