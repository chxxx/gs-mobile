# -*- coding: utf-8 -*-
"""第7章对比方法（reduced-3DGS / Flux-GS）实测结果聚合 → 论文表 7-2/7-3/7-4 数据行。

输入：bench.html / bench-flux.html 结果卡片里 copy 出来的 KEY=VALUE 文本
      （默认读 thesis_project/data/ch7_measurements/raw/*.txt）。
输出：thesis_project/data/ch7_measurements/out/ 下
      - table7_2_7_4_baseline_rows.md  可直接粘进论文的对比方法数据行（含覆盖子集脚注）
      - per_scene_detail.csv           逐场景中位数明细（附录用）
      - aggregated.json                结构化结果（便于二次核对）

统计口径（与论文 7.2.2 一致）：
  1. 同一场景多轮取中位数（只统计 ok=1 且 drawOk!=0 的轮）；
  2. 数据集行 = 该数据集内"已覆盖场景"的中位数再取算术平均；
  3. 场景覆盖率不足时在脚注里显式写出覆盖子集，不允许拿部分场景冒充整行。

用法：
    python gsplat.js/tools/ch7_baseline_report.py
    python gsplat.js/tools/ch7_baseline_report.py --raw-dir D:/tmp/raw --out-dir D:/tmp/out
    python gsplat.js/tools/ch7_baseline_report.py raw/one.txt raw/two.txt
"""
import argparse
import csv
import glob
import json
import os
import statistics
import sys

# Windows 控制台默认 GBK，直接 print 中文/符号会抛 UnicodeEncodeError；统一改成 UTF-8 + 容错。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

DATASET_ORDER = ["mip360", "tnt", "db"]
DATASET_LABEL = {"mip360": "Mip-NeRF 360", "tnt": "Tanks and Temples", "db": "Deep Blending"}
# 论文表格里该数据集应覆盖的场景总数（用于覆盖子集脚注）
DATASET_TOTAL = {"mip360": 9, "tnt": 2, "db": 2}


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def parse_kv(line):
    out = {}
    for token in line.split():
        if "=" in token:
            k, v = token.split("=", 1)
            out[k] = v
    return out


def parse_result_blocks(text):
    """把结果文本切成若干 block：{'header': {...}, 'rounds': [{...}], 'summary': [{...}]}"""
    blocks, cur, section = [], None, None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line == "[RESULT]":
            cur, section = {"header": {}, "rounds": [], "summary": []}, "header"
            continue
        if cur is None:
            continue
        if line == "[END]":
            blocks.append(cur)
            cur, section = None, None
            continue
        if line.startswith("--- per-round"):
            section = "rounds"
            continue
        if line.startswith("--- summary"):
            section = "summary"
            continue
        if line.startswith("---"):
            continue
        kv = parse_kv(line)
        if not kv:
            continue
        if section == "header":
            cur["header"].update(kv)
        elif section == "rounds":
            cur["rounds"].append(kv)
        elif section == "summary":
            cur["summary"].append(kv)
    return blocks


def arm_of(header, scene):
    if header.get("engine", "") == "fluxgs":
        return "flux-gs"
    if scene.startswith("r3dgs-"):
        return "reduced-3dgs"
    return "ours"


def num(mapping, key):
    try:
        return float(mapping[key])
    except (KeyError, TypeError, ValueError):
        return None


