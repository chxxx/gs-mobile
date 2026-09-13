# -*- coding: utf-8 -*-
"""【状态：已废弃 / 仅供实验】对齐质量严格检验（NDC 重心/展布/包围框 IoU）。

> 废弃原因同 align_flux_positions.py：两套模型本来就在同一坐标系，正式流程不需要对齐。

用途：`align_flux_positions.py` 的 `[检查]` 只证明"两套点云都在画面内"；本工具给出更严的
"是否逐像素重合"的量化结果，用于决定某个场景能不能按"同机位"口径写进论文。

判据（NDC 满幅 ±1）：
  重心差 < 0.15（≈屏宽 7.5%）、展布比 0.6~1.6、包围框 IoU > 0.6 → 视为同一取景。

用法：
    python gsplat.js/tools/check_alignment_quality.py --flux-dir D:\\study\\tmp\\fluxxyz
"""
import argparse
import io
import json
import os
import sys

import numpy as np
from scipy.spatial import cKDTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from align_flux_positions import load_flux, load_ours, make_proj, umeyama  # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass


def fast_align(a, b, iters=8, seed=0):
    """a=Flux 点 → b=本文点；缩放用 RMS 半径比固定，PCA 初值 + 刚性 ICP（截尾）。"""
    rng = np.random.default_rng(seed)
    a = a[rng.choice(len(a), min(15000, len(a)), replace=False)]
    b = b[rng.choice(len(b), min(30000, len(b)), replace=False)]
    A, B = a - a.mean(0), b - b.mean(0)
    Eo = np.linalg.eigh(B.T @ B)[1][:, ::-1]
    Eb = np.linalg.eigh(A.T @ A)[1][:, ::-1]
    s = float(np.sqrt((B**2).sum(1).mean()) / max(np.sqrt((A**2).sum(1).mean()), 1e-9))
    best = None
    probe = cKDTree(b[::5])
    for sx in (1, -1):
        for sy in (1, -1):
            for sz in (1, -1):
                R0 = Eo @ (Eb * np.array([sx, sy, sz])).T
                if np.linalg.det(R0) < 0:
                    continue
                t0 = b.mean(0) - s * (R0 @ a.mean(0))
                d, _ = probe.query(s * (a[::5] @ R0.T) + t0, k=1)
                if best is None or float(d.mean()) < best[0]:
                    best = (float(d.mean()), R0, t0)
    _, R, t = best
    tree = cKDTree(b)
    for _ in range(iters):
        moved = s * (a @ R.T) + t
        d, idx = tree.query(moved, k=1)
        keep = d <= np.quantile(d, 0.5)
        _, R, t = umeyama(a[keep], b[idx[keep]], with_scale=False)
    return s, R, t


def ndc_of(pts, view16, proj):
    B = np.array(view16, dtype=np.float64).reshape(4, 4)
    M = proj.T @ B.T
    homo = np.concatenate([pts, np.ones((len(pts), 1))], axis=1)
    clip = (M @ homo.T).T
    w = np.where(np.abs(clip[:, 3]) < 1e-9, 1e-9, clip[:, 3])
    ok = np.abs(w) > 0
    return clip[ok][:, :2] / w[ok][:, None]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flux-dir", required=True)
    ap.add_argument("--views", default=os.path.join(ROOT, "bench-camviews.json"))
    args = ap.parse_args()

    views = json.load(io.open(args.views, encoding="utf-8"))["views"]
    fx = float(json.load(io.open(os.path.join(ROOT, "bench-flux-camera.json"), encoding="utf-8"))["focal_px"])
    proj = make_proj(fx, 1600, 1063)

    print(f"{'场景':10s} {'重心差':>8s} {'展布比':>7s} {'框IoU':>7s} {'判定':>6s}")
    ok = 0
    total = 0
    for scene in sorted(views):
        binp = os.path.join(args.flux_dir, f"xyz-{scene}.bin")
        if not os.path.isfile(binp):
            continue
        total += 1
        ours = load_ours(os.path.join(ROOT, "scenes", f"point_cloud_quantised_half_r7-{scene}.ply"))
        theirs = load_flux(binp)
        s, R, t = fast_align(theirs, ours)
        aligned = s * (theirs @ R.T) + t
        a = ndc_of(ours[::40], views[scene], proj)
        b = ndc_of(aligned[::40], views[scene], proj)
        dc = float(np.linalg.norm(np.median(a, 0) - np.median(b, 0)))
        sa = float(np.linalg.norm(np.percentile(a, [99], 0) - np.percentile(a, [1], 0)))
        sb = float(np.linalg.norm(np.percentile(b, [99], 0) - np.percentile(b, [1], 0)))
        alo, ahi = np.percentile(a, 1, 0), np.percentile(a, 99, 0)
        blo, bhi = np.percentile(b, 1, 0), np.percentile(b, 99, 0)
        inter = np.prod(np.maximum(np.minimum(ahi, bhi) - np.maximum(alo, blo), 0))
        iou = float(
            inter
            / max(np.prod(np.maximum(ahi - alo, 1e-9)) + np.prod(np.maximum(bhi - blo, 1e-9)) - inter, 1e-9)
        )
        good = dc < 0.15 and 0.6 < sb / max(sa, 1e-9) < 1.6 and iou > 0.6
        ok += 1 if good else 0
        print(f"{scene:10s} {dc:8.4f} {sb / max(sa, 1e-9):7.3f} {iou:7.3f} {'OK' if good else '检查':>6s}")
    print(f"\n通过 {ok}/{total}（重心差<0.15、展布比 0.6~1.6、IoU>0.6；NDC 满幅 ±1）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
