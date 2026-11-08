# rendering/ 目录索引（= gs-mobile，gsplat.js fork）

本目录是项目的**渲染域**：在 gsplat.js 基础上扩展三阶球谐 + QPLY 加载的 WebGL 2.0 渲染器，
同时保存第6、7章的实测脚本与素材。它是**独立 git 仓库**（`origin` 指向 `gs-mobile`），与根目录的训练代码仓库互不嵌套提交。

## 代码与构建

| 路径 | 内容 |
|---|---|
| `src/` | 渲染器源码（TS + GLSL）：`loaders/`（PLY/QPLY 加载）、`renderers/webgl/`（程序与着色器）、`splats/`、`cameras/`、`controls/` |
| `wasm/` | 排序相关的 C++/WASM 源码（`sort.cpp`、`data.cpp`），`compile_wasm.sh` 构建 |
| `examples/` | 官方示例（vanilla-js、editor、4d、fps 等） |
| `index.html`、`demo.ts`、`site/`、`vite*.config.js` | 演示页与站点构建（`npm run dev` / `npm run site:build`） |
| `bench*.ts`、`bench*.html`、`bench-*.json` | 离屏/在屏基准驱动与相机、分辨率、场景配置 |
| `public/`、`dist/`、`site-dist/` | 静态资源与构建产物（后两者 gitignore） |
| `node_modules/` | npm 依赖（gitignore） |

## 实测与评测

| 路径 | 内容 |
|---|---|
| `tools/verify_demo.mjs` | 线上/本地 Demo 无依赖验证器（首帧、下载、交互、截图）——见 `docs/DEPLOYMENT.md` |
| `tools/ch7_*.py/.mjs/.ps1` | 第7章系统性对比实测：协议执行、门禁校验、报告生成、真机与离屏批次 |
| `tools/align_flux_positions.py`、`extract_flux_camera.py`、`check_*_framing.py` | Flux-GS 对照方法的位姿与取景对齐 |
| `tools/make_bench_*.py`、`fetch_reduced3dgs_assets.py`、`inspect_ply_header.py` | bench 资源与资产准备 |
| `scenes/` | 低秩 QPLY 演示资产（`point_cloud_quantised_half_r7-*.ply`、`*_std45-*.ply`） |
| `reduced-3dgs/` | reduced-3DGS 对照资产（PLY 已 gitignore，用 `tools/fetch_reduced3dgs_assets.py` 取回） |
| `flux-gs-project-gh-pages/` | Flux-GS 官方页面的渲染产物（对照实验证据） |

## 文档

| 路径 | 内容 |
|---|---|
| `docs/DEPLOYMENT.md` | 线上部署状态与验证证据（README §4.1 的依据） |
| `docs/ADAPTIVE_QUALITY.md`、`docs/A_B_GUIDE.md` | 自适应质量与 A/B 对照说明 |
| `docs/部署使用说明.md` | 中文部署操作说明 |
| `docs/thesis/` | **第6、7章写作素材与实测记录**：`ch6_*`（渲染器实现事实与正文）、`ch7_*`（数据集均值、公平性框架、Gen3 实测、离屏批次、Flux-GS 对照、章节成稿等）、`thesis_ch6_ch7_merged_text.md` |
| `BENCH_ASSETS.md`、`README_CN.md` | 评测资产说明与中文 README（上游内容） |
