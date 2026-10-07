# 第 7 章 · Gen3（Snapdragon 8 Gen 3 / Adreno 750）实验数据总结

> 本文件由 `_tmp_ch7probe/gen_report.mjs` 从 `thesis_project/data/ch7_measurements/raw/` 的**原始回传记录**直接生成（数字不手抄）。
> 生成时间：2026-10-07T10:15:55.662Z

## 0. 口径摘要（本表所有数据同口径）

- 设备：Snapdragon 8 Gen 3（Adreno 750）；手机 Chrome（微信内置浏览器实测）
- 分辨率：`res=1600x1063`（`res_mode=forced`），本文臂另有 `offscreen_target=fbo:1600x1063`
- 协议：`bench_mode=offscreen-paper-match` + `driver=msgchannel` + `frames=20` + `warmup=20` + `runs=5` + `fences=3` + `sync=gputimer`
- 轮数：`rounds=3`；冷启动 `cold=1`；两臂同会话交替（ABAB）
- 机位：Flux-GS 原相机（`bench-flux-camera.json` 的 `default_view`，13 场景共用），两臂一致（容差 ≤0.32°）

## 1. 表 A · 13 场景两臂对比（主结果）

| 场景 | 数据集 | 本文臂 FPS(中位) | Flux 臂 FPS(中位) | 本文/Flux | 本文首帧 ms | 本文 fetch ms | 本文 parse ms | Flux 首帧 ms | Flux decode ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bicycle | mip360 | 101.5 | 155.9 | 0.651 | 7422 | 25432 | 5482 | 37120 | 37088 |
| bonsai | mip360 | 180.6 | 124.9 | 1.446 | 7380 | 10297 | 5142 | 29915 | 29892 |
| counter | mip360 | 181.7 | 167.7 | 1.083 | 6717 | 11569 | 5075 | 18245 | 18216 |
| drjohnson | db | 90.9 | 97.3 | 0.934 | 8633 | 19249 | 6488 | 22633 | 22613 |
| flowers | mip360 | 89.8 | 152.1 | 0.590 | 7700 | 57792 | 5822 | 37914 | 37878 |
| garden | mip360 | 104.1 | 120.3 | 0.865 | 7515 | 29867 | 5470 | 57917 | 57882 |
| kitchen | mip360 | 188.8 | 126.3 | 1.495 | 7548 | 16169 | 5551 | 32199 | 32166 |
| playroom | db | 96.8 | 130.1 | 0.744 | 8001 | 14021 | 6196 | 16133 | 16111 |
| room | mip360 | 146.8 | 155.8 | 0.942 | 6465 | 10602 | 4720 | 19181 | 19160 |
| stump | mip360 | 105.1 | 166.9 | 0.630 | 7148 | 24610 | 5296 | 29036 | 29005 |
| train | tnt | 81.2 | 97.7 | 0.831 | 7954 | 40138 | 6080 | 25929 | 25902 |
| treehill | mip360 | 108.1 | 162.9 | 0.664 | 7537 | 33501 | 5635 | 32978 | 32950 |
| truck | tnt | 118.8 | 123.9 | 0.959 | 8192 | 33927 | 6070 | 24531 | 24503 |

> FPS 为 3 轮**中位数**；`本文/Flux` > 1 表示本文臂更快。首帧/分段单位 ms。

## 2. 表 B · D 层消融阶梯 + 历史锚点（garden，rounds=3）

| 记录 | 臂(arm) | 各轮 fps | 中位 fps | cold |
| --- | --- | --- | --- | --- |
| abl0_20261007_130932.txt | base | - | 58.9 | 1 |
| abl1_20261007_131111.txt | frag | - | 74.2 | 1 |
| abl2_20261007_131219.txt | frag+notx+nocolortx | - | 86 | 1 |
| abl3_20261007_131552.txt | lr+notx+nocolortx | - | 98.1 | 1 |
| f0-base-r3_20261003_153912.txt | base | - | 54.2 | 1 |
| f0-bn-base_20261003_155653.txt | lr+notx+nocolortx | - | 102.8 | 1 |
| f0-bn-df05_20261003_155907.txt | lr+notx+nocolortx | - | 172.8 | 1 |
| f0-bn-rs05_20261003_155820.txt | lr+notx+nocolortx | - | 188.3 | 1 |
| f0-flux-r3_20261003_155425.txt | - | - | 105.2 | 1 |
| f0-frag-r3_20261003_154124.txt | frag | - | 80.3 | 1 |
| f0-fragboth-r3_20261003_154327.txt | frag+notx+nocolortx | - | 90.6 | 1 |
| f0-lrboth-r3_20261003_154513.txt | lr+notx+nocolortx | - | 101.5 | 1 |
| f0-lrfrzboth-r3_20261003_154658.txt | lr-frozen+notx+nocolortx | - | 120.1 | 1 |
| helper01c1_20261006_203449.txt | lr+notx+nocolortx | - | 104.1 | 1 |

