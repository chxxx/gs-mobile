# -*- coding: utf-8 -*-
"""逐文件比对「本地内嵌的 Flux-GS 副本」与「官方 gh-pages 仓库」。

用法：
    python tools/check_flux_vendor_diff.py

依赖：
    - tools/flux_gh_pages_tree.json —— 官方 gh-pages 最新 commit 的完整 git tree
      （取自 GitHub Git Data API；见 tools/flux_gh_pages_commit.json 里的 commit SHA）。
      重新抓取：
        curl -sS "https://api.github.com/repos/xiaobiaodu/flux-gs-project/commits?sha=gh-pages&per_page=1" \
             -o tools/flux_gh_pages_commit.json
        curl -sS "https://api.github.com/repos/xiaobiaodu/flux-gs-project/git/trees/<tree-sha>?recursive=1" \
             -o tools/flux_gh_pages_tree.json

原理：GitHub tree 里的每个 blob 都带 SHA-1（= sha1(b"blob <len>\\0" + content)），
因此可以**逐字节**判断本地副本是否与官方一致，不受 mtime / 编码 / 换行影响。
结论写进 tools/flux_vendor_diff_report.txt，并在 FLUX_VENDOR_DIFF.md 中给出行级 diff。
"""
import hashlib
import json
import os
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)  # gsplat.js/
LOCAL = os.path.join(ROOT, "flux-gs-project-gh-pages")
TREE_JSON = os.path.join(TOOLS, "flux_gh_pages_tree.json")
OUT = os.path.join(TOOLS, "flux_vendor_diff_report.txt")


def git_blob_sha(data: bytes) -> str:
    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def main() -> int:
    with open(TREE_JSON, "rb") as f:
        tree = json.loads(f.read().decode("utf-8"))
    entries = [e for e in tree["tree"] if e["type"] == "blob"]

    identical, lf_only, modified, missing = [], [], [], []
    for e in entries:
        rel = e["path"].replace("/", os.sep)
        p = os.path.join(LOCAL, rel)
        if not os.path.isfile(p):
            missing.append((e["path"], e["size"]))
            continue
        with open(p, "rb") as fh:
            raw = fh.read()
        if git_blob_sha(raw) == e["sha"]:
            identical.append(e["path"])
            continue
        norm = raw.replace(b"\r\n", b"\n")
        if git_blob_sha(norm) == e["sha"]:
            lf_only.append(e["path"])
            continue
        modified.append((e["path"], e["size"], len(raw)))

    official_paths = set(e["path"] for e in entries)
    extra = []
    for dirpath, _dirnames, filenames in os.walk(LOCAL):
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, LOCAL).replace(os.sep, "/")
            if rel not in official_paths:
                extra.append((rel, os.path.getsize(full)))

    lines = []
    lines.append("# Flux-GS official-vs-vendored file comparison")
    lines.append("official tree: %s" % tree["sha"])
    lines.append("blobs in official tree: %d" % len(entries))
    lines.append("")
    lines.append("## byte-identical (LF): %d" % len(identical))
    for p in identical:
        lines.append("  = %s" % p)
    lines.append("")
    lines.append("## identical after CRLF->LF normalization only: %d" % len(lf_only))
    for p in lf_only:
        lines.append("  ~ %s" % p)
    lines.append("")
    lines.append("## MODIFIED (official_size, local_size): %d" % len(modified))
    for p, a, b in modified:
        lines.append("  M %s  (%d -> %d)" % (p, a, b))
    lines.append("")
    lines.append("## MISSING locally: %d" % len(missing))
    for p, a in missing:
        lines.append("  - %s (%d bytes)" % (p, a))
    lines.append("")
    lines.append("## EXTRA locally (not in official tree): %d" % len(extra))
    for p, a in extra:
        lines.append("  + %s (%d bytes)" % (p, a))
    lines.append("")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("written", OUT)
    print(
        "identical=%d lf_only=%d modified=%d missing=%d extra=%d"
        % (len(identical), len(lf_only), len(modified), len(missing), len(extra))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
