# 第 7 章 · 跨臂 GL 状态污染**系统性审计**（2026-10-10）

> 起因：本次"Flux 离屏纯黑"的根因只是**一行 `clearColor` 泄漏**。但那类 bug 的本质是
> **共享上下文 + 未在每个渲染入口显式重置状态**；而多数污染**不像纯黑那样显眼**
> （blend 因子、colorMask、scissor、viewport 都是"画面看着还行、数值已被改"的类型）。
> 本文把**所有相关状态逐项**过一遍，并加一条**结果自证**机制，让未来的隐性污染无法藏。

## 1. 架构事实（先确定"污染面"在哪）

| 事实 | 结论 |
|---|---|
| 两臂各自在**自己的 iframe** 里创建 WebGL2 上下文（本文臂 `bench-case.html`，Flux 臂其官方页） | **跨臂不会在 GL 层直接互相污染**；风险来自 ①**驱动页**在同一上下文里改状态；②**同一臂内部**多个 pass/程序之间 |
| 驱动页（`bench-*.ts`）在**臂的上下文**上做事：建离屏 FBO、`bindFramebuffer`、画布清黑、可选的 1×1 readPixels 探针 | 驱动**必须**只改自己声明的东西、并**恢复**其他状态 |
| 本文臂：单 pass + 多个子 pass（TF / SH 缓存 / prep / 颜色缓存） | 子 pass 之间必须**显式设置 + 保存恢复** |

## 2. 状态矩阵（逐项 × 每臂 × 驱动）

| 状态 | 本文臂渲染器 | Flux 臂渲染器 | 驱动页 | 判定 / 处置 |
|---|---|---|---|---|
| `viewport` | **每帧显式** `viewport(0,0,cw,ch)`（`RenderProgram.ts:2858`）；各子 pass 自己设并恢复（3122/3141/3148/3258） | 仅在 `resize()` 设一次 | 不改 | ✅（Flux 依赖"无人改 viewport"⇒ 驱动侧约定见 §4） |
| `clearColor` | **每帧显式 `(0,0,0,0)`**（2859） | **从不设置** ⇒ 完全依赖继承 | **曾泄漏 `(0,0,0,1)` 不恢复** | ❌→✅ **L1**（Flux 侧，已修）+ **L2**（本文臂画布清黑，本次修） |
| `clear(COLOR)` | 每帧 clear ✓ | 每帧 clear ✓ | 画布清黑一次（自己 bind `null`） | ✅ |
| `DEPTH_TEST` | 每帧 `disable` ✓（2867） | init 时 disable 一次 | 不改 | ✅ |
| `BLEND` / `blendFuncSeparate` / `blendEquationSeparate` | **每帧显式**（2871–2873，`ONE_MINUS_DST_ALPHA/ONE` + `FUNC_ADD`） | 仅 init 设一次 | 不改 | ✅（两臂公式相同 ⇒ 也是论文的"公平项"） |
| **`SCISSOR_TEST`** | **从未显式关闭** | 从未设置 | 不改 | ⚠️→✅ **R4**：本次每帧显式 `disable`（若被开启会**静默裁掉画面**） |
| **`colorMask`** | 未设置（依赖默认全开） | 未设置 | 不改 | ⚠️→✅ **R5**：本次每帧显式 `colorMask(true×4)`（若被禁用 = "画了但没写"，**最阴的一类**） |
| `depthMask` | 未设置 | 未设置 | 不改 | ⚠️→✅ 本次显式 `true`（无深度附件，仅去掉隐式依赖） |
| `drawBuffers` | 仅 prep FBO 设（3125/3130） | 未设 | 不改 | ✅（WebGL2 里 drawBuffers 属 **FBO 状态** ⇒ 不跨 FBO 泄漏） |
| `RASTERIZER_DISCARD` | TF pass `enable`→`disable` 配对（3328/3354） | — | — | ✅（异常中断会漏，代价是整帧失败，可接受） |
| `CURRENT_PROGRAM` / `TEXTURE_BINDING_2D` / `ARRAY_BUFFER` / VAO | 每帧 `useProgram` + 逐帧 `bindTexture` ✓ | 帧内 `bindTexture(TEX0/1)` ✓（program 仅 init） | **注入实验路径** `?injmb=` 里 `useProgram(injProg)` + attrib 设置**不恢复** | ⚠️ **L3**：仅实验路径，已在代码注释与本文记录，不属主路径 |
| `FRAMEBUFFER_BINDING` | 子 pass 保存/恢复 `savedFbo`/`prevFbo`/`prevFbo2` ✓ | 依赖驱动绑定 ✓ | 逐帧 `target.bind()`…`unbind()` 包住"恰好一帧" ✓ | ✅ |
| `pixelStorei`（`UNPACK_*`/`PACK_ALIGNMENT`） | 未设置（依赖默认：不翻转、对齐 4） | 未设置 | 不改 | ⚠️ 低风险（当前均为 RGBA8/32UI、无 sub-rect 上传）；列入"新臂/新 pass 检查表" |

