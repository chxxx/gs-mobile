# -*- coding: utf-8 -*-
"""按 URL 拉取 reduced-3DGS 量化模型到 `gsplat.js/reduced-3dgs/`（这些 .ply 不入库）。

链接表：`gsplat.js/reduced-3dgs-urls.json`（可编辑）
  - `overrides[scene]`：该场景的直链；留空则回退到 `default_pattern`（`{scene}` 会被替换）
  - 官方已确认可用：bicycle / bonsai / counter / kitchen（其余场景的链接请自行补进 overrides）

用法：
    python gsplat.js/tools/fetch_reduced3dgs_assets.py                 # 拉取缺失的场景（已存在且体积相符则跳过）
    python gsplat.js/tools/fetch_reduced3dgs_assets.py --check         # 只核对本地文件，不下载
    python gsplat.js/tools/fetch_reduced3dgs_assets.py --scenes bicycle,truck
    python gsplat.js/tools/fetch_reduced3dgs_assets.py --update-manifest   # 下载后把点数/体积写回 baseline-scenes.json

说明：浏览器测帧要求"页面与模型同源"，所以**不要**在清单里直接写外链；
本脚本负责把文件拉到本地，`vite.site.config.js` 在构建时把 `reduced-3dgs/` 复制进 site-dist，
部署后的站点即为同源。
"""
import argparse
import io
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TYPESIZE = {"short": 2, "uchar": 1, "float": 4, "double": 8, "int": 4}

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass


def url_for(scene, cfg):
    direct = (cfg.get("overrides") or {}).get(scene, "")
    if direct:
        return direct
    pattern = cfg.get("default_pattern", "")
    return pattern.replace("{scene}", scene) if pattern else ""


def audit_ply(path):
    """读 PLY 头，返回 (顶点数, 格式标记)。"""
    raw = open(path, "rb").read(1 << 16)
    idx = raw.find(b"end_header\n")
    if idx < 0:
        return None, "invalid"
    header = raw[:idx].decode("latin-1")
    counts = {}
    for line in header.splitlines():
        if line.startswith("element "):
            _, name, cnt = line.split(" ")
            counts[name] = int(cnt)
    total = sum(v for k, v in counts.items() if k.startswith("vertex_"))
    fmt = "qply_naive" if "codebook_centers" in counts else "std_ply"
    return total, fmt


def download(url, dest, expected_mb=None):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (chapter7-bench-fetch)"})
    tmp = dest + ".part"
    with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as out:
        total = int(resp.headers.get("content-length") or 0)
        got = 0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            got += len(chunk)
            if total:
                pct = got * 100 / total
                print(f"\r    下载 {os.path.basename(dest)}: {pct:5.1f}%  ({got / 1e6:.1f}/{total / 1e6:.1f} MB)", end="")
    print()
    os.replace(tmp, dest)
    mb = os.path.getsize(dest) / 1024 / 1024
    if expected_mb and abs(mb - expected_mb) / max(expected_mb, 1e-6) > 0.02:
        print(f"    ⚠ 体积 {mb:.2f}MB 与清单登记 {expected_mb}MB 差 >2%，建议核对来源")
    return mb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenes", default="", help="逗号分隔；缺省=baseline-scenes.json 的全部场景")
    ap.add_argument("--check", action="store_true", help="只核对本地文件，不下载")
    ap.add_argument("--update-manifest", action="store_true", help="下载后把点数/体积写回 baseline-scenes.json")
    args = ap.parse_args()

    out_dir = os.path.join(ROOT, "reduced-3dgs")
    os.makedirs(out_dir, exist_ok=True)
    cfg = json.load(io.open(os.path.join(ROOT, "reduced-3dgs-urls.json"), encoding="utf-8"))
    with io.open(os.path.join(ROOT, "baseline-scenes.json"), encoding="utf-8") as f:
        manifest = json.load(f)

    wanted = [s.strip() for s in args.scenes.split(",") if s.strip()]
    entries = [
        s for s in manifest["scenes"]
        if not wanted or s.get("scene") in wanted or s["id"] in wanted
    ]

    print(f"{'场景':10s} {'本地':>6s} {'点数':>10s} {'MB':>8s}  动作")
    changed = False
    for entry in entries:
        scene = entry.get("scene") or entry["id"]
        dest = os.path.join(ROOT, entry["file"].replace("/", os.sep))
        exists = os.path.isfile(dest)
        if exists:
            pts, fmt = audit_ply(dest)
            mb = os.path.getsize(dest) / 1024 / 1024
            print(f"{scene:10s} {'有':>6s} {pts if pts else '-':>10} {mb:8.2f}  跳过（本地已有）")
            if args.update_manifest and pts:
                if entry.get("points") != pts or abs(float(entry.get("storageMB", 0)) - round(mb, 2)) > 0.01:
                    entry["points"] = pts
                    entry["storageMB"] = round(mb, 2)
                    changed = True
            continue
        url = url_for(scene, cfg)
        if args.check or not url:
            reason = "只核对模式" if args.check else "未提供链接（请补进 reduced-3dgs-urls.json 的 overrides）"
            print(f"{scene:10s} {'无':>6s} {'-':>10} {'-':>8}  {reason}")
            continue
        print(f"{scene:10s} {'无':>6s} {'-':>10} {'-':>8}  下载 {url}")
        try:
            mb = download(url, dest, entry.get("storageMB"))
        except Exception as exc:  # noqa: BLE001
            print(f"    ✗ 失败：{exc}")
            continue
        pts, fmt = audit_ply(dest)
        print(f"    ✓ {pts} 点（{fmt}）{mb:.2f}MB")
        if args.update_manifest and pts:
            entry["points"] = pts
            entry["storageMB"] = round(mb, 2)
            changed = True

    if changed:
        with io.open(os.path.join(ROOT, "baseline-scenes.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=4)
        print("[out] baseline-scenes.json 已更新（点数/体积）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
