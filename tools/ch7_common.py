# -*- coding: utf-8 -*-
"""第 7 章统一测量协议（docs/ch7_measurement_protocol.md）的共享常量与解析工具。

约定（与协议 §2/§4 一一对应）：
- 场景清单唯一来源：`gsplat.js/bench-scenes.json`（13 项，带 dataset 分组）；
- 原始数据落盘：`thesis_project/data/ch7_measurements/raw/{platform}/{scene_key}/round{n}.json`；
- 四个批次组（协议 §4.2/§5.5）：
    main = 13 场景 × 5 平台 × 3 轮 = 195（表 7-2/7-3/7-4/7-7；Gen2 双内核各算一组）
    load = 3 场景 × 2 臂 × 5 轮 = 30（表 7-5，platform=gen3，scene_key={scene}-r7 / {scene}-std45）
    res  = 4 档分辨率 × 3 轮 = 12（表 7-8，platform=rtx4060，scene_key=garden-{WxH}）
    flux = 13 场景 × 4 平台 × 3 轮 = 156（Flux-GS 基线，platform 不含 gen2-chrome 取证轮）
  核心合计 393 份；另有 gen2-chrome 的 Flux-GS 取证轮 39 份（该内核下 Flux-GS 渲染异常，
  只留档、不进表、不计入核心期望数），见协议 §4.2；
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

# 平台标识（协议 §2）：`<机型>[-<内核>]`。内核不是 Chrome 时必须显式加后缀——
# 不同浏览器内核对同一 WebGL 实现的差异不能当成"硬件差异"（协议 §6.4 的跨内核规则）。
PLATFORMS = ("rtx4060", "gen3", "d9400", "gen2-xweb", "gen2-chrome")
PLATFORM_LABEL = {
    "rtx4060": "RTX 4060 Laptop / Chrome Windows（含无头 Edge）",
    "gen3": "Snapdragon 8 Gen 3 / Adreno 750（Chrome Mobile；若实测只能用微信内核，请写作 gen3-xweb）",
    "d9400": "Dimensity 9400 / Mali（Chrome Mobile；同上，必要时写作 d9400-xweb）",
    "gen2-xweb": "Snapdragon 8 Gen 2 / Adreno 740 · 微信 XWEB 内核（Flux-GS 唯一可用内核）",
    "gen2-chrome": "Snapdragon 8 Gen 2 / Adreno 740 · Chrome Mobile（Flux-GS 在此内核渲染异常，仅取证）",
}


def platform_base(platform):
    """`gen2-xweb` → `gen2`（判断"该平台是否承担某组"用机型，落盘目录用完整标识）。"""
    return str(platform).split("-", 1)[0]


def platform_kernel(platform):
    """`gen2-xweb` → `xweb`；无后缀视为 `chrome`（协议 §2 缺省内核）。"""
    return str(platform).split("-", 1)[1] if "-" in str(platform) else "chrome"


# 批次组
GRP_MAIN, GRP_LOAD, GRP_RES, GRP_FLUX = "main", "load", "res", "flux"
GROUPS = (GRP_MAIN, GRP_LOAD, GRP_RES, GRP_FLUX)
ROUNDS = 3                                   # 兼容旧调用（= main/res 的轮次）
ROUNDS_BY_GROUP = {GRP_MAIN: 3, GRP_LOAD: 5, GRP_RES: 3, GRP_FLUX: 3}
LOAD_SCENES = ("garden", "truck", "drjohnson")
LOAD_ARMS = ("r7", "std45")
RES_TIERS = ("800x531", "1600x1063", "2400x1596", "3200x2126")

# Flux-GS 基线（协议 §5.5）：页面是 bench-flux.html，清单是 flux-baseline-scenes.json。
FLUX_PAGE = "bench-flux.html"
FLUX_SCENES_JSON = os.path.join(GS_REPO, "flux-baseline-scenes.json")
FLUX_PLATFORMS = ("rtx4060", "gen3", "gen2-xweb", "d9400")
FLUX_EVIDENCE_PLATFORMS = ("gen2-chrome",)   # 只取证（渲染异常），不计入核心期望数


def rounds_for(group):
    """该组每场景跑几轮（协议 §6.4：本文方法与 Flux-GS 分开定轮次）。"""
    return ROUNDS_BY_GROUP.get(group, ROUNDS)


def is_flux_engine(engine):
    """结果头 `engine=fluxgs` → True（Flux-GS 臂；`engine=gsplat` 为本文方法，协议 §5.5）。"""
    return str(engine or "").strip().lower().startswith("flux")

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
    "rounds": "3",                       # 逐组分轮次见 rounds_for()；build_url 会按组覆盖
    "report": "",                        # 远程协助：页面自动回传端点（分发链接里显式给出）
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


def flux_scene_ids(path=None):
    """Flux-GS 基线场景清单（`flux-baseline-scenes.json`，13 项；读不到时退回主清单）。"""
    path = path or FLUX_SCENES_JSON
    try:
        with io.open(path, "r", encoding="utf-8") as fh:
            obj = json.load(fh)
        items = obj["scenes"] if isinstance(obj, dict) else obj
        return [s["id"] for s in items]
    except (OSError, ValueError, KeyError):
        return scene_ids()


def scene_keys(group, platform):
    """返回该 (组, 平台) 下的 scene_key 列表（即 raw/ 下的一级子目录名）。"""
    base = platform_base(platform)
    if group in (GRP_MAIN, GRP_FLUX):
        return list(scene_ids()) if group == GRP_MAIN else list(flux_scene_ids())
    if group == GRP_LOAD:
        if base != "gen3":
            return []
        return ["%s-%s" % (s, arm) for s in LOAD_SCENES for arm in LOAD_ARMS]
    if group == GRP_RES:
        if base != "rtx4060":
            return []
        return ["garden-%s" % t for t in RES_TIERS]
    raise ValueError("未知批次组：%s" % group)


def expected_files(group=None, platform=None):
    """{(group, platform): 期望文件数} 与**核心合计**（不含 gen2-chrome 的 Flux-GS 取证轮）。

    核心合计（协议 §4.2）= main 195 + load 30 + res 12 + flux 156 = **393**。
    另有 Flux-GS 在 gen2-chrome 的取证轮 39 份（渲染异常，只留档、不进表），见 evidence_files()。
    """
    table = {}
    for plat in PLATFORMS:
        for grp in GROUPS:
            if grp == GRP_FLUX and plat in FLUX_EVIDENCE_PLATFORMS:
                continue                      # 取证轮单独统计
            keys = scene_keys(grp, plat)
            if keys:
                table[(grp, plat)] = len(keys) * rounds_for(grp)
    if group is not None:
        return table.get((group, platform), 0)
    return table, sum(table.values())


def evidence_files():
    """Flux-GS 在 gen2-chrome 的取证轮数（该内核下渲染异常，只留档，不计入核心期望数）。"""
    return {p: len(flux_scene_ids()) * rounds_for(GRP_FLUX) for p in FLUX_EVIDENCE_PLATFORMS}


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
    - flux（Flux-GS 基线）：13 个 Flux-GS 场景 id（来自 `flux-baseline-scenes.json`）
    """
    if group == GRP_LOAD:
        arm = scene_key.split("-", 1)[1] if "-" in scene_key else "r7"
        if arm.startswith("std"):
            return ",".join("%s-%s" % (s, arm) for s in LOAD_SCENES)
        return ",".join(LOAD_SCENES)
    if group == GRP_RES:
        return "garden"
    if group == GRP_FLUX:
        return ",".join(flux_scene_ids())
    return ",".join(scene_ids())


