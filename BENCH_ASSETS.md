# 第7章对比方法实测：资产与生成物清单

> 本文件说明"跑第7章 reduced-3DGS / Flux-GS 对比实测"需要哪些文件、哪些**不入库**（体积/第三方原因）、
> 以及哪些文件是**脚本生成物**（每次重测会重新生成，不要手工改）。

## 1. 需要入库的文件（已随仓库提交）

| 文件 | 作用 |
| :--- | :--- |
| `bench.html` / `bench.ts` | 本方法 + reduced-3DGS 的测帧页 |
| `bench-flux.html` / `bench-flux.ts` | Flux-GS 的测帧页（同源 iframe 驱动其自带渲染器） |
| `bench-cameras.json` | 固定机位表（`cam=near/mid/far`）；由 `tools/make_bench_cameras.py` 生成 |
| `bench-flux-camera.json` | 从 Flux-GS 官方渲染器源码抽出的相机（`cam=flux` 用）；由 `tools/extract_flux_camera.py` 生成 |
| `baseline-scenes.json` | reduced-3DGS 场景清单 |
| `flux-baseline-scenes.json` | Flux-GS 场景清单 |
| `flux-gs-project-gh-pages/render_shared/main.js` | Flux-GS 渲染器（仅加测量钩子，见文件内 `[BENCH INSTRUMENTATION]`） |
| `flux-gs-project-gh-pages/render_bonsai/` `render_stump/` | 补齐的两个场景页 |
| `flux-gs-project-gh-pages/scene/*.json` | Flux-GS 13 个场景的压缩模型（约 46MB，**已入库**；部署时同源提供） |
| `reduced-3dgs-urls.json` | reduced-3DGS 量化模型的下载链接表（可编辑，供 fetch 脚本使用） |
| `tools/*.py` | 资产审计、资产拉取、相机抽取、取景表生成、结果聚合等脚本 |
| `BENCH_ASSETS.md` | 本文件 |

## 2. 不入库的资产（需在本机准备，已加入 `.gitignore`）

| 路径 | 体积 | 说明 / 获取方式 |
| :--- | ---: | :--- |
| `reduced-3dgs/quantized_<scene>.ply` | ~105 MB（当前 5 个场景） | reduced-3DGS 官方发布的 quantised 模型。**按链接拉取**（见第 3 节脚本）：<br>已确认可下载 `bicycle / bonsai / counter / kitchen / truck`（200，字节数与本地一致）；<br>官方**未发布** `room / garden / stump / treehill / flowers / train / drjohnson / playroom`（同路径 404），这几个场景只能按"子集"报告，或自行用其官方代码复现导出后补链接 |
| `scenes/*.ply`（本方法 13 场景 r7 QPLY） | ~120 MB | 训练导出的部署资产，本地开发直接放在 `scenes/` |

**资产核对（每次重测前跑一次）**：

```cmd
python gsplat.js\tools\inspect_ply_header.py gsplat.js\reduced-3dgs gsplat.js\scenes
```

## 3. 互联网（部署站点）实测要怎么准备

浏览器测帧要求**页面与模型同源**——实测确认 `repo-sam.inria.fr` 与 GitHub Release 资产**都不返回 `Access-Control-Allow-Origin`**，
所以**不能**在清单里写外链让浏览器直取（jsDelivr 有 CORS 但单文件限 20MB，50MB 的 bicycle 也放不下）。
结论：模型必须由**站点同源**提供。做法是"构建前拉到本地 → `site:build` 复制进产物 → 部署"。

实测 CORS 对照（`curl -D -` 看响应头，HEAD 与 Range GET 都测过）：

| 来源 | `access-control-allow-origin` | 能否跨域 fetch |
| :--- | :--- | :--- |
| `https://repo-sam.inria.fr/fungraph/reduced_3dgs/...` | 无 | ❌ |
| `https://github.com/<user>/<repo>/releases/download/...` | 无 | ❌ |
| `https://cdn.jsdelivr.net/gh/...` | `*` | ✅（但单文件限 20MB，本项目 PLY 超限） |
| 本站 Pages 同源路径 | 同源无需 CORS | ✅ **推荐** |

### 3.1 本机（开发/桌面实测）