def collect(scene_stats, header, rounds):
    """逐轮记录 → scene_stats[(arm, dataset, scene)][metric] = [值...]"""
    for r in rounds:
        scene = r.get("scene", "")
        if not scene:
            continue
        arm = arm_of(header, scene)
        ok = r.get("ok") == "1"
        if arm != "flux-gs" and r.get("drawOk", "1") == "0":
            ok = False
        if not ok:
            continue
        key = (arm, r.get("dataset", ""), scene)
        slot = scene_stats.setdefault(
            key,
            {
                "fps": [],
                "first_frame_ms": [],
                "fetch_ms": [],
                "bytes": [],
                "covered": [],
                "kept": [],
                "visible": [],
                "poses": set(),
                "cam": header.get("cam", ""),
                # 机位口径（2026-09-17 追加）：`pose_src=` 两臂同名（本文臂新增、Flux 臂原本就有），
                # 用来核对"两臂是否同一机位档"；旧版本文臂报告没有该字段，用 `cam=` 回退
                # （本文臂 cam=flux ⇔ Flux 臂 pose_src=flux，同一个机位来源）。
                "pose_srcs": set(),
                # 计时口径字段（2026-09-16 追加）：帧驱动（driver=）与预热帧数（warmup=），
                # 用于核对两臂 FPS 是否同一口径 —— 驱动不同则 FPS 不可横向比较。
                "drivers": set(),
                "warmups": set(),
                # 台上布局（stage=）：fit1 = iframe 布局尺寸 = res 像素 + CSS 等比缩放（1:1 协议）；
                # fill = 铺满渲染区（仅观感对照）。两臂不同则说明不是同构台上布置。
                "stages": set(),
                # 像素口径（2026-09-16 追加）：res_mode=（forced=统一像素协议 / native=Flux 自适应）
                # 与逐轮实测的 res=。native 行**不得进跨方法主表**（各臂分辨率不对等）。
                "res_modes": set(),
                "ress": set(),
                # 动态相机挡位（2026-09-17 追加）：`spin=`（rate = deg/帧、swing = 摆幅，0 = 静止协议）
                # 与 `spin_pivot=` / `spin_mode=`。
                # **`spin != 0` 的轮次一律不进主表**：那是"相机在测量窗口内转动"的效度自查数据
                # （见 bench-shared 顶部"动态相机挡位"与三臂手册），与静止协议的论文口径不同源。
                "spins": set(),
                "spin_pivots": set(),
                "spin_modes": set(),
                # 内容量扫描（2026-09-17 追加）：`sweep_cov_mean=` 逐姿态**真实渲染**覆盖率均值、
                # `sweep_seen_mean=` 逐姿态**裁剪盒内**高斯比例均值。它们是"两臂是否在看同量级的内容"
                # 的直接证据（fps 差异能否归因于实现，取决于这一列对齐）。
                "sweep_cov_mean": [],
                "sweep_seen_mean": [],
                "sync_ms": [],
                "fps_capped": set(),
                # 计时地板（2026-09-16 追加）：逐轮行的 floor_used_ms= 是**判定 fps_capped 时实际引用**
                # 的本轮实测地板；结果头 timer_floor_ms= 只是各轮中位数，两者不是同一个数。
                "floor_used_ms": [],
                # 帧内阻塞耗时（2026-09-17 追加）：逐轮 frame_ms= / frame_mean_ms=，口径是
                # “渲染提交 → gl.finish() 返回”之间**实际被阻塞**的时长，不含帧内让出。
                # ⚠️ 它**不是**“地板无关的单帧渲染能力”，不得用于算两臂倍数：被地板封顶的臂
                # 两端读数都落在 performance.now() 的 100µs 量化下限附近（读数 0.10ms 的正确
                # 含义是“≤0.15ms”）；跨臂倍数只能由帧间隔（1000/fps）之比给出，且贴地板的一侧
                # 只能给下界。逐轮原始值保留，供核对 `cpu_ms ≈ 地板 + frame_ms`。
                "frame_ms": [],
                "frame_mean_ms": [],
                # fps_capped 自查：重算判据与页面报告不一致的轮次（逐条留原文，便于定位）
                "capped_check": [],
                # 逐轮原始值：per_scene_detail.csv 要能看到每轮原始数字，而不是只剩一个中位数
                "rounds_raw": [],
            },
        )
        if header.get("driver"):
            slot["drivers"].add(header["driver"])
        if header.get("warmup"):
            slot["warmups"].add(header["warmup"])
        if header.get("stage"):
            slot["stages"].add(header["stage"])
        # 机位档（header 优先，逐轮值在下面补）：本文臂 `cam=` ⇔ Flux 臂 `pose_src=`
        pose_src_header = header.get("pose_src") or (
            "flux" if header.get("cam") == "flux" else ("auto" if header.get("cam") == "auto" else "")
        )
        if pose_src_header:
            slot["pose_srcs"].add(pose_src_header)
        if r.get("res_mode"):
            slot["res_modes"].add(r["res_mode"])
        elif header.get("res_mode"):
            slot["res_modes"].add(header["res_mode"])
        if r.get("res"):
            slot["ress"].add(r["res"])
        # 动态相机挡位（逐轮优先，缺字段时退回表头；旧数据两者都没有 → 视为静止协议 spin=0）
        spin = r.get("spin", header.get("spin", "0"))
        if spin is not None:
            slot["spins"].add(str(spin))
        spin_pivot = r.get("spin_pivot", header.get("spin_pivot", ""))
        if spin_pivot:
            slot["spin_pivots"].add(str(spin_pivot))
        # 轨迹模式（2026-09-17 追加）：`rate`（`spin=` 是 deg/帧）| `swing`（`spin=` 是摆幅）
        spin_mode = r.get("spin_mode", header.get("spin_mode", ""))
        if spin_mode:
            slot["spin_modes"].add(str(spin_mode))
        # 内容量扫描（2026-09-17 追加）：逐姿态实测的覆盖率 / 裁剪盒内高斯比例（均值）
        for metric, field in (("sweep_cov_mean", "sweep_cov_mean"), ("sweep_seen_mean", "sweep_seen_mean")):
            value = num(r, field)
            if value is not None:
                slot[metric].append(value)
        sync_ms = num(r, "sync_ms")
        if sync_ms is not None:
            slot["sync_ms"].append(sync_ms)
        if r.get("fps_capped") in ("0", "1"):
            slot["fps_capped"].add(r["fps_capped"])
        for metric, field in (
            ("fps", "fps"),
            ("first_frame_ms", "first_frame_ms"),
            ("fetch_ms", "fetch_ms"),
            ("bytes", "bytes"),
            # 帧内阻塞耗时（2026-09-17 追加）：诊断/自检用，不参与跨臂倍数
            ("frame_ms", "frame_ms"),
            ("frame_mean_ms", "frame_mean_ms"),
        ):
            value = num(r, field)
            if value is not None:
                slot[metric].append(value)
        for metric, field in (("covered", "covered"), ("kept", "kept"), ("visible", "visible")):
            raw = str(r.get(field, "")).rstrip("%")
            try:
                slot[metric].append(float(raw))
            except ValueError:
                pass
        if r.get("res_fallback") == "1":
            slot["res_fb"] = True
        pose = r.get("pose", "")
        if pose:
            slot["poses"].add(pose)
        if r.get("pose_src"):
            slot["pose_srcs"].add(r["pose_src"])
        # fps_capped 自查（2026-09-16 追加）：用该轮 fps 与该轮**实际引用**的地板重算判据，
        # 与页面报告的 fps_capped 比对；对不上说明输出与实际判定不一致，必须查清再用。
        floor_used = num(r, "floor_used_ms")
        if floor_used is not None:
            slot["floor_used_ms"].append(floor_used)
        fps_round = num(r, "fps")
        reported = r.get("fps_capped")
        if floor_used and fps_round and reported in ("0", "1"):
            expect = "1" if (1000.0 / fps_round) <= floor_used * 1.05 else "0"
            if expect != reported:
                slot["capped_check"].append(
                    "round=%s fps=%.1f 1/fps=%.2fms floor_used=%.2fms 报告=%s 重算=%s"
                    % (r.get("round", "?"), fps_round, 1000.0 / fps_round, floor_used, reported, expect)
                )
        # 逐轮原始值（同上）：逐轮差异（机器状态 / 地板抖动）是判断这批数字能不能用的关键
        slot["rounds_raw"].append(
            {
                "round": r.get("round", ""),
                "fps": fps_round,
                "elapsed_ms": num(r, "elapsed_ms"),
                "first_frame_ms": num(r, "first_frame_ms"),
                "decode_ms": num(r, "decode_ms"),
                "floor_used_ms": floor_used,
                "sync_ms": num(r, "sync_ms"),
                # 帧内阻塞耗时（2026-09-17 追加）：诊断/自检用（不可用于算倍数，见 collect 顶部说明）
                "frame_ms": num(r, "frame_ms"),
                "frame_mean_ms": num(r, "frame_mean_ms"),
                "fps_capped": reported if reported in ("0", "1") else "",
            }
        )


