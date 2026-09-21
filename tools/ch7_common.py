# -*- coding: utf-8 -*-
"""第 7 章统一测量协议（docs/ch7_measurement_protocol.md）的共享常量与解析工具。

约定（与协议 §2/§4 一一对应）：
- 场景清单唯一来源：`gsplat.js/bench-scenes.json`（13 项，带 dataset 分组）；
- 原始数据落盘：`thesis_project/data/ch7_measurements/raw/{platform}/{scene_key}/round{n}.json`；
- 三个批次组：
    main = 13 场景 × 4 平台 × 3 轮 = 156（表 7-2/7-3/7-4/7-7）
    load = 3 场景 × 2 臂 × 3 轮 = 18（表 7-5，platform=gen3，scene_key={scene}-r7 / {scene}-std45）
    res  = 4 档分辨率 × 3 轮 = 12（表 7-8，platform=rtx4060，scene_key=garden-{WxH}）
  合计 186 份，见协议 §4.2；
- 资产登记：`thesis_project/data/ch7_measurements/scenes_manifest.csv`（本地工作副本）
  与 `docs/ch7_assets_manifest.csv`（入库镜像，因 `thesis_project/` 被主仓 .gitignore 忽略）。
"""

import csv
import hashlib
import io
import json
import os

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
GS_REPO = os.path.dirname(TOOLS_DIR)                       # .../gsplat.js
PROJECT_ROOT = os.path.dirname(GS_REPO)                    # .../Plasticity-Pruning-GS

CH7_DIR = os.path.join(PROJECT_ROOT, "thesis_project", "data", "ch7_measurements")
RAW_ROOT = os.path.join(CH7_DIR, "raw")
MANIFEST = os.path.join(CH7_DIR, "scenes_manifest.csv")
MANIFEST_MIRROR = os.path.join(PROJECT_ROOT, "docs", "ch7_assets_manifest.csv")
PROTOCOL_SNAPSHOT = os.path.join(CH7_DIR, "protocol.json")
RAW_INDEX = os.path.join(PROJECT_ROOT, "docs", "ch7_raw_index.csv")

SCENES_DIR = os.path.join(GS_REPO, "scenes")
BENCH_SCENES_JSON = os.path.join(GS_REPO, "bench-scenes.json")
BENCH_PAGE = "bench.html"
PROTOCOL_DOC = os.path.join(PROJECT_ROOT, "docs", "ch7_measurement_protocol.md")

# 平台标识（协议 §2）
PLATFORMS = ("rtx4060", "gen2", "gen3", "d9400")
PLATFORM_LABEL = {
    "rtx4060": "RTX 4060 Laptop / Chrome Windows（含无头）",
    "gen2": "Snapdragon 8 Gen 2 / Adreno 740",
    "gen3": "Snapdragon 8 Gen 3 / Adreno 750",
    "d9400": "Dimensity 9400 / Mali",
}

# 批次组
GRP_MAIN, GRP_LOAD, GRP_RES = "main", "load", "res"
ROUNDS = 3
LOAD_SCENES = ("garden", "truck", "drjohnson")
LOAD_ARMS = ("r7", "std45")
RES_TIERS = ("800x531", "1600x1063", "2400x1596", "3200x2126")

# 统一口径参数（协议 §2）——URL 里每一项都显式写出，不依赖页面默认值。
# `profile` 采用「显式点名场景」写法（不写 `full`）：这样新增基线/标准臂资产时，
# `full` 的含义不会被悄悄改变，跑批范围与期望文件数始终精确可控（协议 §4.2）。
PROTO_PARAMS = {
    "mode": "bench",
    "res_mode": "forced",
    "res": "1600x1063",
    "dpr": "1",
    "frames": "300",
    "driver": "timer",
    "warmup": "0",
    "proto": "flux",
    "cold": "1",
    "rounds": str(ROUNDS),
}

REQUIRED_FIELDS = ("fps", "frame_ms", "fps_capped", "floor_used_ms")
AUX_FIELDS = ("cpu_ms", "points", "bytes", "parse_ms", "first_frame_ms", "fetch_ms",
              "covered", "kept", "timer_floor_ms", "sync_ms", "chip", "gl_renderer")


# --------------------------------------------------------------------------- 场景清单

def load_bench_scenes(path=None):
    """读 bench-scenes.json → [ {id, dataset, demo, points, file} ]（按文件顺序）。"""
    path = path or BENCH_SCENES_JSON
    with io.open(path, "r", encoding="utf-8") as fh:
        obj = json.load(fh)
    return obj["scenes"] if isinstance(obj, dict) else obj


def scene_ids(path=None):
    return [s["id"] for s in load_bench_scenes(path)]


def scene_datasets(path=None):
    return {s["id"]: s.get("dataset", "") for s in load_bench_scenes(path)}


