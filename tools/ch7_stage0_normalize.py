# -*- coding: utf-8 -*-
"""阶段0：Flux 点数（dump 探针**实测**）+ 字节/点归一化 + 口径对照。

数据来源（都不靠估算）：
  · Flux 点数：`_tmp_ch7probe/out/dump_<scene>.json` 里 cdp 捕获的控制台行
    `bench: dumped Flux world positions: N`（由 stage0_dump.ps1 用 harness 的
    `dump=1&profile=<scene>` 单场景探针产出）。**不用网络抓包估算、不解析 json 头**
    —— 二者已被证伪（直开页面会轮播导致计数串场；json 头无可直读点数字段）。
  · Flux 字节：仓库内 `flux-gs-project-gh-pages/scene/<scene>.json` 的**实际文件大小**
    （与 HF 同名文件逐字节一致，已核）。
  · 本文 r7：点数来自 PLY 头实测，字节来自文件大小（B/点 恒为 24）。

用法：python tools/ch7_stage0_normalize.py [--md docs/stage0_size_normalization.md]
产物：_tmp_ch7probe/out/stage0_size_normalization.csv（含确定性校验列）
"""

import argparse
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

GS = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT = os.path.join(GS, "_tmp_ch7probe", "out")
SCENEDIR = os.path.join(GS, "flux-gs-project-gh-pages", "scene")

OURS = {
    "garden": (610000, 14648586), "bicycle": (580000, 13928586), "flowers": (530000, 12728586),
    "stump": (550000, 13208586), "treehill": (490000, 11768586), "room": (220000, 5288586),
    "counter": (250000, 6008586), "kitchen": (250000, 6008586), "bonsai": (220000, 5288586),
    "truck": (273169, 6564642), "train": (287304, 6903882), "drjohnson": (432000, 10376586),
    "playroom": (320000, 7688586),
}
ORDER = ["garden", "bicycle", "flowers", "stump", "treehill", "room", "counter", "kitchen",
         "bonsai", "truck", "train", "drjohnson", "playroom"]


def probe(scene, suffix=""):
    """读探针原始输出里的点数（返回 None 表示该次还没跑/失败）。"""
    p = os.path.join(OUT, "dump_%s%s.json" % (scene, suffix))
    if not os.path.exists(p):
        return None
    txt = open(p, encoding="utf-8", errors="replace").read()
    hits = re.findall(r"dumped Flux world positions: (\d+)", txt) or re.findall(r"dumped=(\d+)", txt)
    return int(hits[-1]) if hits else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--md", default="")
    a = ap.parse_args()
    rows, missing, det_ok, det_bad = [], [], [], []
    for s in ORDER:
        n = probe(s)
        if n is None:
            missing.append(s)
        size = os.path.getsize(os.path.join(SCENEDIR, "%s.json" % s)) if os.path.exists(os.path.join(SCENEDIR, "%s.json" % s)) else 0
        r = probe(s, "_rep")
        if n is not None and r is not None:
            (det_ok if n == r else det_bad).append("%s(%d/%d)" % (s, n, r))
        op, ob = OURS[s]
        rows.append({
            "scene": s, "flux_points": n if n is not None else "", "flux_bytes": size,
            "flux_bpp": ("%.2f" % (size / n)) if n else "",
            "ours_points": op, "ours_bytes": ob, "ours_bpp": "%.2f" % (ob / op),
            "ratio_bytes": ("%.2f" % (ob / size)) if size else "",
            "rep": r if r is not None else "",
        })
    cols = ["scene", "flux_points", "flux_bytes", "flux_bpp", "ours_points", "ours_bytes",
            "ours_bpp", "ratio_bytes", "rep"]
    csv = ",".join(cols) + "\n" + "\n".join(",".join(str(r[c]) for c in cols) for r in rows) + "\n"
    p = os.path.join(OUT, "stage0_size_normalization.csv")
    open(p, "w", encoding="utf-8", newline="\n").write(csv)
    w = [csv, "# 缺点数（探针未完成/失败）：%s" % (", ".join(missing) or "无"),
         "# 确定性校验一致：%s" % (", ".join(det_ok) or "无"),
         "# 确定性校验不一致：%s" % (", ".join(det_bad) or "无")]
    txt = "\n".join(w)
    print(txt)
    if a.md:
        open(a.md, "w", encoding="utf-8", newline="\n").write(txt + "\n")
        print("WROTE " + a.md)


if __name__ == "__main__":
    main()
