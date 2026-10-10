# 第 7 章 · 两臂"非黑/非背景输出检查"（OUTCHK）与配置差异核查（2026-10-10）

## 1. 定位（**必须写清楚，避免误用**）

`ink_pct` = 在**当前绑定的 framebuffer** 上，用 **stride=8 稀疏网格**统计 **`RGB>8`** 的样本占比。

- 它回答的是：**这一帧有没有真的往当前渲染目标写出非黑内容**（即"不是黑图/空图"）。
- 它 **不是**"两臂工作量相同"的证明。**相同点数、相同输出尺寸、相同机位、相同驱动，只能证明输入与测试协议基本对齐**；
  每个 splat 的实际着色量（SH 阶数、裁剪、混合）不同时，两臂工作量**仍然不等价**（见 §5）。
- 与既有 `covered=` 的关系：**同一份像素、同一网格，但判据不同** —— `covered` 是 **`alpha>0`**，
  所以**一块被 clear 成 `(0,0,0,1)` 的空 FBO 也会报 100%**。两个数配对读：
  `covered` 高 + `ink` ~0 ⇒ 只有 clear/空画面；两者皆 ~0 ⇒ 这一帧没写当前目标。

## 2. 实现（两臂对称，默认开；不进任何计时口径）

| 臂 | 位置 | 内容 |
|---|---|---|
| 本文臂 | `bench-measure.ts` `readOutputStats()`（`readCoveragePct()` 改为委托它） | 一次读回同时给 `coveredPct`(`alpha>0`) 与 `inkPct`(`RGB>8`) |
| Flux 臂 | `render_shared/main.js` `__fluxBenchStep()` 内 `__fluxProbeOutput()` | 同上；并在**首帧**与**本 run 末帧**各探一次（`inkPct` / `inkPctLast`、`coveredPctLast`） |

字段（两臂逐轮行）：`ink_pct=`、`ink_last_pct=`、`covered_last=`；Flux 另有 `offscreen_note=|…RD<WxH>`。

## 3. 桌面实测：纯黑是**渲染侧**现象，不是读取问题（决定性）

**两臂在完全相同的离屏协议、相同 res、同一天桌面环境下各跑一轮**（`benchmode=offscreen-paper-match&runs=1&frames=2&sync=batch&res=1600x1063`）：

| 臂 | 场景/点数 | `offscreen_target` | `covered` | **`ink_pct`** | fps | `frame_ms` | 分段 lab |
|---|---|---|---|---|---|---|---|
| **本文臂** | bonsai / 220000 | `fbo:1600x1063` | **99.7%** | **90.1%** | 125.8 | 0.15 | `T0.1F0.3G0.0E17.2RA17.2N220000…EL15.9SMP2` |
| **Flux 臂** | truck / 273169 | `fbo:1600x1063` | **100.0%** | **0.0%** | 344.8 | 5.75 | `T0.5F11.5G0.0E12.5RA12.4N273169…EL5.8SMP2` |

Flux 侧另有三条旁证：
1. 探针读的尺寸 **`RD1600x1063` == `offscreen_target=fbo:1600x1063`** ⇒ **读的就是那块目标，尺寸没错**；
2. `covered=100%`（alpha 处处 >0）而 `ink=0%`（RGB 处处 ≤8）⇒ 目标是 `(0,0,0,α>0)`，**"被 clear 过、但没有可见几何写上去"**；
3. 桌面**有 GPU 计时器**（`ext=1`，手机没有），shader 编译正常、排序执行过、纹理上传成功。

⇒ 结论：**不是移动端读回的毛病，也不是尺寸/目标绑错**；桌面同样复现 ⇒ **渲染侧现象**。
（同时，本检查让两臂首次有了**同一个可比指标**：本文臂 90.1% vs Flux 0.0%。）

## 4. 根因已定案 + 一字修复 + 验证（2026-10-10 闭合）

**你的"第 0 步"假设（数据没加载完就开始测）已排除：**
- `bench-flux.ts:1354 await waitFirstFrame(cw, 180000)` 轮询到 `__FLUXGS_STATS__.firstFrameAt > 0`；
- `main.js:2464` **只在 `if (vertexCount > 0)` 的绘制分支里**才设 `firstFrameAt` ⇒ 等到它 = 等到"解码 + 纹理上传 + 至少一次真实绘制"；
- 记录算术吻合：`decode_ms=15212` → `tex_ms=12` → `first_frame_ms=15242`；探针再证 `NVP/NVPL=273169`（绘制确已执行）。

