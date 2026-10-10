# 第 7 章 · ours vs Flux-GS 官方实现的图像级对比（首次，2026-10-10）

> 目的：把既有 `ours vs reduced-3DGS` 的**并排图 + 差集掩码**口径，第一次套到 **Flux-GS 官方实现**上。
> 结论先行：**本文臂的帧有效，Flux 臂的帧无效（纯黑）**——已定位根因并修好，需重跑同两条链接；
> 数字（89.7 vs 158.7 fps）**不能**当作渲染能力结论，理由见 §3.3。

## 1. 为什么以前没做过

`ours vs reduced-3DGS` 之所以能零改动复用 `framedump=1`，是因为**两臂跑在同一个页面**（reduced 资产也在本文渲染器里渲染）。
Flux 跑在自己的 iframe（`bench-flux.html`）里，**没有任何抓帧能力**（`bench-flux.ts` 里 `framedump` 命中数 = 0）。
所以本轮先给 Flux 臂补上抓帧（两次踩坑见 §2.3），再按同一口径取帧。

## 2. 本轮改动（默认关，缺省路径逐字不变）

| 文件 | 改动 |
|---|---|
| `bench-flux.ts` | 新增 `?framedump=1`：离屏协议测完后，**绑着离屏 FBO** 调 `__FLUXGS_BENCH_FRAME_OFFSCREEN__()` 渲染一帧 → `gl.finish()` → `readPixels` → 无损 PNG 进结果行 `framedump_png=`；并回传自检 `framedump_ink_pct=` |
| `vite.site.config.js` | `maxBody` 4 MiB → **64 MiB**（与 dev 对齐）。实测 ours 那幅 base64 = **4,949,120 B ≈ 4.95 MB > 4 MiB** ⇒ 不抬上限必然 413 拒收 |

### 2.3 两次踩坑（都进过产物，必须记录）

1. `ReferenceError: sideFramePng is not defined` ×2 —— 第一次是把它声明在 `measureRound()` 局部作用域，而结果文本由 `buildResultText()` 构建；第二次更隐蔽：用 `insert_line` 插入时块落进了 `runBench()` 的函数体内部。**该 bug 会让所有 Flux 轮次都挂**（不只 framedump），已搬到模块作用域（`const FLUXSRC_OFFICIAL` 之后）。
2. **抓到纯黑**（本次真机实测）—— 根因：抓帧时**没有绑离屏目标**就调 `frame()`，Flux 把这一帧画到了**默认 framebuffer**；随后绑上 FBO 读回 ⇒ 读到空图。
   驱动逐帧的正确口径是「`target.bind()` → `frame()` → `target.unbind()`」（`driveFluxOffscreenRuns.renderFrame`，`bench-flux.ts:1116-1139`），抓帧必须照抄。
   **安全网**：新增 `framedump_ink_pct=`（非黑像素占比，阈值 8/255）⇒ 再抓到空图，结果行自己就会露馅。

## 3. 本次真机结果（同会话、同设备、同协议）

### 3.1 链接与记录

- 本文臂 → `raw/sideflux_20261010_172714.txt`（`u=sideflux-1-ours`，`arm=lr+notx+nocolortx`）
- Flux 臂 → `raw/sideflux_20261010_172756.txt`（`u=sideflux-2-flux`，`+noge=1`）

两臂都是：`res=1600x1063&res_mode=forced`、`dpr=3.6`、`frames=2&warmup=0&rounds=1`、`driver=msgchannel`、
`bench_mode=offscreen-paper-match`、`offscreen_target=fbo:1600x1063`、
`sync_policy=batch_submit_drain_at_run_end|fallback=gputimer_unavailable->batch`、`cam=flux&spin=0`。
**设备同为 Snapdragon 8 Gen 2 / Adreno 740 / XWEB 1500145**（相隔 41 秒）。

### 3.2 逐字段对照

| 字段 | ours | flux | 备注 |
|---|---|---|---|
| points | **273169** | **273169** | ✅ 逐位相同 |
| covered / drawOk | 100.0% / 1 | 100.0% | ✅ 同量级 |
| pose 指纹 | `0.467561,0.035955,0.883327,0,-0.114043,0.993277` | `0.47,0.04,0.88,0,-0.11,0.99`（2 位打印） | ✅ 同机位 |
| fx | `1159.588` | `FOC1159.6,1164.7` | ✅ 焦距对齐到 0.01% |
| bytes | 6501400（r7 QPLY） | 2850230（压缩） | ⚠️ 资产不同（既有 caveat） |
| first_frame_ms | 587 | 15242 | ⚠️ 载入期口径不可比 |
| **offscreen_fps（协议数）** | **89.7**（std 0.0） | **158.7**（std 0.0） | 见 §3.3 |
| offscreen_fps_source | wall-clock | wall-clock | ⚠️ **无 GPU 计时器**（`ext=0`，两臂都取不到） |
| frame_ms（结果头） | **1.05** | **21.95** | 帧内口径**不同源**，不可互减 |
| 分段 lab | `T0.1 F2.1 G0.0 E24.4 RA24.2 RAf0.1 RAp23.5 EL22.3` | `T0.7 F43.9 G0.3 E21.6 RA21.0 RAf0.3 RAp19.9 EL12.6` | F=2 帧合计；E=run 末排空 |
| cpu_ms（逐轮） | 11.15 | 6.30 | = EL / 2 ✅ 与 fps 自洽 |
| scene_diag | 912.36 | 666.37 | ⚠️ 资产尺度不同 |
| network_regime | （未报该字段） | `controlled`（本地副本，与 HF 同字节） | — |

