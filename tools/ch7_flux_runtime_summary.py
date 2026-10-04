"""Flux 运行时抓包汇总：把 `_tmp_ch7probe/out/flux_net_<scene>.json`（cdp/flux_net.mjs 产物）
汇总成 13 场景表 —— 每场景：其 `<scene>.json` 的传输字节与来源（本地/HF）、本地站点代码字节、
远程请求条数、页面文本（可见性自证）。只读产物，不联网、不改仓库。

用法：python _tmp_ch7probe/flux_net_summary.py [--md docs/ch7_flux_runtime.md]
"""

import argparse
import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
GS = os.path.abspath(os.path.join(HERE, ".."))            # = gsplat.js
OUT = os.path.join(GS, "_tmp_ch7probe", "out")            # 抓包产物落在 scratch 工作区（gitignore）
SCENES = ["garden", "bicycle", "flowers", "stump", "treehill", "room", "counter",
          "kitchen", "bonsai", "truck", "train", "drjohnson", "playroom"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--md", default="")
    a = ap.parse_args()
    rows, total_scene, total_local, missing = [], 0, 0, []
    for s in SCENES:
        p = os.path.join(OUT, "flux_net_%s.json" % s)
        if not os.path.exists(p):
            missing.append(s)
            continue
        d = json.load(open(p, encoding="utf-8"))
        reqs = d["requests"]
        # 场景数据 = 唯一那个 .json 请求（HF 或本地）
        scene_req = [r for r in reqs if r["url"].endswith("/%s.json" % s) or r["url"].endswith("%s.json" % s)]
        local = sum(r.get("encoded", 0) for r in reqs if "127.0.0.1" in r["url"] or "localhost" in r["url"])
        remote = d["totals"]["remoteCount"]
        sb = scene_req[0]["encoded"] if scene_req else 0
        src = scene_req[0]["origin"] if scene_req else "(无)"
        total_scene += sb
        total_local += local
        rows.append("| %s | %d | %.2f | %d | %.2f | %s | %d | %d |" %
                    (s, sb, sb / 1048576, local, local / 1048576, src, remote, d["totals"]["count"]))
    lines = ["# Flux 页面**运行时**请求清单（实测，13 场景）", "",
             "> 口径：`_tmp_ch7probe/flux_net.mjs`（CDP `Network.enable` + 禁缓存 + `Page.navigate`），",
             "> 页面 `flux-gs-project-gh-pages/render_<scene>/index.html` 由本机 vite dev server 托管。",
             "> 「本地字节」含 `@vite/client` 等 **dev 注入**（正式 gh-pages 部署不存在）。", "",
             "| scene | `<scene>.json` 传输字节 | = MiB | 本地站点字节 | = MiB | 数据来源 | 远程请求数 | 总请求数 |",
             "|---|---|---|---|---|---|---|---|"] + rows + [
             "| **合计** | **%d** | **%.2f MiB** | **%d** | **%.2f MiB** | — | — | — |" %
             (total_scene, total_scene / 1048576, total_local, total_local / 1048576), ""]
    if missing:
        lines += ["未完成（缺 json 产物）：%s" % ", ".join(missing), ""]
    txt = "\n".join(lines) + "\n"
    print(txt)
    if a.md:
        open(a.md, "w", encoding="utf-8", newline="\n").write(txt)
        print("WROTE " + a.md)


if __name__ == "__main__":
    main()
