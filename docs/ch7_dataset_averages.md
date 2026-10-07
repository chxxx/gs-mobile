# 数据集平均值汇总（论文用表底稿）

> 由 `_tmp_ch7probe/dataset_avg.mjs` 生成 2026-10-07T10:15:55.714Z；**两套协议不可混表**。

## 表 1 · 协议 A：统一像素协议（`driver=timer`、无预热、`res_mode=forced` 1600×1063）

> 来源：`thesis_project/data/ch7_measurements/out/aggregated.json`（既有产物）。
> ⚠ 本文臂在该表内 **`fps_capped=true`**（帧率贴到驱动节奏上限）⇒ 按原表规则**不能用于算两臂倍数**。

| 数据集 | 方法 | 场景数 | FPS↑ | First Frame↓(ms) | Storage↓(MB) |
| --- | --- | ---: | ---: | ---: | ---: |
| Mip-NeRF 360 | 本文（Ours, r7 QPLY） | 9 | 194.9 | 2992.2 | 22.1 |
| Mip-NeRF 360 | Flux-GS（官方 WebGL 渲染器） | 9 | 134.3 | 58179.7 | 4.0 |
| Tanks and Temples | 本文（Ours, r7 QPLY） | 2 | 196.1 | 2415.5 | 16.5 |
| Tanks and Temples | Flux-GS（官方 WebGL 渲染器） | 2 | 74.8 | 20325.0 | 2.8 |
| Deep Blending | 本文（Ours, r7 QPLY） | 2 | 193.6 | 1841.5 | - |
| Deep Blending | Flux-GS（官方 WebGL 渲染器） | 2 | 135.4 | 27301.0 | 2.3 |
| **全部 13 场景** | 本文（Ours, r7 QPLY） | 13 | 194.9 | 2726.5 | 20.9 |
| **全部 13 场景** | Flux-GS（官方 WebGL 渲染器） | 13 | 125.3 | 47605.3 | 3.5 |

## 表 2 · 协议 B：Gen3 手机离屏论文口径（`offscreen-paper-match` + `msgchannel` + `frames=20/warmup=20` + `rounds=3` 冷启动）

> 来源：`raw/helper01c1/c2/c3`（本文臂）与 `raw/helper01f1/f2/f3`（Flux 臂）；全部 `ok=3/3`；两臂同机位（容差 ≤0.32°）。
> ⚠ DB 用 `helper01c3_20261006_224140`：**首测 `…212409` 是异常会话已弃用**（fetch 是后两次的 2–3 倍，FPS 75.7/86.3 vs 90.9/96.8；疑热节流），弃用记录与第二会话 `helper01d3`（91.2/96.4）互证。

| 数据集 | 方法 | 场景数 | FPS↑ | First Frame↓(ms) | Decode↓(ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| Mip-NeRF 360 | 本文（Ours, r7 QPLY） | 9 | 134.1 | 7270.2 | - |
| Mip-NeRF 360 | Flux-GS（官方 WebGL 渲染器） | 9 | 148.1 | 32722.8 | 32693.0 |
| Tanks and Temples | 本文（Ours, r7 QPLY） | 2 | 100.0 | 8073.0 | - |
| Tanks and Temples | Flux-GS（官方 WebGL 渲染器） | 2 | 110.8 | 25230.0 | 25202.5 |
| Deep Blending | 本文（Ours, r7 QPLY） | 2 | 93.8 | 8317.0 | - |
| Deep Blending | Flux-GS（官方 WebGL 渲染器） | 2 | 113.7 | 19383.0 | 19362.0 |
| **全部 13 场景** | 本文（Ours, r7 QPLY） | 13 | 122.6 | 7554.8 | - |
| **全部 13 场景** | Flux-GS（官方 WebGL 渲染器） | 13 | 137.1 | 29517.8 | 29489.7 |

### 协议 B 的覆盖场景

| 数据集 | 场景 |
| --- | --- |
| Mip-NeRF 360 | bicycle,bonsai,counter,flowers,garden,kitchen,room,stump,treehill |
| Tanks and Temples | train,truck |
| Deep Blending | drjohnson,playroom |

## 表 3 · 质量指标（PSNR / SSIM / LPIPS）现状核查

**结论：本仓库里没有"本文 vs Flux-GS 的逐场景 PSNR/SSIM/LPIPS"表**，只有下面两类质量数字：

| 类别 | 内容 | 来源 |
| --- | --- | --- |
| **真机等价性闸门**（FINAL vs BASE） | PSNR 55.75–62.27 dB、SSIM 0.9978–0.9999、最大级差 ≤9、>8 级像素 = 0 | `docs/ch7_b_layer.md`、`tools/ch7_b_layer_gate.ps1`、真机 `raw/g3png_f|b_*`（320×213 无损 PNG） |
| **桌面颜色闸门**（`notx=1` 路径等价性） | PSNR 60.03 dB、SSIM 0.999863、最大级差 5、>8 级 = 0 | `raw/colorgate_20261004_151300/151327.txt`（见 `docs/ch7_b_layer.md`） |
| **训练侧质量**（第 4 章体系） | 去掉预算剪枝 ⇒ 点数 0.411M→1.806M、体积 9.9→15.3 MB、**PSNR −0.18 dB** | `docs/ch7_project_status.md` §7.3 |

**为什么没有两臂 PSNR 表**：Flux-GS 是"压缩+解码"工作，其论文报的是体积/解码时间，没有逐场景 PSNR；
两臂的重建质量要各自"训练/量化 → 渲染 → 与参考图比"这条链路，本仓库没有做（真机抓到的是等价性闸门 PNG）。

**可立即补的（我能做）**：① 用真机 `g3png_f`/`g3png_b`（320×213 无损）出 FINAL-vs-BASE 的 PSNR/SSIM/最大差；
② 若论文第 5/6 章已有"本文 PSNR/SSIM/LPIPS 逐场景表"，告诉我文件路径，我按同样格式并入本表（含数据集平均行）。