def load_manifest(path):
    """清单 → {场景名: {points, storageMB}}"""
    if not os.path.isfile(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    out = {}
    for item in data.get("scenes", []):
        out[item.get("scene") or item.get("id")] = {
            "id": item.get("id"),
            "points": item.get("points"),
            "storageMB": item.get("storageMB"),
        }
    return out


def build_per_scene(scene_stats, r3dgs_manifest, flux_manifest):
    rows = []
    for (arm, dataset, scene), slot in sorted(scene_stats.items()):
        manifest = flux_manifest if arm == "flux-gs" else r3dgs_manifest
        scene_name = scene[6:] if scene.startswith("r3dgs-") else scene
        meta = manifest.get(scene_name, {})
        med = statistics.median

        def med_of(key):
            vals = slot.get(key) or []
            return round(med(vals), 1) if vals else None

        # 逐轮原始值（2026-09-16 追加）：CSV 里同时给出每轮原始数字与中位数
        raw = slot.get("rounds_raw") or []

        def raw_vals(field):
            return [x[field] for x in raw if isinstance(x.get(field), (int, float))]

        def raw_join(field, digits=1):
            vals = raw_vals(field)
            return "/".join(("%.*f" % (digits, v)) for v in vals) or None

        def raw_med(field, digits=1):
            vals = raw_vals(field)
            return round(med(vals), digits) if vals else None

        rows.append(
            {
                "arm": arm,
                "dataset": dataset,
                "scene": scene,
                "scene_name": scene_name,
                "rounds": len(slot["fps"]),
                "cam": slot.get("cam", ""),
                "fps_median": round(med(slot["fps"]), 1) if slot["fps"] else None,
                "first_frame_ms_median": round(med(slot["first_frame_ms"]), 0) if slot["first_frame_ms"] else None,
                "fetch_ms_median": round(med(slot["fetch_ms"]), 0) if slot["fetch_ms"] else None,
                "covered_median": med_of("covered"),
                "kept_median": med_of("kept"),
                "visible_median": med_of("visible"),
                # 计时口径（跨臂可比性核对用）：帧驱动 / 预热帧数 / 台上布局
                "driver": "/".join(sorted(slot.get("drivers") or [])) or "-",
                "warmup": "/".join(sorted(slot.get("warmups") or [])) or "-",
                "stage": "/".join(sorted(slot.get("stages") or [])) or "-",
                # 像素口径：forced=统一像素协议（主表口径）；native=Flux 自适应（仅附录）
                "res_mode": "/".join(sorted(slot.get("res_modes") or [])) or "-",
                "res": "/".join(sorted(slot.get("ress") or [])) or "-",
                # 动态相机挡位（2026-09-17 追加）：0 = 静止协议（论文口径）；非 0 = 效度自查数据
                "spin": "/".join(sorted(slot.get("spins") or [])) or "0",
                "spin_pivot": "/".join(sorted(slot.get("spin_pivots") or [])) or "-",
                # 轨迹模式（`rate` = `spin` 是 deg/帧；`swing` = `spin` 是摆幅）
                "spin_mode": "/".join(sorted(slot.get("spin_modes") or [])) or "rate",
                # 内容量扫描（动态轮才有）：逐姿态实测覆盖率的均值（中位数）
                "sweep_cov_mean_median": med_of("sweep_cov_mean"),
                "sweep_seen_mean_median": med_of("sweep_seen_mean"),
                "sync_ms_median": round(med(slot["sync_ms"]), 2) if slot["sync_ms"] else None,
                "fps_capped": "1" in (slot.get("fps_capped") or set()),
                # 帧内阻塞耗时（2026-09-17 追加）：中位数 + 逐轮值 + 均值口径。
                # **只作诊断/自检**：核对 `cpu_ms ≈ 地板 + frame_ms`，或暴露被地板封顶的臂落在
                # 量化下限上；跨臂倍数**不得取这一列**，只能由帧间隔（1000/fps）之比给出。
                "frame_ms_median": round(med(slot["frame_ms"]), 2) if slot["frame_ms"] else None,
                "frame_ms_raw": raw_join("frame_ms", 2),
                "frame_mean_ms_median": round(med(slot["frame_mean_ms"]), 2) if slot["frame_mean_ms"] else None,
                # 逐轮原始值 + 中位数（2026-09-16 追加）：地板与解码耗时的逐轮差异是判断
                # 这批数字可用性的关键，报表里不能只剩一个中位数。
                "fps_raw": raw_join("fps", 1),
                "elapsed_ms_raw": raw_join("elapsed_ms", 0),
                "floor_used_ms_raw": raw_join("floor_used_ms", 2),
                "floor_used_ms_median": raw_med("floor_used_ms", 2),
                "fps_capped_raw": "/".join(str(x.get("fps_capped", "")) for x in raw) or None,
                "decode_ms_raw": raw_join("decode_ms", 0),
                "decode_ms_median": raw_med("decode_ms", 0),
                "capped_check_mismatch": len(slot.get("capped_check") or []),
                "pose_locked": len(slot.get("poses") or []) <= 1,
                # 机位档与指纹（2026-09-17 追加）：`pose_fingerprint` = 视图矩阵（列主序）前 6 位，
                # 本文臂与 Flux 臂**同格式**（见 bench-measure.viewFingerprint / bench-flux poseKey）；
                # 同一场景多轮取到不同值时会用 "/" 连接（同时 pose_locked=False）。
                "pose_src": "/".join(sorted(slot.get("pose_srcs") or [])) or "-",
                "pose_fingerprint": "/".join(sorted(slot.get("poses") or [])) or "-",
                "pose_rounds": len(slot.get("poses") or []),
                "pose_dmax": None,
                "pose_vs_flux": "",
                "res_fallback": bool(slot.get("res_fb")),
                "storage_mb": meta.get("storageMB"),
                "points": meta.get("points"),
            }
        )
    return rows


# 机位指纹比对容差：`cam=flux` 用 (position, quaternion) 复现 Flux 原相机，与它的原矩阵
# 最大差 0.32°（元素级 ≤ ~0.006，见 src/cameras/Camera.fluxParity.test.ts）。
# 取 0.02：既能容纳这条重建路径的偏差，又能挡住"两个不同机位"（不同机位的元素差通常 > 0.1）。
POSE_TOL = 0.02


def parse_pose_fingerprint(text):
    """把 `pose=` 指纹（视图矩阵前 6 位、逗号分隔）解析成 6 个数；多值/缺失/非法返回 None。"""
    raw = str(text or "").strip()
    if not raw or raw == "-" or "/" in raw:
        return None
    try:
        values = [float(x) for x in raw.split(",")]
    except ValueError:
        return None
    return values if len(values) == 6 else None


def annotate_pose_cross_arm(per_scene):
    """同 (dataset, scene) 下把本文臂与 Flux-GS 臂的机位指纹对上，写 pose_vs_flux / pose_dmax。

    取值：
      match(dmax=0.0031)     两臂机位一致（逐元素最大差 ≤ POSE_TOL）
      MISMATCH(dmax=0.4200)  两臂机位不同 —— 该场景 FPS 不可直接跨臂比对
      no-fingerprint         本行或对照行的报告里没有 pose=（旧版页面采集，需重跑）
      no-flux                该场景没有 Flux-GS 臂数据
    """
    by_scene = {}
    for row in per_scene:
        by_scene.setdefault((row["dataset"], row["scene_name"]), {})[row["arm"]] = row
    for (_dataset, _scene), arms in by_scene.items():
        ours = arms.get("ours")
        flux = arms.get("flux-gs")
        if ours is None:
            continue
        ours_fp = parse_pose_fingerprint(ours.get("pose_fingerprint"))
        flux_fp = parse_pose_fingerprint(flux.get("pose_fingerprint")) if flux else None
        if flux is None:
            ours["pose_vs_flux"] = "no-flux"
            continue
        if ours_fp is None or flux_fp is None:
            ours["pose_vs_flux"] = "no-fingerprint"
            flux["pose_vs_flux"] = "no-fingerprint"
            continue
        dmax = max(abs(a - b) for a, b in zip(ours_fp, flux_fp))
        ours["pose_dmax"] = round(dmax, 4)
        ours["pose_vs_flux"] = "%s(dmax=%.4f)" % ("match" if dmax <= POSE_TOL else "MISMATCH", dmax)
        flux["pose_vs_flux"] = "-"  # 结论只记在本文臂那一行，避免同一条结论出现两次


def aggregate_datasets(per_scene):
    """数据集行 = 已覆盖场景中位数的算术平均。"""
    rows = {}
    for row in per_scene:
        slot = rows.setdefault((row["arm"], row["dataset"]), {"scenes": [], "fps": [], "ff": [], "storage": []})
        slot["scenes"].append(row["scene_name"])
        if row["fps_median"] is not None:
            slot["fps"].append(row["fps_median"])
        if row["first_frame_ms_median"] is not None:
            slot["ff"].append(row["first_frame_ms_median"])
        if row["storage_mb"] is not None:
            slot["storage"].append(row["storage_mb"])
    return rows


def render_comparability(per_scene):
    lines = ["", "## 可比性核对（视角与计时口径是否一致）", ""]
    lines.append(
        "| 场景 | 方法 | 机位 | 机位指纹（vs 基线） | 驱动 | 分辨率口径 | res | 布局 | warmup | FPS(中位) | sync_ms | 帧内阻塞ms(中位/逐轮) | covered% | kept% | visible(百万) | 机位锁定 |"
    )
    lines.append("|---|---|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|:--:|")
    flags = []
    by_scene = {}
    for row in sorted(per_scene, key=lambda r: (r["dataset"], r["scene_name"], r["arm"])):
        vis = row["visible_median"]
        fp = str(row.get("pose_fingerprint") or "-")
        verdict = str(row.get("pose_vs_flux") or "")
        pose_cell = "-"
        if fp != "-":
            # 表里只显示前 3 个分量（完整值见 per_scene_detail.csv），后缀是跨臂结论
            pose_cell = ",".join(fp.split(",")[:3]) + ",…"
            if verdict and verdict != "-":
                pose_cell += " " + verdict
        elif verdict:
            pose_cell = verdict
        # 帧内阻塞耗时（2026-09-17 追加）：中位数 / 各轮。**只作诊断/自检**（地板贴住时两臂读数都在
        # 量化下限上），跨臂倍数不得取这一列，只能由帧间隔（1000/fps）之比给出。
        fmed = row.get("frame_ms_median")
        frame_cell = "—" if fmed is None else f"{fmed} / {row.get('frame_ms_raw') or '—'}"
        lines.append(
            f"| {row['scene_name']} | {row['arm']} | {row['cam'] or '-'} | {pose_cell} | {row.get('driver') or '-'} | "
            f"{row.get('res_mode') or '-'} | {row.get('res') or '-'} | "
            f"{row.get('stage') or '-'} | {row.get('warmup') or '-'} | "
            f"{row['fps_median'] if row['fps_median'] is not None else '—'} | "
            f"{row['sync_ms_median'] if row['sync_ms_median'] is not None else '—'} | "
            f"{frame_cell} | "
            f"{row['covered_median'] if row['covered_median'] is not None else '—'} | "
            f"{row['kept_median'] if row['kept_median'] is not None else '—'} | "
            f"{round(vis / 1e6, 3) if vis else '—'} | "
            f"{'OK' if row['pose_locked'] else 'BAD'} |"
        )
        by_scene.setdefault((row["dataset"], row["scene_name"]), []).append(row)
        if not row["pose_locked"]:
            flags.append(f"{row['scene_name']}/{row['arm']}：多轮机位不一致（说明视角未固定，FPS 不可用）")
        # 跨臂机位一致性（2026-09-17 追加）：逐元素比对指纹，比"看画面是否像"更硬
        if str(row.get("pose_vs_flux") or "").startswith("MISMATCH"):
            flags.append(
                f"{row['scene_name']}/{row['arm']}：与 Flux-GS 臂机位指纹不一致（{row['pose_vs_flux']}）"
                "—— 两臂没在同一机位测帧，该场景 FPS 不可直接跨臂比对"
                "（本文臂链接需带 cam=flux；默认值已改为 flux，新链接不写也对齐）"
            )
        if row.get("res_fallback"):
            flags.append(
                f"{row['scene_name']}/{row['arm']}：res 回退到默认分辨率"
                "，该批数字不满足统一像素协议，需先确认链接未写 force=native 后重测"
            )
        # 统一像素协议（主表口径）：三臂都必须是 res_mode=forced 且 res=1600x1063
        if row.get("res_mode") == "native":
            flags.append(
                f"{row['scene_name']}/{row['arm']}：res_mode=native（Flux-GS 自适应分辨率）"
                "—— 各臂分辨率不对等，**不得进跨方法主表**，只能作为附录的部署资源说明"
            )
        elif row.get("res") not in ("-", "1600x1063"):
            flags.append(
                f"{row['scene_name']}/{row['arm']}：res={row['res']} ≠ 统一像素协议 1600x1063"
                "（该行不可与主表其它行直接比较）"
            )
        # 动态相机（2026-09-17 追加）：`?spin=` 是"相机在测量窗口内转动"的**效度自查**挡位。
        # 论文主表口径是静止协议（spin=0）；两者混在一起会把"每帧排不排序"的差别算进方法差距里，
        # 所以这里与 res_mode=native 同样处理：**明确标出、不得进跨方法主表**。
        spins = [s for s in str(row.get("spin") or "").split("/") if s and s.strip() not in ("0", "0.000", "0.0")]
        if spins:
            modes = "/".join(sorted(set(str(row.get("spin_mode") or "rate").split("/"))))
            flags.append(
                f"{row['scene_name']}/{row['arm']}：含动态相机数据（mode={modes}，"
                f"spin={'/'.join(sorted(spins))}{' deg/帧' if modes == 'rate' else ' deg(摆幅)'}，"
                f"pivot={row.get('spin_pivot') or '-'}）—— 这是效度自查口径，**不得进跨方法主表**"
                "（主表口径为静止协议 spin=0；动态数据见 §7.9 的效度验证小节）"
                # 内容量扫描（2026-09-17 追加）：判断该行 fps 差异能否归因于实现的**前提**是两臂看着
                # 同量级的内容；这里把该行的实测值摆出来，跨臂核对时直接比大小。
                + (
                    f"；本行内容量扫描 sweep_cov_mean={row['sweep_cov_mean_median']}%、"
                    f"sweep_seen_mean={row['sweep_seen_mean_median']}%（请与另一臂同挡位对照："
                    "差值大说明画面内容量不同，该挡位的 fps 差异不能只归因于实现）"
                    if row.get("sweep_cov_mean_median") is not None
                    else ""
                )
            )
        if row.get("fps_capped"):
            fmed = row.get("frame_ms_median")
            fnote = (
                f"；本行帧内阻塞耗时（frame_ms）中位数为 {fmed} ms，只能用来核对"
                " `cpu_ms ≈ 地板 + frame_ms`，**不得用于算两臂倍数**"
                if fmed is not None
                else "；本批结果缺 frame_ms（帧内阻塞耗时）字段，无法核对本行的地板关系"
            )
            flags.append(
                f"{row['scene_name']}/{row['arm']}：fps_capped=1（帧率贴到该轮实测地板 floor_used_ms 的驱动上限）"
                "—— 该 FPS 是驱动节奏上限而非渲染极限，本行的每帧耗时可报的只是**上界**（≤ 1000/fps 的读数）；"
                "跨臂倍数只能由**帧间隔之比**给出，且被地板封顶的一侧只能给下界"
                "（frame_ms 落在 performance.now() 的 100µs 量化下限上，两端都不可作分子分母）" + fnote
            )
        # fps_capped 自查（2026-09-16 追加）：用逐轮 fps 与 floor_used_ms 重算判据，与页面报告比对
        if row.get("capped_check_mismatch"):
            flags.append(
                f"{row['scene_name']}/{row['arm']}：fps_capped 自查不通过（{row['capped_check_mismatch']} 轮）"
                "—— 逐轮 fps / floor_used_ms 重算的判据结果与页面报告不一致，数据不可直接引用"
            )
    for (_, scene_name), rows in by_scene.items():
        cov = [r["covered_median"] for r in rows if r["covered_median"] is not None]
        if len(cov) >= 2 and (max(cov) - min(cov)) > 15:
            flags.append(
                f"{scene_name}：两臂画面覆盖率相差 {max(cov) - min(cov):.1f} 个百分点"
                "（>15 说明两臂实际渲染负载不可比，需换近/远景档或用 covered% 归一化后比较）"
            )
        # 帧驱动一致性（2026-09-16 追加）：两臂必须同驱动 —— rAF 每次只申请一个 vsync 间隔，
        # 会被屏幕刷新率封顶（60Hz 设备最多报 60），与基线 setTimeout(0) 链的 FPS 定义不同。
        drivers = {}
        missing = []
        for r in rows:
            raw_driver = str(r.get("driver") or "")
            if not raw_driver or raw_driver == "-":
                missing.append(r["arm"])
                continue
            for d in raw_driver.split("/"):
                if d:
                    drivers.setdefault(d, []).append(r["arm"])
        if len(drivers) > 1:
            parts = "; ".join(
                "%s(%s)" % (d, "/".join(sorted(set(arms)))) for d, arms in sorted(drivers.items())
            )
            flags.append(
                "%s：两臂帧驱动不一致（%s）—— FPS 不可横向比较，本文臂链接必须带 &driver=timer"
                % (scene_name, parts)
            )
        if "raf" in drivers:
            flags.append(
                "%s：存在 raf 口径的数据（每帧只申请一个 vsync 间隔，会被屏幕刷新率封顶），"
                "不可与 timer 口径混在同一张表里统计" % scene_name
            )
        if missing and drivers:
            flags.append(
                "%s：%s 的结果缺 driver= 字段（旧版页面采集），无法核对驱动一致性，勿与新数据合并统计"
                % (scene_name, "/".join(sorted(set(missing))))
            )
        # 台上布局 / 预热帧数一致性（2026-09-16 追加）：协议值为 stage=fit1 + warmup=0
        stages = set()
        warmups = set()
        for r in rows:
            for one in str(r.get("stage") or "").split("/"):
                if one and one != "-":
                    stages.add(one)
            for one in str(r.get("warmup") or "").split("/"):
                if one and one != "-":
                    warmups.add(one)
        if len(stages) > 1:
            flags.append(
                "%s：两臂台上布局不一致（%s）—— fit1 = iframe 布局尺寸 = res 像素 + CSS 等比缩放（协议值），"
                "fill = 铺满渲染区，两者窗口/画布比例不同" % (scene_name, "/".join(sorted(stages)))
            )
        if len(warmups) > 1:
            flags.append(
                "%s：两臂预热帧数不一致（%s）—— 主表口径为 warmup=0（无预热，与其原实现一致）"
                % (scene_name, "/".join(sorted(warmups)))
            )
    # 机位指纹缺失的汇总（2026-09-17 追加）：旧版页面采集的报告没有逐轮 pose=，
    # 逐行报警会把说明刷屏，因此只汇总一条，并指明"重跑一次即有指纹"。
    no_fp = [r for r in per_scene if str(r.get("pose_vs_flux") or "") == "no-fingerprint"]
    if no_fp:
        flags.append(
            "机位指纹缺失 %d 行（场景：%s）：这批报告由旧版页面采集，未输出逐轮 pose=；"
            "现在的页面会逐轮打印 pose=（与 Flux-GS 臂同格式），重跑一次即可用指纹硬核机位，"
            "在此之前只能靠 cam= / pose_src= 核对机位档（本文臂 cam=flux ⇔ Flux 臂 pose_src=flux）"
            % (len(no_fp), "、".join(sorted({r["scene_name"] for r in no_fp}))[:120])
        )
    if flags:
        lines += ["", "**需要处理的可比性问题：**"] + [f"- {f}" for f in flags]
    else:
        lines += ["", "两臂机位锁定且覆盖率差异在 15 个百分点以内，FPS 可直接横向比较。"]
    return "\n".join(lines) + "\n"


def render_markdown(dataset_rows, per_scene):
    lines = ["# 表 7-2/7-3/7-4 对比方法数据行（脚本生成）", ""]
    lines.append("| 数据集 | 方法 | FPS↑ | First Frame(s)↓ | Storage(MB)↓ | 覆盖场景 |")
    lines.append("|---|---|---:|---:|---:|---|")
    for dataset in DATASET_ORDER:
        for arm in ("reduced-3dgs", "flux-gs"):
            slot = dataset_rows.get((arm, dataset))
            if not slot or not slot["scenes"]:
                lines.append(f"| {DATASET_LABEL[dataset]} | {arm} | — | — | — | 未测 |")
                continue
            fps = f"{statistics.fmean(slot['fps']):.1f}" if slot["fps"] else "—"
            ff = f"{statistics.fmean(slot['ff']) / 1000:.2f}" if slot["ff"] else "—"
            storage = f"{statistics.fmean(slot['storage']):.1f}" if slot["storage"] else "—"
            covered = f"{len(slot['scenes'])}/{DATASET_TOTAL[dataset]}（{', '.join(slot['scenes'])}）"
            lines.append(f"| {DATASET_LABEL[dataset]} | {arm} | {fps} | {ff} | {storage} | {covered} |")
    lines += [
        "",
        "> 填表规则：FPS 取该数据集内**已覆盖场景**中位数的算术平均（主表口径＝统一像素协议：三臂同 `res_mode=forced`、",
        "> 1600×1063、300 帧、无预热、`setTimeout(0)` 链驱动（`driver=timer`）、每帧 `gl.finish()` 同步、",
        "> 起表点 = 首帧绘制完成 → 末帧绘制完成）；",
        "> 若某行 `res_mode=native`（Flux-GS 自适应分辨率）或 `fps_capped=1`，**不得按上一条直接进主表**——",
        "> native 只能进附录的部署资源说明，`fps_capped=1` 的数字是驱动节奏上限而非渲染极限；",
        "> First Frame 为\"文件获取完成后→首帧\"的秒数（脚本已把 ms 换算为 s）；覆盖列不满覆盖时，",
        "> 论文表注必须写明覆盖子集；Flux-GS 的 Storage 为其压缩模型文件体积均值，",
        "> 与论文报告值口径不同时需在表注中分别标注。",
    ]
    return "\n".join(lines) + "\n" + render_comparability(per_scene)


def main():
    root = repo_root()
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="*", help="raw 结果文本；缺省则扫描 --raw-dir")
    parser.add_argument("--raw-dir", default=os.path.join(root, "thesis_project", "data", "ch7_measurements", "raw"))
    parser.add_argument("--out-dir", default=os.path.join(root, "thesis_project", "data", "ch7_measurements", "out"))
    args = parser.parse_args()

    files = args.files or sorted(glob.glob(os.path.join(args.raw_dir, "*.txt")))
    if not files:
        print(f"没有找到结果文本：{args.raw_dir}")
        print("先把结果卡片 copy 的文本保存为 .txt，或直接用命令行传入文件路径。")
        return 1

    scene_stats = {}
    for path in files:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        blocks = parse_result_blocks(text)
        for block in blocks:
            collect(scene_stats, block["header"], block["rounds"])
        print(f"[parse] {os.path.basename(path)} → blocks={len(blocks)}")
    if not scene_stats:
        print("没有解析到任何有效轮次（检查 ok= / drawOk= 字段）")
        return 1

    per_scene = build_per_scene(
        scene_stats,
        load_manifest(os.path.join(root, "gsplat.js", "baseline-scenes.json")),
        load_manifest(os.path.join(root, "gsplat.js", "flux-baseline-scenes.json")),
    )
    annotate_pose_cross_arm(per_scene)
    dataset_rows = aggregate_datasets(per_scene)

    os.makedirs(args.out_dir, exist_ok=True)
    with open(os.path.join(args.out_dir, "per_scene_detail.csv"), "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(per_scene[0].keys()))
        writer.writeheader()
        writer.writerows(per_scene)
    markdown = render_markdown(dataset_rows, per_scene)
    with open(os.path.join(args.out_dir, "table7_2_7_4_baseline_rows.md"), "w", encoding="utf-8") as f:
        f.write(markdown)
    with open(os.path.join(args.out_dir, "aggregated.json"), "w", encoding="utf-8") as f:
        json.dump(
            {"per_scene": per_scene, "dataset_rows": {f"{k[0]}|{k[1]}": v for k, v in dataset_rows.items()}},
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(markdown)
    print(f"[out] {os.path.join(args.out_dir, 'table7_2_7_4_baseline_rows.md')}")
    print(f"[out] {os.path.join(args.out_dir, 'per_scene_detail.csv')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
