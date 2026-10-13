// [PEEK 2026-10-11] 打印若干记录的关键字段（一屏看完）：u / 臂 / fps / ink / cpu / TW / GLS / points / ok / err / 逐轮 fps
// 用法: node ch7_peek.mjs rerun_ 4
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = path.resolve(here, "../../thesis_project/data/ch7_measurements/raw");
const prefix = process.argv[2] || "rerun_";
const n = parseInt(process.argv[3] || "4", 10);

const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".txt"))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.m - b.m)
    .slice(-n);

const g = (t, re) => {
    const r = re.exec(t);
    return r ? (r[1] ?? "").trim() : "-";
};

for (const { f } of files) {
    const t = fs.readFileSync(path.join(dir, f), "utf8");
    const arm = t.includes("benchFlux") || t.includes("__FLUXGS") ? "flux?" : "";
    const isFlux = /decode_def=/.test(t);
    const rounds = [...t.matchAll(/^scene=(\S+)\s+dataset=(\S+)\s+round=(\d+)([^\r\n]*)/gm)].map((m) => {
        const rest = m[4];
        const rfps = /(?:^|\s)fps=([0-9.]+)/.exec(rest);
        const rok = /(?:^|\s)ok=(\d)/.exec(rest);
        return `R${m[3]}:ok=${rok ? rok[1] : "?"},fps=${rfps ? rfps[1] : "-"}`;
    });
    console.log("=".repeat(100));
    console.log(`${f}   arm=${isFlux ? "flux" : "ours"}   size=${t.length}`);
    console.log(`  u=${g(t, /(?:^|\s)u=(\S+)/)}`);
    console.log(`  fps_mean=${g(t, /offscreen_fps_mean=([0-9.]+)/)}  fps_std=${g(t, /offscreen_fps_std=([0-9.]+)/)}  src=${g(t, /offscreen_fps_source=(\S+)/)}`);
    console.log(`  ink=${g(t, /ink_pct=([0-9.]+%)/)}  cpu_ms=${g(t, /cpu_ms=([0-9.]+)/)}  points=${g(t, /(?:^|\s)points=(\d+)/)}  bytes=${g(t, /(?:^|\s)bytes=(\d+)/)}`);
    console.log(`  TW=${g(t, /(TWframe|TWdrain)/)}  BUILD=${g(t, /BUILD\[([^\]]*)\]/)}`);
    console.log(`  driver=${g(t, /(?:^|\s)driver=(\S+)/)}  sync_policy=${g(t, /offscreen_sync_policy=([^|\s]+)/)}  fallback=${g(t, /fallback=(\S+)/)}`);
    console.log(`  top_ok=${/\[RESULT\]/.test(t) ? "RESULT" : "无RESULT"}  err_fields=${[...t.matchAll(/(?:^|\s)(err\w*)=([^\r\n]{0,80})/gm)].map((m) => m[1] + "=" + m[2]).join(" | ") || "-"}`);
    console.log(`  GLS=${g(t, /GLS\[([^\]]*)\]/)}`);
    console.log(`  rounds(${rounds.length}): ${rounds.join("  ")}`);
    // 逐轮完整行（含 frame_ms/sync_ms/cpu_prepare_ms/getError*_ms 等分解）——只看第 1 轮，截断 700 字
    const firstRound = /^scene=\S+[^\r\n]*/m.exec(t);
    if (firstRound) {
        const line = firstRound[0];
        const keep = /(?:^|\s)(frames|warmup|elapsed_ms|sync_ms|sync_frames|frame_ms|frame_mean_ms|fps|cpu_ms|ink_pct|covered|driver|fetch_ms|parse_ms|first_frame_ms|seg_[a-z0-9_]*|sync_p50_ms|sync_p90_ms|gpu_[a-z0-9_]*)=[^\s]*/g;
        console.log(`  r1fields: ${(line.match(keep) || []).join(" ").slice(0, 900)}`);
    }
    const note = /offscreen_note=[^\r\n]*/.exec(t);
    if (note) console.log(`  note=${note[0].slice(0, 700)}`);
    // Flux 臂专属：官方 frameStats 里的 getError 分解（若该记录带）
    const ge = [...t.matchAll(/getError([12])_ms=([0-9.]+)/g)].map((m) => `getError${m[1]}=${m[2]}`);
    if (ge.length) console.log(`  fluxGetError: ${ge.join(" ")}`);
    const cp = /cpu_prepare_ms=([0-9.]+)/.exec(t);
    const dm = /draw_ms=([0-9.]+)/.exec(t);
    const pm = /post_ms=([0-9.]+)/.exec(t);
    if (cp || dm || pm) console.log(`  fluxPhase: cpu_prepare=${cp?.[1] ?? "-"} draw=${dm?.[1] ?? "-"} post=${pm?.[1] ?? "-"}`);
}
