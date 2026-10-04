# 收口阶段 · 数据/计划输入（数据集清单 + T8 反例表）

> 生成：2026-10-03。与 `docs/ch6_code_facts.md`（T11）配套；论文数字必须 rounds=3 同会话 ABAB。

## 1. 全量场景清单（论文需覆盖三个数据集的**全部场景**）

点数由 **PLY 头 `element vertex N` 实测**（不靠体积反推）；体积同时给 B 与 MiB。`B/点` 一列用于交叉校验（r7 全部为 24）。

| 数据集 | scene id | QPLY 文件 | 类型 | 点数(头实测) | 体积 B | 体积 MiB | B/点 | mtime | 清单声明点数 | FINAL(r7) 兼容 |
|---|---|---|---|---|---|---|---|---|---|---|
| mip360 | garden | `point_cloud_quantised_half_r7-garden.ply` | r7 | **610,000** | 14,648,586 | 13.97 MiB | 24 | **2026-09-08 14:07** ⚠ | 610000 | 是 |
| mip360 | bicycle | `…r7-bicycle.ply` | r7 | 580,000 | 13,928,586 | 13.28 MiB | 24 | 2026-09-24 13:54 | — | 是 |
| mip360 | flowers | `…r7-flowers.ply` | r7 | 530,000 | 12,728,586 | 12.14 MiB | 24 | 2026-09-24 13:54 | — | 是 |
| mip360 | stump | `…r7-stump.ply` | r7 | 550,000 | 13,208,586 | 12.60 MiB | 24 | 2026-09-24 13:54 | — | 是 |
| mip360 | treehill | `…r7-treehill.ply` | r7 | 490,000 | 11,768,586 | 11.22 MiB | 24 | 2026-09-24 13:54 | — | 是 |
| mip360 | room | `…r7-room.ply` | r7 | 220,000 | 5,288,586 | 5.04 MiB | 24 | 2026-09-24 13:54 | — | 是 |
| mip360 | counter | `…r7-counter.ply` | r7 | 250,000 | 6,008,586 | 5.73 MiB | 24 | 2026-09-24 13:54 | — | 是 |
| mip360 | kitchen | `…r7-kitchen.ply` | r7 | 250,000 | 6,008,586 | 5.73 MiB | 24 | 2026-09-24 13:54 | — | 是 |
| mip360 | bonsai | `…r7-bonsai.ply` | r7 | 220,000 | 5,288,586 | 5.04 MiB | 24 | 2026-09-24 13:54 | — | 是 |
| tnt | truck | `…r7-truck.ply` | r7 | **273,169** | 6,564,642 | 6.26 MiB | 24 | 2026-09-24 13:54 | 273169 | 是 |
| tnt | train | `…r7-train.ply` | r7 | 287,304 | 6,903,882 | 6.58 MiB | 24 | 2026-09-24 13:54 | — | 是 |
| db | drjohnson | `…r7-drjohnson.ply` | r7 | **432,000** | 10,376,586 | 9.90 MiB | 24 | 2026-09-24 13:54 | 432000 | 是 |
| db | playroom | `…r7-playroom.ply` | r7 | 320,000 | 7,688,586 | 7.33 MiB | 24 | 2026-09-24 13:54 | — | 是 |
| mip360 | garden-std45 | `…std45-garden.ply` | std45 | 头解析失败〔待核〕 | 37,834,087 | **36.08 MiB** | — | 2026-09-24 13:54 | 610000 | 否（仅表 7-5 对照） |
| tnt | truck-std45 | `…std45-truck.ply` | std45 | 同上 | 16,950,565 | 16.17 MiB | — | 2026-09-24 13:54 | 273169 | 否（仅表 7-5） |
| db | drjohnson-std45 | `…std45-drjohnson.ply` | std45 | 同上 | 26,798,087 | 25.56 MiB | — | 2026-09-24 13:54 | 432000 | 否（仅表 7-5） |

**小计**：r7 **13** 个（三个数据集全覆盖：mip360×9 / tnt×2 / db×2）+ std45 3 个 = **16 个 .ply**。

**缺失 / 需确认清单（不替代、不推测）**

| 类别 | 内容 | 处置 |
|---|---|---|
| ⚠ 可疑过期 | **mip360/garden（r7）mtime = 2026-09-08 14:07**，比其余 15 个文件早 16 天 | 需你确认它是否属于当前 FINAL 导出流程；若否则**重新导出后重测**，本次不用旧数据代替 |
| 待补 | std45 三个文件的点数为 `?`（PLY 头格式与 r7 不同，4096 B 内未匹配到 `element vertex`） | 若表 7-5 需要，我再按实际头结构解析（不影响 FINAL 口径） |
| 待补 | `bench-scenes.json` 只声明了 garden/truck/drjohnson 的 `points` | 其余 10 个场景的点数已由**头实测**给出，建议回填清单 |

## 1b. Flux 页面实际资源清单（撤销原 `.mobilegs` 要求）

* **仓库内确实存在的 Flux 文件**（`flux-gs-project-gh-pages/`，只列 >64 KB 的数据类文件）：
  `tools/tmc3.wasm` **1,238,308 B (1.18 MiB)**、`static/images/teaser.png` 309,336 B、`motivation.png` 195,456 B、`method.png` 185,062 B、`densification.png` 67,478 B、`static/css/bulma.css.map.txt` 96,528 B。
  ⇒ **仓库内没有任何场景数据文件**（无 `.ply` / `.splat` / `.json` 场景数据）。
