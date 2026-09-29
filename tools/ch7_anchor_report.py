# -*- coding: utf-8 -*-
"""第 7 章：**双分辨率锚点**对照报告（2026-09-28）。

用途（回答用户三问）：
  1. `runs>=5` 之后 flux 在 **batch（=论文官方口径）** 下的 CV 是多少；
  2. 两个分辨率锚点（当前 1600x1063 与官方公式推导出的锚点）各自算出的 ours/flux 倍数；
  3. 依据阈值判定"分辨率是否是主导因素"，并给出可否锁定当前单点结果的结论。

数据来源：真机回传的结果原文（`raw/paper_protocol/*.txt` 或 `raw/*.txt`）。
每个文件 = 一次链接运行；文件内 `offscreen_run_fps=` 是**逐 run** FPS 列表 ⇒ 可算 run 内 CV；
同名 `u=` 的多个文件 ⇒ 可算次间 CV。

用法：
    python tools/ch7_anchor_report.py --glob "anchor*_2026*.txt"
    python tools/ch7_anchor_report.py --glob "nat5_2026*.txt" --raw-dir raw
"""

import argparse
import io
import os
import re
import statistics as st
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
GS_REPO = os.path.dirname(TOOLS_DIR)
PROJECT_ROOT = os.path.dirname(GS_REPO)
RAW_DEFAULT = os.path.join(PROJECT_ROOT, "thesis_project", "data", "ch7_measurements", "raw", "paper_protocol")

RATIO_TOLERANCE = 0.30   # 两锚点倍数相差 < 30% ⇒ 分辨率不是主导因素（用户给定口径）
PAPER_ALIGNED_POLICIES = ("batch_submit_drain_at_run_end",)


def grab(text, pat, dflt=""):
    m = re.search(pat, text)
    return m.group(1) if m else dflt


def fnum(text, pat, dflt=float("nan")):
    m = re.search(pat, text)
    if not m:
        return dflt
    try:
        return float(m.group(1))
    except ValueError:
        return dflt


def parse_file(path):
    t = io.open(path, encoding="utf-8", errors="replace").read()
    per_round = t.split("--- per-round ---", 1)[1] if "--- per-round ---" in t else t
    run_list = grab(per_round, r"offscreen_run_fps=([0-9.,\-]+)")
    runs = [float(x) for x in run_list.split(",") if x.strip() and x.strip() != "-"]
    floor = fnum(per_round, r"floor_used_ms=([-0-9.]+)")
    d = {
        "file": os.path.basename(path),
        "engine": grab(t, r"engine=(\w+)"),
        "u": grab(t, r"u=(\S+)"),
        "ok": grab(t, r" ok=(\d)"),
        "res": grab(per_round, r" res=(\d+x\d+)") or grab(t, r"res=(\d+x\d+)"),
        "points": fnum(per_round, r" points=(\d+)"),
        "fps_round": fnum(per_round, r" fps=([-0-9.]+)"),
        "runs_n": fnum(per_round, r"offscreen_runs=(\d+)"),
        "frames_per_run": fnum(per_round, r"offscreen_frames_per_run=(\d+)"),
        "warmup": fnum(per_round, r"offscreen_warmup_frames=(\d+)"),
        "policy": grab(per_round, r"offscreen_sync_policy=([^\s]*)"),
        "driver": grab(per_round, r" driver=(\w+)"),
        "fps_capped": grab(per_round, r"fps_capped=(\d)"),
        "run_fps": runs,
    }
    d["guard_ok"] = not (floor and floor > 0 and d["fps_round"] > 1000.0 / floor)
    return d


def stats(vals):
    vals = [v for v in vals if v == v]
    if not vals:
        return (float("nan"), float("nan"), float("nan"), float("nan"))
    mean = st.mean(vals)
    sd = st.pstdev(vals) if len(vals) > 1 else 0.0
    return (mean, sd, (100.0 * sd / mean if mean else float("nan")),
            (max(vals) / min(vals) if min(vals) else float("nan")))


