# 阶段 2 · O1 真机报告（Gen2/Adreno740 为主）

> 生成：2026-10-01~02。锚定提交 **`a18cff5`**（O1 实现 + `docs/ch7_stage2_o1.md`）。
> 协议：离屏 1600×1063（forced/dpr1）、20 预热 + 20 帧、`runs=5`、`rounds=3`、`sync=batch`、`driver=msgchannel`、
> `benchmode=offscreen-paper-match`、`profile=garden`（610k 点）、同会话背靠背、真机自动回传
> （`raw/o1-*.txt`，全部 `ok=3/3`）。判定臂一律取报告里的 `arm=`（本轮 9 条的 `arm=` **全部与预期一致**，无 `+notx-rejected`）。

## 1. 三行结论

1. **`notx` 是干净的胜利**：`frag` 16.18 ms → **`frag+notx` 13.85 ms（−14.4%，+16.8% fps）**；而且 **`notx` 单独就拿到全部收益**（`frag+notx+nocolortx` 13.89 ms，与 `frag+notx` 在噪声内相同）。
2. **`nocolortx` 无收益（打平）**：61.4 vs 61.8 fps（−0.7%，在 ±0.9 std 内）。⇒ 此前"未使用 sampler ≈11% 惩罚"**不能推广到片元生产遍**（那条实测在顶点侧）。保留它的理由改为**零成本清理**，不进性能结论。
3. **Gen2 可交付最优 = `frag+notx`：22.68 → 13.85 ms（对 BASE 1.64×）**；`frag` 相对 BASE 1.40×。跨帧复用上限（`lr-frozen+notx+nocolortx`）10.68 ms（对 BASE 2.12×）⇒ 下一步该攻"**减少生产帧数**"。

## 2. 数据表（Snapdragon 8 Gen 2 / Adreno 740 / `ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)`，garden 610k）

| # | `arm=` | fps(mean±std) | frame_ms | cpu_ms | covered | Δ vs 同族基线 |
|---|---|---|---|---|---|---|
| 1 | `base` | 44.1 ± 0.4 | 22.68 | 22.71 | 99.8% | — |
| 2 | `frag` | 61.8 ± 0.9 | 16.18 | 16.19 | 99.8% | 1.40× vs base |
| 3 | **`frag+notx`** | **72.2 ± 1.4** | **13.85** | 13.86 | 99.8% | **−14.4% vs frag** |
| 4 | `frag+nocolortx` | 61.4 ± 0.6 | 16.29 | 16.52 | 99.8% | −0.7%（打平） |
| 5 | `frag+notx+nocolortx` | 72.0 ± 1.1 | 13.89 | 13.95 | 99.8% | −14.2% vs frag |
| 6 | `lr` | 58.2 ± 0.6 | 17.18 | 17.11 | 99.8% | — |
| 7 | `lr+notx+nocolortx` | 68.1 ± 1.3 | 14.68 | 14.65 | 99.8% | −14.5% vs lr |
| 8 | `lr-frozen+notx+nocolortx`（**上限参照**） | 93.6 ± 1.2 | 10.68 | 10.60 | 99.8% | −34.0% vs lr |
| 9 | `flux`（Flux-GS，739k 点） | 127.2 ± 7.0 | 7.86 | 7.96 | 100.0% | 2.89× vs base |

**单 splat 时间（ns/splat = frame_ms / 点数）**

| 臂 | ns/splat | 与 Flux 之比 |
|---|---|---|
| `frag` | 26.5 | 2.50× |
| **`frag+notx`** | **22.7** | **2.14×** |
| `lr+notx+nocolortx` | 24.1 | 2.27× |
| `lr-frozen+notx+nocolortx` | 17.5 | 1.65× |
| **Flux** | **10.6** | 1.00× |

（Flux 的代价：Gen2 上 **首帧 `decode_ms_median=102.7 s`**；其存储 6.95 MB vs 我们 QPLY 14.65 MB。）

