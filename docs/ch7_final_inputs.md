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

## 1b. Flux 页面实际资源清单（**更正**：场景数据在仓库内）

> ⚠ 更正说明：上一版本的脚本把 `.json` 从"数据文件"列表里排除了，导致误报"仓库内无场景数据"。实际路径是
> **`flux-gs-project-gh-pages/scene/<scene>.json`**（Flux 页面即用它渲染）。

**Flux 场景数据（仓库内实测，13 个 = 与我们 13 个 r7 场景一一对应）**

| scene | Flux `scene/<scene>.json` (B) | Flux (MiB) | 本文 `…r7-<scene>.ply` (B) | 本文 (MiB) | Flux/本文 |
|---|---|---|---|---|---|
| garden | 7,287,834 | 6.95 MiB | 14,648,586 | 13.97 MiB | 0.50 |
| bicycle | 4,995,740 | 4.76 MiB | 13,928,586 | 13.28 MiB | 0.36 |
| flowers | 4,939,481 | 4.71 MiB | 12,728,586 | 12.14 MiB | 0.39 |
| stump | 3,939,877 | 3.76 MiB | 13,208,586 | 12.60 MiB | 0.30 |
| treehill | 4,395,068 | 4.19 MiB | 11,768,586 | 11.22 MiB | 0.37 |
| room | 2,550,067 | 2.43 MiB | 5,288,586 | 5.04 MiB | 0.48 |
| counter | 2,430,005 | 2.32 MiB | 6,008,586 | 5.73 MiB | 0.40 |
| kitchen | 3,578,216 | 3.41 MiB | 6,008,586 | 5.73 MiB | 0.60 |
| bonsai | 3,241,322 | 3.09 MiB | 5,288,586 | 5.04 MiB | 0.61 |
| truck | 2,903,845 | 2.77 MiB | 6,564,642 | 6.26 MiB | 0.44 |
| train | 3,051,204 | 2.91 MiB | 6,903,882 | 6.58 MiB | 0.39 |
| drjohnson | 2,747,767 | 2.62 MiB | 10,376,586 | 9.90 MiB | 0.26 |
| playroom | 1,991,225 | 1.90 MiB | 7,688,586 | 7.33 MiB | 0.26 |

* 合计：Flux **42.44 MiB**（13 场景） vs 本文 r7 **114.87 MiB**（13 场景）⇒ 本文格式**更大**（比值 0.26~0.61）。

### 1b-实测 · Flux 页面运行时请求清单（2026-10-04；无头 Edge + CDP `Network` **实测**，非推断）

口径：`_tmp_ch7probe/flux_net.mjs`（`Network.enable` + `setCacheDisabled(true)` + `Page.navigate`，load 后静默 6 s 收尾），
页面 = `flux-gs-project-gh-pages/render_garden/index.html`，由本机 vite dev server 托管该静态站。

| # | 请求 | 类型 | 传输字节 | Body 字节 | Content-Encoding | 来源 |
|---|---|---|---|---|---|---|
| 1 | `https://huggingface.co/datasets/mobile-gs2/mobile-gs2/resolve/main/garden.json` | Fetch | **7,292,354** | **7,287,834** | 无（不压缩） | **远程 HF** |
| 2 | `/flux-gs-project-gh-pages/render_shared/main.js` | Script | 106,120 | 671,429 | br | 本地 |
| 3 | `/@vite/client` | Script | 29,799 | 137,725 | br | 本地（**dev 注入**） |
| 4 | `/node_modules/vite/dist/client/env.mjs` | Script | 1,694 | 4,021 | br | 本地（**dev 注入**） |
| 5 | `/flux-gs-project-gh-pages/render_shared/viewer.css` | CSS | 1,223 | 3,171 | br | 本地 |
| 6 | `/flux-gs-project-gh-pages/render_garden/index.html` | Document | 1,025 | 758 | — | 本地 |
| 7 | `/flux-gs-project-gh-pages/render_garden/main.js` | Script | 753 | 481 | — | 本地 |
| 8 | `/favicon.ico` | Other | 157 | 0 | — | 本地（404） |

* **结论 1（场景数据不是本地 json）**：`render_garden/main.js` 只设 `defaultModel:"garden.json"`、**未设 `modelBaseUrl`**
  ⇒ `render_shared/main.js:1669-1678` 的基址落到 HF。仓库内 `scene/*.json` 是**同字节副本**
  （garden：本地 7,287,834 B = HF `Content-Length` 7,287,834 B）——**页面不读它**。⇒ 13 场景表的口径应写
  "HF 上的 `<scene>.json`"，而不是"仓库内 `scene/<scene>.json`"（体积相同，来源不同）。
* **结论 2（无 xyz.bin / xyz.ply / 其它远程文件）**：`--compressedStreamPath=/xyz.bin`、`--reconstructedDataPath=/xyz.ply`
  只出现在 **Emscripten 虚拟文件系统**（`main.js:878` `writeFile('/xyz.bin')`、`:882` `mainObject/…`、`:893` `readFile('/xyz.ply')`），
  **不是网络请求**；实测 `xyz.*` 请求数 = 0，远程请求只有 HF 的 1 个 `garden.json`。json 即全部场景数据
  （msgpack：`{"xyz":{"_type":"bytes","offset":0,"length":1616757}, …"scale_code":[…ndarray float16…]}`）。
