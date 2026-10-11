// [SUMMARY 2026-10-11] 把手机回传的 `full-*` 记录汇总成表 + 体检（逐场景逐臂）。
// 用法: node tools\ch7_table.mjs [前缀=full-]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = path.resolve(here, "../../thesis_project/data/ch7_measurements/raw");
const prefix = process.argv[2] || "full-";

const EXPECT = {
    bicycle: 580000, flowers: 530000, garden: 610000, stump: 550000, treehill: 490000,
    room: 220000, counter: 250000, kitchen: 250000, bonsai: 220000,
    truck: 273169, train: 287304, drjohnson: 432000, playroom: 190000,
};
const RED_EXPECT = { bicycle: 2410512, bonsai: 517904, counter: 499049, kitchen: 838257, truck: 854249 };

const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".txt"))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.m - b.m);

const g = (t, re) => {
    const r = re.exec(t);
    return r ? r[1].trim() : "";
};
const med = (a) => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

const rows = [];
const problems = [];
for (const { f } of files) {
    const t = fs.readFileSync(path.join(dir, f), "utf8");
    const u = g(t, /(?:^|\s)u=(\S+)/);
    const armTag = u.split("-")[0];
    const arm = armTag === "A" ? "本方法" : armTag === "B" ? "Flux(noge)" : armTag === "C" ? "reduced" : armTag;
    const renderer = g(t, /gl_renderer=([^\r\n]+)/);
    const dev = /Adreno 7\d\d/.exec(renderer)?.[0] || (/Adreno/.exec(renderer)?.[0] ?? "?");
    const build = g(t, /BUILD\[([^\]]*)\]/);
    const tw = g(t, /(TWframe|TWdrain)/);
    const gls = g(t, /GLS\[(.*?)\](?=BAND|WU|NW|P-|WS|$)/s).replace(/\s+/g, " ");
    const glsBad = !gls ? "无GLS" : /sc=(?!0)\d|cm=(?!1111)\d{4}|dt=(?!0)\d|cf=(?!0)\d/.test(gls) ? "GLS异常" : "";
    const alignOk = g(t, /aligned_pose_ok=(\d)/);
    const sim3s = g(t, /sim3_s=([0-9.]+)/);
    // 记录里由引擎自己算的"轮内均值"（权威值；逐轮 fps 的算术均值应与它一致）
    const fpsMeanField = parseFloat(g(t, /offscreen_fps_mean=([0-9.]+)/) || "NaN");

    const rounds = [...t.matchAll(/^scene=(\S+) dataset=(\S+) round=(\d+)([^\r\n]*)/gm)].map((m) => {
        const rest = m[4];
        const get = (k) => {
            const r = new RegExp(`(?:^|\\s)${k}=([^\\s]+)`).exec(rest);
            return r ? r[1] : "";
        };
        return {
            scene: m[1], dataset: m[2], round: +m[3],
            ok: get("ok") === "1",
            fps: parseFloat(get("fps") || "NaN"),
            first: parseFloat(get("first_frame_ms") || "NaN"),
            fetch: parseFloat(get("fetch_ms") || "NaN"),
            points: parseInt(get("points") || "0", 10),
            bytes: parseInt(get("bytes") || "0", 10),
            ink: parseFloat((get("ink_pct") || "").replace("%", "") || "NaN"),
            covered: parseFloat((get("covered") || "").replace("%", "") || "NaN"),
            cpu: parseFloat(get("cpu_ms") || "NaN"),
        };
    });

    const scene = rounds[0]?.scene ?? "?";
    const okR = rounds.filter((r) => r.ok);
    const fps = okR.map((r) => r.fps).filter((v) => Number.isFinite(v));
    const exp = arm === "reduced" ? RED_EXPECT[scene] : EXPECT[scene];
    const pts = rounds[0]?.points ?? 0;
    const flags = [];
    if (!rounds.length) flags.push("无逐轮行");
    if (okR.length < rounds.length) flags.push(`ok=${okR.length}/${rounds.length}`);
    if (!fps.length) flags.push("无 fps");
    if (glsBad) flags.push(glsBad);
    if (!tw) flags.push("无TW");
    if (!/^bench(-|Flux-)?[A-Za-z0-9_-]*\.js$/.test(build)) flags.push(`BUILD=${build || "缺"}`);
    // 与"当前构建"比对由人工看（哈希每次构建都变）；这里只要求 BUILD 是本站 bundle 名。
    const ink0 = rounds[0]?.ink;
    if (Number.isFinite(ink0) && ink0 < 50) flags.push(`ink=${ink0}%`);
    if (arm !== "Flux(noge)" && exp && pts !== exp) flags.push(`points=${pts}!=${exp}`);
    if (arm === "reduced" && alignOk !== "1") flags.push(`aligned_pose_ok=${alignOk || "缺"}`);
    if (fps.length >= 2 && Math.max(...fps) / Math.min(...fps) > 1.5)
        flags.push(`轮间x${(Math.max(...fps) / Math.min(...fps)).toFixed(2)}`);
    for (const m of t.matchAll(/(?:^|\s)err=([^\r\n]{0,80})/g)) flags.push(`err:${m[1].trim().slice(0, 50)}`);

    rows.push({
        f, arm, dev, scene, dataset: rounds[0]?.dataset ?? "?", n: rounds.length, okN: okR.length,
        fpsMed: med(fps), fpsMin: fps.length ? Math.min(...fps) : NaN, fpsMax: fps.length ? Math.max(...fps) : NaN,
        // 均值口径（用户要求）：优先用记录里的 offscreen_fps_mean（引擎算的轮均值），
        // 缺失时退回逐轮 fps 的算术均值；sd 为轮内标准差（n-1，单轮记 0）。
        fpsMean: Number.isFinite(fpsMeanField)
            ? fpsMeanField
            : fps.length
              ? fps.reduce((a, b) => a + b, 0) / fps.length
              : NaN,
        fpsSd: fps.length > 1
            ? Math.sqrt(fps.reduce((a, b) => a + (b - fps.reduce((x, y) => x + y, 0) / fps.length) ** 2, 0) / (fps.length - 1))
            : 0,
        firstMean: okR.length ? okR.reduce((a, r) => a + (Number.isFinite(r.first) ? r.first : 0), 0) / okR.length : NaN,
        fetchMean: okR.length ? okR.reduce((a, r) => a + (Number.isFinite(r.fetch) ? r.fetch : 0), 0) / okR.length : NaN,
        first: med(okR.map((r) => r.first)), fetch: med(okR.map((r) => r.fetch)),
        cpu: med(okR.map((r) => r.cpu)), ink: ink0, covered: rounds[0]?.covered,
        points: pts, bytes: rounds[0]?.bytes, tw, build, alignOk, sim3s, flags,
    });

    if (flags.length) problems.push({ f, arm, scene, flags });
}