## 3. 结果自证：`GLS[…]` 指纹（本次新增）

只靠"人会去看代码"不够 ⇒ 把**每轮实际生效的状态**写进结果行，让污染**自己暴露**：

- 实现：`bench-offscreen.ts` 的 `glStateFingerprint(gl)`（只读 `getParameter`/`isEnabled`，无副作用）。
- 落点：**两臂**的 `offscreen_note` 末尾追加 `GLS[….]`（本文臂在 `bench-measure.ts` 的 lab 段；Flux 臂在驱动逐帧钩子里取一次）。
- 指纹含：`vp`（viewport）、`sc`（scissor 开关+框）、`cm`（colorMask 四位）、`dt/dm`（深度测试/写掩码）、
  `bl(src,dst,eq)`、`cf`（cull）、`fbo`、`tex2`。

**期望值（两臂都应是，真机已实测本文臂）**：`vp=0,0,1600x1063`、`sc=0`、`cm=1111`、`dt=0/dm=1`、
`bl=1(773,1,eq32774)`（`773=ONE_MINUS_DST_ALPHA`、`1=ONE`、`eq32774=FUNC_ADD`）、`cf=0`。
**注**：`fbo=` 与 `tex2=` 是**探针时刻（帧之后）**读到的绑定——`fbo=0` 表示驱动已在帧末解绑（**正常**）、
`tex2=1` 表示仍有纹理绑定（Flux 侧正常）；这两项只作参考，不作判据。
**读法**：只要 `sc/cm/dt/bl/cf/vp` 与期望不符 ⇒ 该轮的状态环境已被污染，**该轮数据作废**
（与 `ink_pct`、`cpu_ms` 同级闸门）。
**实测样例**（本文臂桌面，`raw/outchk6_20261011_132731.txt`）：
`GLS[vp=0,0,1600x1063 sc=0[0,0,300x150] cm=1111 dt=0/dm=1 bl=1(773,1,eq32774) cf=0 fbo=0 tex2=1]` ✓

## 4. 不留隐式依赖的三条规则（写进 checklist）

1. **每个渲染入口（每帧/每 pass）都要显式声明它依赖的全部状态**，不得依赖"上一步设过了"：
   至少覆盖 `viewport / scissor / colorMask / depthMask / DEPTH_TEST / BLEND(+func,eq) / cull / 清屏色`。
2. **驱动页只改自己声明的东西，并且改完就恢复**（本次 L1/L2 的教训：`clearColor` 改完必须回 `(0,0,0,0)`）。
   驱动**不得**触碰 `viewport / scissor / colorMask / blend / depth`（手臂自己管）。
3. **新增能力（新 pass、新臂、新钩子）必须过检查表**：① 上表逐项确认显式设置；② 本轮结果里的 `GLS[…]`
   与期望值一致；③ 若确需改状态，先保存再恢复，并在注释里写明"为什么必须改"。

## 5. 验收（下次真机跑完即可核对）

- 两臂结果行都出现 `GLS[...]`，且 `sc=0 cm=1111 dt=0 bl=1(770,1,eq32774) cf=0`；
- 本文臂与 Flux 臂的 `vp=` 应分别为 `0,0,1600x1063`（离屏 FBO 的全幅 viewport）；
- 任一不符 ⇒ 先查 §4 的三条规则，再决定该轮是否作废。
