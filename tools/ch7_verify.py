# -*- coding: utf-8 -*-
"""第 7 章统一测量协议（docs/ch7_measurement_protocol.md）的资产登记与批次校验工具。

两个子命令：

  # 1) 生成/刷新资产登记（协议 §4.3）。会同时写工作副本与入库镜像（docs/ 下）
  python gsplat.js/tools/ch7_verify.py manifest

  # 2) 校验原始数据是否齐全、字段是否完整、资产是否对得上（协议 §4.2 / §6）
  python gsplat.js/tools/ch7_verify.py verify --write-index

期望文件数（协议 §4.2，合计 186）：
  main：13 场景 × 4 平台 × 3 轮 = 156
  load：3 场景 × 2 臂 × 3 轮 = 18（platform=gen3）
  res ：4 档分辨率 × 3 轮 = 12（platform=rtx4060，表 7-8）

退出码：0=全部通过；1=有缺失/字段不全/资产不一致；2=参数或前置条件错误。
"""

import argparse
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ch7_common as C            # noqa: E402
import inspect_ply_header as H    # noqa: E402  复用同目录既有的 PLY 头部解析

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

MANIFEST_FIELDS = ["scene", "dataset", "file", "format", "arm", "points", "sh_basis",
                   "bytes", "mb", "sha256", "groups", "codebook_props",
                   "source_batch", "used_by_tables"]

ASSET_RE = re.compile(r"^point_cloud_quantised_half_(?P<arm>r\d+|std\d+)-(?P<scene>[A-Za-z0-9_]+)\.ply$")


def parse_asset_name(name):
    """`point_cloud_quantised_half_r7-garden.ply` → ("garden", "r7")；不匹配返回 (stem, "?")。"""
    m = ASSET_RE.match(name)
    if m:
        return m.group("scene").lower(), m.group("arm")
    return os.path.splitext(name)[0], "?"


def inspect_asset(path, dataset_map):
    header = H.read_header(path)
    counts = H.parse_element_counts(header)
    info = H.inspect(path)
    scene, arm = parse_asset_name(os.path.basename(path))
    used = "表 7-5（标准臂）" if arm.startswith("std") else "表 7-2/7-3/7-4/7-7（主表）"
    return {
        "scene": scene,
        "dataset": dataset_map.get(scene, ""),
        "file": os.path.basename(path),
        "format": info["format"],
        "arm": arm,
        "points": info["vertex_total"],
        "sh_basis": counts.get("sh_basis", 0),
        "bytes": info["bytes"],
        "mb": info["mb"],
        "sha256": C.hash_file(path),
        "groups": info["groups"],
        "codebook_props": info["codebook_props"],
        "source_batch": "",
        "used_by_tables": used,
    }


def cmd_manifest(args):
    scenes_dir = args.scenes_dir
    if not os.path.isdir(scenes_dir):
        print("✗ 资产目录不存在：%s" % scenes_dir)
        return 2
    dataset_map = C.scene_datasets()
    bench_points = {s["id"]: s.get("points") for s in C.load_bench_scenes()}
    rows, unknown, mismatch = [], [], []
    for name in sorted(os.listdir(scenes_dir)):
        if not name.lower().endswith(".ply"):
            continue
        path = os.path.join(scenes_dir, name)
        row = inspect_asset(path, dataset_map)
        rows.append(row)
        if row["arm"] == "?":
            unknown.append(name)
        elif row["arm"].startswith("r") and bench_points.get(row["scene"]) not in (None, row["points"]):
            mismatch.append("%s: manifest=%d vs bench-scenes.json=%s"
                            % (row["scene"], row["points"], bench_points[row["scene"]]))
    rows.sort(key=lambda r: (r["arm"] != "r7", r["scene"]))
    C.write_csv(args.out, MANIFEST_FIELDS, rows)
    C.write_csv(args.mirror, MANIFEST_FIELDS, rows)

    print("已写资产登记：")
    print("  工作副本：%s（%d 行）" % (args.out, len(rows)))
    print("  入库镜像：%s" % args.mirror)
    total_bytes = sum(int(r["bytes"]) for r in rows)
    print("  合计体积：%d 字节（%.1f MB）" % (total_bytes, total_bytes / 1024 / 1024))
    for row in rows:
        print("  %-9s %-6s %-7s points=%-8d sh_basis=%-3s %8.2f MB  sha256=%s"
              % (row["scene"], row["arm"], row["format"], row["points"], row["sh_basis"],
                 row["mb"], (row["sha256"] or "")[:12]))
    if unknown:
        print("⚠ 命名不符合 `point_cloud_quantised_half_<arm>-<scene>.ply` 的文件（不作为资产入库）：")
        for name in unknown:
            print("   - %s" % name)
    if mismatch:
        print("✗ 点数与 bench-scenes.json 不一致：")
        for line in mismatch:
            print("   - %s" % line)
        return 1
    missing_std = [s for s in C.LOAD_SCENES if not any(
        r["scene"] == s and r["arm"].startswith("std") for r in rows)]
    if missing_std:
        print("ℹ 表 7-5 标准臂资产尚未导出（%s）——见协议 §7 卡点 2（需训练机）。" % ", ".join(missing_std))
    return 0