> 用途：论文“每个开关贡献多少”的阶梯表，并与历史锚点（52.1→80.4→90.6→101.8、Flux 103.3）对账。

## 3. 表 C · Gen3 记录清单（可追溯性）

| 记录 | u | arm | cold | rounds | 场景数 | ok | KB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| abl0_20261007_130932.txt | abl0-gen3-xweb-main | base | 1 | 3 | 1 | 1 | 9 |
| abl1_20261007_131111.txt | abl1-gen3-xweb-main | frag | 1 | 3 | 1 | 1 | 9 |
| abl2_20261007_131219.txt | abl2-gen3-xweb-main | frag+notx+nocolortx | 1 | 3 | 1 | 1 | 9 |
| abl3_20261007_131552.txt | abl3-gen3-xweb-main | lr+notx+nocolortx | 1 | 3 | 1 | 1 | 9 |
| f0-base-r3_20261003_153912.txt | f0-base-r3 | base | 1 | 3 | 1 | 1 | 9 |
| f0-bn-base_20261003_155653.txt | f0-bn-base | lr+notx+nocolortx | 1 | 1 | 1 | 1 | 5 |
| f0-bn-df05_20261003_155907.txt | f0-bn-df05 | lr+notx+nocolortx | 1 | 1 | 1 | 1 | 5 |
| f0-bn-rs05_20261003_155820.txt | f0-bn-rs05 | lr+notx+nocolortx | 1 | 1 | 1 | 1 | 5 |
| f0-flux-r3_20261003_155425.txt | f0-flux-r3 | - | 1 | 3 | 1 | 1 | 9 |
| f0-frag-r3_20261003_154124.txt | f0-frag-r3 | frag | 1 | 3 | 1 | 1 | 9 |
| f0-fragboth-r3_20261003_154327.txt | f0-fragboth-r3 | frag+notx+nocolortx | 1 | 3 | 1 | 1 | 9 |
| f0-lrboth-r3_20261003_154513.txt | f0-lrboth-r3 | lr+notx+nocolortx | 1 | 3 | 1 | 1 | 9 |
| f0-lrfrzboth-r3_20261003_154658.txt | f0-lrfrzboth-r3 | lr-frozen+notx+nocolortx | 1 | 3 | 1 | 1 | 9 |
| g3png_b_20261007_131404.txt | g3png_b-gen3-xweb-main | base | 1 | 1 | 1 | 1 | 253 |
| g3png_f_20261007_131314.txt | g3png_f-gen3-xweb-main | lr+notx+nocolortx | 1 | 1 | 1 | 1 | 253 |
| helper01c1_20261006_203449.txt | helper01c1-gen3-xweb-main | lr+notx+nocolortx | 1 | 3 | 9 | 9 | 57 |
| helper01c2_20261006_211225.txt | helper01c2-gen3-xweb-main | lr+notx+nocolortx | 1 | 3 | 2 | 2 | 15 |
| helper01c2_20261007_130358.txt | helper01c2-gen3-xweb-main | lr+notx+nocolortx | 1 | 3 | 2 | 2 | 15 |
| helper01c3_20261006_212409.txt | helper01c3-gen3-xweb-main | lr+notx+nocolortx | 1 | 3 | 2 | 2 | 15 |
| helper01c3_20261006_224140.txt | helper01c3-gen3-xweb-main | lr+notx+nocolortx | 1 | 3 | 2 | 2 | 15 |
| helper01d1_20261006_220953.txt | helper01d1-gen3-xweb-main | lr+notx+nocolortx | 1 | 3 | 9 | 9 | 57 |
| helper01d2_20261006_224607.txt | helper01d2-gen3-xweb-main | lr+notx+nocolortx | 1 | 3 | 2 | 2 | 15 |
| helper01d3_20261006_230004.txt | helper01d3-gen3-xweb-main | lr+notx+nocolortx | 1 | 3 | 2 | 2 | 15 |
| helper01f1_20261006_210543.txt | helper01f1-gen3-xweb-flux | - | 1 | 3 | 9 | 9 | 56 |
| helper01f2_20261006_211732.txt | helper01f2-gen3-xweb-flux | - | 1 | 3 | 2 | 2 | 15 |
| helper01f2_20261007_130743.txt | helper01f2-gen3-xweb-flux | - | 1 | 3 | 2 | 2 | 15 |
| helper01f3_20261006_214439.txt | helper01f3-gen3-xweb-flux | - | 1 | 3 | 2 | 2 | 15 |

