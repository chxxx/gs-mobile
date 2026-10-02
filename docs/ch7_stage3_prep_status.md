# 阶段 3（O2+O3）状态：单 splat 预处理 pass（MRT）· 提交时快照

> 生成：2026-10-02。规格：阶段 3「单 splat 预处理 pass（MRT）+ 按排序槽位写入」。
> **本轮为进行中状态**：非槽位臂已验证可用；槽位臂（O3）与 `mrt=0`/`lr` 组合**已编译、零回归、但尚未渲染出画面**（无任何 GLSL/GL 报错）⇒ 见 §3 待查。

## 1. 已实现（全部 URL 开关 + 编译期 `#define` 门控，缺省不注入 ⇒ 缺省着色器逐字不变）

| 开关 | 门控 | 行为 |
|---|---|---|
| `?prep=1` | `#define PREP_MAIN` | 预处理 pass（全屏三角形 FS，每片元 = 1 splat）：cen/cov 2 次取样 → 视空间 → NDC 中心 → EWA 2D 协方差（**与主 pass 逐字同源**，含 `0.3` 低通与截断半径）→ 半轴 → 视锥/近平面剔除 → 三阶 SH 颜色（**与方案 B 生产遍逐字同源**，含 lr/notx/nocolortx/band 支持）； **MRT 写出** T0=RGBA32UI（center.x/y float32 + axis1/axis2 half）、T1=RGBA16F（rgb + a）；剔除 ⇒ `T1.a = 0` 哨兵。主 pass 走 `PREP_MAIN` 分支：**每顶点 2 次 texelFetch**，`a==0` ⇒ 退化顶点，位置 = `center + corner.x*axis1/viewport + corner.y*axis2/viewport`。 |
| `&slot=1` | `#define PREP_SLOT` | O3：排序结果上传成 R32UI 纹理（2048 宽，`texImage2D` 全量）；预处理按 `slot = 片元线性编号`、`idx = sortedIdx[slot]` 写出；主 pass 用 `gl_InstanceID`（不声明 `index` 实例属性） |
| `&mrt=0` | 编译期建**两个单输出程序** | 回退臂：`PREP_OUT_T0/T1` 各一个程序（未选中的输出改成同名全局变量接收写入 ⇒ 被驱动裁掉），两次单目标 pass |

**关键实现点（都是真跑才暴露的）**
1. **多片元输出必须显式 `layout(location=N)`** —— 否则 ANGLE 报
   `'outT0' : when EXT_blend_func_extended extension is not enabled, must explicitly specify all locations...`；
2. **`mrt=0` 不能只挂一个附件而着色器仍有两条输出** —— ANGLE 报
   `glDrawArrays: Fragment shader output type does not match the bound framebuffer attachment type` ⇒ 回退臂必须真的用单输出程序；
3. 排序表纹理必须**真绑到采样单元 12**（只设 uniform 单元号不够）；
4. 模板串里注释**不能出现反引号**（本轮第三次踩，已在代码里写明规则）；
5. MRT FBO 不完整时**显式报错**并指向 `&mrt=0`（不做静默降级——半死的回退路径更危险）。

## 2. 桌面验证（本机 Edge / RTX 4060）

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **0 错** ✓ |
| 零回归（约束 1 的规定脚本 `tools/ch7_desktop_shader_verify.ps1 -Tags base,frag`） | **base ✓ frag ✓**：`mismatchCount=0`、`glErrCount=0`、`ok=1`（`shaderErrCount=2` = Edge 自带 importer 噪声） |
| `?shcache=frag&notx=1&nocolortx=1&prep=1`（**槽位=0，MRT**） | **`ok=1`、`glslErr=0`、`glErr=0`、`covered=99.8345864661654`（与 `frag` 逐值相同）** ✓✓ |
| `&slot=1`（mrt=1）/ `&slot=1&mrt=0` | 编译/链接成功（`[prep=1] 就绪` + 0 GLSL/GL 报错），但**画面全空**（`ok=0`，`kept=1`）✗ — 待查 |
| `&slot=1&lr=1` | 同上待查（程序已建，无报错） |

## 3. 待查（`slot=1` 为什么空）

症状：无 GLSL/GL 报错、无 FBO 不完整、`prep`（非槽位）同代码路径**可用** ⇒ 说明差异只在"槽位"这条链上。
最可能的三个点（按怀疑度）：
1. **`u_prepSlotCount` 取到 0 或 null** ⇒ 预处理对**所有**槽位写哨兵 ⇒ 主 pass 全退化（与"`kept=1`"的自证完全一致：所有实例读同一个/空数据 ⇒ 被剔除到 1）；
2. **排序表采样读数不对**（绑定/坐标：`slot & 0x7ff` × `slot >> 11` 与上传的 2048 宽布局是否一致）；
3. **`gl_InstanceID` 与绘制序**是否真的对齐（`drawArraysInstanced(TRIANGLE_FAN,0,4,len)` 的实例序 = 排序序 ✓ 预期成立，但需实测确认）。

**下一步（建议的定位手段）**：在预处理 pass 里加一次性 `console.log`（只打前 2 帧）输出
`depthIndex.length` / `prepSlotCount` / `sortedIdx[0..3]` / `_prepW/_prepH` / `T1.a` 的读回（可用 `?framedump=1` 看 T1 是否全 0）⇒ 一次就能把 1、2 分开。

## 4. 尚未做（阶段 3 规格的其余部分）

- **真机测量**（Gen3 微信为主）：`S2=lr+notx+nocolortx / prep / prep+slot / prep+slot+lr / prep+slot 冻结 T0·T1` + Flux（同会话、`pose_src=flux`）；
- **预处理 pass 单独耗时**：`prep` 与"预处理冻结"之差；有 `EXT_disjoint_timer_query_webgl2` 时另报 GPU 计时；
- **剔除率**（基准视角、`spin=0.2` 各一次）；
- **颜色闸门**：`prep` / `prep+slot` 对 BASE ≥ 45 dB（若不过先把半轴改 float32 定位 half 精度问题）；
- **动态口径**：`spin=0.2` 下补测 S2 / prep+slot / Flux，排序策略两边一致（都按值触发，或都用 `?sortdz=8.11` 并标"有损"）。