# --------------------------------------------------------------------------- 批次校验

ROUND_INDEX_FIELDS = ["protocol_id", "group", "platform", "scene_key", "round", "scene",
                      "fps", "cpu_ms", "frame_ms", "fps_capped", "floor_used_ms",
                      "points", "bytes", "sync_ms", "ts", "sha256"]


def load_round_file(path):
    """兼容两种落盘形态，返回 `(header, [轮次字典, ...])`：

    ① 规范化逐轮 JSON：顶层直接含 `fps`/`frame_ms`/`fps_capped`/`floor_used_ms`；
    ② CDP 原始输出：`{"value": "<页面结果文本>"}`（`value` 也可能是结果对象）。
    无法解析时返回 `({}, [])`。
    """
    import json
    with io.open(path, "r", encoding="utf-8") as fh:
        try:
            obj = json.load(fh)
        except ValueError:
            return {}, []
    if isinstance(obj, dict) and "fps" in obj:
        return obj, [obj]
    value = obj.get("value") if isinstance(obj, dict) else None
    if isinstance(value, dict) and "fps" in value:
        return value, [value]
    if isinstance(value, str) and "--- per-round ---" in value:
        return C.parse_result_text(value)
    return {}, []


def pick_round(rounds, scene, n):
    """从（可能是整页 39 轮的）解析结果里取出目标场景第 n 轮。"""
    for item in rounds:
        try:
            same_round = int(item.get("round", 0) or 0) == n
        except (TypeError, ValueError):
            same_round = False
        if str(item.get("scene", "")) == scene and same_round:
            return item
    if len(rounds) == 1:
        return rounds[0]
    return None


