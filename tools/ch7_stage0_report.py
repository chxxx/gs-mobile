""" [阶段0 2026-09-30] 生产成本拆分：读 `stage0_*.txt`（按报告里的 `arm=` 分组），出各臂数字与 P/R。

    P（生产成本） = FRAG_FULL − FRAG_FROZEN    （"每帧都生产" vs "只生产前 N 帧后复用"）
    R（读取成本） = FRAG_FROZEN − CONSUME_ONLY  （主 pass 读颜色纹理 vs 读 TF 实例属性）

口径：帧时间 = 1000 / `offscreen_fps_mean`（离屏论文协议，与 §29 同口径）；
      每臂取各轮的均值 ± 逐轮标准差（std 用总体标准差，n=3 时只作离散度参考）。

纪律：**臂一律取报告里的 `arm=`（子页面实际生效配置自证）**；`u=` 只是用户备注，绝不用于分组。
      若报告缺 `arm=`（阶段 0 之前的旧数据），本工具会把它归到 `-`，需要人工核对后才可引用。

用法（在 `gsplat.js` 目录下）：  python tools\ch7_stage0_report.py
可用环境变量 `S0_NAME` 覆盖回传名前缀（缺省 `stage0`）。
"""
import glob
import os
import re
import statistics
import sys

RAW = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "thesis_project", "data", "ch7_measurements", "raw")
)
PREFIX = os.environ.get("S0_NAME", "stage0")


def read_reports():
    rows = []
    for path in sorted(glob.glob(os.path.join(RAW, PREFIX + "_*.txt")), key=os.path.getmtime):
        txt = open(path, encoding="utf-8", errors="replace").read()

        def grab(pat, cast=float, default=None):
            m = re.search(pat, txt, re.M)
            if not m:
                return default
            try:
                return cast(m.group(1))
            except Exception:
                return default

        rows.append(
            {
                "file": os.path.basename(path),
                "arm": grab(r"^arm=([^\r\n]+)", str, "-"),
                "u": grab(r"^u=([^\r\n]+)", str, "-"),
                "fps": grab(r"offscreen_fps_mean=([0-9.]+)"),
                "fps_std": grab(r"offscreen_fps_std=([0-9.]+)"),
                "cpu": grab(r"cpu_ms=([0-9.]+)"),
                "cov": grab(r"covered=([0-9.]+)"),
                "sw": grab(r"^sw_effective=([^\r\n]+)", str, "-"),
            }
        )
    return rows


def main() -> int:
    rows = read_reports()
    if not rows:
        print("no %s_*.txt in %s" % (PREFIX, RAW))
        return 1
    print("raw    =".ljust(9), RAW)
    print("prefix =", PREFIX)

    print("\n== 逐轮（file / arm / fps / cpu_ms / covered / u）==")
    for r in rows:
        print(
            "  %-30s arm=%-12s fps=%-8s cpu=%-7s cov=%-7s u=%s"
            % (r["file"], r["arm"], r["fps"], r["cpu"], r["cov"], r["u"])
        )

    arms = {}
    for r in rows:
        arms.setdefault(r["arm"], []).append(r)

    print("\n== 按 arm= 汇总（frame_ms = 1000/fps）==")
    print("  %-14s %-3s %-22s %-14s %-10s %s" % ("arm", "n", "fps 逐轮均值 ± std", "frame_ms", "cpu_ms", "covered"))
    mean_ms = {}
    for arm, rs in sorted(arms.items()):
        fps_list = [r["fps"] for r in rs if r["fps"]]
        cpu_list = [r["cpu"] for r in rs if r["cpu"]]
        cov_list = [r["cov"] for r in rs if r["cov"]]
        if not fps_list:
            print("  %-14s %-3d (无 fps：这些轮 ok=0)" % (arm, len(rs)))
            continue
        ms_list = [1000.0 / f for f in fps_list]
        mean_ms[arm] = statistics.fmean(ms_list)
        print(
            "  %-14s %-3d %-22s %-14s %-10s %s"
            % (
                arm,
                len(fps_list),
                "%.2f ± %.2f" % (statistics.fmean(fps_list), statistics.pstdev(fps_list) if len(fps_list) > 1 else 0.0),
                "%.3f" % statistics.fmean(ms_list),
                "%.2f" % statistics.fmean(cpu_list) if cpu_list else "-",
                "%.1f" % statistics.fmean(cov_list) if cov_list else "-",
            )
        )

    print("\n== 成本拆分（ms/帧，正数表示该环节的成本）==")
    fr, fz, co = mean_ms.get("frag"), mean_ms.get("frozen"), mean_ms.get("tf_consume")
    if fr is not None and fz is not None:
        print("  P (production cost = FRAG_FULL - FRAG_FROZEN)   = %.3f - %.3f = %+.3f ms" % (fr, fz, fr - fz))
    else:
        print("  P: 缺 `arm=frag` 或 `arm=frozen` 的报告")
    if fz is not None and co is not None:
        print("  R (read cost = FRAG_FROZEN - CONSUME_ONLY)      = %.3f - %.3f = %+.3f ms" % (fz, co, fz - co))
    else:
        print("  R: 缺 `arm=frozen` 或 `arm=tf_consume` 的报告")
    if fr is not None and co is not None:
        print("  合计（FRAG_FULL - CONSUME_ONLY）= %+.3f ms" % (fr - co))
    print("\n注：arm 取子页面实际生效配置（`arm=`）；`u=` 仅是用户备注。P/R 的误差来源见 docs/ch7_stage0_report.md。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
