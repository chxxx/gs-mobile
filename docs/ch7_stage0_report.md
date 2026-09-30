# 阶段 0 报告：数据卫生 + 生产成本拆分（2026-09-30 夜，真机 Adreno 740 / Chrome）

> 用途：作为"是否/如何推进阶段 1"的输入。**结论：可以推进**（数据自证完整、标签自动化到位、P/R 已拆分、
> 颜色闸门已过、缺省路径未动、跨会话数字一致）。
> 一句话结果：**P（生产成本）= 2.71 ms、R（读取成本）= 2.96 ms**（真机，每臂 3 轮）⇒
> **"读取"并不比"生产"便宜**，阶段 1 必须同时打这两处，只优化生产最多拿回 2.7 ms。

## 1. 四项任务的完成情况

| 任务 | 状态 | 要点 |
|---|---|---|
| 1 · 报告标签自动化 | ✅ | `arm=` 由**子页面实际生效的配置**生成（`RenderProgram.publishEffectiveArm()` → `window.__CH7_ARM__` → 结果字段 → 报告头 + 逐轮行），取值 `base/frag/frozen/tf_consume/tf_full/tf_produce`（失败加 `-failed`）；报告头新增 `arm=` 与 **`sw_effective=`**（`shcache|shfreeze|shpass|nosh|noct|shdeg|shfmt|shprobe|webgl2`）。`u=` 降级为**用户备注**。3 份错标报告 → `docs/ch7_excluded_reports.md`（excluded，附物理字段证据）。上线当天就抓到我自己 runner 的 URL 拼接 bug（`shcache=frag-r1` 未生效 ⇒ 报告如实写 `arm=base`）。 |
| 2 · FRAG_FROZEN 臂 | ✅ | `?shcache=frag&shfreeze=N`：只在前 N 帧跑片元生产遍，之后每帧复用颜色纹理；主 pass 与 FRAG_FULL **同一份着色器源码**（同样不声明任何 SH sampler）。**N=1 不可测**（首帧点/变换纹理尚未绑到单元 0–4 ⇒ `cov=0` ⇒ 空缓存 ⇒ 存活探针 ok=0），**N=2 为最短可测**，对 P 的影响 ≈0.2–0.8%。 |
| 3 · spin 协议运动类型 | ✅ | **原地偏航、位置不变**。代码依据：`spin_mode=rate` 时**缺省 pivot = 相机自身位置**（`spin_pivot=cam`）⇒ 相机原地转头；显式 `?pivot=x,y,z` 才是**公转**。**`|Δc|` 的逐帧证据已在报告里**：`sweep_pos` 的 9 个采样点全部相同（`-5.829,-0.130,-3.017`）⇒ 累计位移 **0**；`spin_err=3.3e-6`（与基线臂注入式视图矩阵对账）。公转时每帧 `|Δc| = 2πR·Δθ/360`。 |
| 4 · 低秩导出格式 | ✅ | 见 §5（含字节级闭合）。 |

## 2. 真机测量（Adreno 740 / Chrome 132 / ANGLE，离屏 1600×1063，`spin=0`）

四条链接各 **一次点击 × `rounds=3`**（同一页面内连跑 3 轮），`runs=5`、20 预热 + 20 帧 ⇒ 每个报告头自带 **3 轮均值 ± 3 轮间标准差**。
原始报告：`raw/stage0_20260930_190611/base`、`190730/tf_consume`、`190901/frag`、`191101/frozen`；全部 `err=-`、`covered=99.8%`、设备 `ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)`。

| arm（自证） | u（备注） | 3 轮 fps（均值 ± std） | frame_ms = 1000/fps | cpu_ms | covered |
|---|---|---|---|---|---|
| `base` | s0-base | **43.4 ± 0.6** | **23.041** | 22.92 | 99.8% |
| `tf_consume` | s0-consume | **95.6 ± 3.0** | **10.460** | 10.43 | 99.8% |
| `frag`（FRAG_FULL） | s0-frag | **62.0 ± 1.1** | **16.129** | 16.24 | 99.8% |
| `frozen`（FRAG_FROZEN，`shfreeze=2`） | s0-frozen | **74.5 ± 1.5** | **13.423** | 13.50 | 99.8% |

```
P（生产成本 = FRAG_FULL − FRAG_FROZEN）     = 16.129 − 13.423 = +2.706 ms/帧
R（读取成本 = FRAG_FROZEN − CONSUME_ONLY） = 13.423 − 10.460 = +2.963 ms/帧
合计（FRAG_FULL − CONSUME_ONLY）           = +5.669 ms/帧
```
复算命令：`python tools\ch7_stage0_report.py`（用 `S0_GL=Adreno` 只取真机批；桌面验证批已移到 `raw/_probe/desktop_stage0/`，不参与）。

## 3. 判读（阶段 1 的直接依据）

1. **P ≈ 2.71 ms**：片元生产遍（610k 个片元 × 每片元 6 次 texel fetch + 写出 RGBA16F 颜色纹理）的**每帧**成本。
   ⇒ 与 §29 的 TF 生产遍（30.5 ms）相比便宜 ~11×，方案 B 的立论在"生产成本"这一侧被进一步量化。
