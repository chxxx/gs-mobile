> ⚠️ **【2026-10-10 失效标注】本文件中的 Flux 臂离屏数据可能无效** —— harness 的 `clearColor(0,0,0,1)` 状态泄漏（commit `acf1b6d`，2026-09-29 引入）使 Flux 离屏帧"绘制但无可见输出"（`ink_pct=0`）。凡引用 **2026-09-29 及之后**的 Flux 离屏 fps 的结论，一律按**待重跑**处理。判定规则/受影响记录清单/处置见 **`docs/ch7_invalidated_by_clearcolor_leak.md`**。不受影响：本文臂数据、单臂内部消融、2026-09-29 之前的记录。


# 全量状态总结：论文 ↔ 代码 ↔ 实验数据（2026-10-04 冻结版）

> **用途**：作为后续"分析新具体方案"的**输入基线**。凡本文档未列的结论，都不要当既成事实引用。
> **配套文档**：`docs/ch7_final_inputs.md`（数据集/Flux 清单 + 回填项）、`docs/ch7_flux_runtime.md`（Flux 运行时实测）、
> `docs/ch7_flux_device_records.md`（Flux 真机记录只读审计）、`docs/ch7_flux_network_ab.md`（网络口径 A/B）、
> `docs/ch7_b_layer.md`（桌面无损闸门）、`docs/ch6_code_facts.md`（代码事实）、`docs/ch7_f0_report.md`（F0 瓶颈分析）、
> `docs/ch7_measurement_protocol.md`（测帧协议）。
> **代码冻结**：渲染代码自 2026-10-04 起**冻结**，只允许追加"缺省关闭、逐字不变"的开关；FINAL 定义见 §3。

## 1. 论文结构（`thesis_project/thesis.md`，8 章 + 附录 A/B）

| 章 | 主题 | 关键小节 | 对应代码/数据 |
|---|---|---|---|
| 1 | 引言 | 端侧硬约束、现有问题、**贡献**、结构 | — |
| 2 | 相关工作 | 3DGS 基础、训练期压缩/剪枝、属性压缩/码本/熵编码、Web/移动端渲染 | — |
| 3 | 方法总览 | 整体框架、与既有剪枝路线对比与动机、模块关系 | 第4/5/6 章对应物 |
| **4** | **面向目标点数的预算感知剪枝** | 可微掩码；**温度化预算调度**；剪枝冲击缓解（目标比例对齐 / 动量趋势保护 / 恢复感知触发）；感知细节保持（低点数平滑偏置 / **LPIPS 感知重要性** / 小尺度细节保护 / 多源重要性+全局 Top-K / 周期性感知恢复 / 剪前保护-剪后恢复）；4.7 实验（综合对比、低点数分析、消融）、4.8 小结 | 训练侧脚本（`scripts/`、`gaussian_renderer/`、`utils/`）；论文表见 4.7 |
| **5** | **共享基低秩分解与属性量化** | SH rest 谱分析前提；错峰插入；共享基优化配置；SVD 初始化 + **对称平方根重参数化**；满秩重参数化对照；**分组标量量化** + **低秩系数按列码本**；朴素 45 维量化基线；量化导出与存储组织（单高斯结构、文件级组织、与端侧渲染衔接）；5.7 实验（满秩检验、坐标旋转、率失真、对称/非对称消融、联合微调阶段分解、跨数据集汇总与边界） | 导出脚本 + `scenes/point_cloud_quantised_half_r7-*.ply`（r7）与 `…std45-*.ply` |
| **6** | **QPLY 格式与 WebGL 渲染系统** | 6.2 文件格式设计；6.3 **整数纹理化存储与 shader 实时求值**；6.4 **低秩重建 CPU 并行解码**；6.5 解析器与格式兼容性；6.6 系统集成与部署；6.7 小结 | `src/loaders/*`、`src/renderers/webgl/**`、`docs/ch6_code_facts.md` |
| **7** | **系统集成与端到端实验** | 7.2 实验设置（数据集 / 硬件与测帧协议 / 指标 / 组合配置 / 对比方法）；**7.3 系统级消融**；**7.4 跨数据集端到端对比与移动端实机部署**；7.5 低秩重建端侧开销验证；7.6 目标点数×低秩秩组合分析；7.7 跨设备兼容性与定性；7.8 不同平台实机渲染效果；**7.9 测帧口径的局限与可比性边界**；**7.10 基线帧耗时差异的根因定位**（五轮复核 + 根因判定 + 机理与桌面控制）；7.11 小结 | `bench*.html/ts`、`tools/ch7_*`、`thesis_project/data/ch7_measurements/**` |
| 8 | 总结与局限性 | 全文总结、创新点、未解决局限、未来工作 | — |
| 附录 A/B | 超参数与实现配置 / 术语表与代码约定 | A.1–A.5、B.1–B.2 | — |

