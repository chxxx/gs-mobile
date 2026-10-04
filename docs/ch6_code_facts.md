# 第 6 章 · 代码事实核对（T11，只读产出；每条带 `文件:行号`）

> 生成：2026-10-03。口径：**FINAL = `shcache=frag` + `lr=1` + `notx=1` + `nocolortx=1`**。
> 凡本次未能实测/未逐行确认的，一律标 **〔待核〕/〔待测〕**，不写推测值。

## 1. FINAL 每帧 pass 顺序（`src/renderers/webgl/programs/RenderProgram.ts`）

| 序号 | pass | shader 类型 | 输入 | 输出（格式 × 尺寸） | 位置 |
|---|---|---|---|---|---|
| 0 | 臂自证 `publishEffectiveArm()` | — | 编译期常量 + 运行期自证 | `arm=` 字符串 | `~:2497` |
| 1 | 数据/纹理上传（按需） | — | CPU 数据 | splat 纹理 RGBA32UI、SH 纹理、变换/颜色变换纹理 | `:2518-2610`（splat `:2516`、SH packed `:2407`、SH f16 `:2442`） |
| 2 | **颜色生产遍（方案 B）** | **片元**（全屏三角形） | splat 纹理、SH 纹理、变换纹理/lr UBO | **颜色纹理 RGBA16F，2048 × ⌈N/2048⌉** | `:2672-2712`（`texImage2D RGBA16F` `:2712`） |
| 3 | **主 pass** | **顶点 + 片元**（实例化 `TRIANGLE_FAN`，每 splat **4 顶点**） | 颜色纹理（FINAL）/ 或 SH 纹理；cen/cov | 屏幕（默认 framebuffer） | 顶点 `:1090-1245`；片元 `:1411-1444` |

* FINAL 下 pass 2 **每帧都执行**（无 `shfreeze` ⇒ `produceNow` 恒真，`:2718` 附近）；pass 3 的顶点侧直接 `texelFetch(u_colorTex, ivec2(index % u_colorTexWidth, index / u_colorTexWidth), 0)` 取该 splat 颜色（`:1225`）。

## 2. SH 求值在哪个 pass / 主 pass 顶点还做什么

* **三阶 SH 求值发生在 pass 2 的片元着色器**（`evalSHRGB`，`:714`；`lr=1` 时替换为低秩块 `LR_SH_BLOCK`，同为 pass 2）。
* 主 pass 顶点着色器仍做：`cen/cov` 取样（`:1198`）、`NO_SPLAT_TRANSFORM` 下用 uniform M 或用变换纹理（`:1165-1183`）、投影（`pos2d`）、EWA 2D 协方差（`:1202-1216`）、半轴（`:1220-1221`）、深度衰减 `scalingFactor`（`:1236-1245`）、`gl_Position`；**每 splat 4 个顶点**（`gl.TRIANGLE_FAN, 0, 4` ✓ 实例化）。

## 3. `lr=1` 的数据流

| 项 | 事实 | 位置 |
|---|---|---|
| 加载期（worker） | 只**反量化 r 个 rank 系数**并打包（`wantLowRank=true`），**跳过 CPU 侧的 `Ĉ·B` 重建** | `src/loaders/LowRankQPLYWorker.ts:9,30` |
| 每点打包字节数 | **〔待核〕**（打包进 `lrRank`，纹理格式见下） | 同上 |
| rank 纹理 | `RGBA32UI`（`texImage2D ... gl.RGBA32UI`） | `RenderProgram.ts:2854`（prep 臂）/ `:3018`（lr 臂） |
| 共享基 W | **UBO** `uniform LrBasisBlock { vec4 u_lrB[LR_UBO_VEC4]; }`，`LR_UBO_VEC4 = 79` 个 vec4 = **1,264 B** | `:485`、常量 `:317-320`/`:339`、绑定 `LR_BASIS_BINDING` |
| 秩 r / 分组 | `LR_RANK_MAX = 7`、`LR_REST = 45`（=15 rest × 3 通道）；**单块共享基，无分组** | `:317-320`、`:477-487`、循环 `:503-527` |

## 4. 颜色缓存纹理 + 是否有跨帧复用