### 4.1 真因：**我们 harness 自己的 `clearColor` 状态泄漏**

`bench-flux.ts:1108-1120`（测量前把**画布**清黑，做"离屏已生效"的视觉消歧）里：

```js
gl0.bindFramebuffer(gl0.FRAMEBUFFER, null);
gl0.clearColor(0, 0, 0, 1);      // ← 全局 GL 状态，改完没有再恢复
gl0.clear(gl0.COLOR_BUFFER_BIT);
gl0.flush();
```

`clearColor` 是**全局**状态；而 Flux 的 `frame()` 绘制前只 `gl.clear(COLOR_BUFFER_BIT)`、**从不设置 `clearColor`**（`main.js` 里没有任何 `clearColor` 调用）。于是：

1. 驱动 `target.bind()` → 调 `frame()`；
2. Flux 的清屏把我们那块离屏 FBO 清成 **`(0,0,0,1)`** ⇒ **dst alpha = 1**；
3. Flux 的前到后混合 `blendFuncSeparate(ONE_MINUS_DST_ALPHA, ONE, ONE_MINUS_DST_ALPHA, ONE)` 的
   **src 因子 `1 − dstA` = 0** ⇒ **绘制颜色贡献恒为 0**；
4. ⇒ 画面 = 清屏色 = **RGB 全 0、alpha 255** ⇒ "纯黑"。

**本文臂不受影响**：它**每帧自己** `clearColor(0,0,0,0); clear(...)`（`RenderProgram.ts:2859-2860`），把这个被污染的状态覆盖掉了。

### 4.2 修复与验证（一行）

修复：黑屏消歧之后**立刻恢复** `gl0.clearColor(0, 0, 0, 0)`（`bench-flux.ts`，已落地；`?preclear=1` 保留为可选诊断，默认关）。

| 验证 | `ink_pct` | `ink_last_pct` | `alphaMean` | framedump b64 | 解码后画面 |
|---|---|---|---|---|---|
| 修复前（泄漏状态） | 0.0% | 0.0% | 255.0 | **49,464**（常量黑图） | 均值 0.000 / ink 0.00% |
| 加 `?preclear=1`（判别实验） | 99.3% | 99.3% | 231.1 | — | — |
| **只恢复 clearColor（不带 preclear）** | **99.3%** | **99.3%** | **231.1** | **5,133,224** | **均值 111.06 / 标准差 57.66 / ink 99.04%** |

对比本文臂同场景同机位（truck, 1600×1063）：**均值 116.69 / 标准差 58.22 / ink 99.42%** ⇒ **两臂画面量级一致、可比**。

### 4.3 真机复核（2026-10-10 11:13/11:14，Gen2 PGEM10）

修复后**真机**成对取帧（`side2-1-ours` / `side2-2-flux`，`profile=truck`，
`res=1600x1063&frames=2&rounds=1&framedump=1&benchmode=offscreen-paper-match&runs=1&sync=batch`，
`cam=flux&proto=flux`，**刻意不带 `validateframe=1`**）：

| | ours | flux |
|---|---|---|
| `ink_pct` / `ink_last_pct` | **99.6%** / — | **99.31%** / 99.4% |
| `covered` | 100.0% | 100.0% |
| points | 273169 | 273169 |
| framedump b64 | 4,949,120 | **5,132,136** |
| 解码后 均值 / 标准差 / ink | 116.694 / 58.222 / **99.42%** | 111.344 / 57.687 / **99.07%** |
| `offscreen_fps`（排空主导，**非效率结论**） | 37.0 | 46.8 |
| `frame_ms`（帧内；两臂口径不同源） | 1.05 | 41.75 |
| lab | `F2.1 E58.2 RA57.8 EL54.1` | `F83.5 E7.3 RA7.1` |

**与桌面同协议结果交叉验证（两臂同场景 truck）**：

| | ours 手机 | ours 桌面 | flux 手机 | flux 桌面 |
|---|---|---|---|---|
| 均值 | 116.694 | 116.440 | 111.344 | 111.062 |
| ink | 99.42% | 99.37% | 99.07% | 99.04% |
| 跨臂 `PSNR` / `SSIM` | **16.27 dB / 0.5037** | **16.26 dB / 0.5029** | — | — |
| 掩码 共同/仅ours/仅flux | 98.6% / 0.9% / 0.5% | 98.5% / 0.9% / 0.5% | — | — |