## 2. 代码地图（`d:\study\project\Plasticity-Pruning-GS`）

* **本文项目根**：`Plasticity-Pruning-GS/`（训练 + 导出 + 论文）；**Web 端**：`gsplat.js/`（本文实测与论文第 6/7 章的主战场）。
* **渲染核心（第 6 章对应物）**
  * `src/renderers/webgl/programs/RenderProgram.ts`：所有 shader 变体与**开关**（`shcache=frag`、`lr`、`notx`、`nocolortx`、`prep`、`slot`、`mrt`、`shfmt`、`shpass`、`shfreeze`…），并把**实际生效**的开关发布到 `window.__CH7_ARM__`（臂标签自证，防"链接标 A 实跑 B"）。
  * `src/loaders/{PLYLoader,LowRankQPLYWorker,QPLYLoaderUtils}.ts`：QPLY 解析/低秩解码；`lr=1` 打包（`QPLYLoaderUtils.ts:719` 分配 8×uint32 = **32 B/点**，打包循环 `:802-809` 实写 6 个 uint = **24 B/点**）。
* **测帧与闸门（第 7 章对应物）**
  * `bench.html` + `bench.ts` / `bench-measure.ts` / `bench-case.ts` / `bench-shared.ts` / `bench-offscreen.ts` / `bench-view.ts` / `bench-chip.ts`：逐场景 iframe + `msgchannel` 驱动 + `offscreen-paper-match` + `?framedump=1` 无损抓帧。
  * `bench-flux.html` / `bench-flux.ts`：Flux-GS 基线臂（自带实现）。
  * `tools/ch7_*`（30 个）：跑批/链接分发/真机 ingest/校验/报表/**颜色闸门**/桌面 shader 校验/B 层无损闸门/Flux 运行时抓包/Flux 真机审计/链路加工。
  * `tools/ch7_report_middleware.mjs` + `vite.config.js`：`/__ch7/report` 回传端点（**只存在于 dev/preview server**）。
* **官方 Flux 站点副本**：`flux-gs-project-gh-pages/`（13 个 `render_<scene>/`；`scene/<scene>.json` 与 HF 字节等价；页面默认**从 HF 拉**，见 `docs/ch7_flux_network_ab.md`）。
* **数据**：`scenes/*.ply`（r7×13 + std45×3）；基线 `thesis_project/data/ch7_measurements/raw/**`（记录正文 + `protocol.json`）。

## 3. 冻结口径（FINAL）与测帧协议

**FINAL = `?shcache=frag&lr=1&notx=1&nocolortx=1`**（URL 级开关；渲染代码已冻结）

| 开关 | 含义 | 在 FINAL |
|---|---|---|
| `shcache=frag` | 颜色生产遍走片元（方案 B），配 RGBA16F 颜色纹理 | ✅ |
| `lr=1` | 低秩路径：加载期**不做** C@B 重建，只打包 rank+DC（分配 32 B/点，有效写入 24 B/点） | ✅ |
| `notx=1` | 用 uniform `u_splatTransform` 取代逐 splat 变换取样（`#define NO_SPLAT_TRANSFORM`） | ✅ |
| `nocolortx=1` | 关闭 colorTransform（省 4 次/点取样） | ✅ |
| `shfmt=f16` / `shpass=produce\|consume\|pre`(TF) / `prep=1`(O2) / `slot=1`(O3) / 自动调参 / QPLY2 | 已弃路线 | ❌ 缺省关闭 |
| `shfreeze=N` | 冻结颜色缓存（静态机位逐位等价） | ❌ 仅作**性能上限参照** |

* **⚠ 生成链接的坑**：`tools/ch7_batch.py link` 产出的 URL **不含**这 4 个开关（跑的是 BASE）。
  必须先 `ch7_batch.py link` 再用 **`tools/ch7_c_links_final.py`** 追加（或在链接上手写追加）。
* **真机测帧协议**：`proto=flux`（`driver=timer&warmup=0&frames=300`）+ `rounds=3` **同会话 ABAB**，
  两臂（本文 / 基线）同 `cold`、同分辨率、同 Wi-Fi。
* **桌面闸门协议**（B 层 / 颜色正确性）：`res=320x213&res_mode=forced&dpr=1&frames=20&cold=1&rounds=1`
  + `benchmode=offscreen-paper-match&driver=msgchannel&runs=5&warmup=20&tickevery=16&fences=3&framedump=1`。

## 4. 实验结果现状（截至 2026-10-04）

