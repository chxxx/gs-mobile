# -*- coding: utf-8 -*-
"""清理 `_tmp_ch7probe/` 里的一次性探针产物（**黑名单删垃圾**，默认 dry-run）。

为什么改成黑名单：旧版按白名单保留（只认 `cdp.mjs` / `c_link_c*.txt` / `flux_net_*.json` /
`fps_hist.csv` 这一代产物），而目录里现在是**第 7 章画幅证据**（`out/side_*` 并排图与页面记录、
`ch7_D9400_table_*.md`、`sim3.mjs` / `plylib.mjs` / `compose_side.mjs` 等工具）——
照旧白名单 `--apply` 会把它们全删掉。现在只删"可再生成"的垃圾：

  · `*.log`                —— dev server / 隧道 / 无头取景日志（进程在跑时删不掉，跳过即可）
  · `_*.txt` / `_*.html`   —— 探针临时输出与 `compose_side.mjs` 的排版中间件
  · `_side_mask.png`       —— 差集掩码中间件（`compose_side.mjs` 每次重生成）
  · `diag_*.txt`、`*_fail.png` —— 一次性诊断与失败截图

一律**不删**：`bin/`（隧道二进制，`tools/ch7_serve.ps1` 依赖且不会自动下载）、
所有 `.mjs/.py/.cmd/.ps1/.md/.csv/.json/.txt` 文本与 `.png` 证据。

用法：python tools/ch7_tmp_cleanup.py          # 只看将删什么
      python tools/ch7_tmp_cleanup.py --apply  # 真的删
"""

import argparse
import fnmatch
import glob
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

GS = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
TMP = os.path.join(GS, "_tmp_ch7probe")
# 黑名单：文件名匹配这些模式的就是"可再生成的垃圾"（其余一律保留）
JUNK_PATTERNS = [
    "*.log",           # dev server / 隧道 / 无头取景日志
    "_*.txt",          # 探针临时输出（_q*.txt / _s.txt / _p.txt / _dir.txt / _chk*.txt …）
    "_*.html",         # compose_side.mjs 的排版中间件
    "_side_mask.png",  # 差集掩码中间件（每次重生成）
    "diag_*.txt",
    "*_fail.png",      # 失败截图
]


def is_junk(rel):
    """True = 可再生成的垃圾（会被删）；False = 保留。"""
    if rel.startswith("bin" + os.sep):
        # 隧道二进制（`tools/ch7_serve.ps1` 期望 `bin/cloudflared.exe`，且**不会自动下载**）——勿删
        return False
    base = os.path.basename(rel).lower()
    return any(fnmatch.fnmatch(base, pat) for pat in JUNK_PATTERNS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    victims, freed, kept = [], 0, []
    for p in glob.glob(os.path.join(TMP, "**", "*"), recursive=True):
        if os.path.isdir(p):
            continue
        rel = os.path.relpath(p, TMP)
        if not is_junk(rel):
            kept.append(rel)
            continue
        try:
            freed += os.path.getsize(p)
        except OSError:
            pass
        victims.append(p)
    print("保留 %d 个：%s" % (len(kept), ", ".join(sorted(kept)[:6]) + (" …" if len(kept) > 6 else "")))
    print("将删除 %d 个文件，释放 %.1f MB" % (len(victims), freed / 1048576))
    for v in sorted(victims)[:15]:
        print("  - " + os.path.relpath(v, GS))
    if len(victims) > 15:
        print("  … 其余 %d 个" % (len(victims) - 15))
    if not a.apply:
        print("（dry-run；加 --apply 才真删）")
        return 0
    n = 0
    for v in victims:
        try:
            os.remove(v)
            n += 1
        except OSError as e:
            print("  删除失败 %s: %s" % (v, e))
    # 顺手清空 out 下的空目录
    for d in sorted(glob.glob(os.path.join(TMP, "**", "*"), recursive=True), reverse=True):
        if os.path.isdir(d):
            try:
                os.rmdir(d)
            except OSError:
                pass
    print("已删除 %d 个文件" % n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