```cmd
cd /d D:\study\project\Plasticity-Pruning-GS

:: 1) 拉取 reduced-3DGS 资产（已存在且体积相符会自动跳过）
python gsplat.js\tools\fetch_reduced3dgs_assets.py
::    只核对不下载：  ... --check
::    只拉部分场景：  ... --scenes bicycle,truck
::    顺手回写清单：  ... --update-manifest

:: 2) 构建自包含站点（scenes/ + reduced-3dgs/ + flux-gs-project-gh-pages/ + 各清单 json 都会复制进 site-dist）
cd gsplat.js
npm run site:build

:: 3) 本地预览（在本机先冒烟一遍）
npm run site:preview
```

### 3.2 线上（GitHub Pages）

**这些 .ply 不需要提交到 git**：部署链路是 `push 源码 → Actions（npm ci → npm run site:build）→ 强推 site-dist 到 pages 分支`，
只要在 Actions 里**构建前把资产拉下来**，产物就会带上它们、线上即同源。`deploy-pages.yml` 已加两步：

```yaml
- name: Restore reduced-3DGS assets cache        # 按 reduced-3dgs-urls.json 的 hash 缓存
  uses: actions/cache@v4
- name: Fetch reduced-3DGS assets (optional, non-fatal)
  continue-on-error: true                        # 拉取失败不阻塞部署
  run: python3 tools/fetch_reduced3dgs_assets.py
```

- Flux-GS 的 46MB 模型**已入库**（`flux-gs-project-gh-pages/scene/`），所以它在线上开箱可用，不依赖任何外链。
- `vite.site.config.js` 里 `reduced-3dgs` 是**可选复制**（目录不存在时只警告、不报错），因此 CI 拉取失败也能正常部署，
  代价只是 `profile=reduced3dgs` 那一组显示资产缺失（结果行里带 `err=`）。
- 若想彻底不拉：删掉上面 CI 的 fetch 步骤即可，线上只测"本文方法 + Flux-GS"，reduced-3DGS 改在本机 `npm run dev` 测。
- **体积提醒**：`site-dist` 约 270MB（scenes 120 + reduced-3dgs 105 + flux 50）。GitHub Pages 软上限 1GB 够用，但推送会慢；
  嫌大可用 `--scenes` 分批轮换，或把 reduced-3dgs 资产单独放在同一静态托管的子目录。

## 3. 生成物（不要手工改，可随时删除后重生成）

| 文件 | 生成方式 | 用途 |
| :--- | :--- | :--- |
| `bench-camviews.json` | `bench.html?...&exportPose=1` 的结果 + `tools/make_bench_camviews.py` | 本文机位（`pose=ours` 这种实验路径才用；正式流程不需要） |
| `bench-camviews-flux.json` | `tools/align_flux_positions.py` | 把本文机位换算到 Flux 坐标系（**已废弃**：两套模型本来同坐标系） |
| `bench-flux-camera-aligned.json` | `tools/align_flux_positions.py` | 把 Flux 相机对齐到本文坐标系（**已废弃**） |
| `bench-resolutions.json` | `tools/make_bench_resolutions.py` | 逐场景原生分辨率表；仅在用 `res=table`（Flux 原生分辨率口径）时需要 |
| `../thesis_project/data/ch7_measurements/**` | 结果卡片复制 + `tools/ch7_baseline_report.py` | 原始结果与报表（在论文仓库侧，已被主仓库 `.gitignore` 忽略） |

## 4. 正式实测（三方严格同视角）

```text
本方法：    bench.html?profile=full&rounds=3&cold=1&u=gen3-01&proto=flux&res=1600x1063&cam=flux
reduced：   bench.html?profile=reduced3dgs&rounds=3&cold=1&u=gen3-01&proto=flux&res=1600x1063&cam=flux
Flux-GS：   bench-flux.html?profile=full&rounds=3&cold=1&u=gen3-01&warmup=0&force=1600x1063
```

- `proto=flux`：`warmup=0`（无预热）+ `frames=300`，与 Flux-GS 原实现一致；
- `cam=flux`：使用 `bench-flux-camera.json` 里它自己的 `defaultViewMatrix`（焦距同步 1159.588）；
- Flux 页通过 `[BENCH INSTRUMENTATION]` 钩子在启动时冻结轮播（`carousel=false`），使视角可复现、且与另外两个方法完全一致。
