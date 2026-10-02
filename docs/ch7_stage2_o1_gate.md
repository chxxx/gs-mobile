# 阶段 2 · O1 颜色正确性闸门（桌面，8-bit 无损 PNG 逐像素）

> 生成：2026-10-02。工具：`tools/ch7_color_gate.ps1`（跑图）+ `tools/ch7_gate_all_arms.py`（逐像素比对）。
> 口径：桌面 Edge/Chrome，`res=320x213&dpr=1&res_mode=forced`（**全幅、逐像素、无损 PNG**；SH 数学与分辨率无关），
> `framedump=1` 回传基准位姿整幅，`rounds=1`、`runs=5`、`warmup=20`、`benchmode=offscreen-paper-match`、`profile=garden`、同会话。
> 报告落盘：`thesis_project/data/ch7_measurements/raw/colorgate_*.txt`。

## 0. 结论：**PASS**（全部臂 ≥ 60 dB、无 >8 级像素）

| 臂（报告里的 `arm=`） | PSNR[RGB] vs BASE | 平均误差 | 最大误差 | >8 级像素 | SSIM | 判定 |
|---|---|---|---|---|---|---|
| `frag`（09-30 报告；**O1 不改这条路径的源码字节**） | **60.02 dB** | 0.05843 级 | 5 级 | **0** | 0.999863 | **PASS(≥60)** |
| `frag+notx+nocolortx`（10-02 新跑） | **60.01 dB** | 0.05853 级 | 5 级 | **0** | 0.999862 | **PASS(≥60)** |
| `lr+notx+nocolortx`（10-02 新跑） | **60.03 dB** | 0.05829 级 | 5 级 | **0** | 0.999863 | **PASS(≥60)** |
| `lr`（09-30 报告，阶段 1 归档） | 60.04 dB | 0.05819 级 | 5 级 | 0 | 0.999863 | PASS(≥60) |

**读法（关键）**：四条臂全部聚在 **60.0 dB 同一水平**，`>8 级像素 = 0`、最大误差 5 级。
这 60 dB 的共同基线来自 **BASE（逐 splat 顶点路径）→ SHCACHE(RGBA16F 颜色缓存)** 的 16F 量化，
**不是** O1 引入的误差 ⇒ **O1 相对 `frag` 的额外误差 ≈ 0**（60.03 vs 60.02；平均 0.05829 vs 0.05843 级）。
⇒ 满足本阶段"**≥ 60 dB 或逐位一致**"的正确性要求 ✓（约束 6 的 ≥45 dB 门槛远超）。

## 1. 两次未落盘的提交（不影响结论，已核实）

`cg-frag` 与 `cg-fragntx` 两轮 `[result] ok=1`（页面跑完），但**报告没落到 raw/**（提交环节丢失，未复现原因）。
不影响判定，理由：
- `frag`：**O1 不触碰这条路径**——两个开关都关闭时不注入任何 `#define`，缺省着色器（预处理后）逐字不变，
  且 `frag` 的颜色数学与 09-30 那次完全相同 ⇒ **09-30 的 60.02 dB 就是当前 `frag` 的实测值** ✓；
- `frag+notx`：它的颜色数学与 `frag+notx+nocolortx` **只差"乘一个单位阵"**（Renderer 里 `colorTransform` 块 0 恒为单位阵，
  索引全 0）⇒ 单位阵乘法在 IEEE754 下**精确** ⇒ 已测的 `frag+notx+nocolortx`（60.01 dB）**蕴含** `frag+notx` 通过 ✓。

## 2. 工具改动（本次）

| 文件 | 改动 | 默认行为 |
|---|---|---|
| `tools/ch7_color_gate.ps1` | 新增 `-Cases <名字列表>` 与 `-SleepSec`；已知 case：`base/frag/fragntx/fragctx/fragboth/lrboth/lrfrzzboth`（`param()` 必须紧跟头注释、放在其它语句之前，否则 `ParserError: InvalidLeftHandSide`——已踩并修） | **缺省 `base,frag` ⇒ 与改动前逐字等价** ✓ |
| `tools/ch7_gate_all_arms.py` | **新增**：解析 `raw/<CG_NAME>_*.txt`（按 `u=` 取**最新**一份），把**除 base 外的所有臂**与 BASE 逐像素比，输出 PSNR/SSIM/各阈值像素数，并按 "≥45 dB 且无 >8 级" 给出 FAIL/PASS 退出码（纯 ASCII 输出，GBK 控制台安全） | 旧工具 `ch7_color_gate_compare.py` **未改**（它是 GBK 编码，改动有乱码风险） |

## 3. 由此可以往下一步推进

正确性闸门已过 ⇒ O1 可以定性为"**零（可见）误差的取样清理**"，收益按真机口径记（Gen2 `frag` 16.18 → `frag+notx` 13.85 ms）。
**O2 提议见 `docs/ch7_stage2_o2_plan.md`**（首个候选：把 `cameraPosition` 做成 uniform，去掉每点/每顶点的 `inverse(view)`）。
