# tools/ —— 实测、评测与资产工具

本目录只放**脚本**，全部与「演示/构建」解耦：demo 与 GitHub Pages 站点构建不依赖这里的任何文件，
唯一例外是 `ch7/ch7_report_middleware.mjs`（被 `vite.config.js` / `vite.site.config.js` 以 `import` 引用，
用于真机实测结果的 `/__ch7/report` 回传端点）。

## 分组

| 目录 | 内容 | 说明 |
|---|---|---|
| `ch7/` | 第7章系统性对比实测（36 个文件） | `ch7_common.py` 是共享常量（数据目录、协议、平台），被其余 `ch7_*.py` `import`；`ch7_verify.py` 还 `import inspect_ply_header.py`。所以这些必须**同目录**。 |
| `eval/` | 对照方法对齐、bench 资源生成、资产拉取、部署验证 | `fetch_reduced3dgs_assets.py` 被 CI（`.github/workflows/deploy-pages.yml`）调用；`verify_demo.mjs` 被 `docs/DEPLOYMENT.md` 引用。 |

## 常用入口

```bash
# 线上/本地 Demo 验证（首帧、下载、交互、截图）
node tools/eval/verify_demo.mjs <url>

# 拉取 reduced-3DGS 对照资产（CI 同款；体积约 105MB，不入库）
python tools/eval/fetch_reduced3dgs_assets.py

# 生成 bench 机位/分辨率清单
python tools/eval/make_bench_cameras.py
python tools/eval/make_bench_camviews.py
python tools/eval/make_bench_resolutions.py

# 第7章批次实测（详见 docs/thesis/ch7_*.md 与 docs/README_DIRS.md）
python tools/ch7/ch7_batch.py --help
powershell -ExecutionPolicy Bypass -File tools/ch7/ch7_serve.ps1
```

## 路径约定（重要）

这些脚本会读写**渲染域根**（`rendering/`）与**论文域的实测原始数据**
（`../thesis/data/ch7_measurements/raw`），因此组内统一用「按当前位置向上推导」的方式定位：

- Python：`GS = <渲染域根>`、`PROJECT_ROOT = <工作区根>`（由 `__file__` 上溯，已在迁移时按新层级修正）
- Node（`.mjs`）：`path.resolve(here, "../../../thesis/data/ch7_measurements/raw")`
- PowerShell：`$root/$GS = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)`

**后果**：不要再把这些脚本单独往下挪一层（或整体搬回 `tools/` 平铺），否则上述相对层级会整体偏移。
需要调整分组时，请同步更新本 README 与 `docs/README_DIRS.md`，并重跑 `npm run site:build` 验证。

## 与构建/部署的关系

- `npm run dev` / `npm run site:dev`：加载 `ch7/ch7_report_middleware.mjs`，启用结果回传与 `.ply` 请求埋点。
- `npm run build`（库模式）：`src/index.ts` → `dist/`，与本目录无关。
- `npm run site:build`：`index.html` + 5 个 `bench*.html`（都在根，URL 不变）→ `site-dist/`；
  静态复制 `scenes/`、`scenes.json`、`bench/data/*.json`（`bench-scenes`、`baseline-scenes`、
  `flux-baseline-scenes`、`bench-cameras`、`bench-flux-camera`、`bench-resolutions`、`bench-aligned-poses`）、
  `flux-gs-project-gh-pages/`、`reduced-3dgs/`（可选）。CI 将 `site-dist/` 强推到 `pages` 分支发布。
