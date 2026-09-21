# -*- coding: utf-8 -*-
"""第 7 章统一重测的跑批与落盘工具（协议 docs/ch7_measurement_protocol.md §4/§5/§8）。

子命令
  plan    只生成跑批计划与 `protocol.json` 快照（不启动任何浏览器）
  run     桌面通道：用 `_tmp_ch7probe/cdp.mjs` 起无头 Edge 跑 bench 页，页面文本拆成逐轮 JSON
  ingest  人工通道：把手机页面「复制结果」文本拆成逐轮 JSON（手机端无需 adb）
  count   只做数量/字段/资产校验（委托给 ch7_verify.verify）

落盘（协议 §4.1，唯一合法位置）
  thesis_project/data/ch7_measurements/raw/{platform}/{scene_key}/round{n}.json
  thesis_project/data/ch7_measurements/raw/{platform}/_page/{scene_key}-{ts}.txt   # 页面原始文本留档
  thesis_project/data/ch7_measurements/protocol.json                              # 批次协议快照

每条逐轮 JSON 的结构（顶层平铺逐轮字段，便于校验脚本直接读取）：
  protocol_id / group / platform / scene_key / scene / dataset / round / source
  fps / frame_ms / fps_capped / floor_used_ms / cpu_ms / points / bytes / parse_ms /
  first_frame_ms / fetch_ms / covered / kept / ok / drawOk / raw_line
  header = {结果头全文（u/chip/ts/driver/frames/res/timer_floor_ms/...）}

注意：手机端"自动收数"需要 adb + `chrome://inspect` 端口转发并改造 driver（见协议 §7 卡点 1，
当前 adb 未安装）；在此之前手机端一律走 `ingest` 人工通道，两条通道产出的逐轮 JSON 结构完全一致。
"""

import argparse
import datetime
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ch7_common as C          # noqa: E402
import ch7_verify as V          # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

CDP_DRIVER = os.path.join(C.GS_REPO, "_tmp_ch7probe", "cdp.mjs")
WAIT_SENTINEL = "--- per-round ---"
EXPR_RESULT_TEXT = "(document.getElementById('rc-text')||{}).value||''"
EXPR_POLL = ("(document.getElementById('rc-text')||{}).value"
             "?document.getElementById('rc-text').value.slice(0,300)"
             ":document.body.innerText.slice(0,300)")

# 逐轮行里要保留的字段（协议 §3）
ROUND_FIELDS = ("scene", "dataset", "round", "ok", "drawOk", "points", "bytes", "fetch_ms",
                "parse_ms", "first_frame_ms", "fps", "cpu_ms", "frame_ms", "frame_mean_ms",
                "fps_capped", "floor_used_ms", "timer_floor_ms", "sync_ms", "sync_frames",
                "covered", "kept", "driver", "res_mode", "frames", "elapsed_ms", "err")

HEADER_FIELDS = ("u", "chip", "vendor", "engine", "isolation", "profile", "rounds", "cold",
                 "res", "frames", "driver", "res_mode", "timer_floor_ms", "timer_floor_rounds",
                 "timer_floor_src", "sync_ms", "fps_capped", "frame_ms", "stage", "proto",
                 "cam", "pose_src", "warmup", "fx", "ts", "ua", "gl_renderer", "screen",
                 "dpr", "hardwareConcurrency", "deviceMemory", "fps_def", "cpu_def",
                 "parse_def", "first_frame_def")


def now_iso():
    return datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def git_head(repo):
    try:
        out = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"],
                             capture_output=True, text=True, check=False)
        return out.stdout.strip() if out.returncode == 0 else ""
    except OSError:
        return ""


def protocol_id(gs_head, params):
    """协议 §1：`<锚定 commit 短 sha> + 参数集 sha1 前 8 位>`。"""
    import hashlib
    blob = json.dumps(params, sort_keys=True, ensure_ascii=False).encode("utf-8")
    params_sha = hashlib.sha1(blob).hexdigest()[:8]
    return "%s+%s" % ((gs_head or "nogit")[:12], params_sha)


