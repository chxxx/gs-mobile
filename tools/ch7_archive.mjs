// [ARCHIVE 2026-10-11] 把 Gen3 三臂记录归档为**去 base64 的数值副本**（可 diff / 可复算 / 体积从 294MB 降到 <1MB）。
// 原始记录（含 framedump base64）保留在 raw/ 里不删、不入库。
// 用法: node tools\ch7_archive.mjs [前缀=full-] [归档目录名=archive_20261011]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const raw = path.resolve(here, "../../thesis_project/data/ch7_measurements/raw");
const prefix = process.argv[2] || "full-";
const outName = process.argv[3] || "archive_20261011";
const dest = path.resolve(here, `../../thesis_project/data/ch7_measurements/${outName}/stripped`);

fs.mkdirSync(dest, { recursive: true });
const files = fs.readdirSync(raw).filter((f) => f.startsWith(prefix) && f.endsWith(".txt"));
for (const f of files) {
    const t = fs.readFileSync(path.join(raw, f), "utf8");
    // 只替换 base64 的**内容**，保留字段名与长度信息（可核对抓帧确实存在）
    const stripped = t.replace(/framedump_png=data:image\/png;base64,[A-Za-z0-9+/=]+/g, (m) => {
        const b64 = m.length - "framedump_png=data:image/png;base64,".length;
        return `framedump_png=STRIPPED(base64_chars=${b64}; original_in_raw=${f}; decode: node _tmp_ch7probe/decode_fd.mjs <raw记录> out.png)`;
    });
    fs.writeFileSync(path.join(dest, f), stripped, "utf8");
}
console.log(`archived ${files.length} records -> ${dest}`);
console.log(`total MB = ${(files.reduce((a, f) => a + fs.statSync(path.join(raw, f)).size, 0) / 1048576).toFixed(1)} (raw, 未入库)`);
console.log(`stripped KB = ${(fs.readdirSync(dest).reduce((a, f) => a + fs.statSync(path.join(dest, f)).size, 0) / 1024).toFixed(0)}`);
