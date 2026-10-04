# -*- coding: utf-8 -*-
"""把 `ch7_batch.py link` 的产物加工成 **C 层 FINAL 链接**（冷/热两组）。

为什么需要加工：`tools/ch7_common.build_url` 只写协议参数，**不带** FINAL 开关
（`shcache=frag&lr=1&notx=1&nocolortx=1`）⇒ 直接发出去的链接跑的是 BASE。
本脚本只在**链接级**追加这 4 个开关（页面从 URL 读开关，**不改任何代码**），并另给 `cold=0` 热组。

用法：python _tmp_ch7probe/c_links_final.py   → 打印并落盘 `_tmp_ch7probe/c_links_final.md`
"""

import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
GS = os.path.abspath(os.path.join(HERE, ".."))            # = gsplat.js
SRC = os.path.join(GS, "_tmp_ch7probe")                   # ch7_batch.py link 的产物所在（scratch）
FINAL = "&shcache=frag&lr=1&notx=1&nocolortx=1"
BATCHES = [("c1", "mip360", 9), ("c2", "T&T", 2), ("c3", "DB", 2)]


def main():
    out = ["# C 层 · FINAL 链接（Gen3 微信 · rounds=3 · 同会话 ABAB）", "",
           "> 加工方式：在 `ch7_batch.py link` 产物上**追加** `%s`（页面按 URL 读开关，未改任何代码）。" % FINAL,
           "> 缓存状态：冷组 `cold=1`（每轮全新上下文）；热组 `cold=0`。两臂必须同组同 cold。",
           "> 网络条件：协议**无该字段**（链接无 `net=`）⇒ 只能人工记录（请在手机同一 Wi-Fi 下连跑同一批）。",
           "> 每批的 `u=` 已区分（`helper01c1/c2/c3-gen3-xweb-main`），回传文件名即批次可辨。", ""]
    for tag, name, n in BATCHES:
        p = os.path.join(SRC, "c_link_%s.txt" % tag)
        if not os.path.exists(p):
            out += ["## 批次 %s · %s（%d 场景）" % (tag, name, n), "", "**缺产物：%s**" % p, ""]
            continue
        txt = open(p, encoding="utf-8", errors="replace").read()
        m = re.search(r"(https://\S+)", txt)
        if not m:
            out += ["## 批次 %s · %s（%d 场景）" % (tag, name, n), "", "**产物里没找到 URL**", ""]
            continue
        base = m.group(1)
        u = re.search(r"u=([A-Za-z0-9._-]+)", base)
        out += ["## 批次 %s · %s（%d 场景）· `u=%s`" % (tag, name, n, u.group(1) if u else "?"), "",
                "**冷组（cold=1，主结果）**", "", "```", base + FINAL, "```", "",
                "**热组（cold=0，首帧热值）**", "", "```", base.replace("cold=1", "cold=0") + FINAL, "```", ""]
    txt = "\n".join(out) + "\n"
    print(txt)
    open(os.path.join(SRC, "c_links_final.md"), "w", encoding="utf-8", newline="\n").write(txt)
    print("WROTE _tmp_ch7probe/c_links_final.md")


if __name__ == "__main__":
    main()
