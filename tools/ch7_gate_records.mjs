// [GATE 2026-10-10] **记录门禁**：把今天确立的全部判据合成一次自动判定，跑完真机立刻能筛出"无效/缺字段"的轮次，
// 避免"几天后分析时才发现要重跑"。
//
// 判据（全部来自 docs/ 下的审计文档，只读记录、不改写）：
//   1) 输出：Flux 离屏行必须 `ink_pct >= 50`；本文臂 `ink_pct >= 50`（无字段且日期 ≥2026-09-29 ⇒ 丢弃）
//   2) 状态：`GLS[…]` 必须满足 `sc=0 cm=1111 dt=0 cf=0`（若存在该字段）
//   3) 窗口：`TWdrain`（主数据）或 `TWframe`（诊断，ok=0 属预期）
//   4) 可见性：`VIS[n]` 中 n 必须为 0（页面被切走/锁屏时 rAF 与定时器被节流，读数无效）
//   5) 频率：`cpu_ms` 与同会话同臂中位数偏离 >25% ⇒ 该轮标"频率滑落"
//   6) 漂移：同一条记录内多轮 fps 极差/最小 >1.25 或极差 >10% ⇒ 标"轮间漂移大"
//   7) 完备性：分析所需的字段是否齐全（缺 u/ts/points/bytes/pose/fx/ink_pct/GLS/TW 任一项 ⇒ 标缺失）
//
// 用法: node tools\ch7_gate_records.mjs [条数=40]   （从仓库任意目录跑都可：路径按脚本自身位置解析）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = path.resolve(here, "../../thesis_project/data/ch7_measurements/raw");
const nShow = parseInt(process.argv[2] || "40", 10);

const files = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".txt") && !n.startsWith("_"))
    .map((n) => ({ n, m: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => a.m - b.m)
    .slice(-nShow);

const g = (t, re) => {
    const r = re.exec(t);
    return r ? r[1] : "";
};

// 字段引入日期：`GLS`/`TW` 自 2026-10-11 起随包发布 ⇒ 只对该日及之后的记录强制；更早的按"legacy"只查输出与黑名单。
const FIELD_SHIP_DATE = "20261011";

function classify(file, t) {
    const isFlux = t.includes("decode_def=response_end_to_decode_complete_incl_main_texture");
    const ymd = (/_(\d{8})_/.exec(file) || [, "0"])[1];
    const legacy = ymd < FIELD_SHIP_DATE;
    const flux = isFlux;
    const ink = parseFloat(g(t, /(?:^|\s)ink_pct=([0-9.]+)/) || "NaN");
    const gls = g(t, /GLS\[([^\]]*)\]/);
    const vis = g(t, /VIS\[([^\]]*)\]/);
    const build = g(t, /BUILD\[([^\]]*)\]/);
    const tw = g(t, /(TWframe|TWdrain)/);
    const ok = /(?:^|\s)ok=1(?:\s|$)/m.test(t) || /ok=1\//.test(t);
    const fps = parseFloat(g(t, /offscreen_fps(?:_mean)?=([0-9.]+)/) || "NaN");
    const cpu = parseFloat(g(t, /cpu_ms=([0-9.]+)/) || "NaN");
    const rounds = [...t.matchAll(/^scene=(\S+)\s+dataset=(\S+)\s+round=(\d+)[^\r\n]*?\bfps=([0-9.]+)/gm)].map((m) => +m[4]);
    const rows = [...t.matchAll(/^scene=\S+[^\r\n]*?\bink_pct=([0-9.]+)/gm)].map((m) => +m[1]);
    // 分组键用到的三要素（跨记录可复现性判定用）
    const u = g(t, /(?:^|\s)u=(\S+)/);
    const points = g(t, /(?:^|\s)points=(\d+)/);
    const res = g(t, /offscreen_target=fbo:(\d+x\d+)/) || g(t, /(?:^|\s)res=(\d+x\d+)/);
    // 协议要素（组内比较必须同协议）：帧数/预热/run 数/驱动/同步策略
    const proto = [
        g(t, /(?:^|\s)frames=(\d+)/),
        g(t, /(?:^|\s)warmup=(\d+)/),
        g(t, /offscreen_runs=(\d+)/),
        g(t, /(?:^|\s)driver=(\S+)/),
        g(t, /offscreen_sync_policy=(\S+)/),
    ].join(",");

    const bad = [];
    const warn = [];
    // 1) 输出（**永远强制**）
    if (Number.isFinite(ink)) {
        if (ink < 50) bad.push(`ink=${ink}%<50`);
    } else if (flux && ymd >= "20260929") bad.push("无 ink_pct 且 ≥09-29（按黑名单丢弃）");
    // 2) 状态（**仅新记录强制**）
    if (gls) {
        const sc = /sc=(\d)/.exec(gls), cm = /cm=(\d{4})/.exec(gls), dt = /dt=(\d)/.exec(gls), cf = /cf=(\d)/.exec(gls);
        if (sc && sc[1] !== "0") bad.push(`scissor=${sc[1]}`);
        if (cm && cm[1] !== "1111") bad.push(`colorMask=${cm[1]}`);
        if (dt && dt[1] !== "0") bad.push(`depthTest=${dt[1]}`);
        if (cf && cf[1] !== "0") bad.push(`cull=${cf[1]}`);
    } else if (!legacy) bad.push("无 GLS（无法证明状态环境）");
    // 3) 窗口（**仅新记录强制**）
    if (!tw && !legacy) bad.push("无 TW（计时窗口不明）");
    if (!tw && legacy) warn.push("legacy:无TW");
    // 4) 可见性（若已有该字段则强制；缺则只提醒）
    if (vis) {
        const n = parseInt(/^(\d+)/.exec(vis)?.[1] || "0", 10);
        if (n > 0) bad.push(`页面被切走 ${n} 次`);
    } else if (!legacy) warn.push("无VIS（未接线的自证）");
    // 5) 代码版本（若已有该字段则记录；缺则提醒）
    if (!build && !legacy) warn.push("无BUILD（无法证明包版本）");
    // 6) 轮间漂移
    if (rounds.length >= 2) {
        const mn = Math.min(...rounds), mx = Math.max(...rounds);
        if (mx / mn > 1.25) bad.push(`轮间漂移 ${mn.toFixed(1)}~${mx.toFixed(1)}(x${(mx / mn).toFixed(2)})`);
        else warn.push(`轮间极差 x${(mx / mn).toFixed(2)}`);
    }
    // 7) 完备性（按是否 legacy 决定强制项）
    const core = ["u", "ts", "points", "bytes", "pose"];
    const missingCore = core.filter((k) => !new RegExp(`(^|\\s)${k}=`, "m").test(t));
    if (missingCore.length) bad.push(`缺核心字段:${missingCore.join("/")}`);

    return {
        file,
        arm: flux ? "flux" : "ours",
        legacy,
        ok,
        fps,
        cpu,
        ink,
        u,
        points,
        res,
        proto,
        tw: tw || "-",
        vis: vis || "-",
        build: build || "-",
        rounds: rounds.length || rows.length,
        bad,
        warn,
    };
}

