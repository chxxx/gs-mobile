"""【状态：已废弃 / 仅供实验】把 Flux-GS 的世界坐标对齐到本文坐标系，并生成"对齐后的 Flux 相机"。

> 废弃原因：用修正后的投影约定实测发现，**两套模型本来就在同一世界坐标系**
> （Flux 原 `defaultViewMatrix` 对本文点云的可见比例为 48.8%~92.3%），所以正式流程
> 直接 `cam=flux`（三方同一视角）即可，不需要任何对齐。本脚本仅作为"将来若真的遇到
> 坐标系不同的模型"时的参考实现保留。

输入：
  1) Flux-GS 解码出来的世界坐标：bench-flux.html?dump=1 下载的 `xyz-<scene>.bin`（Float32 LE, N×3）
  2) 本文同场景的 r7 低秩 QPLY（gsplat.js/scenes/point_cloud_quantised_half_r7-<scene>.ply）
输出：
  gsplat.js/bench-flux-camera-aligned.json —— 与 bench-flux-camera.json 同结构，但所有视图矩阵
  已换算到本文坐标系。bench 页会优先加载它，于是 `cam=flux` / `cam=fluxcam:N` 三方同机位立刻成立。

做法：稳健分位盒估计缩放+平移，PCA 估主轴并搜索 8 种符号组合，用最近邻距离选最优；再代入 V' = V·S。

用法：
    python gsplat.js/tools/align_flux_positions.py --scene garden --flux-bin D:/tmp/xyz-garden.bin
"""
import argparse
import io
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TYPESIZE = {"short": 2, "uchar": 1, "float": 4, "double": 8, "int": 4}

# Windows 控制台默认 GBK：统一改成 UTF-8 + 容错，避免 print 特殊符号时崩掉
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass


def load_ours(path, limit=200000):
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
    return np.stack(
        [arr[:, offs[a]: offs[a] + 2].copy().view("<i2").reshape(-1).view("<f2").astype(np.float32) for a in "xyz"],
        axis=1,
    )


