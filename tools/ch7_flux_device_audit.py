"""Flux 真机记录只读审计 v2（**只读**，不新增测量、不下"首帧优劣"结论）。

v1 用「全文含 flux」判定，被 `pose_src=flux`（每条记录都有）污染 ⇒ 529 条假命中。v2 只看**臂标识**
（`u=` / 逐轮 `arm=` / `engine=`），并给出：字段清单、按设备分组的数值分布、三个必答问题。

用法：python _tmp_ch7probe/flux_device_audit2.py [--md docs/ch7_flux_device_records.md]
"""

import argparse
import glob
import os
import re
import statistics as st
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
GS = os.path.abspath(os.path.join(HERE, ".."))
RAW = os.path.join(os.path.dirname(GS), "thesis_project", "data", "ch7_measurements", "raw")
REAL = ("Snapdragon", "Adreno", "Mali", "Dimensity", "Apple", "PowerVR", "Immortalis")


def kv(line):
    m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
    return (m.group(1), m.group(2).strip()) if m else (None, None)


def is_flux(head, rounds):
    if "flux" in (head.get("u") or "").lower() or "flux" in (head.get("engine") or "").lower():
        return True
    return any("flux" in (r.get("arm") or "").lower() for r in rounds)


def parse(path):
    txt = open(path, encoding="utf-8", errors="replace").read()
    if not txt.startswith("[RESULT]"):
        return None
    head, rounds = {}, []
    for line in txt.splitlines():
        if line.startswith("scene="):
            rounds.append(dict(p.split("=", 1) for p in line.split(" ") if "=" in p))
        else:
            k, v = kv(line)
            if k:
                head.setdefault(k, v)
    return txt, head, rounds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--md", default="")
    a = ap.parse_args()
    rows, ms = [], {}
    files = set()
    for path in sorted(glob.glob(os.path.join(RAW, "**", "*.txt"), recursive=True)):
        if os.sep + "_reject" + os.sep in path:
            continue
        got = parse(path)
        if not got:
            continue
        txt, head, rounds = got
        for m in re.finditer(r"([A-Za-z_][A-Za-z0-9_]*)_ms=([0-9.\-]+)", txt):
            ms[m.group(1) + "_ms"] = ms.get(m.group(1) + "_ms", 0) + 1
        if not is_flux(head, rounds):
            continue
        files.add(os.path.basename(path))
        base = os.path.basename(path)
        date = base.split("_", 1)[1][:8] if "_" in base else "-"
        for r in (rounds or [{}]):
            g = lambda k: r.get(k, head.get(k, "-"))      # noqa: E731
            rows.append({"u": head.get("u", "-"), "chip": head.get("chip", "-"),
                         "dataset": r.get("dataset", head.get("profile", "-")),
                         "scene": r.get("scene", head.get("profile", "-")), "date": date, "file": base,
                         "ff": g("first_frame_ms"), "fetch": g("fetch_ms"), "parse": g("parse_ms"),
                         "decode": g("decode_ms"), "fps": g("fps"), "cold": head.get("cold", "-")})
    def nums(key, sel):
        out = []
        for r in rows:
            if sel(r) and r[key] not in ("-", ""):
                try:
                    out.append(float(r[key]))
                except ValueError:
                    pass
        return out

    def stat(v):
        return ("%d / %d / %d（n=%d）" % (min(v), int(st.median(v)), max(v), len(v))) if v else "无"

    dev = lambda r: any(c in r["chip"] for c in REAL)          # noqa: E731
    n_real = sum(1 for r in rows if dev(r))
    miss = [k for k in ("url", "model_base", "net", "network", "cache", "cached", "throttle") if k not in ms and k not in ("",)]
    lines = ["# 已有 Flux 记录 · 首帧/加载字段只读核对（v2，按臂标识判定）", "",
             "> 只读：**未新增任何测量**，数值全部来自 `thesis_project/data/ch7_measurements/raw/**` 已有记录。",
             "> 臂判定只看 `u=`/逐轮 `arm=`/`engine=` 是否含 `flux`（v1 的全文匹配被 `pose_src=flux` 污染，作废）。", "",
             "命中 Flux 记录文件 = **%d**，逐轮行 = **%d**（真机 %d 行 / 桌面 %d 行）。"
             % (len(files), len(rows), n_real, len(rows) - n_real), "",
             "## 1. 记录里出现过的加载/首帧计时字段", "",
             "| 字段 | 出现次数 | 含义（记录自身 `*_def=`） |", "|---|---|---|",
             "| `fetch_ms` | %d | 请求发出 → 响应体接收完（**下载段**） |" % ms.get("fetch_ms", 0),
             "| `parse_ms` | %d | 解析/上传段（本文臂口径） |" % ms.get("parse_ms", 0),
             "| `decode_ms` | %d | Flux 臂解码段（TMC3 + 逐点 MLP，worker 内） |" % ms.get("decode_ms", 0),
             "| `first_frame_ms` | %d | 响应结束 → **首个真实绘制帧** |" % ms.get("first_frame_ms", 0),
             "| 其余 `*_ms=` | %s | 记录里出现过的其它计时字段 |"
             % (", ".join(sorted(k for k in ms if k not in ("fetch_ms", "parse_ms", "decode_ms", "first_frame_ms")))
                or "无"), "",
             "## 2. 数值分布（min / median / max）", "",
             "| 分组 | first_frame_ms | fetch_ms | parse_ms | decode_ms |", "|---|---|---|---|---|",
             "| **真机**（手机 GPU） | %s | %s | %s | %s |" % (
                 stat(nums("ff", dev)), stat(nums("fetch", dev)), stat(nums("parse", dev)), stat(nums("decode", dev))),
             "| **桌面**（ANGLE/RTX） | %s | %s | %s | %s |" % (
                 stat(nums("ff", lambda r: not dev(r))), stat(nums("fetch", lambda r: not dev(r))),
                 stat(nums("parse", lambda r: not dev(r))), stat(nums("decode", lambda r: not dev(r)))), "",
             "## 3. 三个必答问题（只陈述记录事实）", "",
             "1. **是否区分「下载」与「解析/渲染」**：可分 —— `fetch_ms`（下载段）与 `first_frame_ms`"
             "（响应结束→首帧）同条共存；Flux 臂另有 `decode_ms`（worker 解码段）。",
             "2. **当时是否走 HF 远程**：**未记录** —— Flux 记录里没有 `url=`/`model_base=` 等字段，"
             "无法从记录判断数据来自 HuggingFace 还是本地副本。",
             "3. **网络与缓存状态**：**未记录**（无带宽/延迟/代理字段）；缓存状态**只有** `cold=1`（冷启动）标记，"
             "没有 `cache=`/`cached=` 字段。", "",
             "> 不对「首帧优劣」下结论；本表只列字段名与数值区间。", "",
             "## 4. 逐行明细（前 120 行；`--md` 落盘的完整表更长）", "",
             "| u= | chip | dataset | scene | 日期 | 文件 | first_frame_ms | fetch_ms | parse_ms | decode_ms | fps |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows[:120]:
        lines.append("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" %
                     (r["u"], r["chip"], r["dataset"], r["scene"], r["date"], r["file"],
                      r["ff"], r["fetch"], r["parse"], r["decode"], r["fps"]))
    txt = "\n".join(lines) + "\n"
    print("\n".join(lines[:44]))
    if a.md:
        os.makedirs(os.path.dirname(a.md), exist_ok=True)
        open(a.md, "w", encoding="utf-8", newline="\n").write(txt)
        print("WROTE " + a.md)


if __name__ == "__main__":
    main()
