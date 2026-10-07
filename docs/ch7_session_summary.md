# 第 7 章 · 本轮实测收尾总结（交接用）

> 生成：2026-10-07。配套文件：`ch7_paper_tables.md`（论文主表 7-A~7-H）、`ch7_gen3_data_summary.md`（Gen3 全量数据）、`ch7_dataset_averages.md`（协议 A/B 平均值）。

## 1. 结论先行：**不需要再做任何 Gen3 真机测试**

- 三个数据集的**主表数据已齐全**，且都是"**两臂同会话 ABAB 对**"：Mip360 `c1/f1`、T&T `c2b/f2b`、DB `c3b/f3b`；
- 唯一遗留的 **†**（T&T 上 Flux 点数与本文完全相同）**在 PC 上离线就能核查**，不需要手机；
- 原计划的"热组（`cold=0`）"已决定不做；统计检验、PNG 逐像素比对都只用**已有记录**；
- 手机端隧道（cloudflared 22996）已停止；`bench.html`/`bench-flux.html` 的链接仅作留档。

## 2. 本轮做完的 5 件事

1. **会话体检与择优**：发现 10-07 傍晚的新会话（`c2b/f2b` 18:43/18:46、`c3b/f3b` 18:21/18:23）显著优于 10-06 深夜的旧会话（旧会话疑热节流）⇒ 主表全部改用新会话。
2. **质量数据合并**：补齐 T&T / DB 的 Q-PSNR/Q-SSIM/Q-LPIPS（`benchmark_{tanks_temples,deep_blending}_ours`）⇒ 13 场景质量齐，均值 **27.11 / 0.828 / 0.224**。
3. **Flux 论文真值录入**：从 Zotero 全文缓存抠出 **Table 1/2/3 + C.4 的 Table 6/7/8/9**（逐场景 PSNR/SSIM/LPIPS/训练时间）。
4. **论文表格**：7-A（性能主表）、7-B（质量）、7-C（消融）、7-D（论文值）、7-E（缺口）、7-F（对照）、7-G（公平性）、**7-H-1/2/3（一数据集一表）**。
5. **清点与清理**：`_tmp_ch7probe` 从 284 个临时文件精简到 10 个（+2 个可复现脚本），根目录 scratch 全清。

## 3. 三个"必须记住"的勘误（防止再犯）

| ❌ 曾经写错 | ✅ 正确 | 教训 |
| --- | --- | --- |
| Flux-GS **30.14 dB / 151 FPS / 0.16 M** | Table 1/2/3 真值：Mip360 **30.22**(室内)/**24.45**(室外)/**27.02**(聚合)、FPS **147/132/139**、点数 **0.22M/0.48M/0.36M** | **绝不从 Fig. 图内文字抓数**，一律以 Table 为准 |
| 13 场景点数均值 **364k** | **386k**（逐场景重算；存储均值 8.8 MB） | 均值一律用脚本按逐场景重算 |
| 用旧会话数字（`c2` 81.2/118.8、`f2` 97.7/123.9…） | `c2b` **95.2/139.5**、`f2b` **154.8/174.8** | 先比会话时间戳，选最新同晚 ABAB 对 |

## 4. 主表速览（协议 B，Gen3 / 1600×1063 离屏）

| 数据集 | 本文 FPS↑ | Flux FPS↑ | 本文 PSNR↑ | Flux PSNR↑（论文） | 本文点数/存储 | Flux 点数/存储（本地实测） |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Mip-NeRF 360(9) | 134.1 | 148.1 | **27.19** | 27.02 | 411k / 9.42 MB | 408k / 3.91 MB |
| Tanks&Temples(2) | 117.4 | 164.8 | **23.80** | 23.27 | 280k / 6.42 MB | 280k †/ 2.79 MB |
| Deep Blending(2) | 94.4 | 168.5 | **30.01** | 29.73 | 376k / 8.62 MB | 228k / 2.21 MB |
| **13 场景** | **125.4** | **153.8** | **27.11** | — | 386k / 8.8 MB | ≈361k / 3.5 MB |

逐场景结论（Mip360，论文有逐场景）：**PSNR 7 胜 1 负 1 平**（唯一负值 stump −0.35 dB）；SSIM 均值持平（0.806 vs 0.807）；LPIPS 均值本文更优（0.230 vs 0.241）。

## 5. 待办清单（**全部不需要手机**）

| 项 | 做法 / 输入 |
| --- | --- |
| **† 复核** T&T 的 Flux 点数 | 用仓库根 `mpeg-pcc-tmc13` 解码 `gsplat.js/flux-gs-project-gh-pages/scene/{train,truck}.json` 的 `xyz` 字段（TMC3/GPCC），读解码 PLY 头的 `element vertex N`，与 287,304 / 273,169 对比 |
| 统计检验 | 用 `_tmp_ch7probe/latest_ab.csv`（含逐轮 `fps_all`）：13 场景配对 Wilcoxon 符号秩 + 95% CI + Cohen's d |
| 真机画质闸门 | `thesis_project/data/ch7_measurements/raw/g3png_{f,b}_*.txt`（320×213 无损 PNG）→ PSNR/SSIM/最大差 |
| 表格导出 | 7-A/7-H 三表 → LaTeX / Word |
| 附录可补 | 论文 Table 4/5（超参分析）、Table 9（逐场景训练时间）、Fig. 9（用户研究 60% 偏好） |

## 6. 文件地图

| 文件 | 作用 | 入库 |
| --- | --- | --- |
| `docs/ch7_paper_tables.md` | **论文主表 7-A~7-H**（含勘误与溯源） | ✅ |
| `docs/ch7_gen3_data_summary.md` | Gen3 全量数据、可用/弃用会话清单、D 层阶梯 | ✅ |
| `docs/ch7_dataset_averages.md` | 协议 A/B 数据集平均值、质量指标现状核查 | ✅ |
| `docs/ch7_session_summary.md` | 本文件（交接总结） | ✅ |
| `tools/ch7_analyze.py`、`tools/ch7_stage0_normalize.py`、`tools/ch7_c_links_final.py` | 第 7 章数据分析/归一化/链接生成脚本 | ✅ |
| `flux-baseline-scenes-official.json` | Flux 基线官方场景清单 | ✅ |
| `_tmp_ch7probe/`（10 个产物 + 2 脚本） | 论文摘录（`fp_*.txt`）、抽取结果（`latest_ab.csv` 等）、可复现脚本 | gitignored，本机保留 |
| `thesis_project/data/ch7_measurements/**` | **原始手机记录**（`helper01c*` / `helper01f*`）、`out/` 汇总 | 根仓库 gitignored，**证据请勿删** |

## 7. 复现命令

```bash
cd gsplat.js
node _tmp_ch7probe/extract_latest.mjs   # 每个数据集最新 ABAB 会话的逐轮/中位数
node _tmp_ch7probe/extract_phone.mjs    # 13 场景两臂 points / bytes / fps / 首帧
```

## 8. 安全提示

文档里含本次手机实测的隧道链接与口令（`rtok=ch7-2026-phase4`）。隧道已停、链接已失效；若要公开仓库，请**轮换口令并删除链接**。另外文档中出现本机绝对路径（`D:\study\...`），公开前按需替换。
