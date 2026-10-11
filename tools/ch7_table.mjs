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
out.push("| 臂 | 场景 | 数据集 | 设备 | 轮 ok | FPS 中位 | FPS 极差 | 首帧中位 ms | 下载中位 ms | cpu_ms | ink% | points | bytes | TW | BUILD | 标记 |");
out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
    out.push(
        `| ${r.arm} | ${r.scene} | ${r.dataset} | ${r.dev} | ${r.okN}/${r.n} | **${F(r.fpsMed)}** | ${F(r.fpsMin)}~${F(r.fpsMax)} | ${F(r.first, 0)} | ${F(r.fetch, 0)} | ${F(r.cpu, 2)} | ${F(r.ink)} | ${r.points} | ${(r.bytes / 1048576).toFixed(2)}MB | ${r.tw || "-"} | ${r.build ? r.build.slice(0, 19) : "-"} | ${r.flags.length ? "❌ " + r.flags.join("; ") : "✅"} |`,
    );
}
out.push("");
out.push(`## 问题清单（${problems.length} 条）`);
if (!problems.length) out.push("- 无：全部记录通过 状态/窗口/输出/点数/包版本 判据");
for (const p of problems) out.push(`- ${p.arm} / ${p.scene}（${p.f}）：${p.flags.join("; ")}`);
console.log(out.join("\n"));
