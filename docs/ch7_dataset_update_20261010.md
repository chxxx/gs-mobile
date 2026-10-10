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

## 2. 性能指标：**新 PLY 批次 = 论文现在报告的值（已更新）**

> **口径更正**：新换的那两份 PLY 对应 `all_metrics_latest.txt`（2026-09-07 批次）的数值；
> **论文已按这批更新**（此前论文里的 30.09 是**上一个批次**，已替换）。
> 权威位置：`thesis_project/thesis.md` 表 4-2 / 表 4-3 / 第 4 章结论段（均已于 2026-10-10 同步）。

**论文表 4-2（Deep Blending，本文方法，更新后）**：**PSNR 29.76 / SSIM 0.908 / LPIPS 0.244 / #G 0.311M**

**逐场景（`all_metrics_latest.txt`，与新 PLY 一一对应）**：

| Scene | PSNR | SSIM | LPIPS | Q-PSNR | Q-SSIM | Q-LPIPS | Points | Size(MB) | Half(MB) | FPS |
|---|---|---|---|---|---|---|---|---|---|---|
| playroom | 30.0589 | 0.9089 | 0.2461 | 29.9921 | 0.9085 | 0.2471 | **190,000** | 17.40 | 4.36 | 261.59 |
| drjohnson | 29.4680 | 0.9067 | 0.2422 | 29.3497 | 0.9048 | 0.2436 | **432,000** | 39.55 | 9.90 | 237.99 |

两场景均值 **PSNR 29.7635→29.76 / SSIM 0.9078→0.908 / LPIPS 0.2442→0.244**；Final Points 均值 311,000（=0.311M，与论文一致）；
Half PLY 均值 7.13 MB；Bits per Gaussian 768.07；Native GPU FPS 均值 249.79（**桌面原生口径**，非手机 harness）。

**这次更新连带修正的论文结论（已在 `thesis.md` 落地）**：

| 原来 | 改成 | 原因 |
|---|---|---|
| Deep Blending "PSNR、SSIM、LPIPS **三项均为表中最优**" | **仅 LPIPS 最优**；PSNR/SSIM 与最强基线同档 | 新值 29.76 低于 CompGS 29.90 / GaussianSpa 29.98 / Mini-Splatting 30.00；SSIM 0.908 低于 GaussianSpa 0.910 |
| "PSNR 仍提高 **0.67 dB**"（相对 3DGS） | **0.34 dB** | 29.76 − 29.42 |
| 表 4-3 DB 行 "Mini-Splatting 30.00 vs 本文 30.09 ⇒ **+0.09 dB**" | "30.00 vs 本文 29.76 ⇒ **−0.24 dB**"，并补一句"该数据集收益主要体现在感知质量（LPIPS 0.255→0.244）" | 同点数对比下本文 PSNR 已不再领先 |
| 摘要："三个数据集上均取得最高 PSNR … Deep Blending 三项同时最优" | "Mip-NeRF 360 与 Tanks and Temples 上取得最高 PSNR；Deep Blending 上 LPIPS 唯一最优、PSNR/SSIM 与最强基线同档" | 同上 |

> ⚠️ **仍待确认（未改）**：第 7 章表 7-6 的 Deep Blending 行是 **0.376M / 30.01 / 0.909 / 0.241**，
> 其中 **0.376M = 旧 PLY 的点数**（旧 playroom 约 32 万点）⇒ **该行仍是旧 PLY 的数据，需要用新批次重测/更新**。
> 另有两点口径提醒：`FPS` 一栏是**桌面原生 GPU**；`Points` 已随新 PLY 变为 drjohnson 432,000 / playroom 190,000。



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