**附：另一台机的一次记录（`ARM Mali-925` / `Mali-G925-Immortalis MC12`）**
`lr+notx+nocolortx` = **108.5 ± 1.8 fps（9.22 ms）**，`parse_ms` 3918–4558、`first_frame` 5726–6235。
⚠ 该机**缺 `frag` / `frag+notx` 同会话对照** ⇒ 只能作单点记录，**不能算 Δ**（下一步补）。

## 3. 机制解释

- **取样账**（生产遍 + 主 pass×1）：`frag` 26~27 次/点 →`frag+notx` **16~17** →`frag+notx+nocolortx` **11**；
  `lr` 22~23 → `lr+notx+nocolortx` **7**；`*frozen` 稳态 **3**（Flux 5）。

## 4. 下一步建议（按优先级）

| # | 事项 | 为什么 | 判据 |
|---|---|---|---|
| 1 | **桌面正确性闸门**：`frag+notx`、`frag+notx+nocolortx` 对 BASE（同机位、全幅无损 PNG） | 约束 6 要求"新臂对 BASE PSNR ≥ 45 dB、无 >8 级像素"；单位阵乘法在 IEEE754 下精确 ⇒ **预计逐位一致** | PSNR ≥ 60 dB（或逐位一致）才出性能结论 |
| 2 | **瓶颈诊断臂**（用已有开关，不改代码）：`lr` 与 `lr+notx+nocolortx` 各跑 `resscale=1|0.5`、`drawfrac=1|0.5` | 把"顶点/取样侧 vs 片元/混合侧"钉死（`notx` 的收益已暗示顶点侧，但需要独立证据） | `resscale=0.5` 提升 **<10% ⇒ 顶点受限**；**>30% ⇒ 片元受限** |
| 3 | **Mali 补 `frag` / `frag+notx` 同会话对照** | 现在只有 `lr+notx` 单点，无法算 Δ | 得到 Mali 的 `notx` 增量，判断它是否与 Gen2 同向 |
| 4 | **主表口径更新**：新基线 = `frag+notx`（O1 唯一净收益臂）；`nocolortx` 记为"零成本清理"，**不进性能结论** | 避免把打平项当收益写进论文 | 表 7-x 里 `frag+notx` 与 `frag` 并列，`+nocolortx` 只作脚注 |
| 5 | **O2 方向**：由第 2 条决定 —— 若顶点受限 ⇒ 攻主 pass 顶点侧（如"每个 splat 的 VS 工作量"）；若片元受限 ⇒ 攻生产帧数/混合 | 本轮数据表明"继续抠片元生产遍取样"已无收益 | 见第 2 条结果 |

## 5. 代码现状（截至 `a18cff5`）

**生效开关（全部 URL + 编译期 `#define` 门控，缺省不注入 ⇒ 缺省着色器预处理后逐字不变）**

| 开关 | 作用 | 状态 |
|---|---|---|
| `?shcache=frag` | 方案 B：片元生产遍写 RGBA16F 颜色缓存，主 pass 按**原始索引**取色 | 阶段 0/1，已验证（Gen2/Gen3/Mali 三机；桌面闸门 60.02 dB） |
| `?lr=1` | 渲染期低秩：rank 纹理（1 纹素/点）+ 共享基 UBO（79 vec4）；**跳过加载期 `C@B` 与 3 张全 SH 纹理** ⇒ SH 显存 58.6 → 19.5 MB | 阶段 1，颜色闸门 60.04 dB；性能**设备相关**（Mali +26.6% / Gen3 打平 / Gen2 −5.8%） |
| `?notx=1` | **本轮**：不声明/不取样 `u_transforms`、`u_transformIndices`，改用 `uniform mat4 u_splatTransform` + `uniform float u_splatSelected`；**仅单对象**（运行期自证） | 已落地；Gen2 **−14.4%**（净收益）✓ |
| `?nocolortx=1` | **本轮**：`u_colorTransforms`/`u_colorTransformIndices` 的声明与分支一起删 | 已落地；Gen2 **打平**（零成本清理） |
| `?shfreeze=N` / `?shcachefreeze=1` | 冻结臂（前 N 帧后不再生产颜色） | 主表禁用，仅上限参照（名字里标 `frozen`） |
| `?notx=bake` | 预留（加载期烘焙 M 进位置/协方差） | **未实现**（按 `notx=1` 处理并 `console.warn` 自证） |

