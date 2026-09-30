# 阶段 1 设计书：渲染期低秩（`?shcache=frag&lr=1`）

> 2026-09-30 夜定稿（**代码尚未落地**，本文件是实现前的设计冻结；所有结论都已对着代码/文件核实，含行号锚点）。
> 目标（用户口径）：把**片元生产遍**里每点 **6 次** SH 取样降到 **⌈r/8⌉ 次**，用共享基在着色器内重建颜色。

## 0. 已核实的事实（实现的前提，全部来自代码/文件）

| 事实 | 证据 |
|---|---|
| 低秩重建是 `rest45 = C @ B`，**coeff-major**：`[R1,G1,B1, R2,G2,B2, …, R15,G15,B15]` ⇒ **45 列 = l=1..15 的 rest 系数，不含 DC** | `QPLYLoaderUtils.ts` 头部注释（"SH rest coefficients are reconstructed per gaussian as `rest45 = C @ B` … in coeff-major layout"） |
| **DC 不参与**低秩：`f_dc_0..2` 走 `features_dc` 码本，加载期被编进**基础色字节**：`splatUint8[…24+0..2] = (0.5 + SH_C0·fdc)·255` | `QPLYLoaderUtils.ts:319-327` |
| 现有 SH 纹理：**3 通道**各一张 `RGBA32UI`，`shWidth=2048`、`shHeight=⌈2·N/2048⌉`，每点每通道 **2 纹素 = 16 half** ⇒ 着色器每点 **6 次** texelFetch | `QPLYLoaderUtils.ts:233-241`；`RenderProgram.ts:497-504`（`shCoord0/1` + `packedR0/R1`） |
| 610k 点下全 SH 纹理占用：`3 × 2048 × 596 × 16 B ≈ 58.6 MB` | 由上式算得（与文档 §27 的"~58 MB"一致） |
| 低秩纹理（8 half/纹素、r=7）：`2048 × 298 × 16 B ≈ 9.8 MB` ⇒ **6× 更小**，且**每点 1 次取样** | 本设计 §1 |
| 片元生产遍**与 BASE 顶点着色器同源**（SH 常量/函数是运行时从顶点模板切出的同一段文本） | `RenderProgram.ts:194`（`sliceShaderSource`） |
| 主 pass 在 frag 臂**不声明任何 SH sampler**（`#if` 整段排除） | `RenderProgram.ts` 的 `SHCACHE_FRAG` 分支 + §30 修复 3 |
| `evalSHRGB` 的返回值**包含 DC**（`SH_C0·shs[0] + … + 0.5`），主 pass 用 `color.rgb = evalSHRGB(...)` **整体替换**基础色 → 即"基础色 = 纯 DC 项" | `RenderProgram.ts:518`（`vec3 result = SH_C0 * vec3(shs[0], shs[1], shs[2]);`）与顶点侧 `color.rgb = evalSHRGB(...)` |

⇒ **由此得到一个关键简化**：低秩路径下 `color.rgb`（被覆盖前）**已经是 DC 项**（`0.5+SH_C0·fdc`，与 `evalSHRGB` 的 DC 部分同式），
因此**只需把 rest 贡献加回去**：`color.rgb = color.rgb + Σ_j a_j · Σ_{l≥1} Y_l(d)·B[j,l,c]`。
⇒ 代价：DC 取自 8 位基础色（±0.5/255）而 BASE 取自 SH 纹理的精确值 ⇒ 单项 PSNR ≈ 54 dB（> 45 dB 闸门，由 §6 闸门实测确认）。

## 1. 数据侧（加载期不再 CPU 重建）

- **保留**：位置/尺度/旋转/不透明度/DC 的现有路径（`UV32UI u_texture` + 基础色字节），逐字不变。
- **新增**（仅 `lr=1` 时）：把每点的 **r 个 rank 系数**（`features_rank_0..r-1` 经各自码本 **反量化为 half** ⇒ 需求 1）
  打包成**一张 `RGBA32UI` 纹理**：每纹素 **4×uint = 16 B = 8 个 half** ⇒ `r=7` ⇒ **1 纹素/点**（`⌈7/8⌉=1`）。
  布局与颜色缓存同款：`width = 2048`、`height = ⌈N/2048⌉`、点索引 `idx → ivec2(idx % W, idx / W)`；
  半精度打包复用现有 `packHalf2x16`（`src/utils/HalfFloat.ts`）。
