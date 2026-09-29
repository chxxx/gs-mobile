# -*- coding: utf-8 -*-
"""第 7 章：**两套基准协议并列**的对比报告（离屏论文协议 vs 在屏真实协议）。

## 为什么需要它

Flux-GS 论文（Du et al., 2026, §5.1）报的 147/151 FPS 是在**离屏基准协议**下测的：
渲染到离屏 framebuffer、脱离屏幕 vsync、warm-up 之后多轮连续 run 取平均。
本仓库原有的协议是**在屏真实协议**（渲染到真实呈现的 canvas、逐帧 `gl.finish()` 同步）。
两者**不可混读**：前者是"同协议对齐论文数字"，后者是"用户真实体感"。

本脚本把 `raw/` 里的结果文本按 `bench_mode=` 分成两组，输出**同时包含两套数字**的对比表：

    | Method | Scene | Resolution | Offscreen-PaperMatch FPS (mean±std) | Onscreen-Realworld FPS (mean±std) | #Runs | Warmup Frames |

## 数据来源与字段

- 输入：`thesis_project/data/ch7_measurements/raw/**.txt`（`[RESULT]`…`[END]` 纯文本，两臂同格式）；
- 结果头：`engine=` / `bench_mode=` / `res=` / `offscreen_runs=` / `offscreen_warmup_frames=` …；
- 逐轮行：`scene=` / `round=` / `ok=` / `fps=` / `offscreen_fps=`（`mean±std`）/ `offscreen_run_fps=` …；
- **老结果（2026-09-26 之前）没有 `bench_mode=`** → 一律按 `onscreen-realworld` 归类（那套口径就是当时的在屏严格协议）。

## 诚实标注（强制）

Markdown 报告顶部会原样写入与页面/结果文本**同一份**的标注（见 `bench-shared.ts` 的
`OFFSCREEN_DISCLAIMER_ZH` / `OFFSCREEN_DISCLAIMER_EN`），防止后续被误读成
"我方在真实使用场景下也达到了 147 FPS"。

用法：
    python tools/ch7_paper_protocol_report.py                     # 扫描 raw/ 全量
    python tools/ch7_paper_protocol_report.py a.txt b.txt          # 只跑指定文件
    python tools/ch7_paper_protocol_report.py --raw-dir <dir> --out-dir <dir>
"""

import argparse
import csv
import glob
import json
import os
import statistics
import sys

# Windows 控制台默认 GBK：直接 print 中文/符号会抛 UnicodeEncodeError，统一改 UTF-8 + 容错。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

MODE_OFFSCREEN = "offscreen-paper-match"
MODE_ONSCREEN = "onscreen-realworld"

# 与 gsplat.js/bench-shared.ts 的 OFFSCREEN_DISCLAIMER_ZH / _EN **逐字一致**（改一处必须同时改两处）。
DISCLAIMER_ZH = (
    "Offscreen-PaperMatch FPS 是复刻 Flux-GS 论文离屏基准协议（渲染到离屏帧缓冲、脱离屏幕 vsync、"
    "warm-up 后多轮平均）测得的数值，用于与论文报告数字做同协议对比，不代表用户在真实设备屏幕上"
    "感受到的帧率。真实使用场景下的帧率请参考 Onscreen-Realworld FPS 列。"
)
DISCLAIMER_EN = (
    "Offscreen-PaperMatch FPS follows the off-screen benchmarking protocol of the Flux-GS paper "
    "(rendering into an offscreen frame buffer, decoupled from screen vsync, averaged over multiple "
    "runs after a warm-up). It is meant for a like-for-like comparison against the numbers reported "
    "in the paper and does NOT represent the frame rate a user perceives on a real screen. "
    "For real-world frame rates, read the Onscreen-Realworld FPS column."
)


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
        if line.startswith("---") or line.startswith("#"):
            # `#` 行 = 诚实标注/注释：**不参与解析**（否则会被当成 key=value）
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
    """与 ch7_baseline_report.py 同一套判定：engine=fluxgs → flux-gs；r3dgs- 前缀 → reduced-3dgs。"""
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


