"""从 Flux-GS 官方渲染器源码里抽出它的相机，生成 `gsplat.js/bench-flux-camera.json`。

用途：让本文方法 / reduced-3DGS **用 Flux-GS 原来代码里的相机**测帧（三方完全同角度）。
抽出两类：
  1. `cameras[]`：它硬编码的 10 个真实镜头（COLMAP 相机，fx=fy=1159.588，1959x1090）；
  2. `default_view`：`defaultViewMatrix`（未交互时的原始视角，13 个场景共用），由视图矩阵反解出 (位置, 旋转)。

用法：
    python gsplat.js/tools/extract_flux_camera.py
"""
import io
import json
import math
import os
import re
import sys

MAIN = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "flux-gs-project-gh-pages",
    "render_shared",
    "main.js",
)


def quat_from_matrix(m):
    """标准 3x3（行主序）→ 四元数 (x, y, z, w)，与 gsplat.js 的 Matrix3.RotationFromQuaternion 互逆。"""
    r11, r12, r13, r21, r22, r23, r31, r32, r33 = m
    tr = r11 + r22 + r33
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        w = 0.25 * s
        x = (r32 - r23) / s
        y = (r13 - r31) / s
        z = (r21 - r12) / s
    elif r11 > r22 and r11 > r33:
        s = math.sqrt(1.0 + r11 - r22 - r33) * 2
        w = (r32 - r23) / s
        x = 0.25 * s
        y = (r12 + r21) / s
        z = (r13 + r31) / s
    elif r22 > r33:
        s = math.sqrt(1.0 + r22 - r11 - r33) * 2
        w = (r13 - r31) / s
        x = (r12 + r21) / s
        y = 0.25 * s
        z = (r23 + r32) / s
    else:
        s = math.sqrt(1.0 + r33 - r11 - r22) * 2
        w = (r21 - r12) / s
        x = (r13 + r31) / s
        y = (r23 + r32) / s
        z = 0.25 * s
    return [x, y, z, w]


def matrix_from_quat(q):
    x, y, z, w = q
    return [
        1 - 2 * y * y - 2 * z * z,
        2 * x * y - 2 * z * w,
        2 * x * z + 2 * y * w,
        2 * x * y + 2 * z * w,
        1 - 2 * x * x - 2 * z * z,
        2 * y * z - 2 * x * w,
        2 * x * z - 2 * y * w,
        2 * y * z + 2 * x * w,
        1 - 2 * x * x - 2 * y * y,
    ]


