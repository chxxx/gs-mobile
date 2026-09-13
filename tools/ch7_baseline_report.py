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
            },
        )
        for metric, field in (
            ("fps", "fps"),
            ("first_frame_ms", "first_frame_ms"),
            ("fetch_ms", "fetch_ms"),
            ("bytes", "bytes"),
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
                "pose_locked": len(slot.get("poses") or []) <= 1,
                "res_fallback": bool(slot.get("res_fb")),
                "storage_mb": meta.get("storageMB"),
                "points": meta.get("points"),
            }
        )
    return rows


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
    lines = ["", "## 可比性核对（视角是否一致）", ""]
    lines.append("| 场景 | 方法 | 机位 | FPS(中位) | covered% | kept% | visible(百万) | 机位锁定 |")
    lines.append("|---|---|---|---:|---:|---:|---:|:--:|")
    flags = []
    by_scene = {}
    for row in sorted(per_scene, key=lambda r: (r["dataset"], r["scene_name"], r["arm"])):
        vis = row["visible_median"]
        lines.append(
            f"| {row['scene_name']} | {row['arm']} | {row['cam'] or '-'} | "
            f"{row['fps_median'] if row['fps_median'] is not None else '—'} | "
            f"{row['covered_median'] if row['covered_median'] is not None else '—'} | "
            f"{row['kept_median'] if row['kept_median'] is not None else '—'} | "
            f"{round(vis / 1e6, 3) if vis else '—'} | "
            f"{'OK' if row['pose_locked'] else 'BAD'} |"
        )
        by_scene.setdefault((row["dataset"], row["scene_name"]), []).append(row)
        if not row["pose_locked"]:
            flags.append(f"{row['scene_name']}/{row['arm']}：多轮机位不一致（说明视角未固定，FPS 不可用）")
        if row.get("res_fallback"):
            flags.append(
                f"{row['scene_name']}/{row['arm']}：res=table 回退到默认分辨率（bench-resolutions.json 为空）"
                "，该批数字不满足参考协议，需先跑 Flux-GS 臂再重测"
            )
    for (_, scene_name), rows in by_scene.items():
        cov = [r["covered_median"] for r in rows if r["covered_median"] is not None]
        if len(cov) >= 2 and (max(cov) - min(cov)) > 15:
            flags.append(
                f"{scene_name}：两臂画面覆盖率相差 {max(cov) - min(cov):.1f} 个百分点"
                "（>15 说明两臂实际渲染负载不可比，需换近/远景档或用 covered% 归一化后比较）"
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
        "> 填表规则：FPS 取该数据集内**已覆盖场景**中位数的算术平均（参考协议：逐场景原生分辨率、300 帧、无预热）；",
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