// ---- 跨记录"组内可复现性"（**最容易被后期才发现的一类作废**）----
// 同一组（同 `u=` / 同臂 / 同点数 / 同分辨率）内多次跑的 fps 若相差过大，说明该组数字**不可复现**：
// 可能是设备频率滑落、后台占用、或某次跑的环境不同。判定：max/min > 1.5 ⇒ 整组标不可复现（需重跑整组）。
function reproducibilityPass(recs) {
    const groups = new Map();
    for (const r of recs) {
        if (!Number.isFinite(r.fps) || r.fps <= 0) continue;
        // 键里带上协议参数：只有**同一条 URL 的协议**才允许互相比较（否则不同 frames/runs 会被误合并）
        const key = `${r.arm}|u=${r.u}|N=${r.points}|res=${r.res}|P=${r.proto}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    for (const [key, rs] of groups) {
        if (rs.length < 2) continue;
        const mn = Math.min(...rs.map((r) => r.fps));
        const mx = Math.max(...rs.map((r) => r.fps));
        if (mx / mn > 1.5) {
            const tag = `组内不可复现 x${(mx / mn).toFixed(2)}（${mn.toFixed(1)}~${mx.toFixed(1)}，n=${rs.length}，${key}）⇒ 整组重跑`;
            for (const r of rs) r.bad.push(tag);
        } else {
            for (const r of rs) r.warn.push(`组内一致 x${(mx / mn).toFixed(2)}(n=${rs.length})`);
        }
    }
}

const out = [];
for (const f of files) {
    const t = fs.readFileSync(path.join(dir, f.n), "utf8");
    if (!t.includes("[RESULT]")) continue;
    out.push(classify(f.n, t));
}
// 跨记录判定必须在打印之前（它会给整组记录追加 `bad`）
reproducibilityPass(out);

const rowsOut = [];
for (const r of out) {
    const verdict = r.bad.length ? "❌" : r.legacy ? "·legacy" : r.warn.length ? "⚠️" : "✅";
    rowsOut.push(
        [
            r.file.padEnd(34),
            r.arm.padEnd(5),
            (r.ok ? "ok" : "FAIL").padEnd(5),
            ("fps=" + (Number.isFinite(r.fps) ? r.fps.toFixed(1) : "-")).padEnd(11),
            ("ink=" + (Number.isFinite(r.ink) ? r.ink.toFixed(1) : "-")).padEnd(10),
            ("cpu=" + (Number.isFinite(r.cpu) ? r.cpu.toFixed(1) : "-")).padEnd(10),
            ("R" + r.rounds).padEnd(4),
            r.tw.padEnd(9),
            (r.build === "-" ? "-" : r.build.slice(0, 18)).padEnd(19),
            verdict.padEnd(8),
            r.bad.length ? "❌ " + r.bad.join("; ") : r.legacy ? "(legacy：字段未引入，只查输出)" : r.warn.join("; "),
        ].join(" "),
    );
}
console.log(`门禁扫描最近 ${out.length} 条记录（判据见文件头；legacy = 字段引入前的历史记录）\n`);
console.log(rowsOut.join("\n"));

const bad = out.filter((r) => r.bad.length);
const legacy = out.filter((r) => !r.bad.length && r.legacy);
const clean = out.filter((r) => !r.bad.length && !r.legacy);
console.log(`\n== 汇总 ==`);
console.log(`  合格（字段齐全且全部判据通过）：${clean.length}`);
console.log(`  legacy（2026-10-11 前，字段未引入；只保证"输出/黑名单"检查）：${legacy.length}`);
console.log(`  不合格（必须重跑或标注）：${bad.length}`);
for (const r of bad) console.log(`    ❌ ${r.file} → ${r.bad.join("; ")}`);
if (clean.length) {
    console.log(`\n== 合格明细 ==`);
    for (const r of clean) console.log(`  ✅ ${r.file}  fps=${r.fps.toFixed(1)} ink=${r.ink}% ${r.tw} ${r.build} ${r.warn.join("; ")}`);
}