def build_url(base, group, scene_key="", platform="", u=None, report="", rtok="", subset=""):
    """按协议 §2/§12 生成一条 bench URL（每个协议参数都显式写出，不依赖页面默认值）。

    - `group=res` 保留 `frames=100` 并覆盖 `res`（协议 §5.4）；
    - `group=flux` 指向 `bench-flux.html`（Flux-GS 自带渲染器，协议 §5.5）；
    - `report`/`rtok` 用于远程协助的自动回传（页面测完直接 POST 到本机 dev server 的
      `/__ch7/report`，见 vite.config.js；不填则不自动回传，走人工「复制结果」）；
    - `subset` 用逗号分隔的场景 id 覆盖 `profile`（远程协助者分片跑时用）。
    """
    params = dict(PROTO_PARAMS)
    params["rounds"] = str(rounds_for(group))
    params["profile"] = subset or profile_for(group, platform, scene_key)
    if group == GRP_RES and scene_key.startswith("garden-"):
        params["frames"] = "100"                     # 表 7-8 保留 frames=100（协议 §5.4）
        params["res"] = scene_key.split("-", 1)[1]
    if report:
        params["report"] = report
        if rtok:
            params["rtok"] = rtok
    if u:
        params["u"] = u
    page = FLUX_PAGE if group == GRP_FLUX else BENCH_PAGE
    query = "&".join("%s=%s" % (k, v) for k, v in params.items() if str(v) != "")
    return "%s/%s?%s" % (base.rstrip("/"), page, query)

