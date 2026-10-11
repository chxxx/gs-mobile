// [COMPARE 2026-10-11] 三臂对比分析：分数据集（均值/中位/最好/最差）+ reduced 五场景子集的三臂对照。
// 只用"无标记问题"的记录（ch7_table 的同一套判据简化版）。
// 用法: node tools\ch7_compare.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = path.resolve(here, "../../thesis_project/data/ch7_measurements/raw");

const recs = [];
for (const f of fs.readdirSync(dir).filter((x) => x.startsWith("full-") && x.endsWith(".txt")).sort()) {
    const t = fs.readFileSync(path.join(dir, f), "utf8");
    const u = (/u=(\S+)/.exec(t) || [])[1] || "";
    const arm = u.startsWith("A-") ? "ours" : u.startsWith("B-") ? "flux" : u.startsWith("C-") ? "red" : "?";
    const sceneRaw = (/^scene=(\S+)/m.exec(t) || [])[1] || "?";
    const scene = sceneRaw.replace(/^r3dgs-/, ""); // 归一化：reduced 的 id 是 r3dgs-<scene>，比对用纯场景名
    const dataset = (/^scene=\S+ dataset=(\S+)/m.exec(t) || [])[1] || "?";
    const fpsMeanRec = parseFloat((/offscreen_fps_mean=([0-9.]+)/.exec(t) || [])[1] || "NaN");
    const ok = !/ALIGNED-ASSET-MISSING/.test(t) && /GLS\[/.test(t) && (arm !== "red" || /aligned_pose_ok=1/.test(t));
    const rounds = [...t.matchAll(/^scene=\S+ dataset=\S+ round=\d+[^\r\n]*?\bfps=([0-9.]+)/gm)].map((m) => +m[1]);
    const ink = parseFloat((/ink_pct=([0-9.]+)/.exec(t.replace(/\n[\s\S]*?\n/, "")) || [])[1] || "NaN");
    const inkAny = parseFloat((/ink_pct=([0-9.]+)/.exec(t) || [])[1] || "NaN");
    const bytes = parseInt((/^scene=\S+[^\r\n]*?\bbytes=(\d+)/m.exec(t) || [])[1] || "0", 10);
    const pts = parseInt((/^scene=\S+[^\r\n]*?\bpoints=(\d+)/m.exec(t) || [])[1] || "0", 10);
    recs.push({ f, arm, scene, sceneRaw, dataset, mean: fpsMeanRec, rounds, ink: Number.isFinite(ink) ? ink : inkAny, bytes, pts, ok });
}

const valid = recs.filter((r) => r.ok && r.arm !== "?" && Number.isFinite(r.mean));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const sd = (a) => (a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - avg(a)) ** 2, 0) / (a.length - 1)) : 0);
const F = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
const stat = (rs) => {
    const means = rs.map((r) => r.mean);
    const rounds = rs.flatMap((r) => r.rounds);
    return {
        n: rs.length,
        mean: avg(means), sd: sd(means), med: med(means),
        bestScene: means.length ? Math.max(...means) : NaN,
        bestRound: rounds.length ? Math.max(...rounds) : NaN,
        worst: means.length ? Math.min(...means) : NaN,
    };
};
const pick = (arm, ds) => valid.filter((r) => r.arm === arm && (ds === "ALL13" || r.dataset === ds));
const pickScenes = (arm, list) => valid.filter((r) => r.arm === arm && list.includes(r.scene));
const RED5 = ["bicycle", "bonsai", "counter", "kitchen", "truck"];
const RED_MIP = ["bicycle", "bonsai", "counter", "kitchen"];

