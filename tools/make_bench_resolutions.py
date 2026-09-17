# -*- coding: utf-8 -*-
"""从 Flux-GS 臂的实测结果里抽出"逐场景原生画布尺寸"，生成 `bench.js/bench-resolutions.json`。

为什么需要（**已废弃，仅作历史记录**）：早期口径采用 Flux-GS 的自适应画布（由设备视口与文件体积决定，逐场景不同），
本文臂用 `?res=table` 读这张表就能与基线同像素。**2026-09-16 起主表改为"统一像素协议"**
（三臂一律 1600×1063：本文臂/基线臂 `res=1600x1063`、Flux-GS 臂由 `bench-flux.ts` 自动附加 `benchres=1600x1063`），
本脚本与 `bench-resolutions.json` 不再参与正式测帧。

用法：
    python gsplat.js/tools/make_bench_resolutions.py            # 读 thesis_project/data/ch7_measurements/raw/*.txt
    python gsplat.js/tools/make_bench_resolutions.py --raw-dir <dir> --out gsplat.js/bench-resolutions.json
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
    """返回 {scene: (w, h)}，取自 engine=fluxgs 块的 summary 行（res=WxH）。"""
    found = {}
    device = ""
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
                if engine == "fluxgs" and line.startswith("chip=") and not device:
                    device = line.split("=", 1)[1]
                if engine != "fluxgs" or not line.startswith("summary "):
                    continue
                kv = parse_kv(line)
                res = kv.get("res", "")
                if "x" not in res:
                    continue
                w, h = res.split("x")
                try:
                    found[kv["scene"]] = (int(w), int(h))
                except (KeyError, ValueError):
                    continue
    return found, device


def main():
    root = repo_root()
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="*")
    parser.add_argument("--raw-dir", default=os.path.join(root, "thesis_project", "data", "ch7_measurements", "raw"))
    parser.add_argument("--out", default=os.path.join(root, "gsplat.js", "bench-resolutions.json"))
    args = parser.parse_args()

    paths = args.files or sorted(glob.glob(os.path.join(args.raw_dir, "*.txt")))
    if not paths:
        print(f"没有找到结果文本：{args.raw_dir}（先跑 bench-flux.html 并把结果存成 .txt）")
        return 1
    found, device = collect(paths)
    if not found:
        print("没有解析到 Flux-GS 的 summary 行（确认结果文本含 engine=fluxgs 与 summary ... res=WxH）")
        return 1

    payload = {
        "version": 1,
        "note": (
            "逐场景原生画布尺寸（**历史口径，已废弃**），来自 Flux-GS 自带渲染器在其自适应策略"
            "（`len/32 > 500000 → 1× CSS，否则 CSS × devicePixelRatio`）下的实测。"
            "2026-09-16 起主表使用统一像素协议（三臂 1600×1063），本表仅供回溯旧数据。"
        ),
        "device": device,
        "resolutions": {k: {"w": v[0], "h": v[1]} for k, v in sorted(found.items())},
    }
    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    with io.open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    for scene, (w, h) in sorted(found.items()):
        print(f"[res] {scene:12s} {w}x{h}  ({w * h / 1e6:.2f} MP)")
    print(f"[out] {args.out}  scenes={len(found)} device={device}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
