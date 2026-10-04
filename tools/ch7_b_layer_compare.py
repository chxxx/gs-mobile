"""B 层配对打分：把 raw 里 `u=cg-base-<scene>` 与 `u=cg-final-<scene>` 的无损 PNG 配对，
输出逐场景 PSNR / SSIM / 最大误差 / >8 级像素占比，并写 `docs/ch7_b_layer.md`。

判据：**交付红线 = 对 BASE 的 PSNR ≥ 50 dB 且 >8 级像素计数 = 0**（用户 2026-10-04 明确要求，比代码里
"视觉不可分辨"的 45 dB 更严）。任何场景不满足 ⇒ 表内标红 **STOP**，禁止自行修复，先报告。
本脚本同时给 >4/>8/>16 三档计数与 45 dB 参考列。

用法：python _tmp_ch7probe/b_layer_compare.py
"""

import base64
import glob
import io
import os
import re
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
GS = os.path.abspath(os.path.join(HERE, ".."))
RAW = os.path.abspath(os.path.join(GS, "..", "thesis_project", "data", "ch7_measurements", "raw"))
OUT_MD = os.path.join(GS, "docs", "ch7_b_layer.md")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass


def parse():
    found = {}
    for path in sorted(glob.glob(os.path.join(RAW, "colorgate_*.txt")), key=os.path.getmtime):
        txt = open(path, encoding="utf-8", errors="replace").read()
        m = re.search(r"framedump_png=data:image/png;base64,([A-Za-z0-9+/=]+)", txt)
        if not m:
            continue
        u = re.search(r"^u=([^\r\n]+)", txt, re.M)
        cov = re.search(r"covered=([0-9.]+)%", txt)
        pts = re.search(r"points=(\d+)", txt)
        img = Image.open(io.BytesIO(base64.b64decode(m.group(1)))).convert("RGB")
        found[(u.group(1) if u else os.path.basename(path))] = (
            os.path.basename(path),
            np.asarray(img, dtype=np.float64),
            cov.group(1) if cov else "-",
            pts.group(1) if pts else "-",
        )
    return found


def psnr(a, b):
    mse = float(np.mean((a - b) ** 2))
    return float("inf") if mse == 0 else 10.0 * np.log10(255.0**2 / mse)


