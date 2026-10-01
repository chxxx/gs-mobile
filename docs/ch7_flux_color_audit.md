# Flux-GS 官方 WebGL 渲染器：颜色是否每帧随视角求值（只读核查）

> 核查时间：2026-10-01。核查对象：`gsplat.js/flux-gs-project-gh-pages/render_shared/main.js`
> （108,022 B；`render_<scene>/main.js` 仅 **62 B** 的引导文件 ⇒ 13 个场景页共用同一份渲染器）。
> 方法：只读源码，未改任何路径。所有行号均为该文件内行号。

## 0. 一句话结论

**Flux 的颜色是每帧在顶点着色器里用实时相机位置 `camPos` 重新求值的**（`view_dir` + `computeSHChannel`），
**没有加载期颜色烘焙、没有颜色缓存、没有"视角延迟"**；但**只求到 SH 第 1 阶**（每通道 4 个系数）。
首帧 11–25 s **不是**颜色烘焙，而是 **TMC3/MPEG G-PCC 的 WASM 解码 + 每点 MLP 推理（解出 SH 系数本身）**。
颜色之外，Flux 确有**两处**别的"视角相关缓存/延迟"：**排序的角度阈值早退（≤ 8.11°）** 与 **worker 异步排序**。

## 1. 颜色：每帧求值（证据链）

| 步 | 行号 | 代码 | 含义 |
|---|---|---|---|
| 1 | 1233 | `uniform vec3 camPos;` | 相机位置是**每帧 uniform** |
| 2 | 1358-1359 | `vec3 center_world = uintBitsToFloat(cen.xyz); vec3 view_dir = normalize(center_world - camPos);` | 逐点实时视线方向 |
| 3 | 1361-1363 | `float r = computeSHChannel(view_dir, 0, index); … g … b` | 逐点求三通道颜色 |
| 4 | 1248-1268 | `float computeSHChannel(...)`：`vec4 sh = texelFetch(u_sh_texture, texCoord, 0);` → `result = SH_C0*sh.x;` → `result -= SH_C1*y*sh.y + SH_C1*z*sh.z - SH_C1*x*sh.w;` → `return clamp(result+0.5,0,1);` | **1 次取样、4 个系数（DC + l=1 三个）** |
| 5 | 1366 | `vColor = vec4(r,g,b,alpha);` | 颜色只经 VS 传片元 |
| 6 | 1378-1394 | 片元着色器只有 `exp(-dot(p,p))*alpha` 的 α 衰减 | **片元不做任何视角相关计算** |

⇒ 相机一动，颜色当帧即变；**没有**任何"加载时算好颜色、逐帧复用"的路径。

**关键不对称（论文必须写明）**：Flux 部署版**只算 l=0..1**（`SH_C2`/`SH_C3` 常量虽在 1243-1244 声明，但 `computeSHChannel` 不使用；
1243-1244 之后的 C2/C3 与 1272-1323 的"12 系数全量版"**整段被注释掉**）。数据侧也只是 l=1：
`_features_rest = new Float32Array(9)`（1028）、`runTCNN_MLP(… MLP_sh …, 16, 64, **9**, …)`（1078）、
SH 纹理每点 **12 个 float**（1153-1168 的 `sh_f_buffer[i*12+…]`：DC + 3×3 个 l=1 系数）。
⇒ **Flux 每帧每点 3 次 SH 取样（每通道 1 纹素）求 4 个系数；本文 FRAG/LR 每点 6 次取样 / 2 次取样求 16 个系数（l=0..3）** ⇒ 直接比"每帧 SH 成本"必须标注阶数差。

## 2. 首帧 11–25 s 的真实来源（不是颜色烘焙）

全部在 **worker** 里（1200-1213 收 `mobilegs`、1703 用 Blob 起 worker、2582/2651 `postMessage({mobilegs:…})` 送数据）：

1. **TMC3（MPEG G-PCC）WASM 解码 xyz**：`mainFunc(['--mode=1','--compressedStreamPath=/xyz.bin','--reconstructedDataPath=/xyz.ply'])`（881-883，`console.time("TMC3 Decode")`）；
2. **每点 MLP 推理**（`console.time("Neural Decode Loop")`，1051；主循环 1053 起，每点执行）：
   - unisphere 收缩 + TCNN 频率编码（1065-1067），
   - `runTCNN_MLP(MLP_cont, 96→64→13)`（1068，函数在 804-851，含 `pad16` 填充），
   - `runTCNN_MLP(MLP_opacity 16→64→1)`、`MLP_dc 16→64→3`、**`MLP_sh 16→64→9`**（1076-1078），
   - 4 层 PyTorch MLP `MLP_offset`（23 维输入，1115-1118，`runPyTorch_MLP` 在 858-866），输出 12 个偏移量加到 DC/rest 上（1121-1128）；
