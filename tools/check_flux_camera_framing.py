"""【状态：已废弃 / 仅供实验】检查 Flux-GS 的 10 个硬编码镜头能否看到本文模型。

> 废弃说明：它代码里那 10 个硬编码镜头（1959×1090 那组）与这些场景并不对应，
> 正式流程用的是 `defaultViewMatrix`（见 `bench-flux-camera.json`），不使用这些镜头。

做法：对本文 r7 模型采样点，用 Flux 相机 + 其投影（fx=1159.588, 1600x1063, near .2 far 200）
投影，统计落在画面内且在相机前方的比例。两种矩阵约定都算一遍（自诊断），取其优者。
"""
import io
import json
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAM = json.load(io.open(os.path.join(ROOT, "bench-flux-camera.json"), encoding="utf-8"))
W, H = 1600, 1063
NEAR, FAR = 0.2, 200.0
TYPESIZE = {"short": 2, "uchar": 1, "float": 4, "double": 8, "int": 4}


def load_xyz(path, limit=40000, stride=7):
    raw = open(path, "rb").read(1 << 16)
    idx = raw.find(b"end_header\n")
    header = raw[:idx].decode("latin-1")
    start = idx + len(b"end_header\n")
    props, inside, cnt, row = [], False, 0, 0
    for line in header.splitlines():
        if line.startswith("element "):
            inside = line.startswith("element vertex ")
            if inside:
                cnt = int(line.split(" ")[2])
        elif line.startswith("property ") and inside:
            _, t, nm = line.split(" ")
            props.append((nm, t))
            row += TYPESIZE[t]
    offs, off = {}, 0
    for nm, t in props:
        offs[nm] = off
        off += TYPESIZE[t]
    take = min(cnt, limit)
    with open(path, "rb") as f:
        f.seek(start)
        arr = np.frombuffer(f.read(take * row), dtype=np.uint8).reshape(take, row)
    xyz = np.stack(
        [
            arr[:, offs[a]: offs[a] + 2].copy().view("<i2").reshape(-1).view("<f2").astype(np.float32)
            for a in "xyz"
        ],
        axis=1,
    )
    return xyz[::stride]


def projection(fx, w, h):
    return np.array(
        [
            [2 * fx / w, 0, 0, 0],
            [0, -2 * fx / h, 0, 0],
            [0, 0, FAR / (FAR - NEAR), 1],
            [0, 0, -(FAR * NEAR) / (FAR - NEAR), 0],
        ],
        dtype=np.float64,
    )


def visible_ratio(xyz, view_flat, proj, transposed):
    V = np.array(view_flat, dtype=np.float64).reshape(4, 4)
    if transposed:
        V = V.T
    homo = np.concatenate([xyz, np.ones((len(xyz), 1), dtype=np.float32)], axis=1).astype(np.float64)
    cam = homo @ V.T  # 行向量约定：x_cam = V · x
    clip = cam @ proj.T
    w = clip[:, 3]
    ok = w > 1e-6
    ndc = np.zeros((len(xyz), 3))
    ndc[ok] = clip[ok, :3] / w[ok, None]
    inside = ok & (np.abs(ndc[:, 0]) <= 1) & (np.abs(ndc[:, 1]) <= 1) & (ndc[:, 2] <= 1)
    return float(inside.mean()), float(ok.mean())


proj = projection(CAM["focal_px"], W, H)
poses = [("default_view", CAM["default_view"])] + [(f"fluxcam:{c['id']}", c) for c in CAM["cameras"]]

for scene in ["garden", "bicycle", "truck", "drjohnson"]:
    p = os.path.join(ROOT, "scenes", f"point_cloud_quantised_half_r7-{scene}.ply")
    if not os.path.isfile(p):
        continue
    xyz = load_xyz(p)
    print(f"== {scene}  (采样 {len(xyz)} 点)")
    rows = []
    for name, pose in poses:
        v = pose.get("view_matrix") or []
        if len(v) != 16:
            continue
        r1, f1 = visible_ratio(xyz, v, proj, False)
        r2, f2 = visible_ratio(xyz, v, proj, True)
        rows.append((max(r1, r2), name, r1, r2, f1, f2))
    rows.sort(reverse=True)
    for ratio, name, r1, r2, f1, f2 in rows[:4]:
        print(f"   {name:14s} 可见比例 直接={r1*100:5.1f}% 转置={r2*100:5.1f}%  (前方比例 {f1*100:4.0f}%/{f2*100:4.0f}%)")