def main():
    ap = argparse.ArgumentParser(description="双分辨率锚点对照报告")
    ap.add_argument("--raw-dir", default=RAW_DEFAULT)
    ap.add_argument("--glob", default="anchor*_2026*.txt")
    args = ap.parse_args()

    import glob as G

    files = sorted(G.glob(os.path.join(args.raw_dir, args.glob)))
    if not files:
        # 真机回传落在 raw/（中间件 rawDir），而本地跑批落在 raw/paper_protocol/ ⇒ 自动回退一层
        fallback = os.path.dirname(os.path.normpath(args.raw_dir))
        files = sorted(G.glob(os.path.join(fallback, args.glob)))
        if files:
            print("ℹ 在 %s 下未找到，已自动改用 %s" % (args.raw_dir, fallback))
            args.raw_dir = fallback
    if not files:
        print("✗ 没找到匹配文件：%s/%s（也试过其上一级目录）" % (args.raw_dir, args.glob))
        return 2
    rows = [parse_file(f) for f in files]

    print("=" * 118)
    print("逐文件明细（每行 = 一次链接运行）")
    print("=" * 118)
    print("%-26s %-9s %-9s %-6s %-5s %-5s %-5s %-9s %-7s %-7s %-6s %s" % (
        "file", "arm(u)", "res", "driver", "runs", "warm", "ok", "fps(mean)", "runCV%", "max/min", "capped", "policy"))
    print("-" * 118)
    for r in rows:
        if r["run_fps"]:
            mean, _, cv, mm = stats(r["run_fps"])
        else:
            mean, cv, mm = r["fps_round"], 0.0, 1.0
        print("%-26s %-9s %-9s %-6s %-5.0f %-5.0f %-5s %-9.2f %-7.2f %-7.2f %-6s %s" % (
            r["file"][:26], r["u"][:9], r["res"], r["driver"], r["runs_n"], r["warmup"], r["ok"],
            mean, cv, mm, r["fps_capped"] or "-", r["policy"]))

    groups = {}
    for r in rows:
        if r["ok"] != "1":
            continue
        arm = "flux" if r["engine"].lower().startswith("flux") else "ours"
        groups.setdefault((arm, r["res"]), []).append(r)

    print()
    print("=" * 118)
    print("按 (臂, 分辨率) 聚合")
    print("=" * 118)
    print("%-6s %-10s %-4s %-10s %-10s %-9s %-9s %-8s %s" % (
        "arm", "res", "n", "fps(mean)", "run内CV%", "次间CV%", "max/min", "points", "runs x 帧 / 预热"))
    agg = {}
    for (arm, res), rs in sorted(groups.items()):
        file_means = [r["fps_round"] for r in rs if r["fps_round"] == r["fps_round"]]
        run_cv = st.mean([stats(r["run_fps"])[2] for r in rs if r["run_fps"]]) if any(r["run_fps"] for r in rs) else 0.0
        fmean, _, between_cv, _ = stats(file_means)
        _, _, _, mm = stats(file_means)
        agg[(arm, res)] = {"mean": fmean, "n": len(rs)}
        print("%-6s %-10s %-4d %-10.2f %-10.2f %-9.2f %-9.2f %-8.0f %.0f x %.0f / %.0f" % (
            arm, res, len(rs), fmean, run_cv, between_cv, mm, rs[0]["points"],
            rs[0]["runs_n"], rs[0]["frames_per_run"], rs[0]["warmup"]))

    res_list = sorted({res for (_, res) in agg if res})
    if len(res_list) >= 2:
        print()
        print("=" * 118)
        print("★ 锚点对照：各分辨率下 ours/flux 倍数（各臂 fps 均值之比）")
        print("=" * 118)
        ratios = {}
        for res in res_list:
            o, f = agg.get(("ours", res)), agg.get(("flux", res))
            if not o or not f:
                print("%-10s 缺臂：ours=%s flux=%s" % (res, bool(o), bool(f)))
                continue
            ratio = f["mean"] / o["mean"] if o["mean"] else float("nan")
            m = re.match(r"(\d+)x(\d+)", res)
            px = int(m.group(1)) * int(m.group(2)) if m else 0
            ratios[res] = ratio
            print("%-10s px=%-9d ours=%-8.2f flux=%-8.2f  ⇒ flux/ours = %.2fx" % (res, px, o["mean"], f["mean"], ratio))
        if len(ratios) >= 2:
            vals = list(ratios.values())
            lo, hi = min(vals), max(vals)
            spread = (hi - lo) / lo if lo else float("nan")
            print()
            print("倍数区间：%.2fx ~ %.2fx（相差 %.1f%%，阈值 %.0f%%）" % (lo, hi, 100 * spread, 100 * RATIO_TOLERANCE))
            if spread <= RATIO_TOLERANCE:
                print("⇒ 判定：**分辨率不是主导因素**（两锚点倍数接近）⇒ 当前固定分辨率的结果可继续用于论文写作。")
            else:
                print("⇒ 判定：⚠️ **分辨率是主导因素**（相差 > %.0f%%）⇒ 当前任何单点结果都**不能**作为最终结论，"
                      "必须先按官方 downsample 公式定档并重采。" % (100 * RATIO_TOLERANCE))

    print()
    print("=" * 118)
    print("协议合规性核对（论文：offscreen + multiple consecutive runs + short warm-up + average FPS）")
    print("=" * 118)
    bad = 0
    for r in rows:
        if r["ok"] != "1":
            continue
        issues = []
        if not (r["runs_n"] >= 5):
            issues.append("runs=%.0f < 5（违反 multiple runs）" % r["runs_n"])
        if not (r["warmup"] > 0):
            issues.append("warmup=0（论文要求 short warm-up）")
        if not any(p in r["policy"] for p in PAPER_ALIGNED_POLICIES):
            issues.append("policy=%s（非 batch，与论文『脱离屏幕限制』口径不同族）" % r["policy"])
        if not r["guard_ok"]:
            issues.append("量级守卫失败（fps 超过 1000/地板）")
        if issues:
            bad += 1
            print("  ✗ %-26s %s" % (r["file"][:26], "；".join(issues)))
    print("  合规 %d / 不合规 %d（共 %d 个成功文件）" % (len(rows) - bad, bad, len(rows)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