def main():
    reps = parse()
    scenes = sorted({k[len("cg-base-"):] for k in reps if k.startswith("cg-base-")})
    final_scenes = {k[len("cg-final-"):] for k in reps if k.startswith("cg-final-")}
    lines = ["# B 层 · 桌面无损闸门（FINAL vs BASE，逐场景）", "",
             "> 口径：`tools/ch7_b_layer_gate.ps1`（桌面 Edge；`res=320x213&res_mode=forced&dpr=1&rounds=1&cold=1`，",
             "> `proto=flux&benchmode=offscreen-paper-match&sync=batch&driver=msgchannel&runs=5&warmup=20&tickevery=16&fences=3`，",
             "> `framedump=1` 整幅**无损 PNG** 回传）；BASE = 全部开关缺省，FINAL = `shcache=frag&lr=1&notx=1&nocolortx=1`。",
             "> 逐像素判据：对 BASE 的 PSNR / 最大级差 / >4、>8、>16 级像素计数；**交付红线 = PSNR ≥ 50 dB 且 >8 级 = 0**。",
             "> 本层是**静态相机、单臂渲染**的逐像素一致性检查（不含计时对比；“同会话 ABAB”属 C 层口径）。",
             "> 每个场景 BASE 与 FINAL 各跑一次、各占独立浏览器 profile，`rounds=1`。",
             "",
             "### 2026-10-04 两处白跑根因与修复（写进方法学，避免误判成“渲染坏了”）",
             "",
             "1. **dev server 未运行** ⇒ 页面是“连接被拒绝”错误页（控制台一行都没有），13 场景全部无 record。",
             "   `/__ch7/report` 只存在于 vite dev server（`vite.config.js`），静态托管/预览页都没有该端点。",
             "2. **窗口被遮挡 ⇒ `requestAnimationFrame` 冻结**：`bench.ts:238 twoFrames()` 需要连续两帧 rAF；",
             "   窗口被其它窗口遮挡时 Chromium 冻结 rAF ⇒ 该 Promise 永不 resolve ⇒ 走不到 `finishBench()` ⇒",
             "   既无 `[RESULT]` 也无 `submitReport`（服务端连一行日志都没有）。修复 = 启动标志增加",
             "   `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling",
             "   --disable-features=CalculateNativeWinOcclusion`（与 `_tmp_ch7probe/cdp.mjs` 同组），并让每轮独占 profile 目录。",
             "3. 旁注：stderr 里 `framedump_png=` 计数**恒为 0 属正常**（0.26 MB base64 的控制台行被 Chromium 截断）；",
             "   落盘判据只有 raw 目录 `colorgate_*.txt` 的**增量**。",
             ""]
    lines += ["| 场景 | 点数(声明) | BASE 文件 | FINAL 文件 | PSNR[RGB] | SSIM | 最大误差(级) | >4 级 | >8 级 | >16 级 | covered | 判定 | ≥45 dB 参考 |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    ok_all = True
    fails = []          # 未过红线的场景（用户要求：停下报告，不自行修复）
    for sc in scenes:
        if sc not in final_scenes:
            lines.append("| %s | 缺 FINAL 记录 | %s | — | — | — | — | — | — | — | — | **未完成** |" % (sc, reps.get("cg-base-" + sc, ("-",))[0]))
            ok_all = False
            continue
        nb, A, covA, pts = reps["cg-base-" + sc]
        nf, B, covB, _ = reps["cg-final-" + sc]
        if A.shape != B.shape:
            lines.append("| %s | %s | %s | %s | 尺寸不一致 %s vs %s | — | — | — | — | — | — | **不可比** |" % (sc, pts, nb, nf, A.shape, B.shape))
            ok_all = False
            continue
        d = np.abs(A - B)
        dm = d.max(axis=2)
        tot = dm.size
        g8 = int(np.count_nonzero(dm > 8))
        p = psnr(A, B)
        try:
            from skimage.metrics import structural_similarity as ssim

            s = float(ssim(A / 255.0, B / 255.0, channel_axis=2, data_range=1.0))
            s_txt = "%.6f" % s
        except ImportError:
            s_txt = "(skipped)"
        ok = (p >= 50.0) and (g8 == 0)          # 交付红线（用户 2026-10-04）：≥50 dB 且 >8 级 = 0
        ok45 = (p >= 45.0) and (g8 == 0)        # 代码内"视觉不可分辨"参考档
        if not ok:
            fails.append("%s: PSNR=%.2f dB, >8 级=%d" % (sc, p, g8))
        ok_all = ok_all and ok
        lines.append("| %s | %s | %s | %s | %.2f dB | %s | %d | %d | **%d** | %d | %s / %s | %s | %s |"
                     % (sc, pts, nb, nf, p, s_txt, int(d.max()),
                        int(np.count_nonzero(dm > 4)), g8, int(np.count_nonzero(dm > 16)),
                        covA, covB, "✅" if ok else "**✗ STOP**",
                        ("✅" if ok45 else "✗")))
    lines += ["", "判据（交付红线）：PSNR ≥ **50 dB** 且 **>8 级像素 = 0**；最后一列为 45 dB 参考档。", ""]
    if fails:
        lines += ["## 红线未过（按用户要求：停下报告，不自行修复）", ""] + ["- **%s**" % f for f in fails] + [""]
    lines += ["整体：%s" % ("全部通过（13/13 场景 ≤ 红线）" if ok_all and scenes else "**有未通过/未完成项，见下**"), ""]
    os.makedirs(os.path.dirname(OUT_MD), exist_ok=True)
    open(OUT_MD, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")
    print("scenes=%d -> %s" % (len(scenes), OUT_MD))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
