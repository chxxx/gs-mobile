# 阶段 2 · O1：去掉 transform / colorTransform 的逐点取样（+ 瓶颈诊断）

> 生成：2026-10-01。约束遵循：零回归（URL 开关 + 编译期 `#define` 门控、缺省关闭、缺省着色器预处理后逐字不变）、
> `arm=` 由**实际生效**参数生成、三阶 SH 完整保留（`shdeg` 仅诊断、不进任何优化臂）、主表禁用跨帧复用（`shfreeze` 只在 `*frozen` 上限参照臂）。

## 0. 第 0 步（只读核查）结论

### 0.1 garden 的 transform 实际取值

| 项 | 值 | 证据 |
|---|---|---|
| 对象数 | **1**（单 splat） | `RenderData` 构造：`_transformsWidth=5; _transformsHeight=lookup.size`；garden 只加载一个 Splat |
| 每对象纹素 | **5**：0..3 = mat4，4 = `selected` 标志 | `RenderData.ts:110-118`（`_transforms.set(splat.transform.buffer, idx*20)`、`[idx*20+16]=selected?1:0`）；着色器 `texelFetch(u_transforms, ivec2(4, transformIndex), 0).x` |
| 矩阵取值 | **单位阵** | `Object3D._transform = Matrix4.Compose(position=0, rotation=identity, scale=1)`（`Object3D.ts:48`）；加载器/bench **都不设置** position/rotation/scale（全仓无写入者） |
| 含旋转/非均匀缩放？ | **否** | 同上 |
| `_transformIndices` | **全 0** | 单对象 ⇒ `_transformIndices[offset+i] = splatIndex = 0`（`RenderData.ts:261`） |
| 触发写入 | 每个 Splat 在 `buildImmediate` 里必写一次 | `RenderData.ts:211` ⇒ 不是零初始化残留，而是真的单位阵 |

### 0.2 colorTransform 是否启用

| 项 | 值 | 证据 |
|---|---|---|
| 是否存在颜色变换 | **无**（`_colorTransforms` 数组为空） | `Splat._colorTransforms: Array<Matrix4> = []`，全仓无写入者 |
| 实际内容 | **块 0 = 单位阵** | `RenderData.ts:91-95`：`fill(0)` 后显式置 `[0],[5],[10],[15]=1` |
| 索引 | **全 0** | `colorTransformIndices.fill(0)`（`RenderData.ts:102`） |
| 运行期开关 | `u_colorTransformEnabled = 1`（缺省） | `gl.uniform1i(u_colorTransformEnabled, this._noctRequested ? 0 : 1)` |
| ⇒ 结论 | **每点在"乘以单位阵"上付 5 次取样**（1×index + 4×mat4） | `noct=1` 诊断臂早前已验证"跳过它画面不变" |

### 0.3 全部 sampler 与逐点/逐顶点取样次数（逐行）

**A. 主 pass 顶点着色器（默认路径）**

| 行 | sampler | 取什么 | 次数/顶点 |
|---|---|---|---|
| 962 | `u_texture` | `cen`（位置 + selection 字节） | 1 |
| 973-983 | `u_transformIndices` | transformIndex | 1 |
| 974-980 | `u_transforms` | mat4（4 纹素） | 4 |
| 981-983 | `u_transforms` | 第 5 纹素（selected，`if (selected<0.5)` 才执行） | 0~1 |
| 988 | `u_texture` | `cov`（协方差 + DC 字节 + alpha） | 1 |
| 1067-1085 | `u_colorTransformIndices`+`u_colorTransforms` | 1 + 4 | 5 |
| `evalSHRGB` | `u_sh_r/g/b` | 3×2 纹素 | 6 |
| **合计** | | | **18~19** |

**B. 主 pass（`shcache=frag` 消费遍：`SHPASS_PRE`+`SHCACHE_FRAG`）**

`u_texture`×2 + `u_transformIndices`×1 + `u_transforms`×4(+0~1) + **`u_colorTex`×1** = **8~9**
（**不取 SH、不做 colorTransform**，相应声明已整段排除）。

**C. 生产遍片元着色器（方案 B 第一遍）**

| 行 | sampler | 次数/点 |
|---|---|---|
| 408 | `u_texture`（cen） | 1 |
| 409 | `u_transformIndices` | 1 |
| 448-454 | `u_transforms` | 4 |
| 410 | `u_texture`（cov） | 1 |
| `evalSHRGB`（packed） | `u_sh_r/g/b` | 6 |
| 462-472 | `u_colorTransform*` | 5 |
| `lr=1` | `u_lrRank` | 2（rank+DC） |
| **合计** | | frag **18** / lr **14** |

### 0.4 单 splat 取样账（生产遍 + 主 pass×1）

| 臂 | 生产遍 | 主 pass | 每 splat/帧 | 相对 frag |
|---|---|---|---|---|
| `frag` | 18 | 8~9 | **26~27** | — |
| `frag+notx` | 13 | 3 | **16** | −10 |
| `frag+nocolortx` | 13 | 8~9 | **21~22** | −5 |
| `frag+notx+nocolortx` | **8** | **3** | **11** | −15 |
| `lr` | 14 | 8~9 | **22~23** | −4 |
| `lr+notx+nocolortx` | **4** | **3** | **7** | −19 |
| `lr-frozen+notx+nocolortx` | 4（≤N 帧）→ 0 | 3 | **3**（稳态） | −23 |
| **Flux-GS（对照）** | — | — | **5** | −21 |