def text(mapping, key, default=""):
    value = mapping.get(key, default)
    return default if value is None else str(value)


def render_rejects(rejects):
    """被守卫拦下的轮次（ok=0）：把原因照实列出，让"空单元格"可解释。"""
    if not rejects:
        return ""
    lines = [
        "",
        "## 被判无效的轮次（守卫拦下的读数，**不得**当结果用）",
        "",
        "| Method | Scene | Protocol | Reason |",
        "|---|---|---|---|",
    ]
    for row in rejects:
        lines.append(f"| {row['method']} | {row['scene']} | {row['bench_mode']} | {row['err']} |")
    lines += [
        "",
        "> 这些轮次的原始文件仍在 `raw/paper_protocol/` 下（`ok=0`、`err=` 字段非空），"
        "用于复查『为什么这一格是空的』，而不是把猜出来的数填进去。",
        "",
    ]
    return "\n".join(lines)


def render_markdown(rows, rejects=None):
    lines = [
        "# 第 7 章：两套基准协议并列对比（离屏论文协议 vs 在屏真实协议）",
        "",
        "> **强制标注（不可省略）**：" + DISCLAIMER_ZH,
        ">",
        "> " + DISCLAIMER_EN,
        "",
        "## 主表",
        "",
        "| Method | Scene | Resolution | Offscreen config | Offscreen-PaperMatch FPS (mean±std) | "
        "Onscreen-Realworld FPS (mean±std) | #Runs | Warmup Frames |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for row in rows:
        lines.append(
            f"| {row['method']} | {row['scene']} | {row['resolution']} | {row['offscreen_config']} | "
            f"{row['offscreen_fps']} | "
            f"{row['onscreen_fps']} | {row['runs']} | {row['warmup_frames']} |"
        )
    lines += [
        "",
        "## 读表与口径说明",
        "",
        f"- **Offscreen-PaperMatch**（`benchmode={MODE_OFFSCREEN}`）：渲染目标 = 离屏 FBO（`offscreen_target=`），"
        "驱动 = `msgchannel`（不挂 rAF/vsync）；同步/计时策略见 `offscreen_sync_policy=`"
        "（缺省 `gpu_timer_query_ext_disjoint` = GPU 计时查询，FPS 主指标 = `1000 / offscreen_gpu_ms`；"
        "`finish_and_readpixels1x1` / `fence_sync_clientwait0_capN` 为备用口径）；"
        "预热 `offscreen_warmup_frames=` 帧不计入，然后 `offscreen_runs=` 个连续 run 各计 "
        "`offscreen_frames_per_run=` 帧，报『各 run 均值的均值 ± 各 run 标准差的均值』；"
        "**FPS 口径来源必须看 `offscreen_fps_source=`**（`gpu-timer` 或 `wall-clock`）。",
        f"- **Onscreen-Realworld**（`benchmode={MODE_ONSCREEN}`，缺省/历史口径）：渲染到真实呈现的 canvas、"
        "逐帧 `gl.finish()` 同步、`driver=timer`。这是用户真正会感受到的帧率口径。",
        "- 两列**不可互相替代**：跨方法/跨实现比较请在同一列内进行；与论文 147/151 FPS 对比只用左列。",
        "- `capped_*`：`1` = 该轮帧率贴到驱动地板（离屏看 `offscreen_driver_floor_ms=`，在屏看 `floor_used_ms=`），"
        "此时该数字只能当**下界**读。",
        "- 2026-09-26 之前的结果文本没有 `bench_mode=`，本脚本按**在屏真实协议**归类（那是当时的唯一口径）。",
        "- 逐轮明细（含逐 run FPS 列表、覆盖率、机位指纹、栅栏诊断）见同目录 `per_round_detail.csv`；"
        "两列的 `pose` 若不同说明两协议不是同一个机位，**不可并读**。",
        "",
    ]
    return "\n".join(lines) + render_rejects(rejects or [])


def write_csv(path, rows, columns):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def main():
    root = repo_root()
    parser = argparse.ArgumentParser(description="第 7 章两套基准协议并列对比报告")
    parser.add_argument("files", nargs="*", help="raw 结果文本；缺省则扫描 --raw-dir")
    parser.add_argument(
        "--raw-dir",
        default=os.path.join(root, "thesis_project", "data", "ch7_measurements", "raw", "paper_protocol"),
        help="原始结果文本/JSON 目录（递归扫描 *.txt 与子页面结果 *.json；"
             "**默认只扫本协议批次的子目录**，避免把标准协议的 raw 混进两张表）",
    )
    parser.add_argument(
        "--out-dir",
        default=os.path.join(root, "thesis_project", "data", "ch7_measurements", "paper_protocol"),
        help="输出目录",
    )
    args = parser.parse_args()

    files = list(args.files) if args.files else sorted(
        glob.glob(os.path.join(args.raw_dir, "**", "*.txt"), recursive=True)
        + glob.glob(os.path.join(args.raw_dir, "**", "*.json"), recursive=True)
    )
    if not files:
        print(f"没有找到结果文本：{args.raw_dir}")
        print("请先跑 bench.html?benchmode=offscreen-paper-match 与 bench-flux.html（同参数），把结果卡片文本保存为 .txt，")
        print("或用命令行传入文件路径。")
        return 1

    records = {}
    rejects = []
    parsed_blocks = 0
    for path in files:
        if path.lower().endswith(".json"):
            # 子页面结果对象（`--via case` 落盘）：一景一轮一个文件
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                try:
                    obj = json.load(f)
                except ValueError as err:
                    print(f"[parse] {os.path.basename(path)} → JSON 解析失败：{err}")
                    continue
            if not isinstance(obj, dict) or "scene" not in obj:
                print(f"[parse] {os.path.basename(path)} → 不是子页面结果对象，跳过")
                continue
            block = blocks_from_case_json(obj, path)
            parsed_blocks += 1
            if not obj.get("ok"):
                rejects.append(
                    {
                        "method": "ours",
                        "scene": obj.get("scene", ""),
                        "bench_mode": block["header"]["bench_mode"],
                        "err": (obj.get("err") or "").replace("|", "/")[:300],
                    }
                )
            collect(records, path, block["header"], block["rounds"])
            print(
                f"[parse] {os.path.basename(path)} → scene={obj.get('scene')} "
                f"mode={block['header']['bench_mode']} ok={obj.get('ok')}"
            )
            continue
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            body = f.read()
        blocks = parse_result_blocks(body)
        parsed_blocks += len(blocks)
        for block in blocks:
            collect(records, path, block["header"], block["rounds"])
        print(f"[parse] {os.path.basename(path)} → blocks={len(blocks)}")
    if not records:
        print(f"没有解析到任何有效轮次（blocks={parsed_blocks}）：检查 ok= / scene= 字段")
        return 1

    rows = build_rows(records)
    os.makedirs(args.out_dir, exist_ok=True)
    csv_path = os.path.join(args.out_dir, "protocol_comparison.csv")
    md_path = os.path.join(args.out_dir, "protocol_comparison.md")
    detail_path = os.path.join(args.out_dir, "per_round_detail.csv")
    write_csv(csv_path, rows, REPORT_COLUMNS)

    detail_rows = []
    for arm, scene, res in sorted(records.keys(), key=lambda k: (k[1], k[0], k[2])):
        slot = records[(arm, scene, res)]
        for mode in (MODE_OFFSCREEN, MODE_ONSCREEN):
            bucket = slot.get(mode)
            if not bucket:
                continue
            for r in bucket["rounds"]:
                detail_rows.append(
                    {
                        "method": arm,
                        "scene": scene,
                        "resolution": res,
                        "bench_mode": mode,
                        "round": r["round"],
                        "fps": "" if r["fps"] is None else f"{r['fps']:.3f}",
                        "offscreen_fps_mean": "" if r["offscreen_mean"] is None else f"{r['offscreen_mean']:.3f}",
                        "offscreen_fps_std": "" if r["offscreen_std"] is None else f"{r['offscreen_std']:.3f}",
                        "offscreen_runs": fmt_int(r["runs"]),
                        "offscreen_warmup_frames": fmt_int(r["warmup_frames"]),
                        "driver": r["driver"],
                        "fps_capped": r["fps_capped"],
                        "offscreen_driver_capped": r["offscreen_driver_capped"],
                        "covered_pct": "" if r["covered"] is None else f"{r['covered']:.1f}",
                        "pose": r["pose"],
                    }
                )
    if detail_rows:
        write_csv(detail_path, detail_rows, list(detail_rows[0].keys()))

    markdown = render_markdown(rows, rejects)
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(markdown)
    with open(os.path.join(args.out_dir, "protocol_comparison.json"), "w", encoding="utf-8") as f:
        json.dump(
            {"disclaimer_zh": DISCLAIMER_ZH, "disclaimer_en": DISCLAIMER_EN, "rows": rows},
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(markdown)
    print(f"[out] {md_path}")
    print(f"[out] {csv_path}")
    if detail_rows:
        print(f"[out] {detail_path}")
    return 0


def parse_mean_std(value):
    """`offscreen_fps=147.3±2.1` → (147.3, 2.1)；解析不了返回 (None, None)。"""
    if not value or "±" not in value:
        return None, None
    left, right = value.split("±", 1)
    try:
        return float(left), float(right)
    except ValueError:
        return None, None


def safe_num(value):
    """把可能是字符串/None 的读数收敛成 float 或 None（raw 树里两者都存在）。"""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def blocks_from_case_json(obj, source):
    """子页面结果对象（`__BENCH_CASE_RESULT__`，camelCase）→ 与 `[RESULT]` 文本等价的 block。

    与文本口径**逐字段对应**（`benchMode`→`bench_mode`、`offscreenFpsMean`→`offscreen_fps_mean`…），
    因此 `collect()` 只需照常读同一批键名，不需要第二套解析逻辑。
    """
    mode = obj.get("benchMode") or MODE_ONSCREEN
    res = ""
    if obj.get("resW") and obj.get("resH"):
        res = "%sx%s" % (obj["resW"], obj["resH"])
    header = {
        "engine": "gsplat",
        "bench_mode": mode,
        "res": res,
        "res_mode": obj.get("resMode") or "forced",
    }
    row = {
        "scene": obj.get("scene", ""),
        "dataset": obj.get("dataset", ""),
        "round": obj.get("round", 0),
        "ok": "1" if obj.get("ok") else "0",
        "fps": "" if safe_num(obj.get("fps")) is None else "%.3f" % safe_num(obj.get("fps")),
        "driver": obj.get("driver") or "",
        "fps_capped": "1" if obj.get("fpsCapped") else "0",
        "covered": "" if safe_num(obj.get("coveredPct")) is None else "%.3f" % safe_num(obj.get("coveredPct")),
        "pose": obj.get("poseKey") or "",
        "offscreen_runs": ""
        if safe_num(obj.get("offscreenRuns")) is None
        else str(int(safe_num(obj.get("offscreenRuns")))),
        "offscreen_warmup_frames": ""
        if safe_num(obj.get("offscreenWarmupFrames")) is None
        else str(int(safe_num(obj.get("offscreenWarmupFrames")))),
        "offscreen_fps_mean": ""
        if safe_num(obj.get("offscreenFpsMean")) is None
        else "%.3f" % safe_num(obj.get("offscreenFpsMean")),
        "offscreen_fps_std": ""
        if safe_num(obj.get("offscreenFpsStd")) is None
        else "%.3f" % safe_num(obj.get("offscreenFpsStd")),
        "offscreen_driver_capped": "1" if obj.get("offscreenDriverCapped") else "0",
        "offscreen_run_fps": obj.get("offscreenRunFpsList") or "",
        "err": obj.get("err") or "",
    }
    if mode == MODE_OFFSCREEN and row["offscreen_fps_mean"] and row["offscreen_fps_std"]:
        row["offscreen_fps"] = "%s±%s" % (row["offscreen_fps_mean"], row["offscreen_fps_std"])
    return {"header": header, "rounds": [row], "summary": [], "_source": source}


def collect(records, source, header, rounds):
    """
    逐轮记录 → `records[(arm, scene, res)][mode]`。

    每个 mode 的槽位保存：
      - `rounds`：该 (arm, scene, res, mode) 下的逐轮样本（fps / 标准差 / run 数 / 预热帧数 / 自查字段）
      - `run_list`：所有轮次上报的逐 run FPS（离屏协议才有）
      - `sources`：这些轮次来自哪些原始文件（可回溯）
    """
    mode = text(header, "bench_mode", MODE_ONSCREEN) or MODE_ONSCREEN
    if mode not in (MODE_OFFSCREEN, MODE_ONSCREEN):
        mode = MODE_ONSCREEN
    res = text(header, "res", "")
    for r in rounds:
        scene = r.get("scene", "")
        if not scene or r.get("ok") != "1":
            continue
        arm = arm_of(header, scene)
        key = (arm, scene, res)
        slot = records.setdefault(key, {MODE_OFFSCREEN: None, MODE_ONSCREEN: None})
        bucket = slot.get(mode)
        if bucket is None:
            bucket = {"rounds": [], "run_list": [], "sources": []}
            slot[mode] = bucket
        mean, std = parse_mean_std(text(r, "offscreen_fps")) if mode == MODE_OFFSCREEN else (None, None)
        bucket["rounds"].append(
            {
                "round": text(r, "round", ""),
                "fps": num(r, "fps"),
                "offscreen_mean": mean if mean is not None else num(r, "offscreen_fps_mean"),
                "offscreen_std": std if std is not None else num(r, "offscreen_fps_std"),
                "runs": num(r, "offscreen_runs"),
                "warmup_frames": num(r, "offscreen_warmup_frames"),
                "frames_per_run": num(r, "offscreen_frames_per_run"),
                "driver": text(r, "driver", ""),
                "fps_capped": text(r, "fps_capped", ""),
                "offscreen_driver_capped": text(r, "offscreen_driver_capped", ""),
                "pose": text(r, "pose", ""),
                "covered": num(r, "covered"),
            }
        )
        for run_fps in text(r, "offscreen_run_fps", "").split(","):
            if run_fps.strip():
                try:
                    bucket["run_list"].append(float(run_fps))
                except ValueError:
                    pass
        bucket["sources"].append(source)


def summarize(bucket):
    """把一个 (arm, scene, res, mode) 的逐轮样本汇总成一行（缺数据返回 None）。

    **协议参数不同的轮次不混算**：先在桶内按 (frames_per_run, runs, warmup_frames) 分子组，
    取样本数最多的那一组统计，其余组只记在 `cfg_variants` 里（2026-09-26 现场踩到过
    "30 帧×2 run 的短诊断轮"混进"300 帧×5 run 正式轮"的问题）。
    """
    if not bucket or not bucket["rounds"]:
        return None
    groups = {}
    for r in bucket["rounds"]:
        cfg = "%s/%s/%s" % (r["frames_per_run"] or "-", r["runs"] or "-", r["warmup_frames"] or "-")
        groups.setdefault(cfg, []).append(r)
    # 取样本最多的组（并列取字典序最小，保证可复现）
    cfg_main = sorted(groups.keys(), key=lambda c: (-len(groups[c]), c))[0]
    rounds = groups[cfg_main]
    fps_values, std_values = [], []
    for r in rounds:
        if r["offscreen_mean"] is not None:
            fps_values.append(r["offscreen_mean"])
        elif r["fps"] is not None:
            fps_values.append(r["fps"])
        if r["offscreen_std"] is not None:
            std_values.append(r["offscreen_std"])
    if not fps_values:
        return None
    covered = [r["covered"] for r in rounds if r["covered"] is not None]
    return {
        "cfg": cfg_main,
        "cfg_variants": sorted(groups.keys()),
        "fps_mean": statistics.fmean(fps_values),
        # 各轮报告的"run 间标准差"的均值：与下面的轮间标准差**不是同一个量**，两个都报
        "fps_std": statistics.fmean(std_values) if std_values else 0.0,
        "round_std": statistics.pstdev(fps_values) if len(fps_values) > 1 else 0.0,
        "rounds": len(fps_values),
        "runs": bucket["rounds"][0]["runs"],
        "warmup_frames": bucket["rounds"][0]["warmup_frames"],
        "run_list": bucket["run_list"],
        "drivers": sorted({r["driver"] for r in bucket["rounds"] if r["driver"]}),
        "fps_capped": any(r["fps_capped"] == "1" for r in bucket["rounds"]),
        "driver_capped": any(r["offscreen_driver_capped"] == "1" for r in bucket["rounds"]),
        "poses": sorted({r["pose"] for r in bucket["rounds"] if r["pose"]}),
        "covered": statistics.fmean(covered) if covered else None,
    }


def fmt_fps(summary):
    if not summary:
        return "—"
    return f"{summary['fps_mean']:.1f}±{summary['fps_std']:.1f}"


def fmt_int(value):
    return "—" if value in (None, "") else str(int(value))


def build_rows(records):
    """报告主表：每个 (arm, scene, res, 协议参数) 一行，两套协议的数字并排。"""
    rows = []
    for arm, scene, res in sorted(records.keys(), key=lambda k: (k[1], k[0], k[2])):
        slot = records[(arm, scene, res)]
        off = summarize(slot.get(MODE_OFFSCREEN))
        on = summarize(slot.get(MODE_ONSCREEN))
        rows.append(
            {
                "method": arm,
                "scene": scene,
                "resolution": res or "—",
                # 协议参数（离屏协议才有）：frames/run × runs × warmup；多组时同时列出
                "offscreen_config": (
                    ("多组:" + "|".join(off["cfg_variants"])) if off and len(off["cfg_variants"]) > 1
                    else (off["cfg"] if off else "—")
                ),
                # 主表的 Definition 列严格按需求给定的列名组织
                "offscreen_fps": fmt_fps(off),
                "onscreen_fps": fmt_fps(on),
                "runs": fmt_int(off["runs"] if off else None),
                "warmup_frames": fmt_int(off["warmup_frames"] if off else None),
                "rounds_offscreen": fmt_int(off["rounds"] if off else None),
                "rounds_onscreen": fmt_int(on["rounds"] if on else None),
                "driver_offscreen": "/".join(off["drivers"]) if off else "—",
                "driver_onscreen": "/".join(on["drivers"]) if on else "—",
                "capped_offscreen": ("1" if off["driver_capped"] else "0") if off else "—",
                "capped_onscreen": ("1" if on["fps_capped"] else "0") if on else "—",
                "covered_pct": f"{off['covered']:.1f}" if off and off["covered"] is not None else "—",
                "pose_offscreen": (off["poses"][0] if off and off["poses"] else "—"),
                "pose_onscreen": (on["poses"][0] if on and on["poses"] else "—"),
                "run_list_offscreen": ",".join(f"{v:.1f}" for v in (off["run_list"] if off else [])),
                "sources": ";".join(
                    sorted(
                        {
                            os.path.basename(p)
                            for bucket in (slot.get(MODE_OFFSCREEN), slot.get(MODE_ONSCREEN))
                            if bucket
                            for p in bucket["sources"]
                        }
                    )
                ),
            }
        )
    return rows


REPORT_COLUMNS = [
    "method",
    "scene",
    "resolution",
    "offscreen_config",
    "offscreen_fps",
    "onscreen_fps",
    "runs",
    "warmup_frames",
    "rounds_offscreen",
    "rounds_onscreen",
    "driver_offscreen",
    "driver_onscreen",
    "capped_offscreen",
    "capped_onscreen",
    "covered_pct",
    "pose_offscreen",
    "pose_onscreen",
    "run_list_offscreen",
    "sources",
]


if __name__ == "__main__":
    sys.exit(main())
