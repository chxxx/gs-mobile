# 2026-10-08 离屏协议批次小结（Gen2 / 天玑 9400 / reduced-3DGS）

> ⚠⚠ **本文件 §6/§7 的 "两臂都改 `cam=auto`" 方案已被 §8 推翻（2026-10-08 追加）**：
> `cam=auto` 的相机被放在 `dist = span×1.6` 处，而测量路径从不撑开远平面（缺省 `far=100`）⇒
> 大场景整个模型落在远平面之外、画面里几乎什么都没画。`helper01h1` / `helper01h4` / `helper01h7`
> 以及本机 `fd_ours_*` / `fd_spin*` 取图**全部作废**（§8.6 清单）。
> **请先读 §8 再引用本文件的任何数字。**



> 原始记录：`thesis_project/data/ch7_measurements/raw/helper01e{1,2,3}_20261008_*.txt`
> 协议：`benchmode=offscreen-paper-match`、`res=1600x1063&res_mode=forced&dpr=1`、`frames=20/run`、
> `warmup=20`、`runs=5`、`fences=3`、`sync=gputimer`、`rounds=3`、`cold=1`；全部 `ok=3/3`。

## 1. 记录清单与设备归属（**以结果里的 `chip=` 为准，不看 `u=`**）

| 记录 | 文件 | 实际设备（`chip=`） | 场景×轮次 | 生效渲染配置（`arm=`/`sw_effective=`） |
|---|---|---|---|---|
| ① | `helper01e1_20261008_162447.txt` | Snapdragon 8 Gen 2 (Adreno 740) | 13×3 | `arm=base`（`lr=0\|notx=0\|nocolortx=0`） |
| ② | `helper01e2_20261008_165130.txt` | **ARM Mali-925（天玑 9400）** — `u=` 写成 gen3 是笔误 | 5×3（reduced-3DGS） | `arm=base` |
| ③ | `helper01e3_20261008_171227.txt` | ARM Mali-925（天玑 9400） | 13×3 | `arm=base` |

三者的 `offscreen_sync_policy` 均为 `batch_submit_drain_at_run_end|fallback=gputimer_unavailable->batch`
（这些设备的 `EXT_disjoint_timer_query(_webgl2)` 不可用 ⇒ 回落 batch 排空，仍是墙钟真实吞吐）。

> ⚠ **口径警告**：本批是 `base` 渲染配置，而 Gen3 主表批次（`helper01c1/c2b/c3b`）是部署配置
> `arm=lr+notx+nocolortx`（`shcache=frag|lr=1|notx=1|nocolortx=1`）。故本批数字**不可直接与表 7-2 并列**，
> 需用同款部署配置重跑（见 §5 的 ④⑤⑥ 链接）。

## 2. 天玑 9400（Mali-925）13 场景 · 离屏 · base 配置

| 分类 | FPS | 首帧 |
|---|---:|---:|
| Mip360-Outdoor(5) | 73.5（bicycle 59.2 / flowers 75.8 / garden 59.0 / stump 71.4 / treehill 102.1） | 6395 ms |
| Mip360-Indoor(4) | 159.8（bonsai 212.3 / counter 127.3 / kitchen 133.8 / room 165.7） | 5350 ms |
| Tanks and Temples(2) | 135.7（train 117.4 / truck 153.9） | 5279 ms |
| Deep Blending(2) | 105.1（drjohnson 73.5 / playroom 136.6） | 5351 ms |

## 3. 骁龙 8 Gen 2（Adreno 740）13 场景 · 离屏 · base 配置

| 分类 | FPS | 首帧 |
|---|---:|---:|
| Outdoor(5) | 18.2 | 4518 ms |
| Indoor(4) | 35.6 | 3246 ms |
| Tanks and Temples(2) | 29.9 | 3870 ms |
| Deep Blending(2) | 24.2 | 3574 ms |

逐轮抖动明显（`bicycle` 41/16.5/16.6、`treehill` 22.5/32.7/22.3）⇒ 该批建议用部署配置重跑（链接 ④）。

