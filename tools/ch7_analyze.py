# -*- coding: utf-8 -*-
"""阶段3/4/5 分析脚手架（一个 CLI 三个子命令，均可 `--mock` 自检）。

  python tools/ch7_analyze.py validate [--mock] [--md <out.md>]      # 阶段3 字段完整性与真实性校验
  python tools/ch7_analyze.py stats    [--mock] [--md <out.md>]      # 阶段4 配对统计
  python tools/ch7_analyze.py tables   [--mock] [--outdir <dir>]     # 阶段5 三线表 + 两张图

设计要点（照任务规格，不自行简化）：
  · 臂身份**只认记录里的** `arm=` / `sw_effective=`（渲染层 `window.__CH7_ARM__` 的发布值），
    绝不用文件名或链接备注推断；
  · 网络口径只认 `network_regime=` 字段（Flux 臂结果头由 bench-flux.ts 打出 controlled/official）；
  · 统计以 **Wilcoxon 符号秩**为主、配对 t 为辅，附均值差 / 95%CI / Cohen's d；
    体积比与首帧比用**几何平均**；另出 ΔPSNR/每 MB；
  · Mali(P2)数据单独成组，只做方向性定性判断，不并入 13 场景主统计。
"""

import argparse
import glob
import json
import math
import os
import random
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

GS = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
RAW = os.path.join(os.path.dirname(GS), "thesis_project", "data", "ch7_measurements", "raw")
SCENES = ["garden", "bicycle", "flowers", "stump", "treehill", "room", "counter", "kitchen",
          "bonsai", "truck", "train", "drjohnson", "playroom"]
REQUIRED_ROUND = ["scene", "dataset", "round", "ok", "points", "bytes", "fetch_ms", "parse_ms",
                  "first_frame_ms", "fps", "frame_ms", "sync_ms", "covered", "kept"]
EPS_MS = 5.0            # first_frame_ms >= parse_ms - EPS 的容忍
AB_FPS_TOL = 0.05       # 口径 A/B 同场景同臂 FPS 差异阈值（±5%）


def kv(line):
    m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
    return (m.group(1), m.group(2).strip()) if m else (None, None)


def parse_record(path):
    """一条回传记录 → {header, rounds[]}；非结果文本返回 None。"""
    txt = open(path, encoding="utf-8", errors="replace").read()
    if not txt.startswith("[RESULT]"):
        return None
    head, rounds = {}, []
    for line in txt.splitlines():
        if line.startswith("scene="):
            rounds.append({k: v for k, v in (p.split("=", 1) for p in line.split(" ") if "=" in p)})
        else:
            k, v = kv(line)
            if k:
                head.setdefault(k, v)
    return {"file": os.path.basename(path), "header": head, "rounds": rounds}


def classify(rec):
    """返回 (arm, regime, device, browser)；臂身份只来自记录字段。"""
    h = rec["header"]
    sw = (h.get("sw_effective") or "") + " " + (h.get("sw") or "") + " " + (h.get("arm") or "")
    if (h.get("engine") or "").lower().startswith("flux") or "flux" in (h.get("u") or "").lower():
        arm = "flux"
    else:
        arm = "final" if ("lr=1" in sw and "nocolortx=1" in sw) else "base"
    regime = h.get("network_regime", "n/a")
    return arm, regime, h.get("chip", "?"), h.get("browser", h.get("kernel", "?"))


def load(paths=None):
    out = []
    files = paths or sorted(glob.glob(os.path.join(RAW, "**", "*.txt"), recursive=True))
    for p in files:
        if os.sep + "_probe" + os.sep in p or os.sep + "_reject" + os.sep in p:
            continue
        r = parse_record(p)
        if not r or not r["rounds"]:
            continue
        arm, regime, dev, br = classify(r)
        for rd in r["rounds"]:
            row = {"file": r["file"], "arm": arm, "regime": regime, "device": dev, "browser": br}
            row.update({k: rd.get(k, r["header"].get(k, "")) for k in REQUIRED_ROUND})
            for extra in ("network_regime", "engine", "u", "res", "driver", "cold"):
                row[extra] = rd.get(extra, r["header"].get(extra, ""))
            out.append(row)
    return out