⇒ 手机（Adreno 740）与桌面（RTX 4060/ANGLE）**统计上几乎重合**，说明两臂都渲染正确、抓帧链路无设备相关偏差；
且本文臂手机帧与 17:27 那轮**字节完全相同**（b64 均为 4,949,120）⇒ 帧可复现。
**产物**：`_tmp_ch7probe/out/side2_phone_truck_ours_vs_flux.png`（真机）、`…/side2_truck_ours_vs_flux.png`（桌面）。


### 4.4 结论与影响

- **不是**数据未加载、**不是**空帧、**不是**脏标记、**不是**读取/尺寸问题、**也不是**"Flux 画到别处"；
  而是 **harness 的 GL 状态泄漏把 Flux 的混合因子压成 0**。
- **历史上所有 Flux 离屏记录都是在"无可见输出"的状态下取的** ⇒ **必须重跑**（绘制工作量本身没变，但输出状态与 `EL` 都不同，数字不可混用）。
- **跨臂 fps 对照与跨臂图像对比恢复**：现在两条腿都通了（画面有效、抓帧有效）。



## 5. 配置差异核查（用代码位置作证）

| 维度 | 本文臂 | Flux 臂 | 判定 |
|---|---|---|---|
| **混合** | `blendFuncSeparate(ONE_MINUS_DST_ALPHA, ONE, …)`（前到后）`RenderProgram.ts:856` | `blendFuncSeparate(ONE_MINUS_DST_ALPHA, ONE, ONE_MINUS_DST_ALPHA, ONE)` + `FUNC_ADD` `main.js:1795-1801` | ✅ **两臂同一套混合公式** |
| **深度** | `gl.disable(DEPTH_TEST)`；离屏 FBO **不建深度附件**（`OffscreenBenchTarget.ts:401`） | `gl.disable(gl.DEPTH_TEST)` `main.js:1793` | ✅ 都关深度、都无 early-z |
| **SH 阶数** | 默认 **3 阶 45 系数**（`shdeg` 可配） | **只到 1 阶**：片元着色器到 `// Degree 1` 结束（`main.js:1263-1267`），12-系数 texelFetch 段**整段注释掉**（`main.js:1272+`） | ⚠️ **每 splat 着色量不同（我们更多）** —— 这是"工作量不等价"的主要来源 |
| **裁剪** | 有 CPU 侧裁剪统计 `cullStats.keptRatio`（报告为 `kept=`） | 无 CPU 裁剪，`vertexCount` 恒定（= 点数，随视角不变） | ⚠️ 不等价（但两臂都提交全量点数，`kept=` 可用来核对本文臂裁掉多少） |
| **每帧 GPU 完成** | 在屏：逐帧 `gl.finish()`；**离屏**：`NonBlockingFrameGate`（`batch` ⇒ run 末排空） | 在屏：逐帧 `gl.finish()`；离屏：调 `__FLUXGS_BENCH_FRAME_OFFSCREEN__`（**不做 `gl.finish()`**），同一套 gate | ⚠️ 离屏口径下**两臂都不逐帧等 GPU 完成**；完成性只在 **run 末排空**里体现 |
| 计时自洽性 | `EL22.3 ≈ E24.4 ≈ RA24.2`（首轮） | **`EL12.6 < F43.9`**（首轮）—— 协议数来源(EL)小于它自己的帧内累计 | ⚠️ **Flux 臂的窗口与它自己的帧内计时不自洽** ⇒ "是否覆盖 GPU 完成"**无法证实为两臂同一口径**，须专门核对 |

## 6. 对既有结论的影响（与 `ch7_fairness_framework_20261010.md` 一致）

- **内部消融（A/B/C，单变量、同会话、同记录）**：可**有条件保留** —— 依据是同记录 3 轮散布 ×1.00–1.02；
  但仍须报告多轮极差，且**不得**把区间重叠的差异当结论。
- **跨臂倍数**：**只作为"当前配置下的观测结果"**（本机、本协议、本资产、本 SH 阶数），
  **不解释成"实现效率倍数"**；单轮的（如今天 `sideflux` 的 1.77×）应标注不可判。
- **图像级 ours-vs-Flux**：在 §4 未判定前**不出图**；若 `ink_last_pct == 0`，直接放弃该对比。