## 4. reduced-3DGS 覆盖的 5 个场景（设备 = Mali-925，与本文臂同设备、同 base 配置）

| 场景 | 分类 | reduced-3DGS：fps / 首帧 / 点数 / 体积 | 本文臂：fps / 首帧 / 点数 / 体积 | 本文/reduced |
|---|---|---:|---:|---:|
| bicycle | Out | 45.8 / 4525 ms / 2.411M / 50.62MB | 59.2 / 6577 ms / 0.580M / 13.93MB | ×1.29 |
| bonsai | In | 266.8 / 2051 ms / 0.518M / 10.54MB | 212.3 / 5392 ms / 0.220M / 5.29MB | ×0.80 |
| counter | In | 189.9 / 2437 ms / 0.499M / 11.70MB | 127.3 / 5256 ms / 0.250M / 6.01MB | ×0.67 |
| kitchen | In | 118.8 / 2628 ms / 0.838M / 19.64MB | 133.8 / 5336 ms / 0.250M / 6.01MB | ×1.13 |
| truck | T&T | 154.9 / 2264 ms / 0.854M / 17.33MB | 153.9 / 5240 ms / 0.273M / 6.56MB | ×0.99 |
| **均值** | | **155.2 fps / 2781 ms / 1.024M / 21.97MB** | **137.3 fps / 5560 ms / 0.315M / 7.56MB** | ×0.88 |

结论：reduced-3DGS 在这 5 场景上平均快约 13%，但**点数多 3.3×、体积大 2.9×**；本文臂在
`bicycle`/`kitchen` 更快、`truck` 持平、`bonsai`/`counter` 更慢；首帧 reduced-3DGS 更快
（2.78 s vs 5.56 s，本文首帧含低秩重建与纹理打包）。
**覆盖范围仅 5/13 场景**（官方只发布 bicycle/bonsai/counter/kitchen/truck 的量化 PLY，其余 8 个 404），
表注必须写明"子集结果"。

## 5. 待跑：部署配置（`arm=lr+notx+nocolortx`）

链接由 `tools/ch7_batch.py link --protocol offscreen-paper-match --rounds 3` 生成，
末尾手工追加 `&shcache=frag&lr=1&notx=1&nocolortx=1`（与 `helper01c*` 主批次逐字同构）。

| 编号 | 用途 | `u=` |
|---|---|---|
| ④ | 骁龙 8 Gen 2 · 13 场景（替换本批 ①） | `helper01g1-gen2-xweb-main` |
| ⑤ | 天玑 9400 · 13 场景（替换本批 ③） | `helper01g3-d9400-xweb-main` |
| ⑥ | 骁龙 8 Gen 3 · reduced-3DGS 5 场景（与 ② 的 base 结果对照） | `helper01g2-gen3-xweb-reduced3dgs` |

完整 URL 见 `gsplat.js/_tmp_ch7probe/out/LINKS_ALL.txt`。

## 6. ⚠ 公平性核对：② 的 reduced-3DGS 对照**不可用于比较**（2026-10-08 追加）

`bench-cameras.json` 规定的可比性判据是 **`covered%`**（"用 covered% 做可比性核对"）。逐场景核对结果：

| 场景 | `scene_diag` reduced / ours | 比值 | `covered` reduced / ours | 判定 |
|---|---|---:|---:|---|
| bicycle | 209.74 / 434.73 | 2.07× | 100.0% / 100.0% | ✓ |
| bonsai | 95.63 / 310.61 | 3.25× | **77.5%** / 99.7% | ✗ |
| counter | 77.88 / 144.33 | 1.85× | **67.2%** / 100.0% | ✗ |
| kitchen | 100.80 / 138.92 | 1.38× | **65.8%** / 98.6% | ✗ |
| truck | 226.22 / 912.36 | 4.03× | **88.0%** / 100.0% | ✗ |

`pose=` 字符串虽逐字符相同（两臂都用 `cam=flux`），但两臂模型**不在同一世界尺度**，同一相机下 reduced 一侧
只铺满 66–88% 画面 ⇒ 其帧率含"画得少"的成分，**不能与本文臂直接比较**。4/5 场景不通过判据。