const out = [];
const win = (a, b) => (a > b ? "**本方法**" : b > a ? "**Flux**" : "=");
out.push("# 三臂对比分析（Gen3 / Adreno 750，2026-10-11）");
out.push("");
out.push("> 口径：每条 FPS = `offscreen_fps_mean`（该条 3 轮均值）；**均值/中位数 = 跨场景**统计；");
out.push("> **最好(场景)** = 各场景记录均值中的最大值；**最好(单轮)** = 所有轮次 fps 的最大值；最差 = 场景均值最小值。");
out.push("> 只计入有效记录（本轮 26 条 A/B + 5 条重测 C）。");
out.push("");
out.push("## 表 1 · 本方法 vs Flux-GS（分数据集）");
out.push("");
out.push("| 数据集 | 统计量 | 本方法 | Flux-GS(noge) | 谁更好 |");
out.push("|---|---|---|---|---|");
for (const [ds, label] of [["mip360", "Mip360 (9 场景)"], ["tnt", "T&T (2)"], ["db", "DeepBlending (2)"], ["ALL13", "全部 (13)"]]) {
    const a = stat(pick("ours", ds));
    const b = stat(pick("flux", ds));
    out.push(`| ${label} | **均值 ± SD** | ${F(a.mean)} ± ${F(a.sd)} | ${F(b.mean)} ± ${F(b.sd)} | ${win(a.mean, b.mean)} |`);
    out.push(`| ${label} | 中位数 | ${F(a.med)} | ${F(b.med)} | ${win(a.med, b.med)} |`);
    out.push(`| ${label} | 最好(场景) | ${F(a.bestScene)} | ${F(b.bestScene)} | ${win(a.bestScene, b.bestScene)} |`);
    out.push(`| ${label} | 最好(单轮) | ${F(a.bestRound)} | ${F(b.bestRound)} | ${win(a.bestRound, b.bestRound)} |`);
    out.push(`| ${label} | 最差(场景) | ${F(a.worst)} | ${F(b.worst)} | ${win(a.worst, b.worst)} |`);
    out.push("");
}
out.push("## 表 2 · reduced-3DGS 五场景：逐场景三臂对照");
out.push("");
out.push("| 场景 | 数据集 | 本方法 均值 | 本方法 中位 | Flux 均值 | Flux 中位 | reduced 均值 | reduced 中位 | reduced ink% | 本方法 ink% |");
out.push("|---|---|---|---|---|---|---|---|---|---|");
for (const sc of RED5) {
    const a = pickScenes("ours", [sc])[0];
    const b = pickScenes("flux", [sc])[0];
    const c = pickScenes("red", [sc])[0];
    out.push(
        `| ${sc} | ${a?.dataset ?? c?.dataset ?? "?"} | ${F(a?.mean)} | ${F(med(a?.rounds ?? []))} | ${F(b?.mean)} | ${F(med(b?.rounds ?? []))} | ${F(c?.mean)} | ${F(med(c?.rounds ?? []))} | ${F(c?.ink)} | ${F(a?.ink)} |`,
    );
}
out.push("");
out.push("## 表 3 · reduced 五场景子集：三臂聚合（同样只吃这 5 个场景，才可比）");
out.push("");
out.push("| 子集 | 统计量 | 本方法 | Flux-GS(noge) | reduced-3DGS | 谁更好 |");
out.push("|---|---|---|---|---|---|");
const best3 = (x, y, z) => {
    const m = Math.max(x, y, z);
    return [x, y, z].filter((v) => v === m).map((v) => (v === x ? "**本方法**" : v === y ? "**Flux**" : "**reduced**")).join(" / ");
};
for (const [label, list] of [["Mip360 四场景（bicycle/bonsai/counter/kitchen）", RED_MIP], ["T&T 一场景（truck）", ["truck"]], ["全部五场景", RED5]]) {
    const A = stat(pickScenes("ours", list));
    const B = stat(pickScenes("flux", list));
    const C = stat(pickScenes("red", list));
    out.push(`| ${label} | **均值 ± SD** | ${F(A.mean)} ± ${F(A.sd)} | ${F(B.mean)} ± ${F(B.sd)} | ${F(C.mean)} ± ${F(C.sd)} | ${best3(A.mean, B.mean, C.mean)} |`);
    out.push(`| ${label} | 中位数 | ${F(A.med)} | ${F(B.med)} | ${F(C.med)} | ${best3(A.med, B.med, C.med)} |`);
    out.push(`| ${label} | 最好(场景) | ${F(A.bestScene)} | ${F(B.bestScene)} | ${F(C.bestScene)} | ${best3(A.bestScene, B.bestScene, C.bestScene)} |`);
    out.push(`| ${label} | 最好(单轮) | ${F(A.bestRound)} | ${F(B.bestRound)} | ${F(C.bestRound)} | ${best3(A.bestRound, B.bestRound, C.bestRound)} |`);
    out.push("");
}
out.push("### 覆盖度披露（必须写进表注）");
for (const arm of ["ours", "flux", "red"]) {
    const rs = valid.filter((r) => r.arm === arm && RED5.includes(r.scene));
    out.push(`- ${arm === "ours" ? "本方法" : arm === "flux" ? "Flux(noge)" : "reduced"}：ink = ${rs.map((r) => `${r.scene} ${F(r.ink)}%`).join("、")}`);
}
console.log(out.join("\n"));
console.log(`\n[valid] ${valid.length} 条（ours ${valid.filter((r) => r.arm === "ours").length} / flux ${valid.filter((r) => r.arm === "flux").length} / red ${valid.filter((r) => r.arm === "red").length}）`);
