# 第 7 章 · **clearColor 状态泄漏**失效清单与处置（2026-10-10）

> 目的：让**以后任何一次读取都不会把失效数据当结论**。本文只做三件事：
> ① 给出**判定规则**（可机器复算）；② 列出**受影响的记录与文档**；③ 规定**处置方式**。

## 1. 判定规则（可复算：`_tmp_ch7probe/scan_invalid_clearcolor.mjs`）

**受影响 = ① Flux 臂的离屏协议记录**（含 `decode_def=response_end_to_decode_complete_incl_main_texture`
且 `bench_mode=offscreen-paper-match`）**且 ② 时间 ≥ 2026-09-29**（泄漏由 commit `acf1b6d` 引入：
`bench-flux.ts` 的 `gl0.clearColor(0,0,0,1)` 用完未恢复 ⇒ Flux 的清屏把离屏目标 alpha 清成 1
⇒ 其前到后混合 src 因子 `1−dstA`=0 ⇒ **绘制无可见输出**）。

**再按"有无自检字段"分三档（可信度不同）**：

| 档 | 判据 | 含义 |
|---|---|---|
| **A 确认无效** | 记录含 `ink_pct` 且 **< 50** | 该轮**确实**无可见输出（有仪器直接证伪） |
| **B 推定无效** | ≥2026-09-29 且**无** `ink_pct` 字段 | 当时还没加 `ink` 探针 ⇒ **无法证明它出了图**，一律按无效处理 |
| **C 确认有效（修复后）** | 含 `ink_pct` 且 **≥ 50** | 修复后采集，可继续使用 |

## 2. 扫描结果（`raw/` 全量 576 条有效记录）

**Flux 离屏记录 94 条，其中 ≥2026-09-29 共 50 条：A=4、B=41、C=5**（另有 44 条早于泄漏、不受影响）。

### A. 确认无效（4 条，`ink_pct = 0.0`）
`outchk_20261010_180422.txt`、`outchk_20261010_180801.txt`、`outchk_20261010_184621.txt`、`sideflux_20261010_181204.txt`

### B. 推定无效（41 条，含**全部 Gen3 跨臂记录**与 09-29 桌面 Flux 校准）
- **Gen3（Adreno 750）**：`g3_20261001_163043`、`o1-flux_20261002_150301`、`f0-flux-r3_20261003_155425`、
  `helper01f1_20261006_210543`、`helper01f2_20261006_211732`、`helper01f2_20261007_130743`、
  `helper01f2b/f3/f3b_20261006~07_*`、`helper01f2o_20261006_225359`（fps=0）
- **桌面（09-29）**：`desk-sess-*`、`desk-igpu-*`、`inj-*`、`pair_*`、`hiend_*`（**这些是"桌面 Flux 快很多"的来源**）
- **今天**：`nogeabl_20261010_154758`（`2-flux`）、`nogeabl_20261010_155224`（`3-fluxnoge`）、
  `sideflux_20261010_172756/173527/173833/174739`（`sideflux-2-flux`）

### C. 确认有效（5 条，修复后）
`outchk_20261010_184735`（preclear 判别）、`outchk_20261010_185718`（clearfix 隔离验证）、
`outchk_20261010_185753`（桌面 flux 抓帧）、`side2_20261010_191430`、`side2_20261010_191815`（真机成对）

> 完整 CSV：`_tmp_ch7probe/out/INVALID_clearcolor_leak.csv`；人读版：`out/INVALID_scan.txt`。

## 3. 受影响的文档（按风险分级）