**修正口径：两臂都改用 `cam=auto`（`frameScene()`，`bench-measure.ts:1388-1420`）**——
以各自 bbox 中心为靶、`dist = span×1.6`、同 FOV，取景规则**尺度不变** ⇒ 相对取景一致；核对方式改为
`covered%` 是否接近 + `pose_src=auto`（不再比较 `pose=` 字符串）。

> ⛔ **本段（§6 的修正口径）已作废 —— 见 §8**：`cam=auto` 的 `dist = span×1.6` 远超测量路径从不修改的
> 缺省远平面 `far=100`（`CameraData.ts:9-10`）⇒ 模型整个落在远平面外、画面基本是空的。本段以及 §6/§7
> 里所有基于 `cam=auto` 的数字、判定、链接**全部不可用**。

**其它已核对限制**（一致项：res/res_mode/dpr、frames/warmup/runs/fences、driver、bench_mode、proto、
fx=1159.588、stage=fit1、fade=none、spin=0、cold=1、rounds=3、同设备同内核、两臂同配置 base）：
点数差 3–10×、单点 SH 载荷不同（本文 45 维三阶 vs 按其阶数裁剪）、首帧构成不同（低秩重建+纹理打包 vs 纯 PLY 解码）、
以及 **reduced 资产是在本文渲染器内渲染**（其 WebGL 实现未接入）⇒ 只能表述为"同渲染器、跨模型/跨格式对照"，
不可表述为"reduced-3DGS 系统的帧率"。另：两臂均为 base 配置，非本文部署配置。

修正链接（⑦⑧⑨，两臂都 `cam=auto`）另见 `gsplat.js/_tmp_ch7probe/out/LINKS_ALL.txt`。

## 7. 配置口径定案：两臂都用**本文部署开关**（2026-10-08 追加，修正 §6 的 ⑦/⑧）

§6 里 ⑦/⑧ 设成"两臂都 base"是错的：那等于让本文臂**主动降级**，base 在本文自身的 D 层消融里
就是明显更慢的一档（Gen3：`base 58.9 → frag 74.2 → +notx/nocolortx 86 → +lr 98.1`），
既不代表本文系统，也低估本文。四个开关的语义（`RenderProgram.ts` 文件头）说明它们是**部署管线本身**：
`notx=1`（`NO_SPLAT_TRANSFORM`，去掉逐点读恒等仿射的冗余取样）、`nocolortx=1`（去掉颜色变换纹理取样）、
`shcache=frag`（SHCACHE 方案 B：SH 求值移入全屏片元遍 + 颜色缓存纹理）、`lr=1`（低秩渲染期路径）；
四者均带**运行期自证**（不成立则显式失败、该轮作废，不允许静默错标）。

**定案口径**（最终以 `gsplat.js/_tmp_ch7probe/out/LINKS_FINAL.md` 为准，v2）：
**原则 = 每臂各跑自己实现的路径。**
本文臂 = 部署配置（`shcache=frag&lr=1&notx=1&nocolortx=1`，与表 7-2/7-8 同口径）；
reduced-3DGS 臂 = **基线路径（四个开关全关，即 `arm=base`）**。

归属依据：本渲染器 `splat-shq.js`（`package.json: name=splat-shq`，README："本仓库是 gsplat.js 的扩展分支…是 BAPQ 压缩流水线的 WebGL 2.0 部署出口"）**继承了 reduced-3DGS 的量化 PLY 约定**，
而 `notx=1`/`nocolortx=1`/`shcache=frag`/`lr=1` 四个开关都是本仓库在 **2026-09-30 ~ 2026-10-02** 加入的
自研优化（`RenderProgram.ts` 注释带 `[阶段1/阶段2 O1/阶段3]` 标记，缺省全关）。把这四个开关加到 reduced 臂上
等于**把本文的工程优化记在基线头上**（基线虚高、本文被低估），属归属错误 ⇒ 基线臂必须保持 `base`。