### 4.1 质量/体积（第 4/5 章，训练侧，离线评测）
* 7.3 系统级消融：**去掉预算剪枝** ⇒ 点数 0.411M→4.806M、体积 9.9MB→115.3MB、**PSNR 仅 +0.18 dB**；
  **低秩量化**在点数相同条件下把体积 25.5MB→9.9MB（≈−61%）。
* 13 场景 r7：点数 220k–610k；体积 5.04–13.97 MiB（合计 **114.82 MiB**）；`B/点 = 24`（恒定）。
* SH 纹理显存：缺省 3×RGBA32UI = **96 B/点（58.6 MB @610k）**；`lr=1` 1×RGBA32UI =
  **分配 32 B/点 / 有效写入 24 B/点（19.5 MB）**。颜色缓存：8 B/splat，**不跨帧复用**。

### 4.2 桌面无损闸门（B 层，2026-10-04，13/13 全过）
FINAL vs BASE 逐像素：**PSNR 55.75–62.27 dB**、SSIM 0.9978–0.9999、最大级差 ≤8、**>8 级像素 = 0**
（判据红线：PSNR ≥ 50 dB 且 >8 级 = 0）⇒ 产物 `docs/ch7_b_layer.md`；脚本 `tools/ch7_b_layer_gate.ps1`
（含 rAF 冻结 / profile 冲突修复）与 `tools/ch7_b_layer_compare.py`。
* 副产物：`notx=1` 与逐 splat 取样路径在 garden 上**逐像素等价** ⇒ 这也是 garden transform 问题的**等价性证据**（矩阵直印仍未做）。

### 4.3 Gen3 真机（Adreno 750 / 微信 XWEB；rounds=3 同会话 ABAB；garden）
| 臂 | FPS |
|---|---|
| BASE | 52.1 |
| +`shcache=frag` | 80.4 |
| +`frag&notx&nocolortx` | 90.6 |
| **FINAL（+`lr=1`）** | **101.8** |
| `lr-frozen`（上限参照） | 120.3 |
| 同会话 Flux-GS | 103.3 |
* **瓶颈判定：片元/填充率受限**（`resscale=0.5` ⇒ +83%；`drawfrac=0.5` ⇒ +68%）。
* `prep` 预处理：Adreno **−5~8%**、Mali-925 **+12%** ⇒ 不进 FINAL。

### 4.4 Gen2 / Mali（第 7 章附表）
* Gen2（Adreno 740）与 Mali-925 已有 f0 轮次（base / frag / frag+notx+nocolortx / FINAL）。
* **Flux 在 Gen2/Mali 不报 FPS**（渲染报错）⇒ 兼容性证据只取 `gen2-chrome`；Flux 性能对比只在 Gen3。

### 4.5 Flux 对比（体积 + 运行时）
* 运行时实测（13/13）：**唯一远程请求 = HF `…/resolve/main/<scene>.json`**；场景数据合计 **45.86 MiB**
  vs 本文 r7 **114.82 MiB**（逐场景比值 0.26–0.61、均值 0.40）；本地站点代码约 0.13 MiB/场景（含 dev 注入）。
* 仓库内 `scene/*.json` 与 HF **同字节**（garden 7,287,834 B 双方一致）；页面不读本地副本（`modelBaseUrl` 未设 ⇒ 走 HF）。
* `tmc3.wasm`（1.18 MiB）在本次 capture **未被请求** ⇒ 计入与否取决于口径（"实测首载" vs "发布包"），待你定。
* 已撤销：**Flux 首帧 46–52 s 叙事**、**TF 生产遍 30.5 ms**（见 §5）。

## 5. 已撤销 / 口径债（引用前必读）

| 项 | 状态 | 说明 |
|---|---|---|
| "Flux 首帧 46–52 s / 7.5×" | **已撤销（2026-10-04）** | 见 `docs/ch7_ours_vs_flux.md:22/35`；理由：不同口径/不同配对，且 Flux 记录**未记录网络与缓存状态**（真机 `fetch_ms` 1.9–61.9 s） |
| "TF 生产遍 30.5 ms/帧" | **已撤销（2026-10-04）** | 见 `docs/ch7_desktop_investigation_status.md`（横幅）与 `docs/ch7_final_inputs.md`；理由：系**推导值**（PRODUCE_ONLY 52.9 − BASE 22.4）且可加性检验 −6% 不符；只可引用**臂级帧时** |
| Flux 体积合计 | **已更正** | 旧稿 42.44 MiB 是**求和错误** ⇒ 实测 **45.86 MiB**（13 场景） |
| 论文 6.2 "36.08 MB" | **口径冲突（未消解）** | 该值是 std45 口径；FINAL 用 r7（garden 13.97 MiB）⇒ 报告中需注明 |
| garden r7 文件 mtime | **可疑** | 2026-09-08 14:07，比其余 15 个文件早 16 天 ⇒ 需你确认是否属于当前导出流程 |
| std45 三点数未知 | 待补 | 仅表 7-5 用；不影响 FINAL |

