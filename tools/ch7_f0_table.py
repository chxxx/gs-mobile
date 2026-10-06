"""F0.1: 把 ch7 raw 记录汇总成「设备(SoC) × rounds × 臂」总表，并标出可进论文的数字。

规则（与通用约束一致）：
  * `rounds=3` 才可进论文表格；`rounds=1` 只作筛选/定位，禁止与 rounds=3 横向比较；
  * 名称里含 frozen 的只作上限参照（主表禁止跨帧复用）；
  * 同一 (设备, rounds, 臂) 多次测量时列出全部值 + 最大值 + 中位数。

用法（gsplat.js 目录下）：
    python _tmp_ch7probe/f0_table.py                 # 全部
    python _tmp_ch7probe/f0_table.py --device Mali   # 只看某设备（子串匹配 chip/gl_renderer）
    python _tmp_ch7probe/f0_table.py --only-paper    # 只列 rounds=3（可进论文）
"""

import argparse
import glob
import os
import re
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.abspath(os.path.join(HERE, "..", "..", "thesis_project", "data", "ch7_measurements", "raw"))
OUT = os.path.join(os.path.dirname(HERE), "_tmp_ch7probe", "out", "f0_table.md")


def f(txt: str, name: str, default: str = "-") -> str:
    m = re.search(r"^%s=([^\r\n]*)" % re.escape(name), txt, re.M)
    return m.group(1).strip() if m else default


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="")
    ap.add_argument("--only-paper", action="store_true")
    args = ap.parse_args()

    rows = []
    for path in glob.glob(os.path.join(RAW, "*.txt")):
        txt = open(path, encoding="utf-8", errors="replace").read()
        if "[RESULT]" not in txt or "offscreen_fps_mean" not in txt:
            continue
        chip = f(txt, "chip")
        glr = f(txt, "gl_renderer")
        dev = chip if chip != "-" else glr
        if args.device and args.device.lower() not in (chip + " " + glr).lower():
            continue
        try:
            fps = float(f(txt, "offscreen_fps_mean"))
        except ValueError:
            continue
        rows.append(
            {
                "dev": dev,
                "chip": chip,
                "glr": glr,
                "rounds": f(txt, "rounds"),
                "arm": f(txt, "arm"),
                "fps": fps,
                "std": f(txt, "offscreen_fps_std"),
                "u": f(txt, "u"),
                "ts": f(txt, "ts")[:19],
                "sync": f(txt, "sync_ms"),
                "frame": f(txt, "frame_ms"),
                "res": f(txt, "res"),
                "spin": f(txt, "spin"),
                "ua": ("微信/XWEB" if "MicroMessenger" in f(txt, "ua") else "Chrome"),
                "file": os.path.basename(path),
            }
        )
    if not rows:
        print("no records")
        return

    groups = {}
    for r in rows:
        groups.setdefault((r["dev"], r["rounds"], r["arm"]), []).append(r)

    key_order = sorted(groups.keys(), key=lambda k: (k[0], k[1], k[2]))
    lines = []
    lines.append("# F0.1 真机记录总表（自动生成，源：%s）" % RAW)
    lines.append("")
    lines.append("仅 `rounds=3` 可进论文表格；`rounds=1` 只作筛选。名称含 `frozen` = 上限参照，不进主表。")
    lines.append("")
    lines.append("| 设备(SoC) | rounds | 臂 | n | fps 全部值 | fps 中位 | fps 最大 | 可进论文 |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for (dev, rounds, arm) in key_order:
        g = groups[(dev, rounds, arm)]
        vals = [x["fps"] for x in g]
        paper = "✅" if (rounds == "3" and "frozen" not in arm and "-" not in arm) else ("frozen 参照" if "frozen" in arm else "—")
        lines.append(
            "| %s | %s | `%s` | %d | %s | %.1f | %.1f | %s |"
            % (dev, rounds, arm, len(vals), ", ".join("%.1f" % v for v in vals), statistics.median(vals), max(vals), paper)
        )
    lines.append("")
    lines.append("## rounds=3 明细（可进论文的候选）")
    lines.append("")
    lines.append("| ts | 设备 | 臂 | fps | ±std | sync_ms | frame_ms | res | spin | 浏览器 | 文件 |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in sorted([x for x in rows if x["rounds"] == "3"], key=lambda x: x["ts"]):
        lines.append(
            "| %s | %s | `%s` | %.1f | %s | %s | %s | %s | %s | %s | %s |"
            % (r["ts"], r["dev"], r["arm"], r["fps"], r["std"], r["sync"], r["frame"], r["res"], r["spin"], r["ua"], r["file"])
        )
    lines.append("")
    lines.append("## rounds=1 明细（仅筛选用）")
    lines.append("")
    lines.append("| ts | 设备 | 臂 | fps | ±std | res | spin | 浏览器 | 文件 |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for r in sorted([x for x in rows if x["rounds"] == "1"], key=lambda x: x["ts"]):
        lines.append(
            "| %s | %s | `%s` | %.1f | %s | %s | %s | %s | %s |"
            % (r["ts"], r["dev"], r["arm"], r["fps"], r["std"], r["res"], r["spin"], r["ua"], r["file"])
        )
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")
    print("records=%d -> %s" % (len(rows), OUT))
    print("\n".join(lines[:6 + len(key_order)]))


if __name__ == "__main__":
    main()