| 编号 | 用途 | 关键参数 |
|---|---|---|
| A1 / A2 | 表 7-8：Gen2 / 天玑 9400（本文臂部署配置，cam=flux） | `shcache=frag&lr=1&notx=1&nocolortx=1` |
| B1 | reduced 对照 · 本文臂（部署配置，cam=**flux**）——**原定 `cam=auto`，已按 §8 改为 flux** | 含四个开关，`u=helper01h4-gen3-xweb-main` |
| B2 | reduced 对照 · reduced 臂（**基线路径，开关全关**，cam=**flux**）——同上 | 仅 `cam=flux`，`u=helper01h7-…` |
| B3（可选） | 仅用于展示自研优化贡献：本文臂 base（cam=flux），**不与 reduced 结论混用** | `cam=flux`，`u=helper01h8-…` |

（⑦⑧⑨⑩⑪ 及带优化开关的 reduced 版本全部作废；④⑤ 已并入 A1/A2。）

## 8. ⚠⚠ 口径事故：`cam=auto` 的记录**全部作废**（2026-10-08 追加，推翻 §6/§7 的 auto 方案）

**一句话**：§6 提出的"两臂都改 `cam=auto` 以取得尺度不变的相对取景"**在物理上不成立**——
`frameScene()` 把相机放在 `dist = span×1.6` 处，而**测量路径从不撑开远平面**，`CameraData` 缺省是
`near=0.1 / far=100` ⇒ 大场景**整个模型落在远平面之外，画面里几乎什么都没画** ⇒ 帧率虚高（"600+ fps"）、
`covered` 失效。

### 8.1 代码依据（三处，缺一不可）

| # | 位置 | 内容 |
|---|---|---|
| ① | `bench-measure.ts:1411-1419`（`frameScene`） | `span = max(三轴跨度)`、`dist = span × 1.6`、`camera.position = (cx, cy, cz + dist)` |
| ② | `src/cameras/CameraData.ts:9-10` | `private _near = 0.1; private _far = 100;`（**缺省值**） |
| ③ | `bench-measure.ts` 全文 | **没有任何** `far`/`near` 赋值（`findstr /n /i "far near"` 无命中）⇒ 测量路径恒用 `far=100` |

旁证：`bench-view.ts:198-205` 的注释早就写明这个坑——"`frameScene()` 把相机放在 `bbox 外 span*1.6` 处，
而 `CameraData` 缺省裁剪面 `near=0.1/far=100`，**整个模型落在远平面之外 ⇒ 画面永远全黑、且一行异常都不报**"，
并明确"**bench 测量路径默认 `cam=flux`（注入数据集原相机，距离天然在 100 内）所以从未暴露**"。
展示路径是 2026-10-07 靠 `_fitClipPlanes()`（`far = d + span*2`，`bench-view.ts:239-240`）才修好的。

### 8.2 逐场景量化（用记录里的真实包围盒算，不靠估）

`dist = 1.6 × span`；"最近点深度" = 相机到模型最近点的距离：

| 场景 | 臂 | span | dist=1.6·span | 最近点深度 | 在 far=100 内? | 记录 `covered` | 记录 fps |
|---|---|---:|---:|---:|:--:|---:|---:|
| bicycle | ours | 327.3 | 523.7 | 360 | ✗ 全在远平面外 | 100.0% | 317 |
| bonsai | ours | 198.3 | 317.3 | 218 | ✗ | 100.0% | 329 |
| counter | ours | 97.7 | 156.3 | 118 | ✗ | 100.0% | 148 |
| kitchen | ours | 90.9 | 145.5 | 100.1 | ✗ 临界 | 100.0% | 169 |
| truck | ours | 605.9 | 969.4 | 731 | ✗ | 64.0% | **658** |
| r3dgs-bicycle | reduced | 148.4 | 237.5 | 163 | ✗ | 99.8% | 88 |
| r3dgs-bonsai | reduced | 59.3 | 94.9 | 68 | ✓ | 88.0% | 326 |
| r3dgs-counter | reduced | 64.4 | 103.0 | 89 | ✓ | 98.9% | 319 |
| r3dgs-kitchen | reduced | 67.0 | 107.2 | 74 | ✓ | 72.8% | 197 |
| r3dgs-truck | reduced | 165.5 | 264.8 | 182 | ✗ | 57.6% | 296 |