3. **打包 32 B/点记录 + SH 数组**（1131-1168）→ 两次 `texImage2D` 上传（主纹理 `RGBA32UI` 1900-1910、SH 纹理 `RGBA32F` 1926）。

⇒ 11–25 s ≈ TMC3 解码 + 逐点 MLP 推理 + 纹理构建/上传；`__FLUXGS_STATS__` 已有分段：
`decodeDoneAt`（含主纹理上传）、`texUploadDoneAt`（SH 纹理上传完成）（1502-1512、1913-1915、1928-1929），
本文臂对应 `decode_ms=` / `tex_def=`（`bench-flux.ts:1710-1716`）⇒ **可量化归属，不必再推测**。

⇒ 语义上：Flux 的神经网络是**压缩隐变量的解码器**（把"位置/尺度/旋转/外观 + MLP"还原成 SH 系数），
**不是**逐帧神经渲染，**也不是**颜色烘焙。它把神经算力花在**加载期**，把每帧颜色留给**1 阶 SH**。

## 3. Flux 的"视角相关缓存/延迟"（有，但不在颜色上）

| 机制 | 行号 | 行为 | 影响 |
|---|---|---|---|
| **排序角度阈值早退** | 561-572 | `dot = lastProj[2]*viewProj[2]+lastProj[6]*viewProj[6]+lastProj[10]*viewProj[10]; if (Math.abs(dot-1) < 0.01) return;` | ≤ **8.11°** 视角变化内**复用旧深度序**；且判据只看**朝向**（`viewProj` 第 3 行），**纯平移不触发重排** |
| **worker 异步排序** | 613-623 | `throttledSort()`：`runSort` 完成后 `setTimeout(…,0)` 再看 `viewProj` 是否又变 | 排序与绘制解耦，最多晚一帧；`sortCount`（607）只统计"真的排完"的次数 |
| 颜色 | — | **无任何缓存** | 相机一动当帧即变，零延迟 |

（`sortCount` 那行注释是本文埋点；`|dot-1|<0.01` 早退是 **Flux 上游原代码**。）

## 4. 对"缓存"这一侧公平性的结论

本文 `?shfreeze=N`（`RenderProgram.ts:143-157, 2108`）：
`produceNow = !_shCacheFrozen || _shCacheProduceCount++ < SHFREEZE_FRAMES` ⇒ **前 N 帧生产颜色缓存（RGBA16F `u_colorTex`）后不再重算**，
后续帧复用冻结机位下的颜色。臂标签：`frozen` / `lr-frozen`（1223-1225）。

1. **静态机位下缓存是"精确"而非"近似"**：颜色 = f(点, 视线方向)，`spin=0` 时两者都不变 ⇒ 复用值与重算值**逐位相同**
   （两条路径写出的都是同一张 RGBA16F 缓存）⇒ **误差 = 0，可证明**；建议补一个像素级验证（`frag` vs `frozen` 同机位抓帧应逐位一致）。
   ⇒ **在这个协议下，与 Flux 比较是公平的**（Flux 每帧重算、我们缓存，但两者画面相同）。
2. **动态机位下才有误差**：此时应写成"我们以**有界误差**换来 X% 帧率"，并报出**误差-转角曲线**
   （现成工具：`?spin=` / `spin_mode=` / `spin_peak=` + 颜色闸门 `tools/ch7_color_gate*`）。
   - 另注意：动态时**Flux 自己也有近似**（≤ 8.11° 用旧序，且平移不重排），本文臂按文档是"每帧都排（值级判定）"（`bench-shared.ts:1747`）
     ⇒ **动态协议下不能只算我们的账**。
3. **每帧 SH 成本必须标阶数**：Flux = 4 系数/通道、3 纹素/点；本文 = 16 系数/通道（frag 6 纹素 / lr 2 纹素 + 基累加）
   ⇒ 若要与 Flux 同阶比较，需要一个"截到 l=1 的本文臂"（未实现；`lr` 已把取样降到 2，是这条路的自然起点）。

## 5. 待办（本轮未做，只记录）

- [ ] `frag` vs `frozen`（同机位、`spin=0`）像素级对账 ⇒ 把"缓存精确"从推理变成实测；已在 `frozen` 上做过这类对比的现成工具是颜色闸门脚本。
- [ ] 误差-转角曲线：`spin=` 递增 + 抓帧比对 ⇒ 给出 "≤ Y 级 @ Δθ ≤ Z°" 的界。
- [ ] 若论文要写"我们比 Flux 快"，必须先声明阶数差（l=1 vs l=3）与缓存差（每帧重算 vs 有界复用）。