def build_snapshot():
    params = dict(C.PROTO_PARAMS)
    params["rounds"] = C.ROUNDS
    gs_head = git_head(C.GS_REPO)
    main_head = git_head(C.PROJECT_ROOT)
    return {
        "protocol_id": protocol_id(gs_head, params),
        "created": now_iso(),
        "gsplat_head": gs_head,
        "main_head": main_head,
        "params": params,
        "platforms": list(C.PLATFORMS),
        "scenes": C.scene_ids(),
        "load_scenes": list(C.LOAD_SCENES),
        "load_arms": list(C.LOAD_ARMS),
        "res_tiers": list(C.RES_TIERS),
        "expected": {("%s/%s" % k): v for k, v in C.expected_files()[0].items()},
        "protocol_doc": os.path.relpath(C.PROTOCOL_DOC, C.PROJECT_ROOT).replace("\\", "/"),
    }


def tasks_for(group, platforms, base):
    """生成 [(platform, group, scene_key, url), ...]。"""
    plan = []
    for platform in platforms:
        for key in C.scene_keys(group, platform):
            url = C.build_url(base, group, key, platform=platform,
                              u="%s-%s-%s" % (platform, group, key))
            plan.append({"platform": platform, "group": group, "scene_key": key, "url": url})
    return plan


# --------------------------------------------------------------------------- 落盘

