"""[O1 2026-10-02] Color-gate comparator for ALL arms (ASCII-only, safe on GBK consoles).

Reads the reports dumped by `?framedump=1` (lossless PNG, base pose) from
thesis_project/data/ch7_measurements/raw/<CG_NAME>_*.txt, keeps the NEWEST report per `u=` key,
and diffs every non-base arm against BASE pixel by pixel:
  mean/max error (8-bit levels), counts of pixels whose max-channel diff > 0/1/2/4/8/16,
  PSNR[RGB], SSIM (if scikit-image is installed).

Gate (ch7 constraint 6): PSNR >= 45 dB AND no pixel with diff > 8 levels.
Stage-2 goal (O1): >= 60 dB or bit-identical (identity-matrix math is exact in IEEE754).

Usage (from gsplat.js):
    python tools/ch7_gate_all_arms.py
Env:
    CG_NAME   report name prefix (default: colorgate)
"""
import base64
import glob
import io
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.abspath(os.path.join(HERE, "..", "..", "thesis_project", "data", "ch7_measurements", "raw"))
PREFIX = os.environ.get("CG_NAME", "colorgate")


def psnr(a, b):
    mse = float(np.mean((a - b) ** 2))
    return float("inf") if mse == 0 else 10.0 * np.log10(255.0 ** 2 / mse)


def parse_reports():
    """{u: (report_basename, ndarray RGB, covered)} - only reports that contain framedump_png."""
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
    return found


def main():
    reps = parse_reports()
    print("raw =", RAW)
    print("parsed (u -> report):")
    for k in sorted(reps):
        print("   %-22s %s" % (k, reps[k][0]))
    bk = next((k for k in reps if k.endswith("base")), None)
    fk = next((k for k in reps if k.endswith("frag")), None)
    if not bk:
        raise SystemExit("\n[gate] need one u=*-base report (framedump=1); got: %s" % sorted(reps))
    nb, B, covB = reps[bk]
    print("\nBASE = %s  covered=%s%%  (%dx%d)" % (nb, covB, B.shape[1], B.shape[0]))

    fails = []
    order = ([fk] if fk else []) + [k for k in sorted(reps) if k not in (bk, fk)]
    for k in order:
        na, A, covA = reps[k]
        if A.shape != B.shape:
            print("\n== %s vs BASE: shape mismatch %s vs %s ==" % (na, A.shape, B.shape))
            fails.append((na, "shape"))
            continue
        d = np.abs(B - A)
        dm = d.max(axis=2)
        tot = dm.size
        p = psnr(B, A)
        n8 = int(np.count_nonzero(dm > 8))
        print("")
        print("== %-20s vs BASE ==" % na)
        print("   covered: %s%% / BASE %s%%" % (covA, covB))
        print("   mean_err = %.5f levels   max_err = %d levels" % (float(np.mean(d)), int(d.max())))
        row = []
        for thr in (0, 1, 2, 4, 8, 16):
            n = int(np.count_nonzero(dm > thr))
            row.append(">%d:%d(%.3f%%)" % (thr, n, 100.0 * n / tot))
        print("   pixels " + "  ".join(row))
        print("   PSNR[RGB] = %.2f dB" % p)
        try:
            from skimage.metrics import structural_similarity as ssim  # type: ignore

            print("   SSIM      = %.6f" % float(ssim(B / 255.0, A / 255.0, channel_axis=2, data_range=1.0)))
        except ImportError:
            print("   SSIM      = (skipped: pip install scikit-image)")
        ok45 = p >= 45.0
        ok60 = p >= 60.0
        ok8 = n8 == 0
        verd = "PASS(>=60dB)" if (ok60 and ok8) else ("pass(>=45dB)" if (ok45 and ok8) else "FAIL")
        print("   GATE: %s   [PSNR>=45:%s  PSNR>=60:%s  no->8levels:%s]" % (verd, ok45, ok60, ok8))
        if not (ok45 and ok8):
            fails.append((na, "psnr=%.2f n8=%d" % (p, n8)))

    print("")
    if fails:
        print("=== GATE RESULT: FAIL ===")
        for f in fails:
            print("   %s : %s" % f)
        return 1
    print("=== GATE RESULT: PASS (all arms vs BASE: PSNR>=45dB and no >8-level pixel) ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