⇒ `lr+notx+nocolortx`（7 次）与 Flux（5 次）同量级；`*frozen`（3 次）已低于 Flux。



## 1. 实现（`?notx=1` / `?nocolortx=1`）

| 开关 | 编译期门控 | 行为 |
|---|---|---|
| `?notx=1` | `#define NO_SPLAT_TRANSFORM` | 不再声明/取样 `u_transforms`、`u_transformIndices`；改用 `uniform mat4 u_splatTransform` + `uniform float u_splatSelected`（值取自 `RenderData.transforms` 的对象 0）。**仅单对象场景**（`transformsHeight === 1`）运行期自证通过才生效；否则 `arm=…+notx-rejected` + `console.error`（该轮作废）。单对象 + 单位阵 ⇒ 与逐点取样**逐位等价**（IEEE754 下 `I·x` 精确）。 |
| `?notx=bake` | 同上（预留） | 加载期把 M 烘焙进位置/协方差。**本轮未实现** ⇒ 按 `notx=1` 处理并 `console.warn` 自证；`sw=` 回显 `notx=bake->uniform`。 |
| `?nocolortx=1` | `#define NO_COLOR_TRANSFORM` | `u_colorTransforms`/`u_colorTransformIndices` 的**声明与分支一起删**（FS 侧对切片做行级剔除；VS 侧 `#ifndef` 包住声明、两处分支与 `vColor` 三目）。恒等变换 ⇒ 输出逐位不变。 |

适用范围：**主 pass（含 `SHPASS_PRE`/`SHCACHE_FRAG` 两种变体）× 生产遍（FRAG/LR）× TF 第一遍**（三者共用同一份顶点模板 ⇒ 判据与实现同源）。

零回归：两个 `#define` 只在请求时注入（`_getVertexSource()` / `buildTransformFeedbackVertexSource()` / `buildShCacheFragmentSourceForArm()`），
缺省不注入 ⇒ **预处理后源码逐字不变**。

`arm=` 后缀：`base/frag/frozen/tf_*` + `+notx` / `+notx-rejected` / `+nocolortx`；`sw=` 回显 `notx=`、`nocolortx=`（实际生效值）。

## 2. 待测协议（需要真机执行）

**主测（Gen3/Adreno750 微信 XWEB 为主，Gen2/Adreno740 Chrome 复测）**：同会话背靠背交替、`rounds=3`、`runs=5`、`warmup=20`、`frames=20`。

| # | 臂 | URL 追加 |
|---|---|---|
| 1 | `frag` | `&shcache=frag` |
| 2 | `frag+notx` | `&shcache=frag&notx=1` |
| 3 | `frag+nocolortx` | `&shcache=frag&nocolortx=1` |
| 4 | `frag+notx+nocolortx` | `&shcache=frag&notx=1&nocolortx=1` |
| 5 | `lr` | `&shcache=frag&lr=1` |
| 6 | `lr+notx+nocolortx` | `&shcache=frag&lr=1&notx=1&nocolortx=1` |
| 7 | `lr-frozen+notx+nocolortx`（上限参照，名称已标 frozen） | `&shcache=frag&lr=1&notx=1&nocolortx=1&shfreeze=2` |

**诊断臂（用已有开关，不需改代码）**：在 `lr` 与 `lr+notx+nocolortx` 下各跑 `resscale=1|0.5`、`drawfrac=1|0.5`（8 条）。

**判据（O1 规格）**
- `resscale=0.5` 帧率提升 **<10% ⇒ 顶点受限**；**>30% ⇒ 片元受限**（10–30% 记为混合）；
- 单 splat 时间 = `frame_ms / 点数`（ns/splat），与 Flux 的 **8.67 ms / 739431 = 11.7 ns** 对照；
- 正确性闸门：`notx+nocolortx` 对 BASE **逐位一致或 PSNR ≥ 60 dB 且无 >8 级像素**（预计逐位一致）。

## 3. 报告模板（阶段结束时填）

- **三行结论**：① `frag+notx+nocolortx` 相对 `frag` 的 `frame_ms` 增量；② `lr+notx+nocolortx` 相对 `lr` 的增量、是否追平 Flux 的 ns/splat；③ 诊断臂判定"顶点受限/片元受限"。
- **数据表**：七条主臂 `fps / frame_ms / cpu_ms / covered / arm / sw`（按 `arm=` 分组）+ 八条诊断臂。
- **机制解释**：取样账变化（26~27→11、22~23→7）与 ns/splat 是否同步下降；若取样减少而帧时间不动 ⇒ 瓶颈不在取样侧。
- **下一步建议**：由诊断结论决定 O2 方向（顶点/取样侧 vs 片元/混合侧）。

## 4. 桌面自证（本机）

- `npx tsc --noEmit` = **0 错**；`npx vitest run` 绿。
- 零回归 + 新开关冒烟：`tools/ch7_desktop_shader_verify.ps1`（base/frag/fragfrz）+ 直接 Chrome 跑
  `frag&notx=1&nocolortx=1`、`frag&notx=1`、`frag&nocolortx=1`、`lr&notx=1&nocolortx=1`；
  判据：`ERROR:` 0、`GL_INVALID_OPERATION` 0、`Mismatch` 0、`[result] ok=1`。