def read_snapshot():
    if os.path.isfile(C.PROTOCOL_SNAPSHOT):
        try:
            with open(C.PROTOCOL_SNAPSHOT, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (ValueError, OSError):
            return None
    return None


def current_protocol_id():
    snap = read_snapshot()
    return snap["protocol_id"] if snap else build_snapshot()["protocol_id"]


def scene_key_for(group, scene, header, arm=None):
    """逐轮行 → raw/ 下的一级子目录名（协议 §4.1）。"""
    if group == C.GRP_MAIN:
        return scene
    if group == C.GRP_LOAD:
        return "%s-%s" % (scene, arm or "r7")
    tier = str(header.get("res", "")).strip()
    return "garden-%s" % tier if tier else scene


def backup_existing(path):
    """协议 §4.4：不就地覆盖；旧文件改名保留为 `round{n}.superseded.{ts}.json`。"""
    if not os.path.isfile(path):
        return
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    old = path.replace(".json", ".superseded.%s.json" % stamp)
    os.replace(path, old)


def ingest_text(text, platform, group, arm=None, tag="", root=None):
    """把整页结果文本拆成逐轮 JSON 落盘。返回 (写入条数, {scene_key: 轮次数})。"""
    root = root or C.RAW_ROOT
    header, rounds = C.parse_result_text(text)
    if not rounds:
        return 0, {}
    pid = current_protocol_id()
    dataset_map = C.scene_datasets()
    counts = {}
    done_pairs = set()
    duplicated = []
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    page_path = os.path.join(root, platform, "_page", "%s-%s.txt" % (tag or platform, stamp))
    os.makedirs(os.path.dirname(page_path), exist_ok=True)
    with open(page_path, "w", encoding="utf-8") as fh:
        fh.write(text)
    for item in rounds:
        scene = str(item.get("scene", "")).strip()
        try:
            n = int(item.get("round") or 0)
        except (TypeError, ValueError):
            n = 0
        if not scene or n < 1:
            continue
        seen = (scene, n)
        if seen in done_pairs:
            duplicated.append("%s 第%d轮（同一份文本里出现多次，后者覆盖前者）" % seen)
        done_pairs.add(seen)
        key = scene_key_for(group, scene, header, arm)
        obj = {
            "protocol_id": pid, "group": group, "platform": platform, "scene_key": key,
            "scene": scene, "dataset": item.get("dataset") or dataset_map.get(scene, ""),
            "round": n, "source": "page-text", "written_at": now_iso(),
            "raw_line": item.get("raw_line", ""),
            "header": {k: header.get(k) for k in HEADER_FIELDS if k in header},
        }
        for field in ROUND_FIELDS:
            if field in item:
                obj[field] = item[field]
        path = os.path.join(root, platform, key, "round%d.json" % n)
        backup_existing(path)
        C.write_json(path, obj)
        counts[key] = counts.get(key, 0) + 1
    for line in duplicated:
        print("⚠ 重复轮次（已按后出现的一条落盘，旧文件已备份为 .superseded.*）：%s" % line)
    return len(rounds), counts


# --------------------------------------------------------------------------- 子命令

def cmd_plan(args):
    snap = build_snapshot()
    C.write_json(C.PROTOCOL_SNAPSHOT, snap)
    print("协议快照：%s" % C.PROTOCOL_SNAPSHOT)
    print("  protocol_id = %s（gsplat.js@%s，主仓@%s）"
          % (snap["protocol_id"], (snap["gsplat_head"] or "-")[:12], (snap["main_head"] or "-")[:12]))
    print("-" * 78)
    table, total = C.expected_files()
    for (grp, plat), exp in sorted(table.items()):
        keys = C.scene_keys(grp, plat)
        print("%-4s / %-7s 场景 %2d 个 × %d 轮 = 期望文件 %3d   示例 URL：\n        %s"
              % (grp, plat, len(keys), C.ROUNDS, exp,
                 C.build_url(args.base, grp, keys[0], platform=plat,
                             u="%s-%s-%s" % (plat, grp, keys[0]))))
    print("-" * 78)
    print("协议全量期望文件数：%d（协议 §4.2）" % total)
    print("提示：跑批落盘根目录 = %s" % C.RAW_ROOT)
    return 0


def cmd_ingest(args):
    with open(args.text, "r", encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    written, counts = ingest_text(text, args.platform, args.group, arm=args.arm,
                                  tag=args.tag or os.path.splitext(os.path.basename(args.text))[0],
                                  root=args.root)
    if written == 0:
        print("✗ 文本里没解析出逐轮行（缺少 `--- per-round ---` 段？）")
        return 1
    print("来自 %s：解析逐轮行 %d 条，已落盘到 %s/%s/"
          % (args.text, written, args.root, args.platform))
    for key in sorted(counts):
        print("   %-24s %d 轮" % (key, counts[key]))
    print("下一步：python gsplat.js/tools/ch7_batch.py count --platforms %s" % args.platform)
    return 0


DEFAULT_BASE = "http://localhost:4173"      # npm run site:preview（site-dist/）


def cmd_run(args):
    """桌面通道：逐场景跑 bench 页 → 页面文本 → 逐轮 JSON → 立刻做数量校验。"""
    if not os.path.isfile(CDP_DRIVER):
        print("✗ 找不到 CDP 驱动器：%s" % CDP_DRIVER)
        return 2
    platform = args.platform
    keys = C.scene_keys(args.group, platform)
    if not keys:
        print("✗ 组 %s 在平台 %s 上没有场景（检查协议 §4.1 的分组规则）" % (args.group, platform))
        return 2
    if args.group == C.GRP_LOAD and not args.arm:
        print("✗ 表 7-5 是两臂实验，必须显式给 --arm r7 或 --arm std45")
        return 2
    snap = read_snapshot() or build_snapshot()
    print("protocol_id = %s   平台 = %s   组 = %s   场景 = %d 个"
          % (snap["protocol_id"], platform, args.group, len(keys)))
    print("落盘根目录 = %s" % C.RAW_ROOT)
    print("-" * 78)
    failed = []
    for task in tasks_for(args.group, [platform], args.base):
        tmp = os.path.join(C.RAW_ROOT, "_cdp_tmp", "%s-%s.json" % (platform, task["scene_key"]))
        cmd = ["node", CDP_DRIVER, "--url=" + task["url"], "--wait=" + WAIT_SENTINEL,
               "--expr=" + EXPR_RESULT_TEXT, "--pollExpr=" + EXPR_POLL,
               "--out=" + tmp, "--timeout=%d" % args.timeout, "--port=%d" % args.port]
        print("[run] %-24s %s" % (task["scene_key"], task["url"]))
        if not args.yes:
            print("      （dry-run，未启动浏览器；加 --yes 才会真跑）")
            continue
        subprocess.run(cmd, check=False)
        if not os.path.isfile(tmp):
            failed.append(task["scene_key"] + "：驱动器未产出结果文件")
            print("      ✗ 驱动器未产出 %s" % tmp)
            continue
        with open(tmp, "r", encoding="utf-8") as fh:
            obj = json.load(fh)
        text = obj.get("value") or ""
        if not isinstance(text, str) or WAIT_SENTINEL not in text:
            failed.append(task["scene_key"] + "：结果文本为空或未达哨兵（matched=%s）" % obj.get("matched"))
            print("      ✗ 页面未给出完成的结果文本（matched=%s，见 %s）" % (obj.get("matched"), tmp))
            continue
        written, counts = ingest_text(text, platform, args.group, arm=args.arm, tag="run-" + task["scene_key"])
        print("      ✓ 落盘 %d 条：%s" % (written, ", ".join("%s×%d" % (k, v) for k, v in sorted(counts.items()))))
    print("-" * 78)
    if args.yes:
        print("跑批结束，执行数量/字段/资产校验：")
        code = cmd_count(argparse.Namespace(root=args.root, manifest=args.manifest, groups=args.group,
                                           platforms=platform, write_index=args.write_index))
    else:
        print("dry-run 结束。真跑请追加 --yes。")
        code = 0
    if failed:
        print("✗ 失败项（%d）：" % len(failed))
        for line in failed:
            print("   - %s" % line)
        return 1
    return code


def cmd_count(args):
    """委托给 ch7_verify.verify（数量 / 必填字段 / 资产对账 三重校验）。"""
    return V.cmd_verify(argparse.Namespace(root=args.root, manifest=args.manifest, groups=args.groups,
                                           platforms=args.platforms, write_index=args.write_index,
                                           bytes_tol=getattr(args, "bytes_tol", 1024)))


def build_parser():
    parser = argparse.ArgumentParser(description="第 7 章统一重测：跑批计划、采数落盘与计数校验")
    sub = parser.add_subparsers(dest="cmd")

    p1 = sub.add_parser("plan", help="生成 protocol.json 快照并打印跑批计划（不启动浏览器）")
    p1.add_argument("--base", default=DEFAULT_BASE)
    p1.set_defaults(func=cmd_plan)

    p2 = sub.add_parser("run", help="桌面通道跑批（默认 dry-run，加 --yes 才真跑）")
    p2.add_argument("--platform", required=True, choices=list(C.PLATFORMS))
    p2.add_argument("--group", default=C.GRP_MAIN, choices=[C.GRP_MAIN, C.GRP_LOAD, C.GRP_RES])
    p2.add_argument("--arm", default=None, choices=[None, "r7", "std45"], help="仅表 7-5 需要")
    p2.add_argument("--base", default=DEFAULT_BASE)
    p2.add_argument("--timeout", type=int, default=1800, help="单场景超时秒数（13 场景×3 轮≈15–25 分钟）")
    p2.add_argument("--port", type=int, default=9333)
    p2.add_argument("--yes", action="store_true", help="确认真跑")
    p2.add_argument("--root", default=C.RAW_ROOT)
    p2.add_argument("--manifest", default=C.MANIFEST)
    p2.add_argument("--write-index", default="")
    p2.set_defaults(func=cmd_run)

    p3 = sub.add_parser("ingest", help="人工通道：把页面「复制结果」文本拆成逐轮 JSON")
    p3.add_argument("--platform", required=True, choices=list(C.PLATFORMS))
    p3.add_argument("--text", required=True)
    p3.add_argument("--group", default=C.GRP_MAIN, choices=[C.GRP_MAIN, C.GRP_LOAD, C.GRP_RES])
    p3.add_argument("--arm", default=None, choices=[None, "r7", "std45"])
    p3.add_argument("--tag", default="")
    p3.add_argument("--root", default=C.RAW_ROOT, help="落盘根目录（测试时可指到临时目录）")
    p3.set_defaults(func=cmd_ingest)

    p4 = sub.add_parser("count", help="只做数量/字段/资产校验")
    p4.add_argument("--root", default=C.RAW_ROOT)
    p4.add_argument("--manifest", default=C.MANIFEST)
    p4.add_argument("--groups", default="main,load,res")
    p4.add_argument("--platforms", default=",".join(C.PLATFORMS))
    p4.add_argument("--write-index", default="")
    p4.add_argument("--bytes-tol", type=int, default=1024)
    p4.set_defaults(func=cmd_count)
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