const F = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
const out = [];
out.push(`# 手机全数据集三臂测试 · 结果汇总（${prefix}*，共 ${rows.length} 条记录）`);
out.push("");
out.push("| 臂 | 场景 | 数据集 | 设备 | 轮 ok | **FPS 均值** | FPS±SD(轮内) | FPS 中位 | FPS 极差 | 首帧均值 ms | 下载均值 ms | cpu_ms | ink% | points | bytes | TW | 标记 |");
out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
    out.push(
        `| ${r.arm} | ${r.scene} | ${r.dataset} | ${r.dev} | ${r.okN}/${r.n} | **${F(r.fpsMean)}** | ±${F(r.fpsSd, 2)} | ${F(r.fpsMed)} | ${F(r.fpsMin)}~${F(r.fpsMax)} | ${F(r.firstMean, 0)} | ${F(r.fetchMean, 0)} | ${F(r.cpu, 2)} | ${F(r.ink)} | ${r.points} | ${(r.bytes / 1048576).toFixed(2)}MB | ${r.tw || "-"} | ${r.flags.length ? "❌ " + r.flags.join("; ") : "✅"} |`,
    );
}
out.push("");

// ---- 聚合（**均值口径**；只计入无 ❌ 的记录 ⇒ 5 条作废的 reduced 自动排除）----
const groups = new Map();
const push = (k, r) => {
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
};
for (const r of rows) {
    if (r.flags.length) continue;
    push(`${r.arm}|${r.dataset}`, r);
    push(`${r.arm}|ALL13`, r);
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sdv = (a) => (a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - avg(a)) ** 2, 0) / (a.length - 1)) : 0);
out.push("## 聚合（**均值口径**，只计入 ✅ 记录）");
out.push("");
out.push("| 臂 | 数据集 | 场景数 | **FPS 均值 ± SD** | 首帧均值 ms | 下载均值 ms | 体积均值 MB |");
out.push("|---|---|---|---|---|---|---|");
const order = ["本方法", "Flux(noge)", "reduced"];
for (const arm of order) {
    for (const ds of ["mip360", "tnt", "db", "ALL13"]) {
        const rs = groups.get(`${arm}|${ds}`);
        if (!rs || !rs.length) continue;
        const label = ds === "ALL13" ? "**全部**" : ds;
        out.push(
            `| ${arm} | ${label} | ${rs.length} | **${F(avg(rs.map((r) => r.fpsMean)))} ± ${F(sdv(rs.map((r) => r.fpsMean)), 1)}** | ${F(avg(rs.map((r) => r.firstMean)), 0)} | ${F(avg(rs.map((r) => r.fetchMean)), 0)} | ${(avg(rs.map((r) => r.bytes)) / 1048576).toFixed(2)} |`,
        );
    }
}
out.push("");
out.push("> 口径说明：每条的 FPS 取记录的 `offscreen_fps_mean`（引擎对该条 3 轮取的均值）；数据集一行为**该数据集各场景的均值**；");
out.push("> SD = 跨场景标准差。中位数口径见上表 `FPS 中位` 列（论文若用均值，请以本表为准）。");
out.push("");
out.push(`## 问题清单（${problems.length} 条）`);
if (!problems.length) out.push("- 无：全部记录通过 状态/窗口/输出/点数/包版本 判据");
for (const p of problems) out.push(`- ${p.arm} / ${p.scene}（${p.f}）：${p.flags.join("; ")}`);
console.log(out.join("\n"));
