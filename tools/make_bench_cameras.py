# -*- coding: utf-8 -*-
"""生成第7章测帧用的固定机位表 `gsplat.js/bench-cameras.json`。

为什么要固定机位：bench.ts 原先按"模型包围盒"自动取景（dist = span × 1.6）。同一场景下，
本文 r7 模型与对比方法模型的包围盒差异极大（被离群点主导），实测 truck 的 span 为 605.9 vs 165.5、
中心相距 74，导致两条臂其实是在**不同机位**上测帧，FPS 不可比。

本工具以本文 r7 场景为参考，用**分位数包围盒**（对离群点稳健）算出目标中心与基准距离，
并给出 3 档距离（near 0.6× / mid 1.0× / far 1.8×）用于"视角敏感性"实验：
只要三档下方法排序不变，FPS 结论就不依赖某一具体机位。

用法：
    python gsplat.js/tools/make_bench_cameras.py            # 用 gsplat.js/bench-scenes.json 的全部场景
    python gsplat.js/tools/make_bench_cameras.py --q 0.5    # 更紧的分位（默认 0.5%~99.5%）
"""
import argparse
import io
import json
import os

import numpy as np

TYPESIZE = {"short": 2, "uchar": 1, "float": 4, "double": 8, "int": 4}
CAM_LEVELS = {"near": 0.7, "mid": 1.0, "far": 1.8}
# 取景：让 1%~99% 分位盒在画面里占约 1/1.15 的宽度/高度（对比原来的 span*1.6 明显更近、更合理）
CANVAS_W, CANVAS_H = 1600, 1063
FIT_MARGIN = 1.15


def header_block(path):
    raw = open(path, "rb").read(1 << 16)
    idx = raw.find(b"end_header\n")
    return raw[:idx].decode("latin-1"), idx + len(b"end_header\n")


def positions(path, limit=200000, stride_limit=1 << 40):
    """读取全部顶点的 xyz（short 承载半精度位模式，与渲染器读法一致）。"""
    text, start = header_block(path)
    names = [f"vertex_{g}" for g in range(4) if f"element vertex_{g} " in text]
    if not names:
        names = ["vertex"] if "element vertex " in text else []
    out = []
    pos = start
    for name in names:
        props, inside, cnt = [], False, 0
        marker = f"element {name} "
        for line in text.splitlines():
            if line.startswith("element "):
                inside = line.startswith(marker)
                if inside:
                    cnt = int(line.split(" ")[2])
            elif line.startswith("property ") and inside:
                _, t, nm = line.split(" ")
                props.append((nm, t))
        offs, off = {}, 0
        for nm, t in props:
            offs[nm] = off
            off += TYPESIZE[t]
        take = min(cnt, limit)
        if take:
            with open(path, "rb") as f:
                f.seek(pos)
                arr = np.frombuffer(f.read(take * off), dtype=np.uint8).reshape(take, off)
            xyz = np.stack(
                [
                    arr[:, offs[a]: offs[a] + 2].copy().view("<i2").view(np.float16).astype(np.float32)
                    for a in ("x", "y", "z")
                ],
                axis=1,
            )
            out.append(xyz)
        pos += cnt * off
    return np.concatenate(out) if out else np.zeros((0, 3), np.float32)


def build_entry(xyz, q, fx):
    lo = np.percentile(xyz, q, axis=0)
    hi = np.percentile(xyz, 100.0 - q, axis=0)
    center = (lo + hi) / 2.0
    size = np.maximum(hi - lo, 1e-6)
    # 距离 d 处的可见半宽 = d*(W/2)/fx、半高 = d*(H/2)/fx；要求包住半个盒（留 FIT_MARGIN 余量）
    base = max(
        float(size[0]) * fx * FIT_MARGIN / CANVAS_W,
        float(size[1]) * fx * FIT_MARGIN / CANVAS_H,
    )
    entry = {}
    for name, k in CAM_LEVELS.items():
        pos = center.copy()
        pos[2] += base * k
        entry[name] = {
            "position": [round(float(v), 4) for v in np.asarray(pos).ravel()],
            "target": [round(float(v), 4) for v in np.asarray(center).ravel()],
        }
    return entry


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    parser.add_argument("--manifest", default=None)
    parser.add_argument("--out", default=None)
    parser.add_argument("--q", type=float, default=0.5, help="分位数（默认 0.5，即 0.5%%~99.5%% 稳健包围盒）")
    args = parser.parse_args()

    root = args.root
    manifest = args.manifest or os.path.join(root, "bench-scenes.json")
    out_path = args.out or os.path.join(root, "bench-cameras.json")
    scenes = json.load(io.open(manifest, encoding="utf-8"))["scenes"]

    # 焦距与 bennch 页保持一致（Flux-GS 的 COLMAP 焦距），取景距离按它换算
    fx = 1159.5880733038064
    cam_json = os.path.join(root, "bench-flux-camera.json")
    if os.path.isfile(cam_json):
        try:
            fx = float(json.load(io.open(cam_json, encoding="utf-8"))["focal_px"])
        except Exception:  # noqa: BLE001
            pass
    print(f"[cam] 使用焦距 fx={fx:.3f}，画布 {CANVAS_W}x{CANVAS_H}，取景余量 ×{FIT_MARGIN}")

    cameras, skipped = {}, []
    for scene in scenes:
        path = os.path.join(root, scene["file"])
        if not os.path.isfile(path):
            skipped.append(scene["id"])
            continue
        xyz = positions(path)
        if len(xyz) == 0:
            skipped.append(scene["id"])
            continue
        cameras[scene["id"]] = build_entry(xyz, args.q, fx)
        print(f"[cam] {scene['id']:10s} points={len(xyz):8d} "
              f"mid_z={cameras[scene['id']]['mid']['position'][2]:.3f} "
              f"dist={cameras[scene['id']]['mid']['position'][2] - cameras[scene['id']]['mid']['target'][2]:.3f}")

    payload = {
        "version": 1,
        "note": (
            "第7章测帧固定机位表：以本文 r7 场景的分位数包围盒为参考，给出 near/mid/far 三档距离。"
            "本文方法与 reduced-3DGS 臂共用同一机位（同一渲染器同一 FOV），使二者可比；"
            "Flux-GS 使用其自带渲染器的固定默认姿态，用 covered% 做可比性核对。"
        ),
        "quantile": args.q,
        "cameras": cameras,
    }
    with io.open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"[out] {out_path}  scenes={len(cameras)} skipped={skipped}")


if __name__ == "__main__":
    main()