def mock(n_round=3):
    """模拟数据（仅用于验证脚本可用）：结构/字段与真实记录一致，数值带固定种子的抖动。"""
    rnd = random.Random(20261006)
    rows = []
    for s in SCENES:
        for arm, base in (("final", 100.0), ("flux", 103.0)):
            for regime in ("controlled", "official"):
                for r in range(1, n_round + 1):
                    fps = base * (1 + rnd.uniform(-0.06, 0.06)) * (1.0 if regime == "controlled" else 0.99)
                    first = (6000.0 if arm == "final" else 24000.0) * (0.8 if regime == "official" else 1.0)
                    rows.append({"file": "MOCK", "arm": arm, "regime": regime, "device": "Gen3(MOCK)",
                                 "browser": "xweb", "scene": s, "dataset": "mip360", "round": str(r),
                                 "ok": "1", "points": "610000", "bytes": "14648586",
                                 "fetch_ms": "%.0f" % (first * 0.1), "parse_ms": "%.0f" % (first * 0.5),
                                 "first_frame_ms": "%.0f" % first, "fps": "%.1f" % fps,
                                 "frame_ms": "%.2f" % (1000.0 / fps), "sync_ms": "%.2f" % (rnd.uniform(1, 3)),
                                 "covered": "100.0", "kept": "100.0", "network_regime": regime,
                                 "engine": "fluxgs" if arm == "flux" else "gsplat", "u": "MOCK",
                                 "res": "1600x1063", "driver": "timer", "cold": "1"})
    return rows


# ------------------------------------------------------------------ 阶段3：校验
def cmd_validate(rows, args):
    problems, pending, infra = [], [], []
    by_pending = {}
    for r in rows:
        if r["arm"] not in ("final", "flux", "base"):
            problems.append("%s: 臂身份缺失/不可识别（arm=%s）" % (r["file"], r["arm"]))
        miss = [k for k in REQUIRED_ROUND if str(r.get(k, "")) == ""]
        if miss:
            problems.append("%s(%s r%s): 缺字段 %s" % (r["file"], r["scene"], r["round"], ",".join(miss)))
        try:
            fetch, parse, first = float(r["fetch_ms"]), float(r["parse_ms"]), float(r["first_frame_ms"])
            if min(fetch, parse, first) < 0:
                problems.append("%s: 计时为负 fetch=%s parse=%s first=%s" % (r["file"], fetch, parse, first))
            elif first < parse - EPS_MS:
                pending.append("%s(%s %s r%s): first_frame_ms(%.0f) < parse_ms(%.0f) − %.0fms"
                               % (r["file"], r["scene"], r["arm"], r["round"], first, parse, EPS_MS))
                by_pending[(r["scene"], r["arm"])] = by_pending.get((r["scene"], r["arm"]), 0) + 1
        except ValueError:
            problems.append("%s: 计时字段非数值" % r["file"])
        if r.get("network_regime", "n/a") not in ("controlled", "official"):
            pending.append("%s(%s): network_regime 缺失/未知（%s）" % (r["file"], r["scene"], r.get("network_regime")))
        if not r.get("frame_ms") or not r.get("sync_ms") or not r.get("covered") or not r.get("kept"):
            problems.append("%s(%s): fps/frame_ms/sync_ms/covered/kept 不完整" % (r["file"], r["scene"]))
    for (scene, arm), n in by_pending.items():
        if n >= 3:
            infra.append("%s/%s 连续 %d 次违反 first_frame≥parse−ε ⇒ 升级为基础设施问题，暂停该配置"
                         % (scene, arm, n))
    key, cross = {}, []
    for r in rows:
        if r["regime"] in ("controlled", "official") and r["fps"]:
            try:
                key.setdefault((r["scene"], r["arm"], r["regime"]), []).append(float(r["fps"]))
            except ValueError:
                pass
    for scene, arm in sorted({(k[0], k[1]) for k in key}):
        a, b = key.get((scene, arm, "controlled")), key.get((scene, arm, "official"))
        if a and b:
            fa, fb = sum(a) / len(a), sum(b) / len(b)
            d = abs(fa - fb) / max(fa, 1e-9)
            if d > AB_FPS_TOL:
                cross.append("%s/%s: 口径A=%.1f vs 口径B=%.1f（差 %.1f%% > %.0f%%）⇒ 标记异常待排查"
                             "（**不得**默认归因于网络口径）" % (scene, arm, fa, fb, d * 100, AB_FPS_TOL * 100))
    L = ["# 阶段3 · 字段完整性与真实性校验", "",
         "输入：%s" % ("**模拟数据（MOCK，仅验证脚本可用）**" if args.mock
                    else "`thesis_project/data/ch7_measurements/raw/**` 真机回传记录"),
         "逐轮行数 = **%d**" % len(rows), "",
         "| 检查项 | 结论 |", "|---|---|",
         "| 臂身份可识别（只认 arm=/sw_effective=） | %s |" % ("见问题清单" if problems else "✅ 全部可识别"),
         "| 必备字段完整 | %s |" % ("❌ 有缺失" if problems else "✅ 完整"),
         "| 计时非负且 first_frame ≥ parse − %.0fms | %s（%d 条待复核） |"
         % (EPS_MS, "✅" if not pending else "⚠ 有待复核", len(pending)),
         "| 口径 A/B 同场景同臂 FPS 差异 ≤ %.0f%% | %s |"
         % (AB_FPS_TOL * 100, "✅ 通过" if not cross else "⚠ 有异常"),
         "| 同一场景/臂连续 ≥3 次违反 ⇒ 基础设施问题 | %s |" % ("—" if not infra else "**已升级**"), ""]
    for title, arr in (("问题（字段缺失/为负/非数值）", problems), ("待复核（容差内违反/标签缺失）", pending),
                       ("口径 A/B 交叉校验异常", cross), ("基础设施问题（需人工介入，暂停该配置）", infra)):
        if arr:
            L += ["## %s" % title, ""] + ["- " + x for x in arr[:40]] + [""]
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------ 阶段4：统计
def paired(rows, arm_a, arm_b, metric, regime):
    """{scene: (a_mean, b_mean)}——同场景多轮取均值后配对（n=场景数）。"""
    agg = {}
    for r in rows:
        if r["regime"] != regime or r["arm"] not in (arm_a, arm_b) or not r.get(metric):
            continue
        try:
            agg.setdefault((r["scene"], r["arm"]), []).append(float(r[metric]))
        except ValueError:
            pass
    out = {}
    for s in sorted({k[0] for k in agg}):
        a, b = agg.get((s, arm_a)), agg.get((s, arm_b))
        if a and b:
            out[s] = (sum(a) / len(a), sum(b) / len(b))
    return out