- **同时跳过**：`decodeLowRankRange`/`mergeLowRankChunks` 里的 `C @ B`（45 维重建）与 48-half 打包（这正是表 7-5 的 130/282 ms 的主要部分）。
  ⇒ 预计 `parse_ms` 与首帧时间显著下降；**用现成字段测量**（`parse_ms` / `first_frame_ms` / `fetch_ms`），不新增计时器。
- **SH 相关 GPU 字节**（需求报告项）：全 SH `≈58.6 MB` → 低秩 `≈9.8 MB`（`lr=1` 时不创建 3 张全 SH 纹理 ⇒ 该 58.6 MB 直接省掉）。

## 2. 基 B 的存放（需求 2）

- `r=7`、每行 45 列（`l=1..15` × 3 通道，coeff-major）⇒ **315 float**；按 `vec4` 数组存 ⇒ **79 个 vec4 = 1,264 B**。
- **远小于** `GL_MAX_UNIFORM_BLOCK_SIZE`（GLES3 下限 **16,384 B**）⇒ **UBO 方案成立**，**不需要**"RGBA32F 纹理存基"的退路臂。
  报告里会把实测的本机 `MAX_UNIFORM_BLOCK_SIZE` 与 1,264 B 一起回显（`sw_effective` 加 `lr=`、`lrb=`），任何设备都能自证。
- **存储顺序**（性能考虑，语义不变）：行内按 **channel-major** 排：`off(j,c,l) = j*45 + c*15 + (l-1)`
  ⇒ `Σ_l` 沿连续地址 ⇒ 每个 `vec4` 覆盖 4 个相邻 `l`；累加形式仍写作 `color_c += a_j · Σ_l Y_l·B[j,l,c]`（需求 3 的形式）。
- 分组多基（若出现）：loader 的 `basisElement.count` 就是 rank、`properties.length` 是列数（`QPLYLoaderUtils.ts:614-623`）；
  将来若"每分组一基"，总大小 = `groups × r × 45 × 4 B`，**超过 16 KB 时**才启用退路臂（纹理存基），并在报告里写明原因。

## 3. 着色器侧（需求 3）

在生产遍（`SHCACHE_FRAG` 的片元 pass）内新增编译期分支 `#ifdef SHCACHE_LR`：

```glsl
// 1) 每点 1 次取样拿到 a_j（8 half/纹素，只有前 r 个有效）
uvec4 aPacked = texelFetch(u_lrRank, ivec2(idx & (u_lrW - 1u), idx / u_lrW), 0);   // 1 次
float a[LR_RANK];   // LR_RANK = 7，由 TS 侧注入 #define（编译期常量 ⇒ 循环可展开）
// 2) 15 个 Y_l(d)（l=1..15）：沿用切出的同一段 SH_C 常量；循环边界为编译期常量
// 3) color_c = dc_c + Σ_j a_j · Σ_l Y_l(d) · B[j,l,c]   ← 不在寄存器里重建 45 维
```
- 采样数：低秩路径 **1 次**（a_j）+ **0 次**（DC 来自基础色）⇒ 对比现路径 **6 次** ⇒ 目标达成。
- 与 BASE 同源纪律：`SH_C0..C3` 与 `Y_l` 求值顺序沿用切出的同一段文本（`#ifdef SHCACHE_LR` 内联，不改原函数）。

## 4. 主渲染程序 + 缺省路径（需求 4）