### 3.3 数字怎么读（能说什么 / 不能说什么）

**能说**：在这条论文离屏协议 + 本机驱动下，**协议数**是 ours 89.7 vs flux 158.7（flux 1.77×）。

**不能说"Flux 渲染能力是 1.77×"**，三条硬理由：

1. **帧内成本倒挂**：ours 帧内 `F=2.1ms/2 帧 ≈ 1.05 ms/帧`，flux `F=43.9ms/2 帧 ≈ 21.95 ms/帧` ⇒ ours 的帧内成本只有 flux 的 **1/21**。协议数低的一方**不是**被帧内工作限制的。
2. **窗口里混进了排空**：ours 的 `E=24.4ms` 里 `RAp=23.5ms` 是 run 末 `readPixels` 等待（是它 2 帧帧内工作的 11 倍）。`batch` 策略下计时终点取在排空之后 ⇒ 协议数主要在量**提交/排空通路**。
3. **无 GPU 计时器**（`offscreen_gpu_samples=0/0`，`ext=0`）⇒ 两臂都只有 `wall-clock`，**无法把 GPU 段与 CPU 段分开**；且 22 ms 的"帧内"CPU 工作不可能塞进 6.3 ms 的帧间隔 ⇒ 两臂 `frame_ms` 字段**不同源**，不能互减。

⇒ 这条协议的数只能当**提交/排空通路**的指标（与此前「`batch` 偏袒 Flux」的机制一致），**不能**当光栅化能力。
真实使用场景请用 Onscreen-Realworld；跨臂 GPU 段归因在移动端不可得。

### 3.4 图像结果（两轮都没拿到 Flux 的帧）

| 轮次 | 臂 | PNG b64 长度 | 自检 `framedump_ink_pct` | 判定 |
|---|---|---|---|---|
| R1 17:27 | ours | 4,949,120（3.71 MB PNG） | （本文臂无该字段） | ✅ 实测 ink 99.42% |
| R1 17:27 | flux | 49,464（37 KB） | 首版无此字段 | ❌ 纯黑（250 均值 0.000） |
| R2 17:38 | ours | 4,949,120 | — | ✅ |
| R2 17:38 | flux | **49,464（一字不差）** | **0.00** | ❌ **仍纯黑** |

**两次修复的结论**（写进代码注释，避免再踩）：

1. 第一版：抓帧时**没绑离屏目标**就调 `frame()` ⇒ Flux 画到默认 framebuffer ⇒ 纯黑。
2. 第二版：改成**绑着目标**、但放在**整轮跑完之后**抓 ⇒ **仍然纯黑**（b64 与第一版完全相同、`ink=0.00`）。
   说明 run 结束之后同一块 FBO 的内容**已被清空/失效**；而它在**帧内**读回是好的（Flux 自己的 `covered` 探针就在帧内读，报 100%）。
3. 第三版（已构建，待重跑）：抓帧点搬进**驱动自己的逐帧钩子**（`driveFluxOffscreenRuns.renderFrame`，`target.bind()` 之后 / `target.unbind()` 之前、`run>=0 && frame==0`），即"驱动正在画的那一帧"。

`pngstats` 的 `PSNR=5.82 dB / SSIM=0.0024` 在此**无意义**（一方是黑图；跨臂 PSNR/SSIM 本身也无"取景一致性"含义）。
⇒ 并排图/差集掩码**等 R3 后再出**，本轮仍不出图。

### 3.5 离屏 fps：这两个值公平吗？（用你自己的两轮重复回答）

| | ours R1 | ours R2 | **自漂移** | flux R1 | flux R2 | **自漂移** |
|---|---|---|---|---|---|---|
| `offscreen_fps` | 89.7 | 88.9 | **−0.9%** | 158.7 | **253.2** | **+59.5%** |
| `frame_ms` | 1.05 | 0.70 | — | 21.95 | 11.90 | — |
| `cpu_ms` | 11.15 | 11.25 | — | 6.30 | 3.95 | — |

**同一条链接、同一会话、同一台手机**：Flux 自己两轮漂 **1.6×**，我们漂 0.9%。

**结论分两层：**