| 级别 | 文档 | 为什么危险 |
|---|---|---|
| **P0 必加横幅** | `docs/ch7_paper_tables.md` | 论文表格，直接引用跨臂 fps |
| **P0** | `docs/ch7_dataset_averages.md` | 数据集均值（跨臂口径） |
| **P0** | `docs/ch7_gen3_data_summary.md` | Gen3 汇总（**整份受影响**） |
| **P0** | `docs/ch7_ours_vs_flux.md` | ours-vs-flux 结论（倍数/区间） |
| **P0** | `docs/ch7_project_status.md` | 项目状态（含进度判断） |
| P1 | `docs/ch7_offscreen_batch_20261008.md`、`docs/ch7_desktop_investigation_status.md`、`docs/ch7_flux_device_records.md`、`docs/ch7_final_inputs.md`、`docs/ch7_thesis_writing_input.md`、`docs/ch7_strip_ct_ablation.md`（其中**跨臂段落**受影响，**本文臂内部消融段落不受影响**） | 含大量 Flux 读数 |
| P2 | 其它提到 flux 的文档（见 `_docs_flux.txt` 全表） | 多为背景/引用，逐条核对 |

## 4. 处置方式（**不删除原始记录**）

**原则：原始记录是审计轨迹，删除会让"为什么 10-01 没有可用数据"无法解释；正确做法是"标注 + 门槛 + 清单"。**

1. **记录层**（`raw/`）：**保留原文件**，新增 `raw/_INVALID_clearcolor_leak.md` 与
   `_tmp_ch7probe/out/INVALID_clearcolor_leak.csv` 作为黑名单；**不改动**任何原始记录的内容。
2. **文档层**：在 P0/P1 文档**首行加统一横幅**（本文 §5 给出模板），指向本文件；结论段落若已失效，
   在段首加 `【失效·待重跑】` 前缀（**保留原结论文字**，便于追溯当时是怎么算的）。
3. **解析层（最关键）**：报表/绘图脚本读记录前先跑两道门槛：
   - **窗口门槛**：离屏 fps 必须带 `TWdrain|TWframe` 标记（新记录自动带），并**按口径分组**；
   - **输出门槛**：Flux 离屏行必须 `ink_pct ≥ 50`；无 `ink_pct` 且日期 ≥2026-09-29 的行**直接丢弃**（等价于黑名单）。
   实现建议：把 §1 的规则做成 `tools/ch7_gate_records.mjs`（本仓库已有 `tools/ch7_baseline_report.py` 等，可挂同一层）。
4. **重跑**：用 `_tmp_ch7probe/out/rerun_links.txt`（`rounds=3&frames=20&warmup=10`，`twindow=drain|frame` 两套）
   在 Gen3 与 Gen2 各跑一遍；新记录自然带 `TW` 与 `ink_pct`，直接进 C 档。

## 5. 横幅模板（复制到受影响文档首行）

```md
> ⚠️ **【2026-10-10 失效标注】本文件中的 Flux 臂离屏数据可能无效** —— harness 的 `clearColor(0,0,0,1)`
> 状态泄漏（commit `acf1b6d`，2026-09-29 引入）使 Flux 离屏帧"绘制但无可见输出"（`ink_pct=0`）。
> 凡引用 **2026-09-29 及之后**的 Flux 离屏 fps 的结论，一律按**待重跑**处理。
> 判定规则、受影响记录清单与处置见 `docs/ch7_invalidated_by_clearcolor_leak.md`。
> 不受影响：本文臂数据、单臂内部消融、2026-09-29 之前的记录。
```

## 6. 与其它失效源的关系

- 本泄漏**只影响 Flux 臂的离屏输出状态**；本文臂不受影响（它每帧自己 `clearColor(0,0,0,0)`）。
- 与"指标本身分辨率不足"（`ch7_fairness_framework_20261010.md`：Flux 自漂 ×1.08–1.80、本节 A 档等）
  **是两个独立问题**：即使重跑修好输出，**跨臂倍数仍须按"≥3 轮 + 中位数±极差"报告**。
- 与"工具链坑"（本文臂 + `validateframe=1` + `framedump=1` ⇒ 静默不提交）并列记录在 `ch7_plan_next_20261010.md` §5。
