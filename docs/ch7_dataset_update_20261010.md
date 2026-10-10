# 第 7 章 · 数据集与本方法 PLY 更新记录（2026-10-10）

## 1. 本次更新做了什么

**本方法输出的 PLY 被重新生成**（deep-blending 两场景），仓库内 `scenes/` 的旧副本已替换为新副本：

| 场景 | 仓库旧副本 | 新副本（= 数据集输出） | 变化 |
|---|---|---|---|
| drjohnson | 10,376,586 B / MD5 `708D09FC…` | **10,376,586 B / MD5 `430A50A0…`** | **同尺寸、内容不同**（同点数 432,000，量化/剪枝结果变了） |
| playroom | 7,688,586 B / MD5 `5FF62D1C…` | **4,568,586 B / MD5 `0BE17E5B…`** | **尺寸变小**（点数 190,000，旧副本约 32 万点） |

- 源文件：`D:\study\output\benchmark_deep_blending_ours\{drjohnson,playroom}\point_cloud\iteration_30000\point_cloud_quantised_half_r7.ply`
- 目标：`gsplat.js/scenes/point_cloud_quantised_half_r7-{drjohnson,playroom}.ply`（**已复制并校验 MD5 一致**）
- 旧副本备份：`gsplat.js/_tmp_ch7probe/_backup_ply/`（本地，不入库）
- 格式自检：`element vertex 432000 / 190000`，属性为 `short xyz + uchar f_dc_0..2 + f_rank_0..6 + opacity/scale/rot`，
  另有 `element codebook_centers 256` 与 `element sh_basis 7` ⇒ **与本渲染器的 `r7 QPLY` 读取路径一致**，无需改代码。
- 场景清单/相机：`bench-scenes.json` 已有 `drjohnson`（`points:432000`）与 `playroom`（`db`）；`bench-cameras.json` 两场景均有条目 ⇒ 手机端 `cam=flux` 对位可用，**无需新增配置**。

## 2. 性能指标：**以 `thesis_project/thesis.md` 表 4-1/4-2 为准**

> ⚠️ 权威数字在论文里（用户已更新）：**`thesis_project/thesis.md`**。下列逐场景值来自
> `D:\study\output\benchmark_deep_blending_ours\_aggregated_results\all_metrics_latest.txt`（2026-09-07 批次），
> **与论文表中的数据集均值有一处不一致，需你确认哪一批对应新 PLY**。

**论文表 4-2（Deep Blending，本文方法）**：`PSNR 30.09 / SSIM 0.911 / LPIPS 0.243 / #G 0.311M`
（对照：3DGS 29.42/0.900/0.250/2.780M；Mini-Splatting 30.00/0.908/0.255/0.311M）

**逐场景（`all_metrics_latest.txt`，同批次）**：

| Scene | PSNR | SSIM | LPIPS | Q-PSNR | Q-SSIM | Q-LPIPS | Points | Size(MB) | Half(MB) | FPS |
|---|---|---|---|---|---|---|---|---|---|---|
| playroom | 30.0589 | 0.9089 | 0.2461 | 29.9921 | 0.9085 | 0.2471 | **190,000** | 17.40 | 4.36 | 261.59 |
| drjohnson | 29.4680 | 0.9067 | 0.2422 | 29.3497 | 0.9048 | 0.2436 | **432,000** | 39.55 | 9.90 | 237.99 |

该批均值 PSNR **29.7634** / SSIM **0.9078** / LPIPS **0.2441**；Final Points 均值 311,000；
Half PLY 均值 7.13 MB；Bits per Gaussian 768.07；**Native GPU FPS 均值 249.79**；Peak VRAM 训练 14.18 GB / 渲染 1.285 GB。

**差异说明（重要）**：论文表 4-2 的 Deep Blending 本文方法为 **30.09 dB**，而上面这批的**两场景均值是 29.76 dB**（差 0.33 dB）。
两种可能：① 论文用的是**更新的一批**（点数同为 0.311M ⇒ 点数对得上，只是质量指标更高）；② 论文那一行是**不同子集/配置**的均值。
⇒ **以论文为准**；若要做"手机实测 vs 论文"的对照，请以论文表 4-2 的 30.09/0.911/0.243 为基准。

> 另有两点口径提醒：`FPS` 一栏是**桌面原生 GPU**（不是手机 harness 的 `Offscreen-PaperMatch`）；`Points` 已随新 PLY 变为
> drjohnson 432,000 / playroom 190,000，任何**基于旧副本**的点数/覆盖率/FPS 记录都要按新点数重取（替换后自动生效）。


## 3. 影响面（需要跟着更新数字的地方）

**已确认提到 drjohnson/playroom 的文档（11 份）**：
`ch6_thesis_full_text.md`、`ch7_b_layer.md`、`ch7_dataset_averages.md`、`ch7_final_inputs.md`、
`ch7_flux_device_records.md`、`ch7_flux_runtime.md`、`ch7_gen3_data_summary.md`、`ch7_paper_tables.md`、
`ch7_thesis_writing_input.md`、`thesis_ch6_ch7_merged_text.md`、`DEPLOYMENT.md`。

**处置**：
- 这些文档里的 PSNR/SSIM/LPIPS/Points/Size/FPS 若与本表不一致 ⇒ 以本表（= 最新批次）为准；
- 涉及**手机实测**的行，等明天真机数据回来后再补（本表只有桌面原生 FPS）；
- `ch7_paper_tables.md` 已有"Flux 失效"横幅，**再加一条**：本表数字为 2026-09-07 新 PLY 批次。

## 4. 与明天真机测试的关系

- 明天取图的 **C 组**（`db-1/2-ours/flux-{drjohnson,playroom}`）就是用这两份新 PLY；
  验收时 `points=` 应为 **432000 / 190000**（若出现 32 万，说明页面缓存了旧 PLY ⇒ 强刷/重启预览服务）。
- 需要**与本表对照**的量：点数、Half 大小（`bytes=` 应≈4.36/9.90 MB 的传输体或按包体换算）。
