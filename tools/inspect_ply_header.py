# -*- coding: utf-8 -*-
"""批量核对 3DGS/QPLY/reduced-3DGS 量化 PLY 的头部与点数/体积，用于第 7 章资产登记与口径校验。

用法（仓库根目录）：
    python gsplat.js/tools/inspect_ply_header.py gsplat.js/reduced-3dgs gsplat.js/scenes

输出：每个文件一行 CSV：
    file,format,bytes,mb,vertex_total,groups,codebook_props,has_basis
其中 format 取值：
    std_ply      标准 PLY（element vertex，property float/double）
    qply_naive   标准 QPLY（vertex_0..3 + codebook_centers，无 sh_basis）
    qply_lowrank 低秩 QPLY（vertex 单元素 + codebook_centers + sh_basis）
"""
import csv
import os
import sys

HEADER_LIMIT = 64 * 1024  # PLY 头部远小于此值


def read_header(path):
    with open(path, "rb") as f:
        raw = f.read(HEADER_LIMIT)
    idx = raw.find(b"end_header")
    if idx < 0:
        raise ValueError("not a PLY (no end_header in first 64KB)")
    return raw[:idx].decode("latin-1")


def parse_element_counts(header):
    counts = {}
    for line in header.splitlines():
        if line.startswith("element "):
            _, name, count = line.split(" ")
            counts[name] = int(count)
    return counts


def parse_codebook_props(header):
    names, in_cb = [], False
    for line in header.splitlines():
        if line.startswith("element "):
            in_cb = line.startswith("element codebook_centers")
        elif line.startswith("property ") and in_cb:
            names.append(line.split(" ")[2])
    return names


def classify(header, counts):
    has_cb = "codebook_centers" in counts
    grouped = any(k.startswith("vertex_") for k in counts)
    has_basis = "sh_basis" in counts
    if not has_cb:
        return "std_ply"
    if grouped and not has_basis:
        return "qply_naive"
    return "qply_lowrank"


def inspect(path):
    header = read_header(path)
    counts = parse_element_counts(header)
    grouped = {k: v for k, v in counts.items() if k.startswith("vertex_")}
    vertex_total = sum(counts.get(f"vertex_{i}", 0) for i in range(4)) if grouped else counts.get("vertex", 0)
    size = os.path.getsize(path)
    return {
        "file": os.path.basename(path),
        "format": classify(header, counts),
        "bytes": size,
        "mb": round(size / 1024 / 1024, 2),
        "vertex_total": vertex_total,
        "groups": "|".join(f"{k}:{v}" for k, v in sorted(grouped.items(), key=lambda kv: kv[0])),
        "codebook_props": len(parse_codebook_props(header)),
        "has_basis": int("sh_basis" in counts),
    }


def main(dirs):
    files = []
    for d in dirs:
        if os.path.isfile(d):
            files.append(d)
        else:
            for name in sorted(os.listdir(d)):
                if name.lower().endswith(".ply"):
                    files.append(os.path.join(d, name))
    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=["file", "format", "bytes", "mb", "vertex_total", "groups", "codebook_props", "has_basis"],
        lineterminator="\n",
    )
    writer.writeheader()
    for path in files:
        try:
            writer.writerow(inspect(path))
        except Exception as exc:  # noqa: BLE001 - 审计脚本：坏文件不应中断整批
            writer.writerow({"file": os.path.basename(path), "format": f"ERROR:{exc}"})


if __name__ == "__main__":
    args = sys.argv[1:] or ["gsplat.js/reduced-3dgs", "gsplat.js/scenes"]
    main(args)
