# 阶段 2 · O2 方案（O1 已过关，下一步）

> 生成：2026-10-02。上游：`docs/ch7_stage2_o1_report.md`（真机结果）+ `docs/ch7_stage2_o1_gate.md`（闸门 PASS）。

## 0. 现状（决定 O2 方向的三条证据）

1. **O1 只兑现了"顶点/取样侧"那一半**：删 transform 取样（10 次/点）→ Gen2 **−14.4%**；再删 colorTransform 取样（5 次/点，仅生产遍）→ **0 收益**。
   ⇒ 片元生产遍**不是**瓶颈；主 pass（每 splat 一次顶点）侧才有空间。
2. **上限参照**：`lr-frozen+notx+nocolortx` = **10.68 ms**（`frag+notx` 13.85 ms）⇒ "不每帧生产颜色"还有 **−23%** 空间（有损、需误差界）。
3. **与 Flux 的差距**：我们最优可交付 `frag+notx` = **22.7 ns/splat**，Flux = **10.6 ns/splat**（Gen2/同会话）。
   Flux 的每顶点 SH 只用 `uniform vec3 camPos`（`main.js:1233`），而我们**每点/每顶点都算一次 `inverse(view)`**。

## 1. O2-A（首选，零风险，先做）：`cameraPosition` 走 uniform

**问题**：主 pass 顶点着色器（`RenderProgram.ts` 的 `vec3 cameraPosition = inverse(view)[3].xyz;`，位于 `if (degree > 0u || …)` 内）
与**生产遍片元着色器**（同一行，每点执行）都在算 **4×4 矩阵求逆**，而结果永远是"相机世界位置"这一个常量。

**做法**：`?camu=1` ⇒ 编译期 `#define CAM_POS_UNIFORM`，改用 `uniform vec3 u_camPos`；
值在 TS 侧每帧写（`camera.data.position`，或直接取 `inverse(view)[3]`），**两者互为等价**。
缺省不注入 ⇒ 缺省着色器（预处理后）逐字不变 ⇒ 零回归面。

**预期**：去掉每点一次 `inverse`（生产遍 610k 次/帧 + 主 pass 610k 次/帧）；4×4 求逆 ≈ 数十条浮点指令。
判断是否被驱动 hoist：与 Flux 对齐后，若 ns/splat 明显下降 ⇒ 之前确实没被 hoist。

**自证与验证**：① `arm=` 增加 `+camu` 后缀、`sw=` 回显 `camu=`；② 颜色闸门按 O1 同一套跑（预期 **逐位一致**——两表达式在 IEEE754 下同值）；
③ 真机背靠背 `frag+notx` vs `frag+notx+camu`。

## 2. O2-B（诊断臂，决定后续方向）：`resscale` / `drawfrac`

在 `frag+notx` 与 `lr+notx+nocolortx` 下各跑 `resscale=1|0.5`、`drawfrac=1|0.5`（8 条，不改代码）。
判据：`resscale=0.5` 帧率提升 **<10% ⇒ 顶点受限**；**>30% ⇒ 片元受限**。
（注意：方案 B 的生产遍成本**与目标分辨率无关**（固定 610k 片元）⇒ 若 `resscale=0.5` 收益很小，正好印证"生产遍主导"。）

## 3. O2-C（有损杠杆，需误差界）：生产帧数

依据第 0 节第 2 条：跨帧复用有 **−23%** 空间。做法与阶段 1 的 `shfreeze` 同族，但要**给误差界**：
- 静态机位：复用**精确**（颜色只是 (点, 视线方向) 的函数）⇒ 可作为主表臂，只要写清"静态协议"；
- 动态机位：按 Δθ 阈值重生产，报"**误差 ≤Y 级 @ Δθ ≤Z°**"曲线（`?spin=` + 颜色闸门已有工具）。

## 4. 建议顺序

1. **O2-A**（今天就能跑完：改动小、零回归、与 Flux 对齐）；
2. 用 **O2-B** 的诊断臂把"顶点 vs 片元"钉死（决定 O3 是继续抠每帧成本还是转到"少画几帧"）；
3. 视结论推进 **O2-C**（必须同时交误差界，否则不进主表）。
