# -*- coding: utf-8 -*-
"""【状态：可选】从本文臂结果里抽出逐场景视图矩阵 → `gsplat.js/bench-camviews.json`。

> 只有在走 `bench-flux.html?pose=ours`（把本文机位注入 Flux 渲染器）这种实验路径时才需要；
> 正式流程用 `cam=flux`（三方共用 Flux 原视角），不需要本表。

用途：让 Flux-GS 在**与本文臂完全相同的机位**下测帧（`bench-flux.html?...&pose=ours`）。
前提：本文臂运行时带了 `&exportPose=1`（结果 summary 行里才会有 `view=` 字段）。

用法：
    python gsplat.js/tools/make_bench_camviews.py
    python gsplat.js/tools/make_bench_camviews.py --raw-dir <dir> --out gsplat.js/bench-camviews.json
"""
import argparse
import glob
import io
import json
import os
import sys


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def parse_kv(line):
    out = {}
    for token in line.split():
        if "=" in token:
            k, v = token.split("=", 1)
            out[k] = v
    return out


def collect(paths):
    views = {}
    fx = ""
    for path in paths:
        engine = ""
        with io.open(path, encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = raw.strip()
                if line == "[RESULT]":
                    engine = ""
                    continue
                if line.startswith("engine="):
                    engine = line.split("=", 1)[1]
                    continue
                if engine != "gsplat":
                    continue
                if line.startswith("fx=") and not fx:
                    fx = line.split("=", 1)[1]
                if not line.startswith("summary "):
                    continue
                kv = parse_kv(line)
                scene = kv.get("scene", "")
                if not scene or scene.startswith("r3dgs-"):
                    continue  # 只要本文臂
                view = kv.get("view", "")
                parts = [p for p in view.split(",") if p]
                if len(parts) != 16:
                    continue
                try:
                    views[scene] = [float(p) for p in parts]
                except ValueError:
                    continue
    return views, fx


def main():
    root = repo_root()
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="*")
    parser.add_argument("--raw-dir", default=os.path.join(root, "thesis_project", "data", "ch7_measurements", "raw"))
    parser.add_argument("--out", default=os.path.join(root, "gsplat.js", "bench-camviews.json"))
    args = parser.parse_args()

    paths = args.files or sorted(glob.glob(os.path.join(args.raw_dir, "*.txt")))
    if not paths:
        print(f"没有找到结果文本：{args.raw_dir}")
        return 1
    views, fx = collect(paths)
    if not views:
        print("没有解析到 view= 字段：确认本文臂的链接里带了 &exportPose=1 且跑完保存了结果。")
        return 1

    payload = {
        "version": 1,
        "note": (
            "逐场景视图矩阵（16 个数，行主序，布局与 Flux-GS 的 getViewMatrix 及本仓库 gsplat.js 的 "
            "CameraData.viewMatrix 同构）。bench-flux.html 加 &pose=ours 即把该机位注入 Flux-GS 渲染器，"
            "使三个方法在同一机位测帧。换机位档（cam=）或换设备后需重新生成本表。"
        ),
        "focal_px": fx,
        "views": views,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with io.open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    for scene, v in sorted(views.items()):
        print(f"[view] {scene:12s} pos=({v[12]:.3f}, {v[13]:.3f}, {v[14]:.3f})")
    print(f"[out] {args.out}  scenes={len(views)} focal_px={fx or 'default'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