（span 由逐轮行里的 `scene_min=`/`scene_max=` 算出；ours 5 场景的 `dist` 全 >100，reduced 有 3 个落在 far 内
⇒ **两臂"画了什么"根本不是一回事**，§6 期望的"相对取景一致"没有达成。）

### 8.3 "600+ fps" 的实测来源（同设备、同臂、同分辨率，只换机位）

天玑 9400（`chip=ARM Mali-925`）：`helper01e3`（base, `cam=flux`）vs `helper01h1`（base, `cam=auto`）

| 场景 | cam=flux | cam=auto | auto/flux |
|---|---:|---:|---:|
| bicycle | 59.4 | 317.4 | **×5.34** |
| truck | 154.4 | 658.3 | **×4.26**（covered 100% → 64%） |
| bonsai | 212.5 | 328.7 | ×1.55 |
| kitchen | 133.4 | 168.6 | ×1.26 |
| counter | 127.8 | 148.0 | ×1.16 |

⇒ "600+ fps" 不是设备性能，是**几乎空帧**（模型在远平面外）。

### 8.4 本机受控图（最直观的一条证据）

同模型、同分辨率（800×531）、同帧数（`frames=20`）、同协议，只换 `cam`（脚本：`_tmp_ch7probe/fd_flux_test.ps1`，
本机 RTX 4060）：

| 机位 | 记录 | 图 | 结果 |
|---|---|---|---|
| `cam=flux` | `raw/fd_flux_bicycle_*.txt` | `out/fd_flux_bicycle.png` | **正常 bicycle 画面**（小路 / 长椅 / 白色自行车，结构可辨认） |
| `cam=auto` | `raw/fd_auto20_bicycle_*.txt` | `out/fd_auto20_bicycle.png` | **糊成散射光斑**，无任何可辨认结构 |

⚠ 桌面上两者 fps 几乎相同（201.8 vs 208.6）——**桌面上帧率看不出问题，画面才看得出来**（所以必须看图，
不能只看 `covered`/fps）。另：`cam=auto` 在 5 个场景上的 `pose=` 指纹**逐字符相同** ⇒ `frameScene()` 设完位置就
`camera.update()`（朝向仍是缺省），`setCameraTarget()` 在 `update()` **之后**调用、当轮并未生效
⇒ **auto 机位连"朝向 bbox 中心"都没做到**。

### 8.5 `pose=` 指纹证明不了"同画幅"（更正上一轮的推论）

`viewFingerprint()` = `viewMatrix.buffer.slice(0, 6)`（`bench-measure.ts:1470-1475`）。视图矩阵是**列主序** 4×4
（`CameraData.ts:42-50` 的构造里第 4 个元素恒为 0，即末行 `(0,0,0,1)`），因此：

- 元素 0–2 = 旋转矩阵第 1 列、元素 4–5 = 第 2 列前两项 ⇒ **前 6 位只有旋转（朝向）**；
- **平移在元素 12/13/14**，不在指纹内 ⇒ 两臂 `pose=` 相同**只说明朝向相同**，距离/画幅可以完全不同。

⇒ 上一轮"ours 与 reduced 的 `pose=` 逐字符相同 ⇒ 同画幅"的推理**不成立**，在此更正。

### 8.6 作废清单（已核对：都还没进任何表）

| 记录 / 产物 | 原用途 | 处理 |
|---|---|---|
| `helper01h1`（base, cam=auto, D9400） | §6/§7 本臂（base） | **作废** |
| `helper01h4`（deploy, cam=auto, D9400） | §7 的 B1 | **作废** |
| `helper01h7`（reduced, cam=auto, D9400） | §7 的 B2 | **作废** |
| `raw/fd_ours_*`、`fd_spin*`（本机 auto 取图） | 画幅公平性核验 | **作废**（改用 §8.4 的 flux 对照） |
| 本文件 §6「用 `covered%` 做可比性核对」 | 判据 | **失效**：clipped 的场景反而报 `covered=100%`（见 §8.2 表） |

