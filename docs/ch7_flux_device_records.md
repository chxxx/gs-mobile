# 已有 Flux 记录 · 首帧/加载字段只读核对（v2，按臂标识判定）

> 只读：**未新增任何测量**，数值全部来自 `thesis_project/data/ch7_measurements/raw/**` 已有记录。
> 臂判定只看 `u=`/逐轮 `arm=`/`engine=` 是否含 `flux`（v1 的全文匹配被 `pose_src=flux` 污染，作废）。

命中 Flux 记录文件 = **107**，逐轮行 = **311**（真机 208 行 / 桌面 103 行）。

## 1. 记录里出现过的加载/首帧计时字段

| 字段 | 出现次数 | 含义（记录自身 `*_def=`） |
|---|---|---|
| `fetch_ms` | 1065 | 请求发出 → 响应体接收完（**下载段**） |
| `parse_ms` | 754 | 解析/上传段（本文臂口径） |
| `decode_ms` | 311 | Flux 臂解码段（TMC3 + 逐点 MLP，worker 内） |
| `first_frame_ms` | 1065 | 响应结束 → **首个真实绘制帧** |
| 其余 `*_ms=` | cpu_ms, dispose_ms, elapsed_ms, floor_used_ms, frame_mean_ms, frame_ms, frame_p50_ms, frame_p90_ms, gap_max_ms, gap_med_ms, gap_min_ms, iframe_ms, offscreen_driver_floor_ms, offscreen_fence_wait_ms, offscreen_frame_ms, offscreen_gpu_ms, offscreen_warmup_ms, seg_draw_p50_ms, seg_draw_p90_ms, seg_ge1_p50_ms, seg_ge1_p90_ms, seg_ge2_p50_ms, seg_ge2_p90_ms, seg_post_p50_ms, seg_post_p90_ms, seg_prep_p50_ms, seg_prep_p90_ms, seg_sum_p50_ms, seg_sum_p90_ms, seg_sumofp50_p50_ms, sync_ms, sync_p50_ms, sync_p90_ms, tex_ms, timer_floor_ms | 记录里出现过的其它计时字段 |

## 2. 数值分布（min / median / max）

| 分组 | first_frame_ms | fetch_ms | parse_ms | decode_ms |
|---|---|---|---|---|
| **真机**（手机 GPU） | 11013 / 24799 / 102896（n=203） | 1882 / 6390 / 61872（n=203） | 无 | 10996 / 24772 / 102865（n=203） |
| **桌面**（ANGLE/RTX） | 19705 / 31497 / 165205（n=98） | 43 / 158 / 137820（n=98） | 无 | 19677 / 31467 / 165110（n=98） |

## 3. 三个必答问题（只陈述记录事实）

1. **是否区分「下载」与「解析/渲染」**：可分 —— `fetch_ms`（下载段）与 `first_frame_ms`（响应结束→首帧）同条共存；Flux 臂另有 `decode_ms`（worker 解码段）。
2. **当时是否走 HF 远程**：**未记录** —— Flux 记录里没有 `url=`/`model_base=` 等字段，无法从记录判断数据来自 HuggingFace 还是本地副本。
3. **网络与缓存状态**：**未记录**（无带宽/延迟/代理字段）；缓存状态**只有** `cold=1`（冷启动）标记，没有 `cache=`/`cached=` 字段。

> 不对「首帧优劣」下结论；本表只列字段名与数值区间。

## 4. 逐行明细（前 120 行；`--md` 落盘的完整表更长）

