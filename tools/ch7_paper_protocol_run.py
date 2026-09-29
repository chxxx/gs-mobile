# -*- coding: utf-8 -*-
"""第 7 章：**两套基准协议的本地实跑驱动**（dev server + 无头 Edge/CDP，与 `ch7_batch.py run` 同一驱动器）。

为什么单独一个脚本：`ch7_batch.py` 的 URL 由 `ch7_common.PROTO_PARAMS` 固定（在屏口径），
而"离屏论文协议"只在 URL 上多几个参数（`benchmode=` / `runs=` / `warmup=` / `driver=msgchannel`）。
本脚本复用**同一个** `_tmp_ch7probe/cdp.mjs` 驱动器与**同一套**基础参数，只在协议差异项上分叉，
因此两套数字的差异只可能来自"渲染目标 + 驱动 + 同步策略 + 多轮平均"，不来自参数集漂移。

用法（默认 dry-run，加 `--yes` 才真跑）：

    python tools/ch7_paper_protocol_run.py                     # 列出将要跑的组合与 URL
    python tools/ch7_paper_protocol_run.py --yes               # 真跑（garden,flowers × 两臂 × 两协议）
    python tools/ch7_paper_protocol_run.py --yes --scenes garden --arms ours --modes offscreen-paper-match
    python tools/ch7_paper_protocol_run.py --yes --rounds 3     # 正式采集轮次（协议要求 3 轮）

产物：`thesis_project/data/ch7_measurements/raw/paper_protocol/<arm>_<mode>_<ts>.txt`（结果文本原文），
随后跑 `python tools/ch7_paper_protocol_report.py --raw-dir .../raw/paper_protocol` 出对比表。
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
GS_REPO = os.path.dirname(TOOLS_DIR)
PROJECT_ROOT = os.path.dirname(GS_REPO)
CDP_DRIVER = os.path.join(GS_REPO, "_tmp_ch7probe", "cdp.mjs")
RAW_DIR = os.path.join(PROJECT_ROOT, "thesis_project", "data", "ch7_measurements", "raw", "paper_protocol")
TMP_DIR = os.path.join(GS_REPO, "_tmp_ch7probe", "out", "paper_protocol")

MODE_ONSCREEN = "onscreen-realworld"
MODE_OFFSCREEN = "offscreen-paper-match"
MODES = (MODE_OFFSCREEN, MODE_ONSCREEN)

# 两套 URL 的**公共部分**：与 `ch7_common.PROTO_PARAMS`（协议 §2）逐字一致
BASE_PARAMS = (
    ("mode", "bench"),
    ("res_mode", "forced"),
    ("res", "1600x1063"),
    ("dpr", "1"),
    ("frames", "300"),
    ("cold", "1"),
    ("proto", "flux"),
)
# 协议差异项（唯一的不同就在这里，其余参数两套完全相同）
def protocol_params(mode, args):
    """按协议生成差异参数；CLI 的 --runs/--warmup/--fences 覆盖缺省（**就地替换**，不追加重复项：
    `URLSearchParams.get()` 取的是第一个值，追加重复项会导致覆盖静默失效）。"""
    if mode == MODE_OFFSCREEN:
        pairs = [
            ("benchmode", MODE_OFFSCREEN),
            ("driver", "msgchannel"),
            ("runs", str(args.runs)),
            ("warmup", str(args.warmup)),
            ("fences", str(args.fences)),
        ]
    else:
        pairs = [("driver", "timer"), ("warmup", "0")]
    return pairs
ARMS = (("ours", "bench.html"), ("flux-gs", "bench-flux.html"))
CASE_PAGE = "bench-case.html"
OURS_SCENES_JSON = "bench-scenes.json"
FLUX_SCENES_JSON = "flux-baseline-scenes.json"

# 子页面（测量内核）的 URL 参数：与父页面透传下来的完全一致（父页面是"整份查询参数原样透传"，
# 见 bench-shared.buildCasePageUrl），所以这里逐项显式写出来即可，口径不会漂移。
CASE_PARAMS = (
    ("mode", "bench"),
    ("res_mode", "forced"),
    ("res", "1600x1063"),
    ("dpr", "1"),
    ("cold", "1"),
    ("proto", "flux"),
    ("cam", "flux"),
    ("validateframe", "1"),
    ("holdms", "0"),
)


def scene_assets(arm):
    """读清单拿到 场景 id → 模型文件 的映射（两臂各自的清单）。"""
    name = OURS_SCENES_JSON if arm == "ours" else FLUX_SCENES_JSON
    with open(os.path.join(GS_REPO, name), "r", encoding="utf-8") as fh:
        data = json.load(fh)
    scenes = data.get("scenes", data if isinstance(data, list) else [])
    out = {}
    for s in scenes:
        sid = s.get("id")
        base = s.get("file") or s.get("model") or ""
        page = s.get("page")
        if sid and base:
            out[sid] = {"model": base, "page": page, "dataset": s.get("dataset", "")}
    return out

WAIT_SENTINEL = r"\[END\]"  # 结果文本的结束标记（CDP 驱动器按正则匹配）
EXPR_RESULT_TEXT = "(document.getElementById('rc-text')||{}).value||''"
EXPR_POLL = (
    "(document.getElementById('rc-text')||{}).value"
    " ? ('len=' + document.getElementById('rc-text').value.length + ' ' +"
    " document.getElementById('status-big').textContent)"
    " : document.body.innerText.slice(0,200)"
)


def build_url(base, page, params, scenes, rounds, u, frames=300, runs=5, warmup=90, fences=3):
    protocol = []
    for k, v in params:
        if k == "runs":
            protocol.append((k, str(runs)))
        elif k == "warmup":
            protocol.append((k, str(warmup)))
        elif k == "fences":
            protocol.append((k, str(fences)))
        else:
            protocol.append((k, v))
    query = list(BASE_PARAMS[:4]) + [
        ("frames", str(frames)),
        ("cold", "1"),
        ("proto", "flux"),
        ("rounds", str(rounds)),
        ("profile", scenes),
        ("u", u),
    ] + protocol
    return "%s/%s?%s" % (base.rstrip("/"), page, "&".join("%s=%s" % (k, v) for k, v in query))


def build_case_url(base, params, u, model):
    """构造**测量内核页**（`bench-case.html`）的 URL：与父页面透传下来的参数逐项一致。"""
    query = (
        list(params)
        + [
            ("jobId", u),
            ("model", model),
            ("round", "1"),
            ("attempt", "0"),
            ("token", u),
            ("u", u),
        ]
    )
    return "%s/%s?%s" % (base.rstrip("/"), CASE_PAGE, "&".join("%s=%s" % (k, v) for k, v in query))


def run_parent(arm, mode, url, args):
    """走父页面队列：等 `--- per-round ---`（= 父页面把整份结果文本拼好了），再取文本落盘。"""
    os.makedirs(TMP_DIR, exist_ok=True)
    os.makedirs(RAW_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    tmp = os.path.join(TMP_DIR, "parent_%s_%s_%s.json" % (arm, mode, stamp))
    poll = (
        "document.getElementById('rc-text') && document.getElementById('rc-text').value.indexOf('--- per-round ---')>=0"
        " ? 'DONE'"
        " : ((document.getElementById('status-big')||{}).textContent||'').slice(0,140)"
    )
    cmd = [
        "node",
        CDP_DRIVER,
        "--url=" + url,
        "--wait=^DONE$",
        "--expr=(document.getElementById('rc-text')||{}).value||''",
        "--pollExpr=" + poll,
        "--out=" + tmp,
        "--timeout=%d" % args.timeout,
        "--port=%d" % args.port,
        "--poll=3000",
    ]
    print("[run] %-8s %-22s (parent) %s" % (arm, mode, url))
    t0 = time.time()
    subprocess.run(cmd, check=False)
    dt = time.time() - t0
    if not os.path.isfile(tmp):
        print("      ✗ 驱动器未产出结果文件（%.0fs）" % dt)
        return None
    with open(tmp, "r", encoding="utf-8") as fh:
        obj = json.load(fh)
    text = obj.get("value") or ""
    if not isinstance(text, str) or "--- per-round ---" not in text:
        print("      ✗ 未拿到完整结果文本（matched=%s，见 %s）" % (obj.get("matched"), tmp))
        saw = (obj.get("valueSoFar") or "")[:160].replace("\n", " ")
        if saw:
            print("        页面此刻显示：%s" % saw)
        return None
    target = os.path.join(RAW_DIR, "parent_%s_%s_%s.txt" % (arm, mode, stamp))
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("      ✓ %.0fs → %s" % (dt, os.path.relpath(target, PROJECT_ROOT)))
    for line in text.splitlines():
        if line.startswith(("bench_mode=", "offscreen_fps_mean=", "offscreen_fps=", "offscreen_target=",
                            "driver=", "offscreen_sync_policy=", "summary scene=")):
            print("        %s" % line.strip()[:200])
    return target


def dev_server_ok(base):
    try:
        with urllib.request.urlopen(base + "/bench.html", timeout=5) as r:
            return r.status == 200
    except Exception as err:  # noqa: BLE001
        print("✗ dev server 不可用（%s）：%s" % (base, err))
        print("  先在 gsplat.js 目录起服务：npm run dev（或 npx vite --port 5173）")
        return False


def run_one(arm, mode, url, args, scene, roundno):
    """跑**一景一轮**：直接驱动测量内核页（`bench-case.html`），读它挂在 window 上的结果对象。

    为什么不走父页面队列：父页面在"整页重启 + 续跑"路径上不保证在有限时间内走到 finishBench()
    （本地无头实跑实测会反复重启同一轮），而**子页面一轮的结果对象本身已经是完整口径**
    （含离屏协议的全部 `offscreen_*` 字段）。两者用的是同一个测量内核、同一套 URL 参数。
    """
    os.makedirs(TMP_DIR, exist_ok=True)
    os.makedirs(RAW_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    tmp = os.path.join(TMP_DIR, "%s_%s_%s_r%s_%s.json" % (arm, mode, scene, roundno, stamp))
    poll = (
        "window.__BENCH_CASE_RESULT__ ? ('DONE')"
        " : (document.getElementById('status-big') ? document.getElementById('status-big').textContent.slice(0,140)"
        " : document.body.innerText.slice(0,140))"
    )
    cmd = [
        "node",
        CDP_DRIVER,
        "--url=" + url,
        "--wait=^DONE$",
        "--expr=JSON.stringify(window.__BENCH_CASE_RESULT__||null)",
        "--pollExpr=" + poll,
        "--out=" + tmp,
        "--timeout=%d" % args.timeout,
        "--port=%d" % args.port,
        "--poll=2000",
    ]
    if args.console:
        cmd.append("--console=1")
    print("[run] %-8s %-22s %-10s r%s  %s" % (arm, mode, scene, roundno, url))
    t0 = time.time()
    subprocess.run(cmd, check=False)
    dt = time.time() - t0
    if not os.path.isfile(tmp):
        print("      ✗ 驱动器未产出结果文件（%.0fs）" % dt)
        return None
    with open(tmp, "r", encoding="utf-8") as fh:
        obj = json.load(fh)
    raw = obj.get("value")
    if not isinstance(raw, str) or raw in ("null", ""):
        print("      ✗ 未拿到子页面结果对象（matched=%s，见 %s）" % (obj.get("matched"), tmp))
        saw = (obj.get("valueSoFar") or "")[:160].replace("\n", " ")
        if saw:
            print("        页面此刻显示：%s" % saw)
        return None
    try:
        result = json.loads(raw)
    except ValueError:
        print("      ✗ 结果对象无法解析：%s" % raw[:160])
        return None
    target = os.path.join(RAW_DIR, "%s_%s_%s_r%s_%s.json" % (arm, mode, scene, roundno, stamp))
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    ok = bool(result.get("ok"))
    print(
        "      %s %.0fs → %s" % ("✓" if ok else "✗", dt, os.path.relpath(target, PROJECT_ROOT))
    )
    keys = [
        "fps",
        "driver",
        "benchMode",
        "offscreenFpsMean",
        "offscreenFpsStd",
        "offscreenTarget",
        "offscreenRuns",
        "offscreenWarmupFrames",
        "offscreenFrameMsMedian",
        "offscreenFenceWaitMs",
        "offscreenFencesMax",
        "offscreenSyncPolicy",
        "offscreenDriverCapped",
        "offscreenRunFpsList",
        "frameMs",
        "syncMs",
        "fpsCapped",
        "coveredPct",
        "cam",
        "err",
    ]
    shown = ["%s=%s" % (k, result.get(k)) for k in keys if result.get(k) is not None]
    if shown:
        print("        " + "  ".join(shown)[:400])
    return target if ok else None


def main():
    parser = argparse.ArgumentParser(description="第 7 章两套基准协议的本地实跑驱动")
    parser.add_argument("--base", default="http://localhost:5173", help="dev server 地址")
    parser.add_argument("--scenes", default="garden,flowers", help="逗号分隔的场景 id（进 profile=）")
    parser.add_argument("--rounds", type=int, default=1,
                        help="每场景轮次；协议要求 3 轮，缺省 1（快速验证批，只用于跑通/看趋势）")
    parser.add_argument("--arms", default="ours,flux-gs", help="逗号分隔：ours,flux-gs")
    parser.add_argument("--modes", default=",".join(MODES), help="逗号分隔：%s" % ",".join(MODES))
    parser.add_argument("--timeout", type=int, default=1800, help="单组合超时秒数")
    parser.add_argument("--frames", type=int, default=300, help="每 run 帧数（协议 300）")
    parser.add_argument("--runs", type=int, default=5, help="离屏协议的 run 数（协议 5）")
    parser.add_argument("--warmup", type=int, default=90, help="离屏协议的预热帧数（协议 90）")
    parser.add_argument("--fences", type=int, default=3, help="离屏协议的栅栏积压上限（协议 3）")
    parser.add_argument("--port", type=int, default=9411, help="CDP 调试端口（避开 9333 的旧进程）")
    parser.add_argument("--console", action="store_true",
                        help="把页面 console 一起落盘（子页面 timeline 打点；排查用）")
    parser.add_argument("--yes", action="store_true", help="确认真跑（缺省 dry-run 只打印 URL）")
    parser.add_argument("--url", default="",
                        help="直接给一条完整 URL（含 & 的参数只能这样传，cmd 会吃掉 &）："
                             "用于『真机同款链接的本地彩排』——走父页面 + report 自动回传那条路，"
                             "与手机完全同构；给定时忽略场景/协议等构造参数")
    parser.add_argument("--url-file", default="",
                        help="从文件读 URL（第一行非空内容）：**cmd 下发起含 & 的链接请用这个**，"
                             "避免 cmd 把 & 当命令分隔符（`start` 嵌套引号也救不了）")
    parser.add_argument("--via", default="parent", choices=["parent", "case"],
                        help="parent = 走父页面队列（bench.html/bench-flux.html，与 ch7_batch 同一路线）；"
                             "case = 直接驱动测量内核页 bench-case.html（只支持 ours 臂）")
    args = parser.parse_args()

    arms = [a for a in args.arms.split(",") if a]
    modes = [m for m in args.modes.split(",") if m]
    for arm in arms:
        if arm not in dict(ARMS):
            print("✗ 未登记的臂：%s（可选 %s）" % (arm, ",".join(a for a, _ in ARMS)))
            return 2
    for mode in modes:
        if mode not in (MODE_OFFSCREEN, MODE_ONSCREEN):
            print("✗ 未登记的协议：%s（可选 %s）" % (mode, ",".join(MODES)))
            return 2

    if args.rounds < 3:
        print("⚠ rounds=%d < 协议要求的 3：本批只用于【跑通链路 / 看协议差异】，"
              "按项目惯例不得进论文主表" % args.rounds)
    if not args.yes:
        print("（dry-run：只打印组合与 URL；真跑加 --yes）")
    elif not dev_server_ok(args.base):
        return 2

    made = []
    if args.url_file:
        with open(args.url_file, "r", encoding="utf-8") as fh:
            args.url = next((ln.strip() for ln in fh if ln.strip()), "")
        print("[url-file] %s → %s" % (args.url_file, args.url))
    if args.url:
        # ---- 路线 C：真机同款链接（含 report= 自动回传）的本地彩排/实跑 ----
        arm = "flux-gs" if "bench-flux" in args.url else "ours"
        mode = MODE_OFFSCREEN if "benchmode=offscreen-paper-match" in args.url else MODE_ONSCREEN
        if not args.yes:
            print("[plan] %-8s %-22s %s" % (arm, mode, args.url))
            return 0
        if not dev_server_ok(args.base):
            return 2
        target = run_parent(arm, mode, args.url, args)
        made = [target] if target else []
    elif args.via == "case":
        # ---- 路线 A：直接驱动测量内核页（一景一轮 = 一份文档）----
        if "flux-gs" in arms:
            print("ℹ --via case 只支持 ours 臂（Flux-GS 的测量由 bench-flux.html 的父页面编排），已忽略 flux-gs")
            arms = [a for a in arms if a != "flux-gs"]
        for arm in arms:
            assets = scene_assets(arm)
            for mode in modes:
                for scene in [s for s in args.scenes.split(",") if s]:
                    info = assets.get(scene)
                    if not info:
                        print("✗ %s 的清单里没有场景 %s（跳过）" % (arm, scene))
                        continue
                    for roundno in range(1, args.rounds + 1):
                        params = (
                            list(CASE_PARAMS)
                            + [("scene", scene), ("dataset", info["dataset"]), ("frames", str(args.frames))]
                            + protocol_params(mode, args)
                        )
                        u = "paper-%s-%s-%s-r%d" % (arm, mode, scene, roundno)
                        url = build_case_url(args.base, params, u, info["model"])
                        if not args.yes:
                            print("[plan] %-8s %-22s %-10s r%s  %s" % (arm, mode, scene, roundno, url))
                            continue
                        target = run_one(arm, mode, url, args, scene, roundno)
                        if target:
                            made.append(target)
    else:
        # ---- 路线 B：走父页面队列（与 `ch7_batch.py run` 完全同一路线）----
        # 等 `--- per-round ---` 哨兵（结果文本里出现它就说明父页面已经把整份文本拼好了）。
        for arm, page in ARMS:
            if arm not in arms:
                continue
            for mode in modes:
                params = (
                    list(BASE_PARAMS)
                    + [("rounds", str(args.rounds)), ("profile", args.scenes),
                       ("u", "paper-%s-%s" % (arm, mode))]
                    + protocol_params(mode, args)
                )
                url = "%s/%s?%s" % (args.base.rstrip("/"), page,
                                    "&".join("%s=%s" % (k, v) for k, v in params))
                if not args.yes:
                    print("[plan] %-8s %-22s %s" % (arm, mode, url))
                    continue
                target = run_parent(arm, mode, url, args)
                if target:
                    made.append(target)

    if args.yes:
        print("-" * 90)
        print("已落盘 %d 份结果文本：%s" % (len(made), RAW_DIR))
        print("出对比表：")
        print("  python tools/ch7_paper_protocol_report.py --raw-dir \"%s\" --out-dir \"%s\""
              % (RAW_DIR, os.path.join(PROJECT_ROOT, "thesis_project", "data", "ch7_measurements",
                                       "paper_protocol")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