2. **R ≈ 2.96 ms**：主 pass 按**原始 splat 索引**随机 `texelFetch(u_colorTex, ivec2(idx % W, idx / W))`
   （每 splat 4 顶点 ⇒ 610k × 4 ≈ 244 万次随机访问，2048 宽的 RGBA16F 纹理 ⇒ 空间局部性差）。
   ⇒ **R 与 P 同量级、甚至略大**：这不是"读取免费"，而是一个**独立且同样可观**的成本项。
   ⇒ 对照：§29 的 `CONSUME_ONLY`（读 TF 实例属性）95.6 fps ≈ 本轮的 `tf_consume`（95.6 vs 94.9，**跨会话一致**）
   说明"把颜色放**实例属性**"比"放纹理再随机取"省 ≈3 ms。
3. **交叉自证（会话一致性）**：`base` 43.4（§29 44.6、§31 44.2）、`frag` 62.0（§31 63.3）、`tf_consume` 95.6（§29 94.9）
   ⇒ 三个独立会话差异 ≤3% ⇒ 本轮数字可用于决策。
4. **与 NOSH 的关系**：NOSH = 11.7 ms（85.5 fps）⇒ FRAG_FULL（16.13）比"完全不要 SH"仍贵 4.4 ms；
   而 P + R = 5.7 ms ⇒ 差额 1.3 ms 来自基线口径不同（NOSH 里"声明未使用 sampler"另有惩罚，见 §29 第 4 条）。
5. **桌面验证批**（同一 harness，已归档到 `raw/_probe/desktop_stage0/`）：`base` 414→559、`tf_consume` 614→635、
   `frag` 422→455、`frozen` 480 fps ⇒ 桌面 GPU 余量大、**P/R 在桌面上被摊薄**（P≈0.28 ms、R≈0.46 ms）
   ⇒ 与既有一致：**该问题只在移动端可测**。

## 4. 阶段 1 建议（按证据排序）

| 方向 | 打哪一项 | 依据 | 预期 |
|---|---|---|---|
| **B（优先）· 改善读取局部性** | R ≈ 2.96 ms | 主 pass 按原始索引随机取纹理；而 `tf_consume`（实例属性顺序读）只要 10.46 ms ⇒ 顺序化能省 ≈3 ms | 若把颜色按**绘制顺序槽位**存放（生产遍按排序后的槽位写，主 pass 顺序取）⇒ 目标把 R 压到 ≤1 ms |
| **A · 降低生产频率** | P ≈ 2.71 ms | P 与"每帧都生产"绑定；视角/点数变化小时颜色变化也小 | 隔帧或分块生产 + 复用 ⇒ P 可按比例下降（需量化"复用的颜色误差"，与已建好的颜色闸门工具（PSNR/SSIM）直接对接） |
| C · 只对可见/重要点生产 | P | 生产遍当前无条件覆盖全部 610k 点 | 需预计算筛选表；收益取决于可见比例（`sweep_seen` 实测 64.7–68.3%） |
| D · 天花板参照 | — | FRAG_FROZEN 74.5 fps = "零生产成本"时的上界 | A+B 全做完 ⇒ 16.13 → ≈13.4 ms（≈74 fps，1.7× vs base 23.04 ms） |

**验收口径（沿用已建工具）**：任一优化都必须过 ① 颜色闸门（`?framedump=1` + `tools/ch7_color_gate_compare.py`，PSNR ≥ 45 dB、SSIM ≥ 0.999）② 本阶段 0 的 4 臂协议（同会话背靠背、`rounds=3`、`arm=` 自证）③ 缺省路径逐字不变。

## 5. 低秩导出格式核查（只读，字节级闭合）

文件 `scenes/point_cloud_quantised_half_r7-garden.ply`（14,648,586 B）：

| 项 | 结论 |
|---|---|
| 秩 r | **7**（`element sh_basis 7`；`property uchar f_rank_0..6`） |
| 共享基 | **全局一组**（loader 原话 "shared (per-file)"），布局 **rank 行 × 45 列**半精度（`property short b_0…b_44`；45 = 15 系数 × 3 通道，degree-3）⇒ 630 B |
| 系数是否码本量化 / 位宽 | **是**：`f_rank_i`/`f_dc_i`/`opacity`/`scale_i`/`rot_i` 均为 **uchar = 8 位索引**；`element codebook_centers 256` ⇒ **256 中心/字段**，中心以 **half（16 位）位模式**存储 |
| QPLY 字段布局 | `element vertex 610000`：`short x,y,z`（按 half 读）+ uchar `f_dc_0..2`(3) + `f_rank_0..6`(7) + `opacity`(1) + `scale_0..2`(3) + `rot_0..3`(4) = **24 B/点**；`element codebook_centers 256`：12 个 `short` 字段 = 24 B/中心；`element sh_basis 7`：45 个 `short` = 90 B/行 |
| 字节账目 | 头部 ASCII = **1,811 B**；数据区 = **14,646,775 B** vs 理论 `610000×24 + 256×24 + 7×90 = 14,646,774` ⇒ **差 1 B**（`end_header` 行尾 CRLF/LF）⇒ 完全闭合 ✓ |

## 6. 提交

| commit | 内容 |
|---|---|
| `2b0f1f1` | 标签自动化 + `shfreeze=N` + `arm=`/`sw=` 字段与登记 + `docs/ch7_excluded_reports.md` + `tools/ch7_stage0_report.py` |
| `aeb870f` | P/R 工具加 `S0_GL` 环境过滤；桌面验证批归档 `raw/_probe/desktop_stage0/` |
