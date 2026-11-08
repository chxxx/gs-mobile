"""Compare two screenshots (PNG) for the splat-cap A/B quality check.

Usage (Windows cmd does NOT auto-expand globs):

    python tools/compare_images.py cap256.png cap1024.png        # explicit files
    python tools/compare_images.py .                            # scan this folder
    python tools/compare_images.py C:/Users/<you>/Downloads      # scan a folder

When no arguments are given the current folder is scanned for the newest
cap256_*.png / cap1024_*.png pair.

Outputs per-channel & overall PSNR. If scikit-image is installed it also
reports SSIM. If only numpy/Pillow are present it falls back to PSNR only.

Guideline (screenshots at identical camera & resolution):
    - PSNR >= 45 dB  : visually indistinguishable (safe to keep cap 256)
    - 35 ~ 45 dB     : tiny difference, decide by eyeballing diff regions
    - < 35 dB        : visible difference, inspect before adopting cap 256
"""
import glob
import os
import sys

import numpy as np


def load_rgb(path: str) -> np.ndarray:
    try:
        from PIL import Image
    except ImportError as e:  # pragma: no cover
        raise SystemExit("Pillow is required: pip install pillow") from e
    img = Image.open(path).convert("RGB")
    return np.asarray(img, dtype=np.float64)


def find_pair(folder: str) -> tuple[str, str]:
    c256 = glob.glob(os.path.join(folder, "cap256_*.png"))
    c1024 = glob.glob(os.path.join(folder, "cap1024_*.png"))
    if not c256 or not c1024:
        raise SystemExit(
            "Could not find cap256_*/cap1024_* screenshots in:\n"
            f"    {os.path.abspath(folder)}\n"
            "Screenshots are usually saved to your browser download folder. "
            "Either cd there, pass the folder, or pass the two file paths explicitly."
        )
    a = max(c256, key=os.path.getmtime)
    b = max(c1024, key=os.path.getmtime)
    return a, b


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = np.mean((a - b) ** 2)
    if mse <= 1e-12:
        return float("inf")
    return float(10.0 * np.log10((255.0**2) / mse))


def main() -> None:
    args = sys.argv[1:]
    if len(args) == 2:
        path_a, path_b = args[0], args[1]
    elif len(args) <= 1:
        path_a, path_b = find_pair(args[0] if args else ".")
    else:
        raise SystemExit(__doc__)

    a = load_rgb(path_a)
    b = load_rgb(path_b)
    if a.shape != b.shape:
        raise SystemExit(
            f"Image shapes differ: {a.shape} vs {b.shape} — use identical "
            "canvas size & camera when capturing the two frames."
        )

    print(f"comparing  {path_a}  vs  {path_b}")
    print(f"resolution {a.shape[1]}x{a.shape[0]}")
    for c, name in enumerate(("R", "G", "B")):
        print(f"  PSNR[{name}] = {psnr(a[..., c], b[..., c]):.2f} dB")
    print(f"  PSNR[RGB] = {psnr(a, b):.2f} dB")

    try:
        from skimage.metrics import structural_similarity as ssim
    except ImportError:
        print("  (skimage not installed — SSIM skipped; pip install scikit-image to enable)")
        return

    s = ssim(a / 255.0, b / 255.0, channel_axis=2, data_range=1.0)
    print(f"  SSIM     = {s:.4f}")


if __name__ == "__main__":
    main()