- **硬件 / 像素 / 机位 / 协议层面：公平。** 同设备同 kernel（我们两轮 `cpu_ms` 11.15→11.25 稳）、同 FBO `1600x1063`、同点数 `273169`、同机位（`pose` 对齐 + `fx` 1159.588 vs FOC1159.6）、同 `driver=msgchannel`、同 `sync_policy=batch_submit_drain_at_run_end`、同 `fps_def`、**两臂都取不到 GPU 计时器**（`ext=0`）。
- **指标语义层面：不能拿单轮数字算倍数。** ① Flux 自身 1.6× 的漂移与"要测的差异"同量级；② 无 GPU 计时器 ⇒ 只有 `wall-clock`，`batch` 又把 run 末排空算进窗口（我们那 23.5 ms 的 `readPixels` 等待就在窗口里）；③ 两臂 `frame_ms` 口径不同源、且与各自 fps 自相矛盾（Flux 11.9 ms 的"帧内"CPU 塞不进它 2.4 ms 的帧间隔）⇒ **跨臂不可互减**。

⇒ 可以并排写进报告，但必须：**(a) ≥3 轮并报中位数与极差**；**(b) 并列 `frame_ms`、`fps_source=wall-clock`、无 GPU 计时器的声明**；**(c) 不把这条数当"光栅化能力"**（真实场景看 Onscreen-Realworld）。


## 4. 复现 / 重跑

服务端当前在送 `assets/benchFlux-CsZ9qU5h.js`（抓帧点已搬进驱动逐帧钩子）。**两条链接 URL 不变，直接重开即可**：

```
# 1-ours（本文臂部署配置）
https://parking-rna-cute-craig.trycloudflare.com/bench.html?mode=bench&res_mode=forced&res=1600x1063&dpr=1&frames=2&warmup=0&driver=msgchannel&proto=flux&cam=flux&cold=1&rounds=1&framedump=1&validateframe=1&benchmode=offscreen-paper-match&runs=1&fences=3&sync=gputimer&profile=truck&report=/__ch7/report?name=sideflux&u=sideflux-1-ours&shcache=frag&lr=1&notx=1&nocolortx=1&rtok=ch7-2026-phase4

# 2-flux（+noge）
https://parking-rna-cute-craig.trycloudflare.com/bench-flux.html?mode=bench&res_mode=forced&res=1600x1063&dpr=1&frames=2&warmup=0&driver=msgchannel&proto=flux&cam=flux&cold=1&rounds=1&framedump=1&validateframe=1&benchmode=offscreen-paper-match&runs=1&fences=3&sync=gputimer&profile=truck&report=/__ch7/report?name=sideflux&u=sideflux-2-flux&noge=1&rtok=ch7-2026-phase4
```

**验收判据（不用等出图）**：结果行里 `framedump_ink_pct` 应 ≈ **100**（ours 那幅实测 99.42）。
若 flux 侧仍报 `framedump_ink_pct=0.00` ⇒ 抓帧仍未生效，别再出图。

出图（记录落盘后）：

```cmd
cd /d D:\study\project\Plasticity-Pruning-GS\gsplat.js\_tmp_ch7probe
node decode_fd.mjs ..\..\thesis_project\data\ch7_measurements\raw\sideflux_<ts>_1-ours.txt out\sfx_ours_truck.png
node decode_fd.mjs ..\..\thesis_project\data\ch7_measurements\raw\sideflux_<ts>_2-flux.txt out\sfx_flux_truck.png
node sfx_diag.mjs out\sfx_ours_truck.png out\sfx_flux_truck.png
node compose_side.mjs out\sfx_ours_truck.png out\sfx_flux_truck.png out\side_truck_ours_vs_flux.png truck 100.0 100.0 <oursFps> <fluxFps> 9481 --ours-label="本文臂（部署配置）" --other-label="Flux-GS 官方实现（+noge）" --other-short="Flux-GS"
```

> `compose_side.mjs` 本轮已参数化文案（`--ours-label/--other-label/--other-short/--sub/--note`，
> 缺省 = 原 `ours vs reduced` 文案逐字不变），因为原版标题写死"reduced-3DGS（对齐机位）"，用在 Flux 上会说错话。

## 5. 待办

1. **重跑上面两条链接**（URL 不变），先看 `framedump_ink_pct`，再出并排图 + 差集掩码。
   若 flux 侧仍报 `0.00`（即"帧内抓"也拿不到），则判定为**该臂在本设备上无法做 FBO 级取帧**，
   退路只有两条：改 Flux 自己的渲染路径（不动基线，代价大），或**放弃跨臂图像对比**、只保留本文臂的帧。
2. 数字层面若要下结论，需先解决"两臂 `frame_ms` 不同源 + 无 GPU 计时器 + Flux 自漂 1.6×"——
   即此前规划的**同会话多轮 `noge` 对照**（A ours / A′ ours 频率锚 / B flux / C flux+noge 单因子），
   并且**≥3 轮报中位数与极差**（§3.5）。
3. `flux` 侧 `dev=-`（设备 token 未填）与 ours 未报 `network_regime`：都是**结果头字段缺口**，不影响本轮结论，但报表脚本对齐时要注意。