def load_flux(path, limit=200000):
    data = np.fromfile(path, dtype="<f4")
    if data.size % 3 != 0:
        raise ValueError(f"{path} 长度不是 3 的倍数：{data.size}")
    pts = data.reshape(-1, 3)
    if len(pts) > limit:
        pts = pts[:: len(pts) // limit + 1]
    return pts


def umeyama(src, dst, with_scale=True):
    """闭式求解 min ||s R src + t - dst||（Umeyama 1991）。"""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    Sc, Dc = src - mu_s, dst - mu_d
    U, D, Vt = np.linalg.svd(Dc.T @ Sc / len(src))
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1
    R = U @ S @ Vt
    if with_scale:
        var_s = float((Sc**2).sum()) / len(src)
        s = float((D * np.diag(S)).sum()) / var_s if var_s > 1e-12 else 1.0
    else:
        s = 1.0
    return s, R, mu_d - s * R @ mu_s


def similarity_icp(src, dst, init=None, iters=25, sub=20000, target=60000, seed=0, trim=0.7):
    """对齐 src → dst。

    缩放不参与 ICP：用"质心 RMS 半径之比"固定（该量对旋转平移不敏感，同一场景很稳）。
    只精修旋转+平移，并按最近距离截尾（保留最好的 trim 比例）以抑制外点。
    init=(s, R, t) 传入 PCA 初值（必须传，否则 30° 以上的初值误差会让 ICP 陷进错解）。
    返回 (s, R, t, residual, residual_median)。
    """
    rng = np.random.default_rng(seed)
    a = src if len(src) <= sub else src[rng.choice(len(src), sub, replace=False)]
    b = dst if len(dst) <= target else dst[rng.choice(len(dst), target, replace=False)]
    try:
        from scipy.spatial import cKDTree

        tree = cKDTree(b)
        query = lambda p: tree.query(p, k=1)[1]  # noqa: E731
    except Exception:  # noqa: BLE001

        def query(p):
            out = np.empty(len(p), dtype=np.int64)
            for i in range(0, len(p), 2000):
                chunk = p[i: i + 2000]
                out[i: i + 2000] = np.argmin(np.linalg.norm(chunk[:, None, :] - b[None, :, :], axis=2), axis=1)
            return out

    rms_s = float(np.sqrt(((a - a.mean(0)) ** 2).sum(1).mean()))
    rms_d = float(np.sqrt(((b - b.mean(0)) ** 2).sum(1).mean()))
    s = rms_d / max(rms_s, 1e-9)  # 固定缩放
    if init is not None:
        _, R, t = init
    else:
        R, t = np.eye(3), b.mean(0) - s * a.mean(0)

    resid = float("inf")
    for _ in range(iters):
        moved = s * (a @ R.T) + t
        idx = query(moved)
        d = np.linalg.norm(moved - b[idx], axis=1)
        keep = d <= np.quantile(d, trim)
        _, R, t = umeyama(a[keep], b[idx[keep]], with_scale=False)
        resid = float(d.mean())
    moved = s * (a @ R.T) + t
    idx = query(moved)
    d = np.linalg.norm(moved - b[idx], axis=1)
    return s, R, t, resid, float(np.quantile(d, 0.5))


def make_proj(fx, w, h, near=0.2, far=200.0):
    return np.array(
        [
            [2 * fx / w, 0, 0, 0],
            [0, -2 * fx / h, 0, 0],
            [0, 0, far / (far - near), 1],
            [0, 0, -(far * near) / (far - near), 0],
        ]
    )


def nn_cost(a, b, sample=2500):
    """a 中每个点到 b 的最近距离均值（越小越对齐）"""
    if len(a) > sample:
        a = a[:: max(1, len(a) // sample)]
    if len(b) > sample:
        b = b[:: max(1, len(b) // sample)]
    d = np.linalg.norm(a[:, None, :] - b[None, :, :], axis=2)
    return float(d.min(axis=1).mean())


def align_scene(scene, binpath):
    """把一个场景的 Flux 坐标对齐到本文坐标，返回 (s, R, t, resid, resid_med, scene_size)。"""
    ours = load_ours(os.path.join(ROOT, "scenes", f"point_cloud_quantised_half_r7-{scene}.ply"))
    theirs = load_flux(binpath)
    A = ours - ours.mean(0)
    B = theirs - theirs.mean(0)
    Eo = np.linalg.eigh(A.T @ A)[1][:, ::-1]
    Eb = np.linalg.eigh(B.T @ B)[1][:, ::-1]
    rms = lambda X: float(np.sqrt((X**2).sum(1).mean()))  # noqa: E731
    s_rms = rms(A) / max(rms(B), 1e-9)
    best = None
    for sx in (1, -1):
        for sy in (1, -1):
            for sz in (1, -1):
                R0 = Eo @ (Eb * np.array([sx, sy, sz])).T
                if np.linalg.det(R0) < 0:
                    continue
                t0 = ours.mean(0) - s_rms * (R0 @ theirs.mean(0))
                cost = nn_cost(ours, theirs * s_rms @ R0.T + t0)
                if best is None or cost < best[0]:
                    best = (cost, R0, t0)
    init_cost, R0, t0 = best
    s, R, t, resid, resid_med = similarity_icp(theirs, ours, init=(s_rms, R0, t0))
    if resid_med > init_cost * 1.5 and resid > init_cost:
        s, R, t = s_rms, R0, t0
        resid = resid_med = init_cost
    scene_size = float(np.median(np.percentile(ours, 99.5, axis=0) - np.percentile(ours, 0.5, axis=0)))
    print(
        f"[align] {scene:10s} ours={len(ours):6d} flux={len(theirs):6d} scale={s:.6f} "
        f"中位残差={resid_med:.4f}（{resid_med / scene_size * 100:.2f}% of {scene_size:.1f}）"
    )
    return s, R, t, resid, resid_med, scene_size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", default="all", help="场景名，或 all（配合 --flux-dir 批量）")
    ap.add_argument("--flux-bin", default="", help="单个 xyz-<scene>.bin；批量时用 --flux-dir")
    ap.add_argument("--flux-dir", default="", help="包含 xyz-<scene>.bin 的目录（bench-flux.html?dump=1 的下载目录）")
    ap.add_argument("--our-views", default=os.path.join(ROOT, "bench-camviews.json"),
                    help="本文臂导出的机位表（bench-camviews.json），用于生成注入 Flux 的机位")
    ap.add_argument("--inject-out", default=os.path.join(ROOT, "bench-camviews-flux.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "bench-flux-camera-aligned.json"))
    args = ap.parse_args()

    # 收集要处理的 (scene, bin) 列表
    import glob as _glob

    tasks = []
    if args.flux_dir:
        for p in sorted(_glob.glob(os.path.join(args.flux_dir, "xyz-*.bin"))):
            tasks.append((os.path.basename(p)[4:-4], p))
    elif args.flux_bin:
        tasks.append((args.scene if args.scene != "all" else "garden", args.flux_bin))
    if not tasks:
        print("没有输入：用 --flux-bin <file> 或 --flux-dir <dir>（内含 xyz-<scene>.bin）")
        return 1

    results = {}
    for scene, binpath in tasks:
        try:
            results[scene] = align_scene(scene, binpath)
        except Exception as exc:  # noqa: BLE001
            print(f"[align] {scene}: 失败 {exc}")
    if not results:
        print("全部场景对齐失败")
        return 1

    first_scene = next(iter(results))
    s, R, t, resid, resid_med, scene_size = results[first_scene]
    print(f"[align] 以 {first_scene} 的变换写入相机表；共处理 {len(results)} 个场景")

    cam = json.load(io.open(os.path.join(ROOT, "bench-flux-camera.json"), encoding="utf-8"))
    Rt = R.T
    S = np.eye(4)
    S[:3, :3] = Rt / s
    S[:3, 3] = -(Rt / s) @ t

    def transform_pose(pose):
        out = dict(pose)
        v = pose.get("view_matrix")
        if v and len(v) == 16:
            # 同一约定推导：要把"它的相机"表示在我们的坐标系里，有效矩阵 E' = E · S（S=T^{-1}），
            # 因此 buffer 满足 B' = S^T · B
            B_theirs = np.array(v, dtype=np.float64).reshape(4, 4)
            out["view_matrix"] = [round(float(x), 8) for x in (S.T @ B_theirs).reshape(-1)]
        if pose.get("position"):
            p = np.array(pose["position"], dtype=np.float64)
            out["position"] = [round(float(x), 6) for x in (s * (R @ p) + t)]
        return out

    aligned = {
        "version": 1,
        "source": cam.get("source", ""),
        "note": (
            "已对齐到本文坐标系（tools/align_flux_positions.py 生成）。"
            f"scale={s:.6f}，ICP 中位残差={resid_med:.4f}（相对 {resid_med / scene_size * 100:.2f}%）。"
            "bench.html?cam=flux 会优先加载本文件。"
        ),
        "align": {
            "scene": args.scene,
            "scale": s,
            "rotation_rowmajor": [round(float(x), 8) for x in R.reshape(-1)],
            "translation": [round(float(x), 6) for x in t],
            "nn_residual": round(resid, 6),
            "nn_residual_median": round(resid_med, 6),
            "rel_residual_pct": round(resid_med / scene_size * 100, 4),
        },
        "focal_px": cam["focal_px"],
        "cameras": [transform_pose(c) for c in cam["cameras"]],
        "default_view": transform_pose(cam["default_view"]),
    }
    with io.open(args.out, "w", encoding="utf-8") as f:
        json.dump(aligned, f, ensure_ascii=False, indent=2)
    print(f"[out] {args.out}")

    # ---- 额外产出：把"本文机位"换算到它的坐标系，供注入它的渲染器（三方严格同机位）----
    T = np.eye(4)  # x_ours = T · x_theirs
    T[:3, :3] = s * R
    T[:3, 3] = t
    if os.path.isfile(args.our_views):
        ours_views = json.load(io.open(args.our_views, encoding="utf-8")).get("views", {})
        inject, used = {}, []
        for scene, v in ours_views.items():
            if len(v) != 16 or scene not in results:
                continue  # 该场景没有对齐结果（未导出它的坐标）就跳过，避免用错变换
            sc_s, sc_R, sc_t = results[scene][0], results[scene][1], results[scene][2]
            T_scene = np.eye(4)
            T_scene[:3, :3] = sc_s * sc_R
            T_scene[:3, 3] = sc_t
            # 注入 buffer 的正确公式：B_f = T^T · B_our
            #   推导：有效矩阵 E = B^T（GL 按列主序读），要求 E_f = E_our · T  ⇒  B_f = T^T · B_our
            B_our = np.array(v, dtype=np.float64).reshape(4, 4)
            inject[scene] = [round(float(x), 8) for x in (T_scene.T @ B_our).reshape(-1)]
            used.append(scene)
        if inject:
            payload2 = {
                "version": 1,
                "note": (
                    "把本文机位换算到 Flux-GS 坐标系后的视图矩阵（bench-flux.html?pose=aligned 注入用）。"
                    f"逐场景各自对齐；本表含 {len(inject)} 个场景。"
                ),
                "views": inject,
            }
            with io.open(args.inject_out, "w", encoding="utf-8") as f:
                json.dump(payload2, f, ensure_ascii=False, indent=2)
            print(f"[out] {args.inject_out}  scenes={len(inject)}（{', '.join(used[:6])}…）")
        else:
            print("[skip] 没有可注入的场景（本文机位表与对齐结果无交集）")
    else:
        print(f"[skip] 未找到 {args.our_views}：跳过注入表。可先跑 bench.html?...&exportPose=1 再执行 make_bench_camviews.py")

    W, H, NEAR, FAR = 1600, 1063, 0.2, 200.0
    proj = np.array(
        [
            [2 * cam["focal_px"] / W, 0, 0, 0],
            [0, -2 * cam["focal_px"] / H, 0, 0],
            [0, 0, FAR / (FAR - NEAR), 1],
            [0, 0, -(FAR * NEAR) / (FAR - NEAR), 0],
        ]
    )
    # ---- 对齐质量的真正判据：用【本文机位】同时看两套点云，比较可见比例 ----
    our_views_path = args.our_views
    if os.path.isfile(our_views_path):
        our_views = json.load(io.open(our_views_path, encoding="utf-8")).get("views", {})
        fx = float(json.load(io.open(os.path.join(ROOT, "bench-flux-camera.json"), encoding="utf-8"))["focal_px"])
        proj = make_proj(fx, 1600, 1063)

        def visible_pct(points, view16):
            # 约定（已用相机表+点云实测确认）：GL 按列主序读 buffer，故有效矩阵是行主序读法的转置；
            # shader 里做 u_projection * u_view * vec4(x,1)，所以正确组合是 P^T · B^T · x。
            B = np.array(view16, dtype=np.float64).reshape(4, 4)
            M = proj.T @ B.T
            homo = np.concatenate([points, np.ones((len(points), 1), dtype=np.float64)], axis=1)
            clip = (M @ homo.T).T
            w = clip[:, 3]
            ok = w > 1e-6
            ndc = np.zeros((len(points), 3))
            ndc[ok] = clip[ok, :3] / w[ok, None]
            inside = ok & (np.abs(ndc[:, 0]) <= 1) & (np.abs(ndc[:, 1]) <= 1) & (ndc[:, 2] <= 1)
            return float(inside.mean()) * 100

        print("\n[检查] 用本文机位(cam=mid)同时投影两套点云，看是否落在同一块画面里：")
        print(f"{'场景':10s} {'本文方法':>10s} {'Flux(已对齐)':>14s} {'判定':>8s}")
        ok_scenes = []
        for scene, (sc_s, sc_R, sc_t, _r, _rm, _sz) in results.items():
            v = our_views.get(scene)
            if not v:
                continue
            ours_pts = load_ours(os.path.join(ROOT, "scenes", f"point_cloud_quantised_half_r7-{scene}.ply"))[::20]
            theirs_pts = load_flux([p for sc, p in tasks if sc == scene][0])[::20]
            aligned = sc_s * (theirs_pts @ sc_R.T) + sc_t
            a = visible_pct(ours_pts, v)
            b = visible_pct(aligned, v)
            # 判定：两者都>5% 且相对差<40% 视为"同一取景"
            good = a > 5 and b > 5 and abs(a - b) / max(a, 1e-6) < 0.4
            if good:
                ok_scenes.append(scene)
            print(f"{scene:10s} {a:9.1f}% {b:13.1f}% {'OK' if good else '需检查':>8s}")
        print(f"[检查] 判定通过 {len(ok_scenes)}/{len(results)} 个场景：{', '.join(ok_scenes) if ok_scenes else '（无）'}")
        print("       两个比例接近 -> 对齐可用，pose=aligned 后两边画面会重合；差很多 -> 该场景需要单独检查。")


if __name__ == "__main__":
    sys.exit(main())