✔ 已 grep 核对：`thesis_project` 的表与 `docs/ch7_paper_tables.md` 均**未引用**这些记录。

### 8.7 顺带纠正："base 比部署臂快"同样是这批坏数据的产物

同设备、同机位、同协议、各 3 轮的**干净**对照（Gen2 / Adreno 740 / `cam=flux` / 离屏 1600×1063）：
`helper01e1`(base) vs `helper01g1`(deploy) ⇒ **部署臂 13/13 场景全胜**，×1.11–2.41、**均值 ×1.50**
（garden ×1.68、bicycle ×1.92、kitchen ×2.41、playroom ×1.11）；与 D 层阶梯（Gen3 garden：
base 58.9 → deploy 98.1，`ch7_gen3_data_summary.md` 表 B）方向一致。

而在 `cam=auto` 的坏数据里（`helper01h1` vs `helper01h4`，D9400）出现 bicycle ×0.41 / bonsai ×0.61 / truck ×0.40
的"反转"——**两边 covered 都只有 64%（truck），画面本身就不成立** ⇒ 不可作为"部署臂更慢"的证据。

### 8.8 下一步（口径修正后再跑）

1. **两臂对照一律回到 `cam=flux`**；`cam=auto` 只用于观察，禁止进表（`bench-shared.ts:291` 原意即如此）。
2. reduced 与 ours 世界尺度不同（diag 209 vs 435 等）导致的 covered 66–88% 问题，**不能用 auto 去"配平"**。两条可选路：
   - **A（零改代码）**：`cam=flux` 同机位 + 用 `covered / ink% / 内容包围盒` 描述差异，表注写明"同机位、不同世界尺度"；
   - **B（要改代码）**：新增受控 `?camdist=<k>`（乘在 Flux 原相机位置上）**并同时把测量路径的 `far` 按 `dist + 2·span` 撑开**
     （复用 `bench-view._fitClipPlanes` 的逻辑）。⚠ **只加 `camdist` 而不撑 `far` 会比现在更糟**（相机更远 ⇒ 更多模型被裁）。
3. 真机重跑：A2（D9400 部署臂 13 场景 `cam=flux`，等价 `helper01g3-*`）；D9400 base 已有（`helper01e3`）⇒ 表 7-8 两臂齐活。
4. 附加核对项：Flux-GS 官方渲染器用 `znear=0.2 / zfar=200`（`flux-gs-project-gh-pages/render_shared/main.js:161-162`），
   我们侧是 `far=100` ⇒ 同一 `cam=flux` 下我们**多裁掉了 100~200 之间的内容**。两臂一致 ⇒ 跨臂公平性不受影响，
   但与论文数字的**绝对**可比性要写进限制条件（或顺手把测量路径的 far 设成 200 与官方对齐后再复核一遍）。

### 8.9 ⚠ 第二个坑（同日追加）：`profile=r3dgs-<scene>` 逐 id 点名**解析为空**

`expandProfile()` 的点名分支带 **`!meta.baseline` 过滤**（`bench-shared.ts:1902-1905`）：

```ts
const resolved = named.filter((id) => { const meta = sceneById(list, id); return !!meta && !meta.baseline; });
if (named.length > 0 && resolved.length === named.length) return resolved;   // 否则
return [];                                                                   // ← 空表
```

5 个 reduced 场景在 `baseline-scenes.json` 里**全部**登记为 `"baseline": "reduced-3dgs"`（逐条已核）
⇒ `profile=r3dgs-kitchen` / `profile=r3dgs-bicycle` 一律返回 `[]` ⇒ **页面一个场景都不跑、也不报错、什么都不回报**
—— 这正是本机 reduced 3/3 `ok=False waited=120s` 的真因，也是"手机点开没结果"的最可能原因。