* **页面/脚本引用的资源 URL**（逐条判定"业务逻辑 arg + 占位符"或"外部托管"）：
  `--compressedStreamPath=/xyz.bin`、`--reconstructedDataPath=/xyz.ply`、`model.splat`、`<scene>.json`（`render_kitchen/playroom/room/stump/train/treehill/truck/main.js` 各自引用）——均为**占位/本地不存在**；
  真正取数来源是 **`https://huggingface.co/datasets/mobile-gs2/mobile-gs2/resolve/main/`**（`render_shared/main.js`），即运行时远程拉取。
* 因此 T4 的 Flux 侧体积/编码数据 **无法从仓库确定** ⇒ 标注为：**「需用户在 Network 面板提供」**，需记录每条的：文件名、URL 路径、原始字节数、传输字节数（含 `Content-Encoding`）。

## 1c. 三件〔待核〕回填状态

| 项 | 状态 |
|---|---|
| `lr=1` 每点打包字节数 | **部分**：加载期只反量化 r 个 rank 系数并写入 `lrRank`（`ArrayBuffer`，`LowRankQPLYWorker.ts:9-57`），rank 纹理为 `RGBA32UI`（`RenderProgram.ts:3018`）；**具体 B/点**需读 worker 的打包循环后给出〔下一步补〕 |
| garden 的 transform 是否单位阵 | **待实测**（需一次 `u_splatTransform` 打印）——本轮不写推测 |
| `f16 −9.8%` / `TF 生产遍 30.5 ms` 的确切来源文件名 | 归属 `shfmt2_*` 记录族（最近一批 `shfmt2_20261003_161301/161331.txt`）；**配对的具体文件对**待用 `fps_hist.csv` 按 `shfmt=f16` 与同会话 `base` 反查后回填〔下一步补〕 |


## 2. T8 反例表（只用 garden 已有数据）

| 臂 | 结果（对同机基线） | 一句话机制 | 来源文件 |
|---|---|---|---|
| `?shfmt=f16` | **−9.8%** | SH 系数改 RGBA16F 存储：取样字节数减半，但驱动侧半精度取样路径更慢 | `shfmt2_20261003_134803.txt`〔待核文件名〕 |
| TF 生产遍（`shpass=produce/consume/pre`） | 生产遍 **30.5 ms**（一次性成本） | 用 transform feedback 把逐 splat 颜色写进 VBO 再作实例属性；一次性成本高 | 〔待核：阶段 1 记录〕 |
| `?prep=1`（O2） | Adreno 740 **−5~8%**；Mali-925 **+12%** | 预处理把顶点端 ALU 换成每帧 ±15 MB 显存流量；ALU 相对弱的 Mali 净正，强的 Adreno 净负 | Gen2：`o2-prep_20261002_184301.txt` / `o3-prep_20261002_191130.txt`；Mali：`o2-prep_20261002_184917.txt` / `o3-prep_20261002_192054.txt` |
| `?prep=1&slot=1`（O3） | Adreno 740 **−66%**（frame_ms 0.40→2.50、sync_ms 13.4→37.3）；Mali-925 **−31%**（0.15→2.30、12.8→15.6） | 现象：主 pass 去掉 `index` 实例属性、改为 `gl_InstanceID` 取槽位后，移动驱动的实例化路径显著变慢（机理未验证，仅记录现象） | Gen2：`o3-slot_20261002_191221.txt`；Mali：`o3-slot_20261002_191939.txt` |

* 依据：`_tmp_ch7probe/out/f0_analysis.md`（ns/splat、sync_ms、frame_ms 全量）与上述原始文件；〔待核〕两行我下一步用 `fps_hist.csv` 反查确切文件名后回填。

## 3. 平台 id 现状（按 ①(b) 定案）

| id | 用途 | 内核 | 期望数计算 |
|---|---|---|---|
| `gen3-xweb` | 主表（Gen3 / Adreno 750） | 微信 XWEB | 核心 |
| `gen2-xweb` | **附表**（Gen2 / Adreno 740） | 微信 XWEB | 核心（已在 `PLATFORMS`） |
| `gen2-chrome` | **仅 Flux 兼容性取证**（T6，不出性能数据） | Chrome | `OPTIONAL_PLATFORMS` |
| `mali925-xweb` | **附表**（Mali-925，天玑） | 微信 XWEB | `OPTIONAL_PLATFORMS`（本轮新增） |
| `d9400-xweb` / `rtx4060` / `* -chrome` | 沿用既有定义 | — | 不变 |

* 已把已 ingest 的 11 份 Mali 记录所在目录从 `raw/mali925-chrome/` 迁到 `raw/mali925-xweb/`（不改内容）。
* **Flux 在 Gen2/Mali 不报 FPS**；Flux 兼容性证据只从 `gen2-chrome` 取（T6）。

## 4. 后续任务里的"新代码"清单（已获批）

| 项 | 位置 | 约束 |
|---|---|---|
| `?lrload=0|1` | 加载期（PLYLoader/worker 的 URL 读取） | 缺省关闭、逐字不变、零回归自证（T5 用） |
| gzip / `DecompressionStream` 体积与解压计时 | **独立测量页/脚本** | 不改默认加载路径（T4 用） |
| 桌面图像闸门（三数据集各一次 FINAL vs BASE） | `tools/ch7_color_gate*.ps1` 复用 | 无损全幅逐像素，PSNR≥45 dB、无 >8 级像素（T3；真机抓帧不做） |