| u= | chip | dataset | scene | 日期 | 文件 | first_frame_ms | fetch_ms | parse_ms | decode_ms | fps |
|---|---|---|---|---|---|---|---|---|---|---|
| A1-flux-1600x1063-smoke | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260917 | smoke-hl-flux-r1600_20260917_182632.txt | 159325 | 337 | - | 159233 | 154.3 |
| anchor3-flux-401 | unknown | mip360 | garden | 20260928 | anchor3_20260928_162506.txt | - | - | - | - | - |
| anchor3-flux-1600 | unknown | mip360 | garden | 20260928 | anchor3_20260928_162532.txt | - | - | - | - | - |
| anchor3-flux-1600 | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | garden | 20260928 | anchor3_20260928_175040.txt | 66639 | 7336 | - | 66606 | 67.7 |
| anchor3b-flux-1600 | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | garden | 20260928 | anchor3b_20260928_175611.txt | 59160 | 6984 | - | 59119 | 88.7 |
| gen2-base-flux | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | base5-flux_20260922_185700.txt | 19537 | 4280 | - | 19493 | 73.4 |
| gen2-base-flux | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | base5-flux_20260922_185700.txt | 18539 | 5466 | - | 18511 | 72.2 |
| gen2-base-flux | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | base5-flux_20260922_185700.txt | 18544 | 5021 | - | 18519 | 72.2 |
| gen2-base-flux | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | base5-flux_20260922_185700.txt | 19427 | 5996 | - | 19386 | 73.0 |
| gen2-base-flux | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | base5-flux_20260922_185700.txt | 19056 | 2762 | - | 19028 | 73.1 |
| gen2-base-flux | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | base5-flux_20260922_185700.txt | 21113 | 3695 | - | 21083 | 69.9 |
| gen2-base-flux | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | base5-flux_20260922_185700.txt | 20787 | 8390 | - | 20759 | 69.4 |
| gen2-base-flux | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | base5-flux_20260922_185700.txt | 16716 | 4225 | - | 16683 | 69.5 |
| gen2-base-flux | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | base5-flux_20260922_185700.txt | 22240 | 3097 | - | 22204 | 68.4 |
| gen2-base-flux | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | base5-flux_20260922_185700.txt | 20304 | 3474 | - | 20282 | 70.3 |
| clr-flux-a | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | garden | 20260928 | clr_20260928_194954.txt | 70296 | 7046 | - | 70252 | 34.6 |
| clr-flux-b | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | garden | 20260928 | clr_20260928_195119.txt | 60617 | 8892 | - | 60578 | 79.4 |
| clrrep-flux-1 | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | garden | 20260928 | clrrep_20260928_201149.txt | 70376 | 6219 | - | 70336 | 61.5 |
| clrrep-flux-2 | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | garden | 20260928 | clrrep_20260928_201323.txt | 71368 | 8595 | - | 71319 | 76.9 |
| clrrep-flux-3 | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | garden | 20260928 | clrrep_20260928_201454.txt | 67784 | 7189 | - | 67745 | 115.8 |
| clrrep-flux-4 | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | garden | 20260928 | clrrep_20260928_201627.txt | 69178 | 10491 | - | 69140 | 55.7 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | bicycle | 20260922 | helper-d9400-xweb_20260922_163410.txt-20260922_204452.txt | - | - | - | - | - |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | flowers | 20260922 | helper-d9400-xweb_20260922_163410.txt-20260922_204452.txt | - | - | - | - | - |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | garden | 20260922 | helper-d9400-xweb_20260922_163410.txt-20260922_204452.txt | 47172 | 29657 | - | 47122 | 90.7 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | stump | 20260922 | helper-d9400-xweb_20260922_163410.txt-20260922_204452.txt | 23135 | 4789 | - | 23116 | 101.5 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | treehill | 20260922 | helper-d9400-xweb_20260922_163410.txt-20260922_204452.txt | 26360 | 4435 | - | 26323 | 102.1 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | room | 20260922 | helper-d9400-xweb_20260922_163410.txt-20260922_204452.txt | 14090 | 2819 | - | 14065 | 113.5 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | counter | 20260922 | helper-d9400-xweb_20260922_163410.txt-20260922_204452.txt | 14139 | 2398 | - | 14119 | 102.8 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | kitchen | 20260922 | helper-d9400-xweb_20260922_163410.txt-20260922_204452.txt | 21439 | 4286 | - | 21418 | 109.4 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | bonsai | 20260922 | helper-d9400-xweb_20260922_163410.txt-20260922_204452.txt | 19215 | 21406 | - | 19175 | 107.5 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | tnt | truck | 20260922 | helper-d9400-xweb_20260922_163410.txt-20260922_204452.txt | 16671 | 7081 | - | 16644 | 102.2 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | tnt | train | 20260922 | helper-d9400-xweb_20260922_163410.txt-20260922_204452.txt | 17015 | 5296 | - | 17001 | 94.6 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | db | drjohnson | 20260922 | helper-d9400-xweb_20260922_163410.txt-20260922_204452.txt | 16596 | 5133 | - | 16568 | 102.2 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | db | playroom | 20260922 | helper-d9400-xweb_20260922_163410.txt-20260922_204452.txt | 11013 | 3896 | - | 10996 | 103.8 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | bicycle | 20260922 | helper-d9400-xweb_20260922_164421.txt-20260922_204452.txt | 33210 | 10089 | - | 33186 | 124.1 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | flowers | 20260922 | helper-d9400-xweb_20260922_164421.txt-20260922_204452.txt | 29276 | 24105 | - | 29251 | 97.0 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | garden | 20260922 | helper-d9400-xweb_20260922_164421.txt-20260922_204452.txt | 45468 | 37192 | - | 45437 | 85.7 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | stump | 20260922 | helper-d9400-xweb_20260922_164421.txt-20260922_204452.txt | 26098 | 16477 | - | 26073 | 105.7 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | treehill | 20260922 | helper-d9400-xweb_20260922_164421.txt-20260922_204452.txt | 29153 | 7736 | - | 29131 | 97.6 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | room | 20260922 | helper-d9400-xweb_20260922_164421.txt-20260922_204452.txt | 14314 | 4064 | - | 14294 | 95.1 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | counter | 20260922 | helper-d9400-xweb_20260922_164421.txt-20260922_204452.txt | 14618 | 3301 | - | 14601 | 98.9 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | kitchen | 20260922 | helper-d9400-xweb_20260922_164421.txt-20260922_204452.txt | 24837 | 4860 | - | 24802 | 99.0 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | mip360 | bonsai | 20260922 | helper-d9400-xweb_20260922_164421.txt-20260922_204452.txt | 21123 | 3821 | - | 21103 | 98.2 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | tnt | truck | 20260922 | helper-d9400-xweb_20260922_164421.txt-20260922_204452.txt | 18321 | 4955 | - | 18307 | 104.6 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | tnt | train | 20260922 | helper-d9400-xweb_20260922_164421.txt-20260922_204452.txt | 19584 | 18297 | - | 19563 | 91.2 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | db | drjohnson | 20260922 | helper-d9400-xweb_20260922_164421.txt-20260922_204452.txt | 17874 | 7085 | - | 17861 | 97.6 |
| helper-d9400-xweb-d9400-xweb-flux | ARM Mali-925 | db | playroom | 20260922 | helper-d9400-xweb_20260922_164421.txt-20260922_204452.txt | 11169 | 4464 | - | 11146 | 98.3 |
| desk-igpu-1fa-flux | ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260929 | desk-igpu-1fa_20260929_132123.txt | 31360 | 114 | - | 31328 | 43.3 |
| desk-igpu-1fb-flux | ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260929 | desk-igpu-1fb_20260929_132357.txt | 33343 | 563 | - | 33306 | 42.2 |
| desk-igpu-2fa-flux | ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260929 | desk-igpu-2fa_20260929_132808.txt | 31246 | 563 | - | 31219 | 43.4 |
| desk-igpu-2fb-flux | ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260929 | desk-igpu-2fb_20260929_133038.txt | 29776 | 122 | - | 29747 | 43.3 |
| desk-igpu2-1fa-flux | ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260929 | desk-igpu2-1fa_20260929_132855.txt | 30282 | 119 | - | 30253 | 43.4 |
| desk-sess-1fa-flux | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260928 | desk-sess-1fa_20260928_210731.txt | 31752 | 381 | - | 31723 | 432.1 |
| desk-sess-1fa-flux | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260929 | desk-sess-1fa_20260929_124319.txt | 29722 | 137 | - | 29693 | 419.4 |
| desk-sess-1fa-flux | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260929 | desk-sess-1fa_20260929_124856.txt | 30093 | 160 | - | 30065 | 513.9 |
| desk-sess-1fa-flux | ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260929 | desk-sess-1fa_20260929_131206.txt | 29696 | 154 | - | 29668 | 43.4 |
| desk-sess-1fb-flux | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260928 | desk-sess-1fb_20260928_210808.txt | 31497 | 410 | - | 31467 | 508.4 |
| desk-sess-1fb-flux | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260929 | desk-sess-1fb_20260929_124434.txt | 30746 | 144 | - | 30718 | 483.3 |
| desk-sess-1fb-flux | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260929 | desk-sess-1fb_20260929_125050.txt | 31554 | 121 | - | 31527 | 545.2 |
| desk-sess-1fb-flux | ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260929 | desk-sess-1fb_20260929_131244.txt | 30237 | 591 | - | 30209 | 43.4 |
| desk-sess-2fa-flux | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260928 | desk-sess-2fa_20260928_211116.txt | 29315 | 555 | - | 29288 | 498.2 |
| desk-sess-2fa-flux | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260929 | desk-sess-2fa_20260929_124557.txt | 30401 | 144 | - | 30373 | 518.4 |
| desk-sess-2fb-flux | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260928 | desk-sess-2fb_20260928_211232.txt | 29234 | 569 | - | 29208 | 530.6 |
| desk-sess-2fb-flux | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260929 | desk-sess-2fb_20260929_124708.txt | 29602 | 117 | - | 29575 | 565.1 |
| desk-sess-3fa-flux | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260928 | desk-sess-3fa_20260928_211622.txt | 29105 | 560 | - | 29077 | 534.9 |
| desk-sess-3fb-flux | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260928 | desk-sess-3fb_20260928_211740.txt | 30700 | 467 | - | 30672 | 401.0 |
| desk-strict-1-flux-gs-offscreen-paper-match | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260928 | desk-strict-1_20260928_204625.txt | 29581 | 128 | - | 29549 | 415.7 |
| desk-strict2-flux-1 | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260928 | desk-strict2_20260928_204930.txt | 31510 | 407 | - | 31481 | 518.5 |
| desk-strict-flux-1 | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260928 | desk-strict_20260928_204254.txt | 32885 | 177 | - | 32845 | 538.5 |
| desktop-rehearsal-flux-gs-onscreen-realworld | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260926 | desktop-rehearsal_20260926_182713.txt | 30854 | 122 | - | 30824 | 178.6 |
| desktop-rehearsal-flux-gs-onscreen-realworld | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | flowers | 20260926 | desktop-rehearsal_20260926_182713.txt | 19943 | 85 | - | 19918 | 179.0 |
| desktop-rehearsal-flux-gs-offscreen-paper-match | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | garden | 20260926 | desktop-rehearsal_20260926_182815.txt | 30686 | 123 | - | 30658 | 623.4 |
| desktop-rehearsal-flux-gs-offscreen-paper-match | ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11) | mip360 | flowers | 20260926 | desktop-rehearsal_20260926_182815.txt | 19705 | 75 | - | 19677 | 689.7 |
| gen2-exp2A | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | exp2-A_20260922_190354.txt | 21694 | 3063 | - | 21665 | 76.0 |
| gen2-exp2A | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | exp2-A_20260922_190354.txt | 19645 | 3146 | - | 19621 | 77.7 |
| gen2-exp2A | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | exp2-A_20260922_190354.txt | 19181 | 3648 | - | 19148 | 76.0 |
| gen2-exp2A | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | exp2-A_20260922_190354.txt | 20180 | 4409 | - | 20145 | 77.0 |
| gen2-exp2A | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | exp2-A_20260922_190354.txt | 21272 | 3123 | - | 21227 | 76.4 |
| gen2-exp2A | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | exp2-A_20260922_190354.txt | 21495 | 3521 | - | 21463 | 72.1 |
| gen2-exp2A | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | exp2-A_20260922_190354.txt | 21157 | 6811 | - | 21130 | 73.2 |
| gen2-exp2A | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | exp2-A_20260922_190354.txt | 20434 | 3492 | - | 20412 | 72.0 |
| gen2-exp2A | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | exp2-A_20260922_190354.txt | 21746 | 8796 | - | 21710 | 72.7 |
| gen2-exp2A | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | exp2-A_20260922_190354.txt | 20149 | 2435 | - | 20115 | 71.4 |
| gen2-exp2B | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | exp2-B_20260922_191046.txt | 19063 | 2367 | - | 19020 | 189.6 |
| gen2-exp2B | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | exp2-B_20260922_191046.txt | 19043 | 2950 | - | 19010 | 180.4 |
| gen2-exp2B | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | exp2-B_20260922_191046.txt | 18895 | 4902 | - | 18879 | 182.5 |
| gen2-exp2B | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | exp2-B_20260922_191046.txt | 19481 | 2912 | - | 19440 | 197.7 |
| gen2-exp2B | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | exp2-B_20260922_191046.txt | 20646 | 3407 | - | 20602 | 189.4 |
| gen2-exp2B | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | exp2-B_20260922_191046.txt | 22677 | 2615 | - | 22643 | 182.2 |
| gen2-exp2B | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | exp2-B_20260922_191046.txt | 19786 | 3591 | - | 19760 | 183.6 |
| gen2-exp2B | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | exp2-B_20260922_191046.txt | 20262 | 3914 | - | 20225 | 184.9 |
| gen2-exp2B | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | exp2-B_20260922_191046.txt | 21643 | 8016 | - | 21608 | 198.4 |
| gen2-exp2B | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | exp2-B_20260922_191046.txt | 21806 | 3005 | - | 21770 | 191.7 |
| f0-flux-r3 | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | garden | 20261003 | f0-flux-r3_20261003_155425.txt | 61963 | 8684 | - | 61926 | 105.2 |
| f0-flux-r3 | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | garden | 20261003 | f0-flux-r3_20261003_155425.txt | 62036 | 43214 | - | 61998 | 108.4 |
| f0-flux-r3 | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | garden | 20261003 | f0-flux-r3_20261003_155425.txt | 62725 | 17698 | - | 62684 | 96.3 |
| g3-flux | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | garden | 20261001 | g3_20261001_163043.txt | 46054 | 7001 | - | 46022 | 121.2 |
| g3-flux | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | garden | 20261001 | g3_20261001_163043.txt | 52089 | 5287 | - | 52049 | 112.8 |
| g3-flux | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | garden | 20261001 | g3_20261001_163043.txt | 48663 | 5238 | - | 48622 | 112.0 |
| helper01-gen2-xweb-flux | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | bicycle | 20260922 | helper01_20260922_134559-20260922_135707.txt | 43068 | 8879 | - | 43020 | 71.8 |
| helper01-gen2-xweb-flux | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | flowers | 20260922 | helper01_20260922_134559-20260922_135707.txt | 43578 | 5992 | - | 43523 | 66.4 |
| helper01-gen2-xweb-flux | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | garden | 20260922 | helper01_20260922_134559-20260922_135707.txt | 70506 | 20612 | - | 70462 | 53.5 |
| helper01-gen2-xweb-flux | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | stump | 20260922 | helper01_20260922_134559-20260922_135707.txt | 32020 | 7482 | - | 31990 | 99.1 |
| helper01-gen2-xweb-flux | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | treehill | 20260922 | helper01_20260922_134559-20260922_135707.txt | 36212 | 7018 | - | 36174 | 82.3 |
| helper01-gen2-xweb-flux | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | room | 20260922 | helper01_20260922_134559-20260922_135707.txt | 16863 | 3664 | - | 16821 | 85.1 |
| helper01-gen2-xweb-flux | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | counter | 20260922 | helper01_20260922_134559-20260922_135707.txt | 18342 | 3443 | - | 18314 | 99.3 |
| helper01-gen2-xweb-flux | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | kitchen | 20260922 | helper01_20260922_134559-20260922_135707.txt | 28067 | 4232 | - | 28024 | 85.8 |
| helper01-gen2-xweb-flux | Snapdragon 8 Gen 2 (Adreno 740) | mip360 | bonsai | 20260922 | helper01_20260922_134559-20260922_135707.txt | 24799 | 2814 | - | 24772 | 91.4 |
| helper01-gen2-xweb-flux | Snapdragon 8 Gen 2 (Adreno 740) | tnt | truck | 20260922 | helper01_20260922_134559-20260922_135707.txt | 21463 | 2909 | - | 21423 | 73.5 |
| helper01-gen2-xweb-flux | Snapdragon 8 Gen 2 (Adreno 740) | tnt | train | 20260922 | helper01_20260922_134559-20260922_135707.txt | 21842 | 2403 | - | 21817 | 68.9 |
| helper01-gen2-xweb-flux | Snapdragon 8 Gen 2 (Adreno 740) | db | drjohnson | 20260922 | helper01_20260922_134559-20260922_135707.txt | 19728 | 1882 | - | 19704 | 62.8 |
| helper01-gen2-xweb-flux | Snapdragon 8 Gen 2 (Adreno 740) | db | playroom | 20260922 | helper01_20260922_134559-20260922_135707.txt | 14463 | 1917 | - | 14437 | 82.7 |
| gen3-probe-flux-all13-r3 | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | garden | 20260925 | gen3-probe-flux-all13-r3_20260925_232248.txt | 61644 | 17915 | - | 61605 | 88.9 |
| gen3-probe-flux-all13-r3 | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | garden | 20260925 | gen3-probe-flux-all13-r3_20260925_232248.txt | 61327 | 33906 | - | 61288 | 88.4 |
| gen3-probe-flux-all13-r3 | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | garden | 20260925 | gen3-probe-flux-all13-r3_20260925_232248.txt | 61414 | 13804 | - | 61376 | 88.4 |
| gen3-probe-flux-all13-r3 | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | bicycle | 20260925 | gen3-probe-flux-all13-r3_20260925_232248.txt | 40060 | 20382 | - | 40027 | 116.3 |
| gen3-probe-flux-all13-r3 | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | bicycle | 20260925 | gen3-probe-flux-all13-r3_20260925_232248.txt | 40600 | 17735 | - | 40562 | 117.5 |
| gen3-probe-flux-all13-r3 | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | bicycle | 20260925 | gen3-probe-flux-all13-r3_20260925_232248.txt | 40394 | 25174 | - | 40362 | 109.2 |
| gen3-probe-flux-all13-r3 | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | flowers | 20260925 | gen3-probe-flux-all13-r3_20260925_232248.txt | 40439 | 45421 | - | 40403 | 101.3 |
| gen3-probe-flux-all13-r3 | Snapdragon 8 Gen 3 (Adreno 750) | mip360 | flowers | 20260925 | gen3-probe-flux-all13-r3_20260925_232248.txt | 40362 | 37078 | - | 40329 | 105.1 |