* 格式 **RGBA16F**、尺寸 **2048 × ⌈N/2048⌉**（`:2695-2712`；`w=2048` 硬编码 `:2697`）。
* 每帧写入字节数 = **N × 8 B**（RGBA16F = 4 half = 8 B/texel，1 texel/splat）⇒ garden 610k ⇒ **4.88 MB/帧**。
* 缺省**无跨帧复用**：`produceNow = !this._shCacheFrozen || this._shCacheProduceCount++ < SHFREEZE_FRAMES`（`:2718` 附近）；只有显式 `?shfreeze=N` 才冻结（该臂名称含 `frozen`，仅上限参照）。

## 5. notx / nocolortx 的门控方式；garden 下 transform 是否单位阵

* 门控是**编译期 `#define`**：`NO_SPLAT_TRANSFORM`（notx）、`NO_COLOR_TRANSFORM`（nocolortx），只在与运行期自证一致时注入（`:338-339`、`:3417-3418`；自证 `_notxRuntimeOk`）。
* garden 的 transform 是否为**单位阵**：**〔待测〕**（需打印 `u_splatTransform` 的 16 个分量判定；本次未测，不写推测）。

## 6. 缺省路径 vs FINAL 的开关差异 / QPLY 格式是否改动

| 路径 | 编译期开关 | 颜色来源 | 变换/颜色变换 |
|---|---|---|---|
| 缺省 | 无 `#define` | 顶点侧三阶 SH 求值 | 逐点取样纹理 |
| FINAL | `SHPASS_PRE + SHCACHE_FRAG`（`:3407-3408`）、`LR_RANK_MAX/LR_REST/LR_UBO_VEC4`（`:339`）、`NO_SPLAT_TRANSFORM`、`NO_COLOR_TRANSFORM` | pass 2 片元 pass 写颜色纹理，主 pass 只读 | uniform M（notx）/ 恒等（nocolortx） |

* **QPLY 文件格式在 FINAL 下无任何改动**：同一条 URL 参数既决定加载期 `wantLowRank`（`LowRankQPLYWorker.ts:9,30`）又决定渲染期编译开关；文件本身不变 ⇒ 同一份 `scenes/point_cloud_quantised_half_r7-*.ply` 可直接对拍。

## 7. 显存与体积

| 项 | 值 | 依据 |
|---|---|---|
| SH packed（缺省） | **96 B/点** ⇒ garden 610k = **58.6 MB** | 注释 `:2420`（每点 4 texel × 16 B RGBA32UI = 64 B）+ 主 pass 另 2 texel（cen+cov）= 32 B ⇒ 合计 96 B/点〔待核：以实测为准〕 |
| SH f16（`?shfmt=f16`） | **32 B/点** ⇒ **19.5 MB** | 注释 `:2420`（RGBA16F 4096 宽 × 4 half/texel = 8 B，每点 4 texel） |
| 颜色缓存（FINAL） | **8 B/点** ⇒ garden 4.88 MB | §4 |
| 总纹理显存 FINAL vs BASE | **〔待测〕**（需在页面侧读 `perf`/WebGL 统计；本轮未接） | — |
| QPLY 实际体积（garden） | **14,648,586 B = 13.97 MiB** | `dir scenes\point_cloud_quantised_half_r7-garden.ply` |

⚠ **口径冲突（重要）**：论文 6.2 写 garden「36.08 MB」——实测 **std45 文件 = 37,834,087 B = 36.08 MiB**，而 FINAL 使用的 **r7 文件 = 13.97 MiB**。两者不是同一件东西，需在 T9 冲突清单里改口径。

## 8. 加载流程耗时拆分

* 记录里已有：`fetch_ms`（下载）/ `parse_ms`（解析）/ `first_frame_ms`（含上传与首帧）分列；`bytes` 为页面自报字节数。
* FINAL 与缺省路径的**同会话配对**需要 `?lrload=0|1`（已获批，属 T5 工具层改动，不动默认加载路径）。

## 9. 与第 6 章原文的逐句比对

**待你提供 6.1 / 6.3 / 6.4 / 6.7 原文**后逐句标注「一致 / 冲突 / 需改」并附事实依据（本文件 §1–§8 即依据）。