## 6. 未完成清单与下一步

| # | 事项 | 状态 | 备注 |
|---|---|---|---|
| C | **Gen3 真机全量 13 场景 × (FINAL, flux)** | **链接已就绪（FINAL 部分）** | 3 批（mip360 9 / T&T 2 / DB 2）× 冷热；生成见 `tools/ch7_c_links_final.py`；Flux 链接等 §三 A/B 决策 |
| C' | Flux 网络口径 A/B | **待你选** | A=默认 HF（零改动）/ B=链接追加 `&url=<本地副本绝对URL>`（零文件改动）；见 `docs/ch7_flux_network_ab.md` |
| D | 消融实验（garden） | 待跑 | base/frag/frag+notx+nocolortx/FINAL，rounds=3 |
| E | 附表（Gen2-xweb / Mali-xweb） | 待跑 | 同上四臂 |
| T4 | **新增测量页/脚本**：gzip / `DecompressionStream` 体积与解压计时 | 待实现（已获批） | 独立页面，**不动默认加载路径** |
| T5 | **`?lrload=0\|1`** | 待实现（已获批） | 缺省关闭、逐字不变、零回归自证 |
| T11.9 | 冲突清单（等 6.1/6.3/6.4/6.7 与表 7-4 到手） | 待办 | — |
| T9 | 设备口径核对 | 待办 | — |
| T10 | 最终报告 `docs/ch7_final_report.md` + charts CSV + tag `thesis-final` | 待办 | 收尾前需 base+frag 零回归、`tsc` 0 error |

## 7. 事故与陷阱（务必不要再犯）

1. **`/__ch7/report` 只存在于 vite dev server** ⇒ dev server 没跑时，页面是"连接被拒绝"错误页，
   浏览器 stderr 里**连一行页面控制台都没有**（看起来像"渲染坏了"，其实没跑）。
2. **窗口被遮挡 ⇒ `requestAnimationFrame` 冻结**：`bench.ts:238 twoFrames()` 需要连续两帧 rAF，
   被遮挡时该 Promise 永不 resolve ⇒ 走不到 `finishBench()` ⇒ **无 `[RESULT]`、无回传**。
   必须加 `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
   --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion`（同 `_tmp_ch7probe/cdp.mjs`）。
3. **每轮独占浏览器 profile**：多进程共用一个 profile 目录会互删 profile ⇒ 页面起不来。
4. **回传体积上限 4 MB**（服务端 `req.destroy()` ⇒ 客户端只看到网络错误、**静默失败**）；
   无损 PNG 抓帧必须用 `res=320x213`（≈0.26 MB/臂）。
5. **判据只能是 raw 目录增量**：stderr 里 `framedump_png=` 计数恒 0 属正常（超长控制台行被截断）。
6. **臂标签自证**：只认记录里的 `sw_effective=` / `arm=`（`window.__CH7_ARM__` 发布），不要用 `u=` 备注推断。
7. **隧道每次重启换地址**；B 层/首帧测量期间不要让 C 层与桌面测量抢 dev server。

## 8. 快速上手（当前环境）

```bash
# 1) 起服务（dev server + 可选隧道）；B 层/真机链接都依赖它
powershell -ExecutionPolicy Bypass -File gsplat.js\tools\ch7_serve.ps1 -Platform gen3-xweb -Name helper01 -Group main -Rounds 3

# 2) 桌面无损闸门（13 场景 FINAL vs BASE）
powershell -ExecutionPolicy Bypass -File gsplat.js\tools\ch7_b_layer_gate.ps1
python gsplat.js\tools\ch7_b_layer_compare.py            # → docs/ch7_b_layer.md

# 3) Flux 运行时抓包（13 场景）与汇总
node   gsplat.js\tools\ch7_flux_runtime_net.mjs --url=http://127.0.0.1:5173/flux-gs-project-gh-pages/render_garden/index.html --out=gsplat.js\_tmp_ch7probe\out\flux_net_garden.json
python gsplat.js\tools\ch7_flux_runtime_summary.py --md gsplat.js\docs\ch7_flux_runtime.md

# 4) Flux 真机记录只读审计
python gsplat.js\tools\ch7_flux_device_audit.py --md gsplat.js\docs\ch7_flux_device_records.md

# 5) 生成 FINAL 链接（3 批 × 冷热）——先生成后加工，否则跑成 BASE
python gsplat.js\tools\ch7_batch.py link --base <隧道或本机> --group main --platform gen3-xweb --name helper01c1 --rounds 3 --subset bicycle,flowers,garden,stump,treehill,room,counter,kitchen,bonsai
python gsplat.js\tools\ch7_c_links_final.py
```