**诊断开关（不入优化臂）**：`?nosh` `?noct` `?shdeg`（仅诊断；**三阶 SH 完整保留，禁止降阶进优化臂**）`?shfmt=f16` `?shpackf16` `?shpass=pre|produce|consume` `?shprobe=fixedcoord` `?shtfprobe` `?sortlag` `?drawfrac` `?resscale` `?cull` `?framedump` `?clearprobe`。

**本轮改动**：`src/renderers/webgl/programs/RenderProgram.ts`（`notx`/`nocolortx` 的开关、`#define` 注入、采样器切片剔除 + `#endif` 补齐、`u_splatTransform` 每帧写、`arm=`/`sw=` 自证）；新增 `docs/ch7_stage2_o1.md`（第 0 步核查 + 取样账 + 待测协议）。

## 6. 验证状态

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **0 错** ✓ |
| `npx vitest run` | 全绿（5 文件；`QPLYLoaderUtils.lowrank` 3 例 skip） |
| 零回归（约束 1：`tools/ch7_desktop_shader_verify.ps1`） | **base / frag 双通过**：`ok=1`、`mismatchCount=0`、`glErrCount=0`、`shaderErrCount=2`（=Edge 自带 importer 的 `ERROR:` 噪声，非 GLSL） |
| 新开关桌面冒烟 | `frag&notx=1&nocolortx=1`：`glslErr=0`、`glErr=0`、`ok=1`、`covered=99.83%`（与 `frag` 相同） |
| **真机** | **9 条 Gen2 全部 `ok=3/3`，`arm=` 与预期逐条一致，无 `+notx-rejected`** ✓✓ |
| 桌面颜色闸门（PSNR） | **未跑**（下一步第 1 项） |

**本轮修复的三个运行时缺陷（都靠真跑暴露）**：① 生产遍 FS 未注入 `NO_SPLAT_TRANSFORM`/`NO_COLOR_TRANSFORM` ⇒ 引用被剔除的 sampler；② 采样器切片以 `u_colorTransformIndices;` 收尾 ⇒ 新加的 `#endif` 被切掉；③ `u_splatTransform` 漏了每帧写 ⇒ uniform 恒 0、画面全空（`ok=0 kept=1`）。

- **但收益只兑现了 `notx` 那一半**：删 10 次/点（transform 5+5）换来 −14.4%，而再删 5 次/点（colorTransform，仅生产遍）**零收益** ✗。
  ⇒ 说明 **`notx` 的收益主要来自"主 pass（顶点着色器）"那一侧**（每 splat 的 VS 取样/寻址），
  而**片元生产遍的取样不是瓶颈**（该遍是 N 个片元一次、访存连续、且被 SH 求值/ALU 掩盖）。
- **低秩在 Gen2 仍不划算**：`lr*` 各臂比同配置 `frag*` 慢 ~5–6%（17.18 vs 16.18；14.68 vs 13.89），
  与阶段 1 结论一致（Adreno 740 上"省 4 次 TMU"抵不过"加 ~270 ALU"）——`notx` 把两者同比例拉快，**没有改变这个结论**。
- **上限参照的提示**：`lr-frozen+notx+nocolortx` = 10.68 ms ⇒ 若"复用旧颜色"的误差能被颜色闸门接受，
  仍有 **+35%** 空间（且它已低于 Flux 的 7.86 ms × 1.36）。