* **结论 3（`tmc3.wasm` 本次**未被请求**）**：`tools/tmc3.js`+`tools/tmc3.wasm` 只被 **Worker** 用 `importScripts`
  载入（建 worker：`main.js:1699-1707`；worker 内：`:317-349`），且仅当 Worker 收到 `mobilegs` 载荷才走解码分支。
  实测本次 garden 运行 **0 个解码器请求**（本地请求合计仅 140,771 B，远小于 `tmc3.wasm` 1,238,308 B）。
  ⇒ ① 按"**实测首次加载**"口径：**不计入**；② 按"**发布包/解码器可用**"口径：另计 **1.18 MiB**。〔**取哪一口径请你定**〕
* **结论 4（首屏代码体积）**：站点代码 = `render_shared/main.js` 671,429 B（未压缩）/ 106,120 B（brotli）
  + html/css/入口 js 小文件 ≈ **0.64 MiB 未压缩 / 0.13 MiB 线上**；其中 `@vite/client`+`env.mjs` 的 31,493 B
  是 **vite dev 注入**（正式 gh-pages 部署不存在，故线上更小）。
* **口径拆分（按你的要求）**：① **场景数据** = 7,287,834 B（**6.95 MiB**，HF `Content-Length`，实测）；
  ② **解码器** = 1,238,308 B（**1.18 MiB**，本次未加载，见结论 3）；③ **合计** = **8,526,142 B（8.13 MiB）**（含解码器）
  / **7,287,834 B（6.95 MiB）**（实测首载口径）。〔其余 12 场景待 B 层结束后用同一脚本补跑，方法不变〕
* 传输入口：`flux-gs-project-gh-pages/render_<scene>/main.js` 引用 `<scene>.json`；`render_shared/main.js` 另含
  `--compressedStreamPath=/xyz.bin` / `--reconstructedDataPath=/xyz.ply` 的**占位参数**与一条
  `https://huggingface.co/datasets/mobile-gs2/mobile-gs2/resolve/main/` 的**远程兜底路径**。
* **本机测量口径（T4）**：两面都由同一个 vite dev server 提供，dev 默认**不做 gzip**（静态文件原样发出）
  ⇒ 记录时以"原始字节 = 传输字节、`Content-Encoding: none`（本地）"为准；若要报 gzip 后体积，由 T4 的独立测量页/脚本对**同一批文件**做 gzip 后再比（不依赖 Network 面板）。若你希望以 Flux 官方站点（GitHub Pages + HuggingFace）的**真实传输编码**为准，再请从 Network 面板补录。

**仓库内其它 Flux 资源（>64 KB 的非场景文件）**：`tools/tmc3.wasm` **1,238,308 B (1.18 MiB)**、
`static/images/teaser.png` 309,336 B、`motivation.png` 195,456 B、`method.png` 185,062 B、`densification.png` 67,478 B、
`static/css/bulma.css.map.txt` 96,528 B。


## 1c. 三件〔待核〕回填状态

| 项 | 状态 |
|---|---|
| `lr=1` 每点打包字节数 | **已定案：32 B/点**。`QPLYLoaderUtils.ts:719` `new Uint32Array(8 * count)`（8×uint32 = 32 B/splat）；打包循环 `:802-809` 实际写 **6 个 uint = 24 B**（rank r=7 → 4 uint / 8 half：`(r0,r1)(r2,r3)(r4,r5)(r6,0)`；f_dc → 2 uint / 3 half：`(fdc0,fdc1)(fdc2,0)`），余 2 uint 未写。与 `ch6_code_facts.md` 的「SH 96→32 B/点」同源 |
| garden 的 transform 是否单位阵 | **仍待一次 `u_splatTransform` 打印**（本轮不做推测）。**已取得的等价证据**：`notx=1`（改用 uniform `u_splatTransform`）与原逐 splat 取样路径在 garden 上**逐像素等价** —— PSNR **60.03 dB**、SSIM 0.999863、最大级差 5、**>8 级 = 0**（`colorgate_20261004_151300/151327.txt`，见 `docs/ch7_b_layer.md`） |
| `f16 −9.8%` 的确切来源文件名 | **已确证**：BASE = `raw/shfmt2_20260929_210825.txt`（`u=shfmt2-chrome-base`、`shfmt=-`、**43.9 ± 0.4 fps**）；F16 = `raw/shfmt2_20260929_210448.txt`（`u=shfmt2-chrome-f16`、`shfmt=f16`、**39.6 ± 0.3 fps**）⇒ **(39.6−43.9)/43.9 = −9.79%**。两臂同设备（Adreno 740）/同场景（garden）/同分辨率（1600×1063）/同 `driver=msgchannel & bench_mode=offscreen-paper-match`、rounds=1 |
| `TF 生产遍 30.5 ms` 的确切来源文件名 | **部分**：TF 臂记录已定位 = `raw/stage0_20260930_190611.txt`（`arm=base`，43.1/43.5 fps）+ `raw/stage0_20260930_190730.txt`（`arm=tf_consume`，95.9/96.7 fps，两轮），唯一标识字段是 `sw_effective=…\|shpass=consume\|…`（`?shpass=pre\|produce\|consume`，见 `RenderProgram.ts:75-83/1564/1654`）。**但 `30.5 ms` 这个数字在 `raw/` 任何记录里都搜不到**（按 `shpass=produce`、`shpass=pre`、`produce_ms`、`tf_produce`、`transform feedback`、`生产遍`，以及逐文件搜 `30.5` 全部未命中）⇒ **来源不是 raw 记录**（可能是当时的控制台/中间报告）。**请指明来源文件**，否则建议把该句改为可核对的 TF 臂数据（上列两条记录） |


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
