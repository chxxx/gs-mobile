# B 层 · 桌面无损闸门（FINAL vs BASE，逐场景）

> 口径：`tools/ch7_b_layer_gate.ps1`（桌面 Edge；`res=320x213&res_mode=forced&dpr=1&rounds=1&cold=1`，
> `proto=flux&benchmode=offscreen-paper-match&sync=batch&driver=msgchannel&runs=5&warmup=20&tickevery=16&fences=3`，
> `framedump=1` 整幅**无损 PNG** 回传）；BASE = 全部开关缺省，FINAL = `shcache=frag&lr=1&notx=1&nocolortx=1`。
> 逐像素判据：对 BASE 的 PSNR / 最大级差 / >4、>8、>16 级像素计数；**交付红线 = PSNR ≥ 50 dB 且 >8 级 = 0**。
> 本层是**静态相机、单臂渲染**的逐像素一致性检查（不含计时对比；“同会话 ABAB”属 C 层口径）。
> 每个场景 BASE 与 FINAL 各跑一次、各占独立浏览器 profile，`rounds=1`。

### 2026-10-04 两处白跑根因与修复（写进方法学，避免误判成“渲染坏了”）

1. **dev server 未运行** ⇒ 页面是“连接被拒绝”错误页（控制台一行都没有），13 场景全部无 record。
   `/__ch7/report` 只存在于 vite dev server（`vite.config.js`），静态托管/预览页都没有该端点。
2. **窗口被遮挡 ⇒ `requestAnimationFrame` 冻结**：`bench.ts:238 twoFrames()` 需要连续两帧 rAF；
   窗口被其它窗口遮挡时 Chromium 冻结 rAF ⇒ 该 Promise 永不 resolve ⇒ 走不到 `finishBench()` ⇒
   既无 `[RESULT]` 也无 `submitReport`（服务端连一行日志都没有）。修复 = 启动标志增加
   `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling
   --disable-features=CalculateNativeWinOcclusion`（与 `_tmp_ch7probe/cdp.mjs` 同组），并让每轮独占 profile 目录。
3. 旁注：stderr 里 `framedump_png=` 计数**恒为 0 属正常**（0.26 MB base64 的控制台行被 Chromium 截断）；
   落盘判据只有 raw 目录 `colorgate_*.txt` 的**增量**。

| 场景 | 点数(声明) | BASE 文件 | FINAL 文件 | PSNR[RGB] | SSIM | 最大误差(级) | >4 级 | >8 级 | >16 级 | covered | 判定 | ≥45 dB 参考 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bicycle | 580000 | colorgate_20261004_151349.txt | colorgate_20261004_151417.txt | 62.01 dB | 0.999876 | 4 | 0 | **0** | 0 | 100.0 / 100.0 | ✅ | ✅ |
| bonsai | 220000 | colorgate_20261004_151941.txt | colorgate_20261004_152009.txt | 57.41 dB | 0.998866 | 6 | 7 | **0** | 0 | 100.0 / 100.0 | ✅ | ✅ |
| counter | 250000 | colorgate_20261004_151800.txt | colorgate_20261004_151829.txt | 57.05 dB | 0.998281 | 6 | 7 | **0** | 0 | 100.0 / 100.0 | ✅ | ✅ |
| drjohnson | 432000 | colorgate_20261004_152212.txt | colorgate_20261004_152241.txt | 60.72 dB | 0.999280 | 4 | 0 | **0** | 0 | 100.0 / 100.0 | ✅ | ✅ |
| flowers | 530000 | colorgate_20261004_151439.txt | colorgate_20261004_151507.txt | 60.25 dB | 0.999883 | 5 | 2 | **0** | 0 | 100.0 / 100.0 | ✅ | ✅ |
| garden | 610000 | colorgate_20261004_151300.txt | colorgate_20261004_151327.txt | 60.03 dB | 0.999863 | 5 | 1 | **0** | 0 | 100.0 / 100.0 | ✅ | ✅ |
| kitchen | 250000 | colorgate_20261004_151850.txt | colorgate_20261004_151919.txt | 58.98 dB | 0.999354 | 4 | 0 | **0** | 0 | 100.0 / 100.0 | ✅ | ✅ |
| playroom | 320000 | colorgate_20261004_152302.txt | colorgate_20261004_152331.txt | 55.75 dB | 0.997830 | 8 | 33 | **0** | 0 | 100.0 / 100.0 | ✅ | ✅ |
| room | 220000 | colorgate_20261004_151709.txt | colorgate_20261004_151738.txt | 62.21 dB | 0.999404 | 4 | 0 | **0** | 0 | 100.0 / 100.0 | ✅ | ✅ |
| stump | 550000 | colorgate_20261004_151529.txt | colorgate_20261004_151557.txt | 59.73 dB | 0.999751 | 5 | 2 | **0** | 0 | 100.0 / 100.0 | ✅ | ✅ |
| train | 287304 | colorgate_20261004_152121.txt | colorgate_20261004_152152.txt | 62.27 dB | 0.999715 | 3 | 0 | **0** | 0 | 100.0 / 100.0 | ✅ | ✅ |
| treehill | 490000 | colorgate_20261004_151619.txt | colorgate_20261004_151648.txt | 60.12 dB | 0.999677 | 4 | 0 | **0** | 0 | 100.0 / 100.0 | ✅ | ✅ |
| truck | 273169 | colorgate_20261004_152031.txt | colorgate_20261004_152100.txt | 57.55 dB | 0.999531 | 6 | 12 | **0** | 0 | 100.0 / 100.0 | ✅ | ✅ |

判据（交付红线）：PSNR ≥ **50 dB** 且 **>8 级像素 = 0**；最后一列为 45 dB 参考档。

整体：全部通过（13/13 场景 ≤ 红线）

