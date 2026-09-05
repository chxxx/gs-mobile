"""Compare two screenshots (PNG) for the splat-cap A/B quality check.

Usage (run from the gsplat.js directory after capturing cap256/cap1024 PNGs):

    python tools/compare_images.py cap256.png cap1024.png

Outputs per-channel & overall PSNR. If scikit-image is installed it also
reports SSIM. If only numpy/Pillow are present it falls back to PSNR only.

Guideline (screenshots at identical camera & resolution):
    - PSNR >= 45 dB  : visually indistinguishable (safe to keep cap 256)
    - 35 ~ 45 dB     : tiny difference, decide by eyeballing diff regions
    - < 35 dB        : visible difference, inspect before adopting cap 256
"""
import sys

import numpy as np


def load_rgb(path: str) -> np.ndarray:
    try:
        from PIL import Image
    except ImportError as e:  # pragma: no cover
        raise SystemExit("Pillow is required: pip install pillow") from e
    img = Image.open(path).convert("RGB")
    return np.asarray(img, dtype=np.float64)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = np.mean((a - b) ** 2)
    if mse <= 1e-12:
        return float("inf")
    return float(10.0 * np.log10((255.0**2) / mse))


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    path_a, path_b = sys.argv[1], sys.argv[2]

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