def _int_or_none(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def cmd_verify(args):
    lookup = C.read_manifest(args.manifest)
    if not lookup:
        print("✗ 资产登记为空或不存在：%s" % args.manifest)
        print("  先跑：python gsplat.js/tools/ch7_verify.py manifest")
        return 2
    groups = [g for g in args.groups.split(",") if g]
    platforms = [p for p in args.platforms.split(",") if p]
    table, total_expected = C.expected_files()

    missing, short_fields, asset_bad, index_rows = [], [], [], []
    protocol_id = ""
    if os.path.isfile(C.PROTOCOL_SNAPSHOT):
        try:
            import json
            with io.open(C.PROTOCOL_SNAPSHOT, "r", encoding="utf-8") as fh:
                protocol_id = json.load(fh).get("protocol_id", "")
        except (ValueError, OSError):
            protocol_id = ""

    print("原始数据根目录：%s" % args.root)
    print("协议快照 protocol_id：%s" % (protocol_id or "（未生成）"))
    print("-" * 78)
    got_total, exp_total = 0, 0
    for (grp, plat), exp in sorted(table.items()):
        if grp not in groups or plat not in platforms:
            continue
        exp_total += exp
        got, capped = 0, 0
        for key in C.scene_keys(grp, plat):
            scene = key.split("-")[0]
            arm = key.split("-", 1)[1] if grp == C.GRP_LOAD else "r7"
            for n in range(1, C.ROUNDS + 1):
                rel = "%s/%s/round%d.json" % (plat, key, n)
                path = os.path.join(args.root, plat, key, "round%d.json" % n)
                if not os.path.isfile(path):
                    missing.append(rel)
                    continue
                got += 1
                header, rounds = load_round_file(path)
                rnd = pick_round(rounds, scene, n)
                if rnd is None:
                    short_fields.append("%s：解析不出 scene=%s round=%d" % (rel, scene, n))
                    continue
                blank = [f for f in C.REQUIRED_FIELDS if rnd.get(f) in (None, "", "-")]
                if blank:
                    short_fields.append("%s：缺必填字段 %s" % (rel, ",".join(blank)))
                if rnd.get("fps_capped") == 1:
                    capped += 1
                row = lookup.get((scene, arm))
                if grp == C.GRP_RES:
                    row = lookup.get((scene, "r7"))
                if row:
                    exp_points = _int_or_none(row.get("points"))
                    exp_bytes = _int_or_none(row.get("bytes"))
                    if exp_points is not None and rnd.get("points") not in (None, exp_points):
                        asset_bad.append("%s：points=%s ≠ 登记 %d" % (rel, rnd.get("points"), exp_points))
                    if exp_bytes is not None and rnd.get("bytes") not in (None, exp_bytes):
                        asset_bad.append("%s：bytes=%s ≠ 登记 %d" % (rel, rnd.get("bytes"), exp_bytes))
                else:
                    asset_bad.append("%s：资产登记里没有 %s/%s" % (rel, scene, arm))
                index_rows.append({
                    "protocol_id": protocol_id, "group": grp, "platform": plat, "scene_key": key,
                    "round": n, "scene": scene, "fps": rnd.get("fps"), "cpu_ms": rnd.get("cpu_ms"),
                    "frame_ms": rnd.get("frame_ms"), "fps_capped": rnd.get("fps_capped"),
                    "floor_used_ms": rnd.get("floor_used_ms"), "points": rnd.get("points"),
                    "bytes": rnd.get("bytes"), "sync_ms": rnd.get("sync_ms"),
                    "ts": header.get("ts", ""), "sha256": C.hash_file(path),
                })
        got_total += got
        print("%s %-4s / %-7s 实收 %2d / 应收 %2d   贴地板轮次 %d/%d"
              % ("✓" if got == exp else "✗", grp, plat, got, exp, capped, max(got, 1)))
    print("-" * 78)
    print("合计 实收 %d / 应收 %d（统计范围：组=%s 平台=%s；协议全量 %d）"
          % (got_total, exp_total, ",".join(groups), ",".join(platforms), total_expected))
    for title, items in (("缺失文件", missing), ("字段/解析问题", short_fields), ("资产对账不一致", asset_bad)):
        if items:
            print("✗ %s（%d）：" % (title, len(items)))
            for line in items[:60]:
                print("   - %s" % line)
            if len(items) > 60:
                print("   … 其余 %d 条省略" % (len(items) - 60))
    if args.write_index and index_rows:
        C.write_csv(args.write_index, ROUND_INDEX_FIELDS, index_rows)
        print("已写入轮次索引（可入库）：%s（%d 行）" % (args.write_index, len(index_rows)))
def build_parser():
    parser = argparse.ArgumentParser(description="第 7 章测量协议：资产登记与批次校验")
    sub = parser.add_subparsers(dest="cmd")

    p1 = sub.add_parser("manifest", help="生成资产登记 CSV（工作副本 + docs/ 入库镜像）")
    p1.add_argument("--scenes-dir", default=C.SCENES_DIR)
    p1.add_argument("--out", default=C.MANIFEST)
    p1.add_argument("--mirror", default=C.MANIFEST_MIRROR)
    p1.set_defaults(func=cmd_manifest)

    p2 = sub.add_parser("verify", help="校验原始数据齐全性、必填字段、与资产登记的一致性")
    p2.add_argument("--root", default=C.RAW_ROOT)
    p2.add_argument("--manifest", default=C.MANIFEST)
    p2.add_argument("--groups", default="main,load,res")
    p2.add_argument("--platforms", default=",".join(C.PLATFORMS))
    p2.add_argument("--write-index", default="", help="把逐轮索引写到指定 CSV（建议 %s）" % C.RAW_INDEX)
    p2.set_defaults(func=cmd_verify)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