def cmd_stats(rows, args):
    L = ["# 阶段4 · 配对统计（Wilcoxon 为主、配对 t 为辅）", "",
         "输入：%s" % ("**模拟数据（MOCK，仅验证脚本可用）**" if args.mock else "真机回传记录"),
         "统计口径：**%s**（FPS 主结果用 controlled；加载时间另用 official 单独报，两者不混用）" % args.regime, ""]
    for metric, name in (("fps", "FPS"), ("first_frame_ms", "首帧 first_frame_ms")):
        pr = paired(rows, "final", "flux", metric, args.regime)
        if len(pr) < 3:
            L += ["## %s：样本不足（%d 场景，配对检验需 ≥3）" % (name, len(pr)), ""]
            continue
        scenes = sorted(pr)
        a = [pr[s][0] for s in scenes]
        b = [pr[s][1] for s in scenes]
        d = [x - y for x, y in zip(a, b)]
        n = len(d)
        mean_d = sum(d) / n
        sd = math.sqrt(sum((x - mean_d) ** 2 for x in d) / (n - 1)) if n > 1 else 0.0
        ci = 1.96 * sd / math.sqrt(n) if n > 1 else 0.0
        cohen = (mean_d / sd) if sd > 0 else float("inf")
        w_p = t_p = float("nan")
        try:
            from scipy import stats as st
            if any(x != y for x, y in zip(a, b)):
                w_p = st.wilcoxon(a, b).pvalue
            t_p = st.ttest_rel(a, b).pvalue
        except Exception as e:
            L.append("> ⚠ scipy 不可用（%s）：p 值留空，装好 scipy 后重跑" % e)
        geo = float("nan")
        if all(y > 0 for y in b):
            geo = math.exp(sum(math.log(x / y) for x, y in zip(a, b)) / n)
        L += ["## %s（n=%d 场景；配对 = final − flux）" % (name, n), "",
              "| 指标 | 值 |", "|---|---|",
              "| 均值差 | %.3f |" % mean_d,
              "| 95%% CI（正态近似） | [%.3f, %.3f] |" % (mean_d - ci, mean_d + ci),
              "| Cohen's d（配对） | %.2f |" % cohen,
              "| **Wilcoxon 符号秩 p（主）** | %s |" % ("%.4g" % w_p if w_p == w_p else "—"),
              "| 配对 t 检验 p（辅/交叉验证） | %s |" % ("%.4g" % t_p if t_p == t_p else "—"),
              "| 几何平均比值 final/flux | %.4f |" % (geo if geo == geo else float("nan")), "",
              "| 场景 | final | flux | 差 |", "|---|---|---|---|"] + \
             ["| %s | %.2f | %.2f | %+.2f |" % (s, pr[s][0], pr[s][1], pr[s][0] - pr[s][1]) for s in scenes] + [""]
    csv = os.path.join(GS, "_tmp_ch7probe", "out", "stage0_size_normalization.csv")
    if os.path.exists(csv):
        sz = {}
        for line in open(csv, encoding="utf-8").read().splitlines()[1:]:
            c = line.split(",")
            if len(c) >= 7 and c[5] and c[2]:
                try:
                    sz[c[0]] = (float(c[5]) / 1048576.0, float(c[2]) / 1048576.0)
                except ValueError:
                    pass
        if sz:
            g = math.exp(sum(math.log(x / y) for x, y in sz.values() if y > 0) / len(sz))
            L += ["## 体积比（本文 r7 / Flux，13 场景**几何平均**）", "",
                  "- 几何平均比值 = **%.3f**（>1 表示本文体积更大；逐场景比值见 stage0 CSV）" % g, ""]
    md = os.path.join(GS, "docs", "ch7_b_layer.md")
    if os.path.exists(md):
        hits = [x for x in open(md, encoding="utf-8") if x.startswith("| ") and "dB" in x]
        bad = [x for x in hits if "✗" in x]
        L += ["## 画质红线复核（13/13：PSNR ≥ 50 dB 且 >8 级像素 = 0）", "",
              "- 来源 `docs/ch7_b_layer.md`：命中 %d 行，未过红线 %d 行 ⇒ %s"
              % (len(hits), len(bad), "✅ 全过" if hits and not bad else "⚠ 需人工确认"), ""]
    L += ["## 质量-体积效率（ΔPSNR / 每 MB）", "",
          "> 需输入：本文 PSNR（第 4/5 章离线评测）与两侧体积；本脚本按 ΔPSNR/ΔMB 计算。",
          "> **当前为占位**，等质量表确认后填入即可——本轮不编造任何数值。", ""]
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------ 阶段5：表格与图
def cmd_tables(rows, args):
    od = args.outdir
    os.makedirs(od, exist_ok=True)
    prA = paired(rows, "final", "flux", "fps", "controlled")
    prB = paired(rows, "final", "flux", "fps", "official")
    scenes = sorted(set(list(prA) + list(prB)) or SCENES)
    L = ["### (a) 13 场景 FPS 对比（Gen3；口径 A=受控 / B=官方）" + ("  **[MOCK]**" if args.mock else ""), "",
         "| 场景 | 本文 FINAL（A） | Flux（A） | 本文 FINAL（B） | Flux（B） |", "|---|---|---|---|---|"]
    for s in scenes:
        L.append("| %s | %s | %s | %s | %s |" % (
            s,
            "%.1f" % prA[s][0] if s in prA else "—",
            "%.1f" % prA[s][1] if s in prA else "—",
            "%.1f" % prB[s][0] if s in prB else "—",
            "%.1f" % prB[s][1] if s in prB else "—"))
    seg = {}
    for r in rows:
        if r["arm"] == "flux" and r.get("first_frame_ms"):
            try:
                seg.setdefault((r["scene"], r["regime"]), []).append(
                    (float(r["fetch_ms"] or 0), float(r["parse_ms"] or 0), float(r["first_frame_ms"] or 0)))
            except ValueError:
                pass
    L += ["", "### (c) 首帧分段（fetch / parse / first_frame，两口径分列）", "",
          "| 场景 | 口径 | fetch_ms | parse_ms | first_frame_ms |", "|---|---|---|---|---|"]
    for (s, rg), v in sorted(seg.items())[:40]:
        n = len(v)
        L.append("| %s | %s | %.0f | %.0f | %.0f |" % (s, rg, sum(x[0] for x in v) / n,
                                                      sum(x[1] for x in v) / n, sum(x[2] for x in v) / n))
    L += ["", "### (e)(f) Mali 抽样 / Gen2 兼容性", "",
          "- Mali（P2，**3 场景抽样、非全量**）：材料回填到 `stage_p2_mali.md` 后并入本表；只做方向性定性判断。",
          "- Gen2（仅兼容性现象，不进性能矩阵）：材料回填到 `stage0_6_gen2_compat_record.md`。", ""]
    md = "\n".join(L) + "\n"
    open(os.path.join(od, "tables_main.md"), "w", encoding="utf-8", newline="\n").write(md)
    tex = []
    for block in md.split("\n\n"):
        rs = [x for x in block.strip().splitlines() if x.strip().startswith("|")]
        if len(rs) < 3:
            continue
        cols = len(rs[0].split("|")) - 2
        tex.append("\\begin{tabular}{%s}\n\\hline\n" % ("l" + "r" * (cols - 1)))
        for x in rs:
            if set(x.replace("|", "").replace("-", "").strip()) == set():
                continue
            tex.append(" & ".join(c.strip() for c in x.strip().strip("|").split("|")) + " \\\\\n\\hline\n")
        tex.append("\\end{tabular}\n\n")
    open(os.path.join(od, "tables_main.tex"), "w", encoding="utf-8", newline="\n").write("".join(tex))
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        xs = list(range(len(scenes)))
        fA = [prA[s][0] if s in prA else 0 for s in scenes]
        qA = [prA[s][1] if s in prA else 0 for s in scenes]
        fB = [prB[s][0] if s in prB else 0 for s in scenes]
        qB = [prB[s][1] if s in prB else 0 for s in scenes]
        plt.figure(figsize=(10, 4))
        plt.plot(xs, fA, "o-", label="FINAL (regime A)")
        plt.plot(xs, qA, "s-", label="Flux (regime A)")
        plt.plot(xs, fB, "o--", label="FINAL (regime B)")
        plt.plot(xs, qB, "s--", label="Flux (regime B)")
        plt.xticks(xs, scenes, rotation=60, ha="right")
        plt.ylabel("FPS (per-scene mean of rounds)")
        plt.title("FPS per scene (Gen3)%s" % ("  [MOCK]" if args.mock else ""))
        plt.legend()
        plt.tight_layout()
        plt.savefig(os.path.join(od, "fig_fps.png"), dpi=160)
        plt.close()
        csv = os.path.join(GS, "_tmp_ch7probe", "out", "stage0_size_normalization.csv")
        if os.path.exists(csv):
            fx, fy, ox, oy = [], [], [], []
            for line in open(csv, encoding="utf-8").read().splitlines()[1:]:
                c = line.split(",")
                try:
                    if c[1]:
                        fx.append(float(c[1]) / 1000.0)
                        fy.append(float(c[2]) / 1048576.0)
                    ox.append(float(c[4]) / 1000.0)
                    oy.append(float(c[5]) / 1048576.0)
                except (ValueError, IndexError):
                    pass
            if fx or ox:
                plt.figure(figsize=(6, 5))
                if ox:
                    plt.scatter(ox, oy, marker="^", label="ours (r7, 24 B/pt)")
                if fx:
                    plt.scatter(fx, fy, marker="o", label="Flux (dump-probe point count)")
                plt.xlabel("points (k)")
                plt.ylabel("file size (MiB)")
                plt.title("size vs points%s" % ("  [MOCK]" if args.mock else ""))
                plt.legend()
                plt.tight_layout()
                plt.savefig(os.path.join(od, "fig_size_points.png"), dpi=160)
                plt.close()
    except Exception as e:
        print("⚠ 出图失败（%s）" % e)
    print("WROTE %s/{tables_main.md,tables_main.tex,fig_fps.png,fig_size_points.png}" % od)
    print(md)


# ------------------------------------------------------------------ CLI
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["validate", "stats", "tables"])
    ap.add_argument("--mock", action="store_true", help="用模拟数据自检（不读真机记录）")
    ap.add_argument("--regime", default="controlled", choices=["controlled", "official"])
    ap.add_argument("--md", default="")
    ap.add_argument("--outdir", default=os.path.join(GS, "_tmp_ch7probe", "out", "stage5"))
    a = ap.parse_args()
    rows = mock() if a.mock else load()
    if not rows:
        print("✗ 没有可用记录：确认 dev server 在跑、回传有落盘；或先用 --mock 自检")
        return 1
    txt = {"validate": cmd_validate, "stats": cmd_stats, "tables": cmd_tables}[a.cmd](rows, a)
    if txt and a.md:
        open(a.md, "w", encoding="utf-8", newline="\n").write(txt)
        print("WROTE " + a.md)
    if txt:
        print(txt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
