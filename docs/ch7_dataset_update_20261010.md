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

## 2. 性能指标：**新 PLY = 第 7 章的 r7 量化部署模型（已按新批次更新论文）**

> **口径更正（我先前搞反过一次，已修正）**：本次替换的两份 PLY 是 **r7 量化部署模型**，
> 对应的是 **第 7 章**（部署模型的离线质量 + 实机离屏实测），**不是第 4 章**。
> 第 4 章用的是**未量化**模型（表 4-2/4-3 的 30.09/0.911/0.243 保持不变，已还原）。
> 已更新位置：`thesis.md` **表 7-4 本文方法行、表 7-6 的 Deep Blending 行、§7.4 画质/体积文字、
> 表 7-4/7-6 的字段口径注**。

**第 7 章 Deep Blending（2 场景，本文方法，更新后）**：**PSNR 29.76 / SSIM 0.908 / LPIPS 0.244 / 点数 0.311M / Storage 7.5 MB**

**逐场景（`all_metrics_latest.txt`，与新 PLY 一一对应）**：

| Scene | PSNR | SSIM | LPIPS | Q-PSNR | Q-SSIM | Q-LPIPS | Points | Size(MB) | Half(MB) | FPS |
|---|---|---|---|---|---|---|---|---|---|---|
| playroom | 30.0589 | 0.9089 | 0.2461 | 29.9921 | 0.9085 | 0.2471 | **190,000** | 17.40 | 4.36 | 261.59 |
| drjohnson | 29.4680 | 0.9067 | 0.2422 | 29.3497 | 0.9048 | 0.2436 | **432,000** | 39.55 | 9.90 | 237.99 |

两场景均值 PSNR 29.7635→**29.76** / SSIM 0.9078→**0.908** / LPIPS 0.2442→**0.244**；
点数均值 **311,000 = 0.311M**；Storage 均值 **(4.57+10.38)/2 = 7.5 MB**（十进制 MB，与论文注口径一致，旧值 9.0 MB 来自旧 playroom 的 7.69 MB）。

**这次更新连带修正的第 7 章结论（已落地）**：

| 位置 | 原来 | 改成 | 原因 |
|---|---|---|---|
| 表 7-4 / 表 7-6 | PSNR 30.01 / SSIM 0.909 / LPIPS 0.241 / 9.0MB（表 7-6 点数 0.376M） | **29.76 / 0.908 / 0.244 / 7.5MB（点数 0.311M）** | 新批次 |
| §7.4 画质段 | "Tanks and Temples 与 Deep Blending 上…**均高于表中全部参照方法**" | TnT 仍高于全部；**DB 高于 3DGS/3DGS\*/Mobile-GS\*/Flux-GS，但低于 Mobile-GS（含 MLP）的 29.93 dB** | 29.76 < 29.93 |
| §7.4 画质段 | "**LPIPS 在两个数据集上都低于 Mobile-GS 与 Flux-GS**" | TnT 成立；**DB 上 0.244 低于 Flux-GS 0.275，但与 3DGS/Mobile-GS 的 0.243 相差 0.001** | 0.244 > 0.243 |
| §7.4 体积段 / 表 7-4 注 | Deep Blending **9.0MB** | **7.5MB** | 0.311M × 24 B/点 |

> ⚠️ **仍需重测（第 7 章设备侧列，尚未改）**：表 7-4 的 **FPS 94.4 / First Frame 2.10 s / Download 16.2 s**、
> 表 7-6 的 **DB FPS 94.4**、以及 §7.8 四平台表的 **DB 行（199.3 / 216.6 / 191.4 / 197.3 FPS）**——
> 这些都是在**旧 PLY（0.376M 点）**上测的，新模型点数更少（0.311M）⇒ **FPS 会变，必须重跑再填**。
> 另：第 4 章（未量化模型）的表 4-2/4-3 与摘要**已还原为原值（30.09/0.911/0.243）**，不要再动。
> `FPS` 逐场景列里的 261.59 / 237.99 是**桌面原生 GPU** 口径（`all_metrics_latest.txt`），≠ 手机 harness 口径。




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
