# -*- coding: utf-8 -*-
"""清理 `_tmp_ch7probe/` 里的一次性探针产物（白名单保留，其余删除）。默认 dry-run。

为什么要白名单：该目录是 **gitignore 的 scratch 区**（351 个文件，绝大多数是一次性探针的
`.err/.log/stat*.txt/probe*.txt` 与已被 `tools/` 取代的旧脚本）。删错会丢证据 ⇒ 只保留：
  · `cdp.mjs`                     —— `tools/ch7_batch.py run` 依赖的 CDP 驱动器（**不能删**）
  · `out/fps_hist.csv`            —— 文档引用的历史汇总
  · `out/flux_net_<scene>.json`   —— Flux 运行时抓包原始产物（13 份，`docs/ch7_flux_runtime.md` 的证据）
  · `c_link_c{1,2,3}.txt`         —— `tools/ch7_c_links_final.py` 的输入
  · `c_links_final.md`            —— 已发出的 C 层链接留档

用法：python tools/ch7_tmp_cleanup.py          # 只看将删什么
      python tools/ch7_tmp_cleanup.py --apply  # 真的删
"""

import argparse
import glob
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

GS = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
TMP = os.path.join(GS, "_tmp_ch7probe")
KEEP_TOP = {"cdp.mjs", "flux_net.mjs", "fps_hist.py", "f0_table.py",
            "c_link_c1.txt", "c_link_c2.txt", "c_link_c3.txt", "c_links_final.md"}
KEEP_OUT = {"fps_hist.csv", "f0_analysis.md", "f0_table.md", "cg_base.png", "cg_frag.png"}


def keep(rel):
    if rel in KEEP_TOP:
        return True
    if rel.startswith("out" + os.sep):
        base = os.path.basename(rel)
        return base in KEEP_OUT or (base.startswith("flux_net_") and base.endswith(".json"))
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    victims, freed, kept = [], 0, []
    for p in glob.glob(os.path.join(TMP, "**", "*"), recursive=True):
        if os.path.isdir(p):
            continue
        rel = os.path.relpath(p, TMP)
        if keep(rel):
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