✔ 正确写法：**reduced 臂用分组 token `profile=reduced3dgs`**（`bench-shared.ts:1893`：`s.baseline === "reduced-3dgs"` ⇒ 5 个 id）；
本文臂（ours）5 个场景不是 baseline ⇒ 逐 id 点名有效（`profile=bicycle,bonsai,counter,kitchen,truck`）。

（自我印证：`helper01e2` 头部打印的 `profile=r3dgs-bicycle,r3dgs-bonsai,…` 是**展开后**的 id 列表，
说明它当时是用 `profile=reduced3dgs` 启动的 ⇒ 有数据 ✓；而 800×531 那几条 reduced 取图链接用逐 id 写法 ⇒ 必然失败 ✓。）

### 8.10 附加核对项（far 与官方渲染器的差异，同 §8.8 第 4 条）

Flux-GS 官方渲染器用 `znear=0.2 / zfar=200`（`flux-gs-project-gh-pages/render_shared/main.js:161-162`），我们侧是 `far=100`
⇒ 同一 `cam=flux` 下我们**多裁掉了 100~200 之间的内容**。两臂一致 ⇒ 跨臂公平性不受影响，
但**绝对**可比性要写进限制条件（或把测量路径 far 设成 200 与官方对齐后复核一遍）。

### 8.11 ⚠ 第三个坑（2026-10-09 追加）：回传体上限 4 MiB 会把"带 framedump 的整份记录"413 掉

- **现象**：本机 5 场景取图跑（`?framedump=1`：每场景每轮内嵌一张 800×531 无损 PNG data URL ≈ 1.2 MB）
  **页面跑完却没有任何文件落地**；唯一线索在服务端日志 `_tmp_ch7probe/out/dev_host.log`：
  `[ch7-report] 拒收（413）：body too large (>4194304 bytes)`。
- **机制**：`vite.config.js:32` 的 `CH7_MAX_BODY = 4 MiB`（原注释假设"结果文本只有几十 KB"——在 framedump 口径下不成立）
  与 `tools/ch7_report_middleware.mjs:51` 的 `CH7_MAX_BODY_DEFAULT`。5 场景 × 1 轮 ≈ **6.3 MB** > 4 MiB
  ⇒ 中间件 `req.destroy()` + 413 ⇒ **记录整份丢失**（页面端只表现为"提交失败"，不报错码）。
- **修复（2026-10-09）**：两处上限 4 MiB → **64 MiB**，并把理由与实测证据写进原注释。
  端到端验证：`curl --data-binary @6291469 字节` → `OK …raw/probe_big_20261009_123102.txt` ✓（小体量记录不受影响）。
- **影响面**：**只影响带 framedump 的取图口径**；正式数字批次（10–300 KB）从来不受影响。
  ⚠ 改上限后**必须重启 dev server** 才生效。
- **操作规范（新增）**：取图链接一次不超过 ~3 个场景（≈4 MB），或确认 dev server 已带 64 MiB 上限。

### 8.12 隧道 / dev server 的一键启动（2026-10-09 追加）

本机隧道与 dev server 会随终端关闭而消失（quick tunnel 地址每次重启都会变）。现成脚本：

- `gsplat.js\_tmp_ch7probe\ch7_boot3.cmd` → 起 `npm run dev -- --host` + `cloudflared tunnel --url http://localhost:5173`，
  抓取新地址写 `out\_cf_url.txt`、自测 `/bench.html`+两个清单+reduced PLY、
  **并按当前地址生成完整 B 组链接** `out\LINKS_B_GEN2_D9400.md`，最后进入 keep-alive 保活。
- 触发方式（脱离终端，避免被回收）：`schtasks /run /tn ch7boot3`（任务已注册）。
- 判断"隧道好不好"不要用本机直连结果：本机 DNS 常打不开 `*.trycloudflare.com`（`000` 不代表隧道坏），
  以真机实测为准；有代理时用 `curl -x http://127.0.0.1:7890` 复核。




### 8.13 ✅ 画幅公平性：`pose_src=aligned` 相机对齐协议（2026-10-09 晚）

