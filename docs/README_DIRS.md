# rendering/ 目录索引（= gs-mobile，gsplat.js fork）

本目录是项目的**渲染域**：在 gsplat.js 基础上扩展三阶球谐 + QPLY 加载的 WebGL 2.0 渲染器，
同时保存第6、7章的实测脚本与素材。它是**独立 git 仓库**（`origin` 指向 `gs-mobile`），与根目录的训练代码仓库互不嵌套提交。

## 代码与构建

| 路径 | 内容 |
|---|---|
| `src/` | 渲染器源码（TS + GLSL）：`loaders/`（PLY/QPLY 加载）、`renderers/webgl/`（程序与着色器）、`splats/`、`cameras/`、`controls/` |
| `wasm/` | 排序相关的 C++/WASM 源码（`sort.cpp`、`data.cpp`），`compile_wasm.sh` 构建 |
| `examples/` | 官方示例（vanilla-js、editor、4d、fps 等） |
| `index.html`、`demo.ts` | 演示首页与其入口脚本（`npm run dev` / `site:build` 的主页面） |
| `bench.html`、`bench-case.html`、`bench-flux.html`、`bench-hop.html`、`bench-done.html` | **实测页 HTML（留在根：它们的 URL 就是 `/<name>.html`，论文第7章与对外链接都按此记录）** |
| `bench/` | 实测页驱动：`bench.ts`、`bench-shared.ts`、`bench-measure.ts`、`bench-view.ts`、`bench-case.ts`、`bench-flux.ts`、`bench-offscreen.ts`、`bench-chip.ts` + 3 个 `*.test.ts`（vitest） |
| `bench/data/` | 实测页数据清单：`bench-scenes.json`、`baseline-scenes.json`、`flux-baseline-scenes*.json`、`bench-cameras.json`、`bench-flux-camera.json`、`bench-resolutions.json`、`bench-aligned-poses.json`（页面按 `./bench/data/*.json` fetch） |
| `scenes.json`、`reduced-3dgs-urls.json` | 演示首页场景清单 / reduced-3DGS 资产链接表（CI 用），留在根 |
| `vite.config.js`、`vite.site.config.js`、`package.json`、`tsconfig*.json`、`eslint.config.js` | 库构建 / 站点构建 / 工具配置 |
| `public/`、`dist/`、`site-dist/` | 静态资源与构建产物（后两者 gitignore） |
| `node_modules/` | npm 依赖（gitignore） |

## 实测与评测

| 路径 | 内容 |
|---|---|
| `tools/ch7/` | **第7章实测全套**（36 个文件）：`ch7_common.py`（路径/协议常量，被其余脚本 import）、`ch7_batch.py`/`ch7_serve.ps1`（批次编排与本地伺服）、`ch7_realdevice.ps1`、`ch7_paper_protocol_*`（论文口径执行与报告）、`ch7_verify.py`/`ch7_gate_*`（门禁校验）、`ch7_*report*/table/analyze`（结果汇总）、`ch7_report_middleware.mjs`（dev/preview 共用的结果回传端点，被两个 vite 配置 import）、`inspect_ply_header.py`（被 `ch7_verify.py` import） |
| `tools/eval/verify_demo.mjs` | 线上/本地 Demo 无依赖验证器（首帧、下载、交互、截图）——见 `docs/DEPLOYMENT.md` |
| `tools/eval/align_flux_positions.py`、`extract_flux_camera.py`、`check_flux_camera_framing.py`、`check_alignment_quality.py`、`compare_images.py` | Flux-GS 对照方法的位姿/取景对齐与图像对比 |
| `tools/eval/make_bench_*.py`、`fetch_reduced3dgs_assets.py` | bench 相机/机位/分辨率生成、reduced-3DGS 资产拉取（CI 亦调用） |
| `scenes/` | 低秩 QPLY 演示资产（`point_cloud_quantised_half_r7-*.ply`、`*_std45-*.ply`） |
| `reduced-3dgs/` | reduced-3DGS 对照资产（PLY 已 gitignore，用 `tools/eval/fetch_reduced3dgs_assets.py` 取回） |
| `flux-gs-project-gh-pages/` | Flux-GS 官方页面的渲染产物（对照实验证据） |

## 文档

| 路径 | 内容 |
|---|---|
| `docs/DEPLOYMENT.md` | 线上部署状态与验证证据（README §4.1 的依据） |
| `docs/ADAPTIVE_QUALITY.md`、`docs/A_B_GUIDE.md` | 自适应质量与 A/B 对照说明 |
| `docs/部署使用说明.md` | 中文部署操作说明 |
| `docs/thesis/` | **第6、7章写作素材与实测记录**：`ch6_*`（渲染器实现事实与正文）、`ch7_*`（数据集均值、公平性框架、Gen3 实测、离屏批次、Flux-GS 对照、章节成稿等）、`thesis_ch6_ch7_merged_text.md` |
| `BENCH_ASSETS.md`、`README_CN.md` | 评测资产说明与中文 README（上游内容） |