## 4. 已齐的部分

- **主结果**：13 场景 × 两臂 × 3 轮 × 冷启动（本文臂 `helper01c1/c2/c3`；Flux 臂 `helper01f1/f2/f3`），全部 `ok=3/3`。
- **D 层消融**：`abl0`(base) / `abl1`(frag) / `abl2`(frag+notx+nocolortx) / `abl3`(FINAL)，同会话 garden、rounds=3。
- **真机画质闸门**：`g3png_f`(FINAL) / `g3png_b`(base)，Garden 320×213，含无损 PNG。
- **历史锚点**：`f0-*`（base/frag/fragboth/lrboth/lr-frozen/flux）与 `g3-*`（同口径复测）。
- **第二会话复核**：`helper01d1/d2/d3`（本文臂，13 场景，r=3）⇒ 可作方差/稳健性附件。

## 5. 还没做 / 可选项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 热组（`cold=0`） | 未跑（`cold=0` 刚修好） | 主结果用冷组；补不补由你定（性价比低，暂缓） |
| P1 的 Flux 侧 | 不做 | 原配“口径B 官方 HF”，已按要求取消 |
| Gen2 / Mali 附表 | 有基础数据 | 属其它机型，另行整理 |
| 演示视频/截图素材 | 未开始 | 场景已定：优势场景 kitchen / bonsai / counter |
| 冷/热对照小节 | 依赖热组 | — |

## 6. 问题清单（需要你确认/注意）

- **`cold=0`（热组）此前与 `cold=1` 完全等价**：每轮都新建 iframe、都带全新 `ts=` 令牌重新下载模型、轮间等待都固定 1000 ms。**已修**（`cold=0` 改为按场景稳定令牌 ⇒ 第 2 轮起命中 HTTP 缓存），但**尚未复跑** ⇒ 目前没有真实热组数据。
- **两臂 `pose=` 字符串不同是正常的**：本文臂打印由(位置+四元数)算出的视图矩阵（`0.467561,0.035955,…`），Flux 臂打印它源码里仅 2 位小数的原矩阵（`0.47,0.04,0.88,…`）。协议已注明**用数值容差比对**，差 ≤0.32°（1600px 画布下边缘 ≈4.4px）。
- **跨臂“首帧”不能直接比**：Flux 臂首帧几乎全被 `decode_ms` 占掉（几十秒），本文臂是 `fetch+parse`；做对比图必须在图注写清首帧构成不同（两侧都同处离屏协议下量）。
- **部分户外场景本文臂低于 Flux 臂**（表 A 中 `本文/Flux` < 1 的行）：写作时不要用它做“更快”的论据；优势场景是室内（kitchen / bonsai / counter）。
- **更早批次不要混入**：`helper01_2026-09-22*`、`gen3-main13-r3*`、`gen3-twoarms-r5*`、`gen3-probe-*`（9/25）是另一套口径（在屏/计时器协议），不可与本表并列。
- **`helper01f2o`（口径B 官方 HuggingFace）`ok=0`**：真机访问不到 HF，按要求已放弃该口径，不参与任何统计。
- **`helper01c3_20261006_212409`（DB 首测）是异常会话，已弃用**：它的 `fetch_ms` 是后两次的 2–3 倍（drjohnson 53.9 s vs 19.2 s；playroom 26.4 s vs 14.0 s），FPS 偏低（75.7/86.3 vs 90.9/96.8）；紧接上一批连续跑，疑为热节流。本报告统一改用 `helper01c3_20261006_224140`（与第二会话 `helper01d3` 的 91.2/96.4 一致，±0.5%）。
- **每场景只有 3 轮**（表内为 3 轮 `fps_median`）：若论文要 均值±标准差/95%CI，需要我用记录里的 `fps_rounds=` 逐轮值重算。
- **Gen2 / Mali 不是这台设备**：属其它机型的记录，不能混进本表。
- **真机画质闸门两张 PNG 已到位**（`g3png_f` / `g3png_b`，各约 253 KB，内嵌 base64）⇒ 可直接做逐像素比对（我还没跑）。

## 7. 建议的下一步（我这边可直接做）

1. 用 `fps_rounds` 逐轮值算 **均值±标准差**，并做两臂 **Wilcoxon 符号秩 + 配对 t + 95%CI + Cohen's d**（13 场景配对）。
2. 出 **D 层阶梯表**（abl0→abl1→abl2→abl3 逐档增益与占比）。
3. 出 **两张真机 PNG 逐像素比对**（FINAL vs BASE：PSNR / 最大差 / 差异像素比例）。
4. 把表 A 的 `本文/Flux` 比值画成**条形图**（按场景排序），标注优势/劣势场景。
