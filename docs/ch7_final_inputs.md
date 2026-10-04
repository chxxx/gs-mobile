# 收口阶段 · 数据/计划输入（数据集清单 + T8 反例表）

> 生成：2026-10-03。与 `docs/ch6_code_facts.md`（T11）配套；论文数字必须 rounds=3 同会话 ABAB。

## 1. 三个数据集清单（③）

| 数据集 | 代表场景 | QPLY（FINAL 使用：r7） | 点数 | 秩 r | SH 阶数 | QPLY 体积 | std45 对照文件（体积） | Flux 的 .mobilegs |
|---|---|---|---|---|---|---|---|---|
| **Mip-NeRF 360** | garden | `scenes/point_cloud_quantised_half_r7-garden.ply` | **610,000** | **7** | **3**（15 rest × 3 通道 = 45 系数） | **14,648,586 B = 13.97 MiB** | `…std45-garden.ply`（**37,834,087 B = 36.08 MiB**） | **N/A（仓库内不存在）** |
| **Tanks & Temples** | truck | `scenes/point_cloud_quantised_half_r7-truck.ply` | **273,169** | 7 | 3 | **6,564,642 B = 6.26 MiB** | `…std45-truck.ply`（16,950,565 B = 16.17 MiB） | **N/A（仓库内不存在）** |
| **Deep Blending** | drjohnson | `scenes/point_cloud_quantised_half_r7-drjohnson.ply` | **432,000** | 7 | 3 | **10,376,586 B = 9.90 MiB** | `…std45-drjohnson.ply`（26,798,087 B = 25.56 MiB） | **N/A（仓库内不存在）** |

* 点数取自 `bench-scenes.json` 的 `points` 字段（garden 610000 / truck 273169 / drjohnson 432000）。
* 体积为本机实测（`dir scenes\*.ply`，2026-10-03）。**论文 6.2 的「36.08 MB」= std45 口径，不是 FINAL 用的 r7 口径** ⇒ 需改口径（见 `ch6_code_facts.md` §7 冲突）。
* Flux 的 `.mobilegs`：在 `flux-gs-project-gh-pages/` 下递归搜索 **0 个命中** ⇒ 需向 Flux 官方取件；无对应文件的数据集在 T4/对比表里标 **N/A**。
* 说明：本仓库另有 bicycle/flowers/stump/treehill/room/counter/kitchen/bonsai/train/playroom 共 10 个 r7 场景文件（供扩展），但论文三数据集只用上表三个。

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