def scene_keys(group, platform):
    """返回该 (组, 平台) 下的 scene_key 列表（即 raw/ 下的一级子目录名）。"""
    if group == GRP_MAIN:
        return list(scene_ids())
    if group == GRP_LOAD:
        if platform != "gen3":
            return []
        return ["%s-%s" % (s, arm) for s in LOAD_SCENES for arm in LOAD_ARMS]
    if group == GRP_RES:
        if platform != "rtx4060":
            return []
        return ["garden-%s" % t for t in RES_TIERS]
    raise ValueError("未知批次组：%s" % group)


def expected_files(group=None, platform=None):
    """(group, platform) → 期望文件数；不带参数时返回 {(group, platform): n} 与总计。"""
    table = {}
    for grp in (GRP_MAIN, GRP_LOAD, GRP_RES):
        for plat in PLATFORMS:
            keys = scene_keys(grp, plat)
            if keys:
                table[(grp, plat)] = len(keys) * ROUNDS
    if group is not None:
        return table.get((group, platform), 0)
    return table, sum(table.values())


# --------------------------------------------------------------------------- 结果文本解析

def _num(value):
    """把页面文本里的数值转成 int/float；`99.8%`、`-` 之类原样保留为字符串。"""
    if value is None:
        return None
    text = value.strip()
    if text == "" or text == "-":
        return text
    if text.endswith("%"):
        try:
            return float(text[:-1])
        except ValueError:
            return text
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        return text


def parse_result_text(text):
    """把页面结果文本（`[RESULT]` 头 + `--- per-round ---` 逐轮行）解析为 (header, rounds)。

    逐轮行形如 `scene=garden dataset=mip360 round=1 ... fps=200.0 cpu_ms=5.02 ...`；
    每个轮次字典额外带 `raw_line`（原始行）与 `line_no`，便于留档与逐位核对。
    """
    header, rounds = {}, []
    in_rounds = False
    for line_no, raw in enumerate(text.replace("\r\n", "\n").split("\n"), 1):
        line = raw.strip()
        if not line:
            continue
        if line == "--- per-round ---":
            in_rounds = True
            continue
        if not in_rounds:
            if line.startswith("[RESULT]") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            header[key.strip()] = _num(value)
            continue
        item = {}
        for token in line.split():
            if "=" in token:
                key, value = token.split("=", 1)
                item[key] = _num(value)
        if item:
            item["raw_line"] = line
            item["line_no"] = line_no
            rounds.append(item)
    return header, rounds


def rounds_by_scene(rounds):
    """逐轮列表 → {scene: [轮次字典, ...]}（保持页面给出的轮次顺序）。"""
    grouped = {}
    for item in rounds:
        grouped.setdefault(str(item.get("scene", "")), []).append(item)
    return grouped


# --------------------------------------------------------------------------- 文件与 URL 工具

def hash_file(path, chunk=1 << 20):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def read_manifest(path=None):
    """读资产登记 CSV → `{(scene, arm): row}`（同一场景的 r7 与 std45 两臂共存）；
    文件不存在时返回 `{}`。"""
    path = path or MANIFEST
    if not os.path.isfile(path):
        return {}
    with io.open(path, "r", encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    table = {}
    for row in rows:
        scene = (row.get("scene") or "").strip()
        arm = (row.get("arm") or "r7").strip()
        if scene:
            table[(scene, arm)] = row
    return table


def write_json(path, obj):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with io.open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")


def write_csv(path, fieldnames, rows):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def profile_for(group, platform, scene_key=""):
    """`?profile=` 的取值：一律**显式点名场景**（bench-shared.ts:expandProfile 支持逐 id 枚举）。

    - main：13 个场景 id 全列出（不写 `full`，避免以后新增资产时改变 `full` 的含义）
    - load（表 7-5）：r7 臂 = garden,truck,drjohnson；std45 臂 = garden-std45,truck-std45,drjohnson-std45
      （std45 资产导出后需在 bench-scenes.json 里登记这三个 id，见表 7-5 前置条件）
    - res（表 7-8）：只跑 garden
    """
    if group == GRP_LOAD:
        arm = scene_key.split("-", 1)[1] if "-" in scene_key else "r7"
        if arm.startswith("std"):
            return ",".join("%s-%s" % (s, arm) for s in LOAD_SCENES)
        return ",".join(LOAD_SCENES)
    if group == GRP_RES:
        return "garden"
    return ",".join(scene_ids())


def build_url(base, group, scene_key="", platform="", u=None):
    """按协议 §2 生成一条 bench URL（每个协议参数都显式写出，不依赖页面默认值）。"""
    params = dict(PROTO_PARAMS)
    params["profile"] = profile_for(group, platform, scene_key)
    if group == GRP_RES and scene_key.startswith("garden-"):
        params["frames"] = "100"                     # 表 7-8 保留 frames=100（协议 §5.4）
        params["res"] = scene_key.split("-", 1)[1]
    if u:
        params["u"] = u
    query = "&".join("%s=%s" % (k, v) for k, v in params.items())
    return "%s/%s?%s" % (base.rstrip("/"), BENCH_PAGE, query)