def grab(text, from_idx):
    """从 text[from_idx] == '[' 开始按括号配对取出整个数组字面量（含两端方括号）。"""
    depth, i = 0, from_idx
    while i < len(text):
        ch = text[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return text[from_idx: i + 1]
        i += 1
    return ""


def nums(s):
    return [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", s)]


def inv3(m):
    """3x3 行主序求逆；不可逆返回 None。"""
    a, b, c, d, e, f, g, h, i = m
    A, B, C = e * i - f * h, -(d * i - f * g), d * h - e * g
    D, E, F = -(b * i - c * h), a * i - c * g, -(a * h - b * g)
    G, H, I = b * f - c * e, -(a * f - c * d), a * e - b * d
    det = a * A + b * B + c * C
    if abs(det) < 1e-12:
        return None
    return [A / det, D / det, G / det, B / det, E / det, H / det, C / det, F / det, I / det]


def view_matrix(position, rotation):
    """与 Flux-GS getViewMatrix 及 gsplat.js CameraData.update 完全相同的公式。"""
    R, t = rotation, position
    return [
        R[0], R[1], R[2], 0,
        R[3], R[4], R[5], 0,
        R[6], R[7], R[8], 0,
        -t[0] * R[0] - t[1] * R[3] - t[2] * R[6],
        -t[0] * R[1] - t[1] * R[4] - t[2] * R[7],
        -t[0] * R[2] - t[1] * R[5] - t[2] * R[8],
        1,
    ]


def main():
    src = io.open(MAIN, encoding="utf-8").read()

    # ---- 1) cameras[] ----
    arr = src[src.index("let cameras = ["):]
    arr = arr[: arr.index("\n];") + 3]
    marks = [m.start() for m in re.finditer(r"id:\s*\d+,", arr)]
    cameras = []
    for i, start in enumerate(marks):
        body = arr[start: marks[i + 1] if i + 1 < len(marks) else len(arr)]
        if "position:" not in body or "rotation:" not in body:
            continue
        position = nums(grab(body, body.index("[", body.index("position:"))))[:3]
        rotation = nums(grab(body, body.index("[", body.index("rotation:"))))[:9]
        fx = re.search(r"fx:\s*([\d.]+)", body)
        wh = re.search(r"width:\s*(\d+),\s*height:\s*(\d+)", body)
        idx = re.search(r"id:\s*(\d+)", body)
        if len(position) != 3 or len(rotation) != 9 or not fx:
            continue
        cameras.append(
            {
                "id": int(idx.group(1)) if idx else len(cameras),
                "position": position,
                "rotation": rotation,
                "quaternion": [round(v, 8) for v in quat_from_matrix(rotation)],
                "view_matrix": [round(v, 8) for v in view_matrix(position, rotation)],
                "fx": float(fx.group(1)),
                "width": int(wh.group(1)) if wh else 0,
                "height": int(wh.group(2)) if wh else 0,
            }
        )

    # ---- 2) defaultViewMatrix：原样保留 16 个数 + 反解 (position, rotation) 供核对 ----
    dv = src.index("defaultViewMatrix = ")
    flat = nums(grab(src, src.index("[", dv)))[:16]
    R = [flat[0], flat[1], flat[2], flat[4], flat[5], flat[6], flat[8], flat[9], flat[10]]
    # 位移满足 vt = -M t，其中 M = [[R0,R3,R6],[R1,R4,R7],[R2,R5,R8]]；注意源码矩阵只写 2 位小数、
    # 并非严格正交，因此必须用真实逆矩阵求 t（用 R 代替 M^-1 会带来约 3e-2 的位置误差）。
    M = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]
    Mi = inv3(M)
    vt = [flat[12], flat[13], flat[14]]
    t = [-sum(Mi[3 * r + c] * vt[c] for c in range(3)) for r in range(3)] if Mi else [0, 0, 0]
    rebuilt = view_matrix(t, R)
    err = max(abs(a - b) for a, b in zip(rebuilt, flat))
    # 直接把原矩阵塞给渲染器（不做任何重建）才是零误差路径
    ortho_err = max(abs(sum(R[3 * r + c] * R[3 * r2 + c] for c in range(3)) - (1.0 if r == r2 else 0.0))
                    for r in range(3) for r2 in range(3))

    # ---- 3) 自检：四元数 ↔ 矩阵 往返一致 ----
    rt = 0.0
    for cam in cameras:
        rt = max(rt, max(abs(a - b) for a, b in zip(matrix_from_quat(cam["quaternion"]), cam["rotation"])))

    payload = {
        "version": 1,
        "source": "flux-gs-project-gh-pages/render_shared/main.js（官方渲染器源码）",
        "note": (
            "Flux-GS 原代码里的相机。cam=flux 用 default_view（未交互时的原始视角，13 场景共用）；"
            "cam=fluxcam:N 用它的第 N 个硬编码镜头。position/rotation 与 gsplat.js 的 "
            "CameraData.update 同构，可直接套到本文渲染器上。"
        ),
        "focal_px": cameras[0]["fx"] if cameras else 1159.588,
        "cameras": cameras,
        "default_view": {
            "position": [round(v, 6) for v in t],
            "rotation": [round(v, 6) for v in R],
            "quaternion": [round(v, 6) for v in quat_from_matrix(R)],
            "view_matrix": flat,
        },
    }

    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bench-flux-camera.json")
    with io.open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    # 诊断：量化"用四元数重建"会带来多大偏差（这是之前看起来有视角偏差的原因）
    Rq = matrix_from_quat(quat_from_matrix(R))
    quat_route = view_matrix(t, Rq)
    quat_err = max(abs(a - b) for a, b in zip(quat_route, flat))

    print(f"[flux-camera] cameras={len(cameras)} focal={payload['focal_px']}")
    print(f"[flux-camera] default_view 位置(真实逆解)={[round(v, 3) for v in t]}")
    print(f"[flux-camera] 逆解重建误差={err:.2e}   源码矩阵非正交度={ortho_err:.2e}")
    print(f"[flux-camera] 「位置+四元数」重建会产生的最大偏差={quat_err:.2e}  ← 现在改为直接注入 16 个矩阵数，偏差为 0")
    print(f"[flux-camera] 四元数往返误差={rt:.2e}")
    for cam in cameras[:3]:
        print(f"  cam{cam['id']}: pos={[round(v, 3) for v in cam['position']]} size={cam['width']}x{cam['height']}")
    print(f"[out] {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
