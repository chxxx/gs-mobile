"""把 ch7 raw 记录抽成一张历史表（便于回答"为什么最近没超过历史最高 FPS"）。

用法（在 gsplat.js 目录下）：
    python _tmp_ch7probe/fps_hist.py            # 写 out/fps_hist.csv 并打印 fps>=100 的记录
    python _tmp_ch7probe/fps_hist.py 90         # 阈值改为 90

输出字段（一行一份记录）：
    ts, fps, std, u, arm, chip, rounds, res, spin, bench_mode, covered
"""

import glob
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.abspath(os.path.join(HERE, "..", "..", "thesis_project", "data", "ch7_measurements", "raw"))
OUT = os.path.join(os.path.dirname(HERE), "_tmp_ch7probe", "out", "fps_hist.csv")


def field(txt: str, name: str, default: str = "-") -> str:
    m = re.search(r"^%s=([^\r\n]*)" % re.escape(name), txt, re.M)
    return m.group(1).strip() if m else default


def perround(txt: str, name: str, default: str = "-") -> str:
    # 只取 `--- per-round ---` 之后的第一行里的字段（避免与全局同名字段混淆）
    i = txt.find("--- per-round ---")
    seg = txt[i:] if i >= 0 else txt
    m = re.search(r"\b%s=([^\s]+)" % re.escape(name), seg)
    return m.group(1).strip() if m else default


def main() -> None:
    thr = float(sys.argv[1]) if len(sys.argv) > 1 else 100.0
    rows = []
    for path in glob.glob(os.path.join(RAW, "*.txt")):
        txt = open(path, encoding="utf-8", errors="replace").read()
        if "[RESULT]" not in txt:
            continue
        fps = field(txt, "offscreen_fps_mean", "-")
        try:
            fpsv = float(fps)
        except ValueError:
            fpsv = -1.0
        rows.append(
            {
                "ts": field(txt, "ts", "-"),
                "fps": fpsv,
                "std": field(txt, "offscreen_fps_std", "-"),
                "u": field(txt, "u", "-"),
                "arm": field(txt, "arm", "-"),
                "chip": field(txt, "chip", "-"),
                "rounds": field(txt, "rounds", "-"),
                "res": field(txt, "res", "-"),
                "spin": field(txt, "spin", "-"),
                "bench_mode": field(txt, "bench_mode", "-"),
                "covered": perround(txt, "covered"),
                "file": os.path.basename(path),
            }
        )
    rows.sort(key=lambda r: r["ts"])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("ts,fps,std,u,arm,chip,rounds,res,spin,bench_mode,covered,file\n")
        for r in rows:
            fh.write(
                "%s,%.1f,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n"
                % (
                    r["ts"],
                    r["fps"],
                    r["std"],
                    r["u"],
                    r["arm"],
                    r["chip"],
                    r["rounds"],
                    r["res"],
                    r["spin"],
                    r["bench_mode"],
                    r["covered"],
                    r["file"],
                )
            )
    print("records=%d  ->  %s" % (len(rows), OUT))
    print("")
    print("== fps >= %.1f（按时间） ==" % thr)
    for r in rows:
        if r["fps"] >= thr:
            print(
                "  %s  fps=%6.1f±%-4s  %-16s  %-34s  %s  rounds=%s res=%s spin=%s %s cov=%s"
                % (r["ts"][:19], r["fps"], r["std"], r["chip"][:16], r["arm"], r["bench_mode"], r["rounds"], r["res"], r["spin"], r["u"], r["covered"])
            )


if __name__ == "__main__":
    main()
