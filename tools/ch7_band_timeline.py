# -*- coding: utf-8 -*-
"""第 7 章：「快带 / 慢带」诊断用的时间线抽取（2026-09-28）。

背景：ours@1600 在**代码/场景/硬件完全相同**的情况下出现过两档稳态吞吐
（每帧排空 ≈27.7 ms 与 ≈64.6 ms，2.3×）。为了判断这是
  (a) 设备热/降频（会与"距上次运行的间隔 / 先前累计负载"相关），还是
  (b) 随机/其他环境因素（与会话无关地跳变），
需要把**所有**真机结果按时间排成一条线，并给出每条的"每帧排空代理"。

数据来源：真机回传结果原文（默认 `thesis_project/data/ch7_measurements/raw`）。
每条结果里可用的排空代理（优先级从高到低）：
  1. `|lab…ER<ms>…SMP<n>` ⇒ `ER / SMP`（新构建，最准：run 末排空的均摊）
  2. `offscreen_fence_wait_ms / (frames_per_run × runs)` ⇒ 门的自记账均摊
  3. `sync_ms`（= fenceWait / 总帧数，逐轮字段；始终存在）
`--frames` 过滤（只留 `frames=N` 的采集）用于把"30 帧/run 档"与"20 帧/run 档"分开比。

用法：
    python tools/ch7_band_timeline.py
    python tools/ch7_band_timeline.py --frames 20 --arms ours,flux
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


def parse(path):
    t = io.open(path, encoding="utf-8", errors="replace").read()
    lab = grab(t, r"\|labT([0-9.]+)F([0-9.]+)G([0-9.]+)E([0-9.]+)")
    per = t.split("--- per-round ---", 1)[1] if "--- per-round ---" in t else t
    frames = fnum(per, r"offscreen_frames_per_run=(\d+)")
    runs = fnum(per, r"offscreen_runs=(\d+)")
    warm = fnum(per, r"offscreen_warmup_frames=(\d+)")
    # 注意：`offscreen_fps_mean=` 只在**结果头部**；逐轮段里叫 `offscreen_fps=`
    fps = fnum(t, r"offscreen_fps_mean=([0-9.]+)")
    if fps != fps:
        fps = fnum(per, r"offscreen_fps=([0-9.]+)")
    fence = fnum(per, r"offscreen_fence_wait_ms=([0-9.]+)")
    m_er = re.search(r"EW([0-9.]+)ER([0-9.]+)", t)
    ew = float(m_er.group(1)) if m_er else float("nan")
    er_v = float(m_er.group(2)) if m_er else float("nan")
    smp = fnum(t, r"SMP(\d+)")
    tick = fnum(t, r"offscreen_tick_every=(\d+)")
    sync_ms = fnum(per, r"sync_ms=([0-9.]+)")
    total = frames * runs
    # 排空代理（每帧 ms）：优先 ER/SMP，其次 fence/total，最后 sync_ms
    if er_v == er_v and smp == smp and smp > 0:
        drain, src = er_v / smp, "ER/SMP"
    elif fence == fence and total == total and total > 0:
        drain, src = fence / total, "fence/帧"
    else:
        drain, src = sync_ms, "sync_ms"
    ok = grab(per, r" ok=(\d)")
    return {
        "file": os.path.basename(path),
        "ts": grab(t, r"ts=(\d{4}-\d\d-\d\dT[\d:.]+Z)"),
        "engine": grab(t, r"engine=(\w+)"),
        "u": grab(t, r"u=(\S+)"),
        "ok": ok,
        "res": grab(per, r" res=(\d+x\d+)") or grab(t, r"res=(\d+x\d+)"),
        "frames": frames,
        "runs": runs,
        "warm": warm,
        "tick": tick,
        "points": fnum(per, r" points=(\d+)"),
        "fps": fps,
        "drain": drain,
        "src": src,
        "lab": lab,
        "ew": ew,
        "er": er_v,
        "fence": fence,
        "sync_ms": sync_ms,
        "note": grab(t, r"err=([^\r\n]*)"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=RAW_DEFAULT)
    ap.add_argument("--glob", default="*.txt")
    ap.add_argument("--frames", type=int, default=0, help="只保留 frames=N 的采集（0=不过滤）")
    ap.add_argument("--arms", default="ours,flux")
    ap.add_argument("--recent", type=int, default=0, help="只打印最后 N 条（0=全部）")
    args = ap.parse_args()

    rows = []
    for p in glob.glob(os.path.join(args.dir, args.glob)):
        d = parse(p)
        if not d["ts"] or d["ok"] != "1" or d["fps"] != d["fps"]:
            continue
        if args.frames and d["frames"] != args.frames:
            continue
        arm = "flux" if d["engine"] == "fluxgs" else "ours"
        if arm not in args.arms.split(","):
            continue
        d["arm"] = arm
        rows.append(d)
    rows.sort(key=lambda r: r["ts"])
    if args.recent:
        rows = rows[-args.recent :]

    print("时间(UTC)            臂     fps   帧/run runs 排空/帧ms 来源      fences      T?  EW     ER     u")
    prev_ts = None
    for r in rows:
        gap = ""
        if prev_ts:
            hh, mm, ss = (int(x) for x in r["ts"][11:19].split(":"))
            ph, pm, ps = (int(x) for x in prev_ts[11:19].split(":"))
            g = (hh * 3600 + mm * 60 + ss) - (ph * 3600 + pm * 60 + ps)
            gap = f" {g:>4d}s"
        print(
            f"{r['ts'][11:19]}{gap:>7s} {r['arm']:<5s} {r['fps']:>6.1f} {r['frames']:>6.0f} "
            f"{r['runs']:>4.0f} {r['drain']:>9.2f} {r['src']:<9s} {r['fence']:>9.1f} "
            f"{r['lab'] or '-':<4s} {r['ew']:>6.1f} {r['er']:>7.1f} {r['u'][:28]}"
        )
        prev_ts = r["ts"]
    print(f"\n共 {len(rows)} 条（ok=1）。排空/帧 = 每帧等 GPU 的毫秒数（越低越快）。")


if __name__ == "__main__":
    main()
