""" [CLRGATE 2026-09-30] 颜色正确性闸门 · 解析与逐像素比对

从 `?framedump=1` 回传的报告里取出两臂**基准位姿**的整幅画面（无损 PNG），做逐像素比对：

  * 平均误差 / 最大误差（RGB 三通道）
  * 不一致像素比例（最大通道差 >0 / >1 / >2 / >4 个 8-bit 级）
  * PSNR（RGB 与逐通道）—— 判据沿用 `tools/compare_images.py` 的口径：**≥ 45 dB = 视觉不可分辨**
  * SSIM（若装了 scikit-image）
  * 顺带打印两臂的 `covered=`，确认几何/alpha 也一致

为什么用 PNG 而不是 JPEG：JPEG 的共同损失会把 PSNR 压到 35–40 dB，会让 45 dB 这条闸门**假阴性**。

用法（在 gsplat.js 目录下）：
    python _tmp_ch7probe/color_gate_compare.py
可选：环境变量 `CG_NAME` 覆盖回传名的前缀（缺省 `colorgate`）。
"""
import base64
import glob
import io
import os
import re
import sys

# Windows 控制台常是 GBK：直接 print 非 GBK 字符（如 ⇒）会 UnicodeEncodeError 打断输出
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.abspath(os.path.join(HERE, "..", "..", "thesis_project", "data", "ch7_measurements", "raw"))
# 输出固定放到被 gitignore 的 scratch 目录：本脚本从 `tools/` 与 `_tmp_ch7probe/` 两个位置跑都写这里
OUT = os.path.abspath(os.path.join(HERE, "..", "_tmp_ch7probe", "out"))
PREFIX = os.environ.get("CG_NAME", "colorgate")


def parse_reports():
    """返回 {u: (报告名, PNG ndarray, covered 字符串)}；只认带 framedump_png 的报告。"""
    found = {}
    for path in sorted(glob.glob(os.path.join(RAW, PREFIX + "_*.txt")), key=os.path.getmtime):
        txt = open(path, encoding="utf-8", errors="replace").read()
        m = re.search(r"framedump_png=data:image/png;base64,([A-Za-z0-9+/=]+)", txt)
        if not m:
            continue
        u = re.search(r"^u=([^\r\n]+)", txt, re.M)
        cov = re.search(r"covered=([0-9.]+)%", txt)
        img = Image.open(io.BytesIO(base64.b64decode(m.group(1)))).convert("RGB")
        found[(u.group(1) if u else os.path.basename(path))] = (
            os.path.basename(path),
            np.asarray(img, dtype=np.float64),
            cov.group(1) if cov else "-",
        )
    # 同一 u 可能被重跑：保留**最新**的一份
    return found


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a - b) ** 2))
    return float("inf") if mse == 0 else 10.0 * np.log10(255.0**2 / mse)


def main() -> None:
    reps = parse_reports()
    print("raw =", RAW)
    print("parsed u ->", {k: v[0] for k, v in reps.items()})
    base_key = next((k for k in reps if k.endswith("base")), None)
    frag_key = next((k for k in reps if k.endswith("frag")), None)
    if not base_key or not frag_key:
        raise SystemExit("需要一份 u=*-base 与一份 u=*-frag（都带 framedump_png）；实际：%s" % list(reps))

    nb, A, covA = reps[base_key]
    nf, B, covB = reps[frag_key]
    if A.shape != B.shape:
        raise SystemExit("尺寸不一致：%s vs %s" % (A.shape, B.shape))
    os.makedirs(OUT, exist_ok=True)
    Image.fromarray(A.astype(np.uint8)).save(os.path.join(OUT, "cg_base.png"))
    Image.fromarray(B.astype(np.uint8)).save(os.path.join(OUT, "cg_frag.png"))

    d = np.abs(A - B)
    dmax = d.max(axis=2)
    print("")
    print("BASE = %s   covered=%s%%   (块 %d x %d)" % (nb, covA, A.shape[1], A.shape[0]))
    print("FRAG = %s   covered=%s%%" % (nf, covB))
    print("")
    print("平均误差 (RGB)      = %.5f 级" % float(np.mean(d)))
    print("最大误差 (单通道)    = %d 级" % int(d.max()))
    print("逐通道 均值/最大     = R %.5f/%d  G %.5f/%d  B %.5f/%d"
          % (float(np.mean(d[..., 0])), int(d[..., 0].max()),
             float(np.mean(d[..., 1])), int(d[..., 1].max()),
             float(np.mean(d[..., 2])), int(d[..., 2].max())))
    tot = dmax.size
    for thr in (0, 1, 2, 4, 8, 16):
        n = int(np.count_nonzero(dmax > thr))
        print("不一致像素 (最大通道差 >%2d 级) = %8d / %d  = %.4f%%" % (thr, n, tot, 100.0 * n / tot))
    print("")
    print("PSNR[RGB] = %.2f dB" % psnr(A, B))
    for i, name in enumerate("RGB"):
        print("PSNR[%s]   = %.2f dB" % (name, psnr(A[..., i], B[..., i])))
    try:
        from skimage.metrics import structural_similarity as ssim  # type: ignore

        print("SSIM      = %.6f" % float(ssim(A / 255.0, B / 255.0, channel_axis=2, data_range=1.0)))
    except ImportError:
        print("SSIM      = (skipped: pip install scikit-image 可启用)")
    # [阶段1 2026-09-30] 低秩臂：若报告里存在 u=*lr*，同样与 BASE / FRAG 对拍（同一套指标）
    lr_key = next((k for k in reps if k.endswith("lr")), None)
    if lr_key:
        nl, L, covL = reps[lr_key]
        Image.fromarray(L.astype(np.uint8)).save(os.path.join(OUT, "cg_lr.png"))
        for ref_key, ref_name in ((base_key, "BASE"), (frag_key, "FRAG")):
            nref, R, covR = reps[ref_key]
            if R.shape != L.shape:
                print("\n== LR vs %s: 尺寸不一致 %s vs %s ==" % (ref_name, R.shape, L.shape))
                continue
            d = np.abs(R - L)
            dmax = d.max(axis=2)
            tot = dmax.size
            print("")
            print("== LR(%s) vs %s(%s) ==" % (nl, ref_name, nref))
            print("  covered: LR %s%% / %s %s%%" % (covL, ref_name, covR))
            print("  平均误差(RGB) = %.5f 级   最大误差(单通道) = %d 级" % (float(np.mean(d)), int(d.max())))
            for thr in (0, 1, 2, 4, 8, 16):
                n = int(np.count_nonzero(dmax > thr))
                print("  不一致像素(最大通道差 >%2d 级) = %8d / %d = %.4f%%" % (thr, n, tot, 100.0 * n / tot))
            print("  PSNR[RGB] = %.2f dB" % psnr(R, L))
            try:
                from skimage.metrics import structural_similarity as ssim  # type: ignore

                print("  SSIM      = %.6f" % float(ssim(R / 255.0, L / 255.0, channel_axis=2, data_range=1.0)))
            except ImportError:
                print("  SSIM      = (skipped)")
    print("")
    print("判据：PSNR >= 45 dB ⇒ 视觉不可分辨（与 tools/compare_images.py 同口径）")
    print("PNG 已存：%s / %s" % (os.path.join(OUT, "cg_base.png"), os.path.join(OUT, "cg_frag.png")))


if __name__ == "__main__":
    sys.exit(main())
