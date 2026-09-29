# -*- coding: utf-8 -*-
"""第 7 章：**pure-clear 探针**的线性拟合（斜率 / 截距 / R²），2026-09-28。

读真机回传里的探针标签 `CLR<W>x<H>:<ms/Mpx/clear>,…`（见 `OffscreenBenchTarget.formatClearProbeTags`），
对每条结果按臂分别做最小二乘 `perMpxPerClear = a + b·mpx` 与 `perClearMs = a + b·mpx`：
  · 斜率 b 的物理含义：**每兆像素增加的清屏成本**（面积项）；
  · 截距 a：与面积无关的固定部分；
  · R²：线性假设的拟合优度 —— 由它判断"面积 vs 清屏耗时是否真的线性"（而不是拿 2-3 个点就断言）。

用法：
    python tools/ch7_clearprobe_fit.py                      # 扫 raw 下全部结果
    python tools/ch7_clearprobe_fit.py --glob "clr*_2026*.txt"
    python tools/ch7_clearprobe_fit.py --glob "clr*_2026*.txt" --field perClear
"""

import argparse
import glob
import io
import os
import re
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
GS_REPO = os.path.dirname(TOOLS_DIR)
PROJECT_ROOT = os.path.dirname(GS_REPO)
RAW_DEFAULT = os.path.join(PROJECT_ROOT, "thesis_project", "data", "ch7_measurements", "raw")

TAG = re.compile(r"CLR((?:\d+x\d+:[0-9.]+,?){1,})CLRrb")


def parse(path):
    t = io.open(path, encoding="utf-8", errors="replace").read()
    m = TAG.search(t)
    if not m:
        return None
    pts = []
    for item in m.group(1).rstrip(",").split(","):
        w, h, v = re.match(r"(\d+)x(\d+):([0-9.]+)", item).groups()
        pts.append((int(w) * int(h) / 1e6, float(v)))
    return {
        "file": os.path.basename(path),
        "u": (re.search(r"u=([^\r\n]+)", t) or [None, "?"])[1].strip(),
        "arm": "flux" if "engine=fluxgs" in t else "ours",
        "mpx": [p[0] for p in pts],
        "perMpx": [p[1] for p in pts],
        "rb": [float(x) for x in re.search(r"CLRrb([0-9,\.]+)", t).group(1).split(",")],
        "band": (re.search(r"BAND(\w+)", t) or [None, "-"])[1],
    }


def fit(xs, ys):
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    if sxx == 0:
        return None
    b = sxy / sxx
    a = my - b * mx
    ss_tot = sum((y - my) ** 2 for y in ys)
    ss_res = sum((y - (a + b * x)) ** 2 for x, y in zip(xs, ys))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    return a, b, r2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=RAW_DEFAULT)
    ap.add_argument("--glob", default="*_2026*.txt")
    ap.add_argument("--field", default="perMpx", choices=("perMpx", "perClear"))
    args = ap.parse_args()

    rows = [r for r in (parse(p) for p in sorted(glob.glob(os.path.join(args.dir, args.glob)))) if r]
    if not rows:
        print("没有找到任何含 `CLR…` 探针标签的结果（链接里需带 ?clearprobe=WxH,…）")
        return
    for arm in ("ours", "flux"):
        sub = [r for r in rows if r["arm"] == arm]
        if not sub:
            continue
        print(f"\n===== {arm}：{len(sub)} 条含探针的结果 =====")
        print("u                              带      逐分辨率 ms/Mpx/次（面积Mpx）")
        for r in sub:
            pairs = "  ".join(f"{m:.3f}Mpx:{v:.3f}" for m, v in zip(r["mpx"], r["perMpx"]))
            print(f"{r['u'][:30]:<30} {r['band']:<8} {pairs}")
        # 合并该臂全部点做一次拟合（每条结果的面积点都可用）
        xs = [m for r in sub for m in r["mpx"]]
        ys = [v for r in sub for v in r["perMpx"]]
        f = fit(xs, ys)
        if f:
            a, b, r2 = f
            print(f"  合并拟合（n={len(xs)} 点）：perMpx/次 = {a:.4f} + {b:.4f}·Mpx   R² = {r2:.4f}")
        for r in sub:
            f1 = fit(r["mpx"], r["perMpx"])
            if f1:
                a, b, r2 = f1
                print(f"  单条拟合 {r['u'][:26]:<26} : a={a:.4f}  b={b:.4f}  R²={r2:.4f}  (n={len(r['mpx'])})")
    print("\n注：`perMpx/次` = 每次 clear（含均摊读回）/ 兆像素；b 即「面积项」斜率，a 为与面积无关的截距。")


if __name__ == "__main__":
    main()