- **主渲染程序（frag 臂）逐字不变**：仍只 `texelFetch(u_colorTex, …)` 一次；仍不声明任何 SH sampler（`#if` 整段排除）。
- `lr` **缺省 0** ⇒ 所有既有分支（含"加载期重建"）**逐字不变**；新增纹理/UBO/程序**只在 `lr=1` 时创建**（与 `shcache` 同款纪律）。
- 冲突硬失败（沿用阶段 0 风格）：`lr=1` ×（缺 `shcache` / `shfmt=f16` / `shpass=*`）⇒ 明确抛错，不静默降级。

## 5. 臂与测量

| 臂 | URL | 作用 |
|---|---|---|
| `frag` | `&shcache=frag` | 阶段 0 基准（每帧生产，6 次取样） |
| `frozen` | `&shcache=frag&shfreeze=2` | 阶段 0 的"零生产"上界 |
| **`lr`** | `&shcache=frag&lr=1` | **本阶段主角**：每点 1 次取样 |
| **`lrfrozen`** | `&shcache=frag&lr=1&shfreeze=2` | 本阶段的"零生产"上界 |
| `lrcb`（可选，需求 5） | `&shcache=frag&lr=1&lrcb=shader` | 码本在着色器端查表（uint8 索引 + uniform 码本），只用于对照**动态索引**开销 |

协议与阶段 0 **完全一致**（同会话背靠背、每条链接 `rounds=3`、`runs=5`、20 预热 + 20 帧、`spin=0`、`arm=` 自证）：
`P_lr = LR_FULL − LR_FROZEN`，与阶段 0 的 `P = 2.706 ms` 对比；加载期取 `first_frame_ms` / `parse_ms`（对比表 7-5 的 130/282 ms）与 SH GPU 字节（58.6 → 9.8 MB）。

## 6. 正确性闸门（桌面，无损 PNG 全幅逐像素；方法同 2.3 节）

`tools/ch7_color_gate.ps1` + `tools/ch7_color_gate_compare.py`（`?framedump=1&res=320x213`，body 0.26 MB，安全）：
**LR_FULL vs FRAG_FULL**、**LR_FULL vs BASE**：PSNR / SSIM / 最大误差 / 误差直方图；**要求 ≥ 45 dB**（SSIM ≥ 0.999、无结构化差异）⇒ 否则**停止**并排查。

## 7. 预期（待实测修正）

| 项 | 现在（阶段 0） | 目标（阶段 1） | 依据 |
|---|---|---|---|
| 生产遍取样/点 | **6 次** | **1 次** | §1/§3 |
| FRAG_FULL | 62.0 fps（16.13 ms） | 提升主要来自 P ↓ | §27：取样次数是最硬的一项 |
| FRAG_FROZEN 类 | 74.5 fps（13.42 ms） | 基本不变（生产遍不跑） | 读取成本 R≈2.96 ms 仍在 |
| 上限参照 | — | ≈74 fps（1.7× vs base 23.04 ms） | 阶段 0 §4 |
| SH GPU 字节 | 58.6 MB | **9.8 MB** | §1 |

> ⚠️ 阶段 0 已证明 **R（读取 2.96 ms）≥ P（生产 2.71 ms）**：本阶段只动 P，**只做这条仍到不了 1.7×**，
> 必须与"读取局部性"（颜色按绘制槽位顺序存放）合并才吃满上限。

## 8. 实施顺序（下一步照此执行）

1. loader：`lr` 快速路径 —— 只反量化 r 个 rank 系数并按 half 打包进 `RGBA32UI`（跳过 `C@B` 与 48-half 打包）；
2. `RenderProgram`：`lr=1` 时建 rank 纹理 + 基 UBO（1,264 B）+ 注入 `#define SHCACHE_LR / SH_CACHE_LR_RANK`，生产遍加低秩分支；
3. 回归验证（`tsc` + 桌面三臂冒烟：`base`/`frag`/缺省 的 `covered` 与 fps 与阶段 0 一致）；
4. 颜色闸门（LR vs FRAG vs BASE）⇒ ≥45 dB 才继续；
5. 真机 4 臂（+可选 `lrcb`）× `rounds=3` ⇒ 出 `P_lr` 与加载期三指标。