**问题（这是「协议对、数字仍不可比」的最深一层）**：两臂虽然都走 `cam=flux`（`pose=` 指纹逐字符相同），
但**世界尺度不同**（同一场景、两条量化管线各自的归一化）⇒ 屏幕覆盖 本文臂 98.6–100% vs reduced 65.8–88%，
reduced「画得更少」⇒ 它的 fps 带正偏。**同一相机数值 ≠ 相机与场景的相对关系相同**。

**做法（任务书预定的回退路径）**：仓库内**不存在**训练相机文件（`cameras.json` / `images.txt` / `transforms.json`
全盘搜索为空）⇒ 用两侧**高斯中心点云**做配准，求出 `x_reduced = ψ(x_ours)`，再把**本文臂 flux 相机**搬进 reduced 坐标系；
本文臂机位一字未动。生成器 `gsplat.js/_tmp_ch7probe/sim3.mjs` → 资产 `gsplat.js/bench-aligned-poses.json`（站点根目录），
残差报告 `_tmp_ch7probe/out/sim3_report.txt`。

踩到的五个坑（代码里都有注释，避免下次重犯）：

1. **位置属性不是量化整数**：QPLY 写作 `property short x/y/z`，但解码走 `readHalfFromDataView` ⇒ **half-float**。
   按「整数 ÷ 缩放」解读会得到完全错的坐标（实测 half 解出的 bbox 与报表 `scene_min/max` 逐位吻合）。
2. **ICP 的最近邻残差对「沿表面切向」的误差是盲的**：位移后的点仍落在同一张表面上，NN 距离照旧很小。
   bonsai 实测：NN 残差 0.38%（≈点间距），但像素偏差 27.8px，**比完全不换机位（7.7px）还差**；
   ⇒ 必须加一步**像素域精修**（`refineByPixels`：直接最小化对应点两臂投影的像素距离，鲁棒截断 40px），精修后 5.7px。
3. **搜索半径要粗→中→细**：初始位姿误差可达 10% 场景尺度，而细网格一次查询只覆盖 ~0.5%
   ⇒ 一上来就用细网格会让绝大多数点找不到对应（bicycle 未匹配 63%、残差卡在 0.78% 不动）。
4. **裁剪分位只能用「有限」距离**：未匹配点记作 `Infinity`，若把它算进分位，高分位被推到 ∞ ⇒ 裁剪退化成 no-op。
5. **四元数/Umeyama 约定**：`RotationFromQuaternion(q)` 的输出**就是标准四元数矩阵 M 的行主序**，
   反解时**不能**再转置一次（转置让往返误差变成 O(1)，实测 1.77）；Umeyama 里 `H = Σ(x-μx)(y-μy)ᵗ` 是标准式的转置
   ⇒ `R = V·S·Uᵗ`，且 `s = trace(D·S)/Σ|x-μx|²`（H、varX 都未归一化，多乘 m 会让缩放差 m 倍，实测 s=1400 vs 0.7）。

**页面支持**：`?pose_src=aligned` ⇒ 只有命中资产里登记的场景 id（reduced 臂 `r3dgs-*`）才换机位；
本文臂与未登记场景照旧 flux。逐轮自证字段：`pose_src=aligned` / `sim3_ver=` / `sim3_s=` / `aligned_pose_ok=`
（`aligned_pose_ok=1` = 页面按资产重算的机位指纹与资产里的 `pose_key` 逐位一致）。

**验证口径（离线，先于上机）**：
1. 对应点像素一致性（ICP 对应点对分别用两臂相机投影）：全 5 场景中位 **0.8–7.9px**（未换机位时 7.7–83.3px）；
2. 本地无头 Edge 逐场景出图（`_tmp_ch7probe/vfy_run.mjs`）+ `pngstats.mjs` 给 `ink%` 与 `PSNR/SSIM` 前后对照。

**结论口径**：对齐只负责把「相机与模型的相对关系」拉平；两侧资产**不是严格相似关系**（逐轴核心尺度比不等，
如 truck 1.50/1.29/1.19），残余覆盖差属于**资产差异**（剪枝集合/离群尾不同），必须与体积、点数比一起读，
不得当成算法优劣。

