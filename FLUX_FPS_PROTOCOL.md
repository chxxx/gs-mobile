# 内嵌副本 `runFluxBenchmark()` 钩子的协议 —— 逐行解读 + bench.html 审计

> **复刻对象（唯一参考口径）**：本地内嵌副本**新增的** `runFluxBenchmark()` 钩子
> （`flux-gs-project-gh-pages/render_shared/main.js:2351-2367` ＋ `frame()` 尾部 `2303-2339`），
> 其上游文件来自 `xiaobiaodu/flux-gs-project@d062af33bab6e74ed45f9c4b6e8ec6b3d6cff752`（gh-pages，
> 186+/4− 的仪器化，渲染语义未改，见 `FLUX_VENDOR_DIFF.md`）。
>
> ⚠️ **这不是"Flux-GS 论文协议"**：论文是否采用同一口径**未经验证**（**unknown**，检索过程见 §A.5）。
> 任何结果/文档都不得把它写成"论文协议""原 benchmark 协议"；`paperProtocolVerified=false`。
>
> 📌 **术语约定**：本文下文出现的"**参考协议 / 参考实现 / 参考臂**"**一律指内嵌副本新增的
> `runFluxBenchmark()` 钩子**（而不是论文、也不是官方仓库里本来就有的东西——官方原版没有测帧 API）。
>
> 本文三部分：
> **A. 参考协议** —— `runFluxBenchmark()` 的 14 个必答问题（逐行源码引用）＋ §A.5~A.9（口径边界、
> 指标命名、改动拆分、节拍条件判定、验证状态）
> **B. 现状审计** —— `bench.html` / `bench.ts` / `bench-case.html` / `bench-measure.ts` 与内嵌副本钩子的差异
> **C. 对齐规范** —— `proto=flux` 语义、协议复刻方式、分辨率与相机对齐、验收测试

---

# A. 参考协议：`runFluxBenchmark()` 逐行解读

## A.1 调用链

```
bench-flux.html
  └─ bench-flux.ts:571  runBenchmark(cw, st.benchFrames = 300, 240000)
       └─ bench-flux.ts:465  cw.runFluxBenchmark(300)          ← 只传 1 个参数（帧数）
            └─ render_shared/main.js:2351-2367  window.runFluxBenchmark
                 └─ render_shared/main.js:2366  setTimeout(() => frame(performance.now()), 0)
                      └─ frame()   ← 官方完整渲染帧（相机/排序/纹理/绘制）
                           └─ main.js:2303-2339  frame() 尾部：计帧 + 再排一帧 / 结算
```

> `?warmup=N` 只影响 `bench-flux.ts:568-570` 是否**额外再调用一次** `runFluxBenchmark(N)`；
> 默认 `warmup=0` ⇒ 参考臂**没有预热**（见 A.3-13）。

## A.2 伪代码（含逐行引用）

```js
// ─────────────────────────────────────────────────────────────────────
// ① 启动（render_shared/main.js:2351-2367）
// ─────────────────────────────────────────────────────────────────────
window.runFluxBenchmark = (count = 300) =>                     // 2351
    new Promise((resolve) => {                                 // 2352
        if (isBenchmarking) { resolve(null); return; }         // 2353-2356  重入保护
        isBenchmarking = true;                                 // 2358
        benchmarkFrameTarget = count;                          // 2359  请求帧数
        benchmarkFrameCount  = 0;                              // 2360
        benchmarkStartTime   = 0;                              // 2361  ★ 计时起点尚未确定
        __fluxBenchResolve   = resolve;                        // 2362
        __fluxBenchCoveredPct = 0;                             // 2363
        carousel = false;                                      // 2364  ★ 冻结相机（关轮播）
        if (rafId) cancelAnimationFrame(rafId);                // 2365  掐掉正在跑的 rAF 链
        setTimeout(() => frame(performance.now()), 0);         // 2366  ★ 用 timer 起第一帧
    });

// ─────────────────────────────────────────────────────────────────────
// ② 一"完整帧" frame(now)（官方函数；本段均为官方原有内容）
// ─────────────────────────────────────────────────────────────────────
frame(now):
    ... 键盘/触摸/手柄输入分支 ...                              // 测帧期间不会触发
    if (carousel) { 每帧按 sin(Date.now()) 改 viewMatrix }      // ★ 测帧期 carousel=false ⇒ 不动相机
    actualViewMatrix = invert4(inv2)                            // 2140
    gl.uniform3fv(u_camPos, cameraPos)                          // 2240
    viewProj = multiply4(projectionMatrix, actualViewMatrix)    // 2242
    worker.postMessage({ view: viewProj })                      // 2243 ★ 只"请求"排序，不等结果
    currentFps = 1000 / (now - lastFrame)                       // 2245
    avgFps = avgFps * 0.9 + currentFps * 0.1                    // 2246 页面显示用 EMA，与协议无关
    if (vertexCount > 0):
        spinner 隐藏
        gl.uniformMatrix4fv(u_view, false, actualViewMatrix)     // 2250
        gl.clear(gl.COLOR_BUFFER_BIT)                            // 2251
        gl.activeTexture/bindTexture(mainTexture)                // 2253-2254
        gl.activeTexture/bindTexture(shTexture)                  // 2255-2256
        gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, vertexCount) // 2263 ★ 唯一一次 draw call
        if (!__FLUXGS_STATS__.firstFrameAt) firstFrameAt = now   // 2264-2267 仪器化打点
        if (isBenchmarking && benchmarkFrameCount === 1 && coveredPct === 0)
            gl.readPixels(…)                                     // 2268-2287 仪器化：仅第 1 帧采样
    else:
        gl.clear(); spinner 显示; start = Date.now() + 2000      // 2293-2297 模型未就绪
    fps.innerText = EMA 值                                      // 2298 ★ 官方自身每帧写 DOM
    lastFrame = now                                             // 2302
    // ── 以下为本地仪器化的计帧/调度分支（2303-2339）──
    if (isBenchmarking):
        if (vertexCount > 0):
            if (benchmarkStartTime === 0) benchmarkStartTime = performance.now() // 2305 ★计时起点
            benchmarkFrameCount++                                                // 2306
            if (benchmarkFrameCount < benchmarkFrameTarget):
                setTimeout(() => frame(performance.now()), 0)                    // 2308 ★先 render 后再排帧
            else:
                elapsed = (performance.now() - benchmarkStartTime) / 1000        // 2310
                fps     = benchmarkFrameCount / elapsed                          // 2311 ★FPS 公式
                resolve({ fps, frames: benchmarkFrameCount, ms: elapsed * 1000,  // 2317-2325
                          resW: gl.canvas.width, resH: gl.canvas.height,
                          coveredPct, view: viewMatrix.map(v => round(v, 3)) })
                isBenchmarking = false; 计数器清零                               // 2327-2329
                carousel = __fluxBenchRes ? false : true                         // 2331
                rafId = requestAnimationFrame(frame)                             // 2332 恢复常驻 rAF
        else:
            setTimeout(() => frame(performance.now()), 0)                        // 2335 模型未就绪就重试
    else:
        rafId = requestAnimationFrame(frame)                                     // 2338 非测帧：官方行为
```

## A.3 14 个必答问题

| # | 问题 | 准确答案 | 引用 |
| --- | --- | --- | --- |
| 1 | 计时起点在何处 | **第一帧 `frame()` 跑完 render 之后的 `performance.now()`**：第 1 帧的 render 时间**不计入** elapsed，起点也不是第 2 帧的开始 | `main.js:2305`（位于 `gl.drawArraysInstanced`（2263）之后） |
| 2 | 先 render 还是先 setTimeout | **先 render，后 setTimeout**：每帧 = `frame()` 完成渲染 → 计帧 → `setTimeout(() => frame(now), 0)` 排下一帧 | `main.js:2308` |
| 3 | 一次「完整帧」调用了哪些函数 | `frame(now)`：相机矩阵（`invert4`/`multiply4`）→ `gl.uniform3fv(u_camPos)` → `worker.postMessage({view})` → `gl.uniformMatrix4fv(u_view)` → `gl.clear` → `gl.activeTexture/bindTexture`(main+SH) → `gl.drawArraysInstanced` | `2140, 2240, 2242, 2243, 2250-2263` |
| 4 | 是否更新相机 | **测帧期间不更新**：`runFluxBenchmark` 置 `carousel = false`（2364）；`frame()` 只在 `carousel === true` 时按 `sin(Date.now())` 改 `viewMatrix`，且不调用任何 controls.update() | `2364`、`1446`、`frame()` 顶部 carousel 分支 |
| 5 | 是否执行排序 | **只发请求、不同步执行**：`worker.postMessage({ view: viewProj })`（2243），排序在 Worker 内异步完成 | `2243` |
| 6 | 是否等待 Worker 排序结果 | **不等**。计帧段（2303-2339）内没有任何 await / 轮询；Flux 侧靠"模型已解码 + 页面已持续渲染"保证 worker 已回过 `depthIndex` | `2303-2339` |
| 7 | 是否执行纹理上传 | **帧内不做上传**：主纹理/SH 纹理仅在 worker 回消息时上传一次（`1754-1774`）；测帧帧内只有 `bindTexture` + `uniform*` | `1763-1774` vs `2253-2256` |
| 8 | 是否调用 requestAnimationFrame | **计帧期间不调用**；结算后恢复常驻链 `rafId = requestAnimationFrame(frame)`（2332）。启动前会 `cancelAnimationFrame(rafId)`（2365） | `2332`、`2365` |
| 9 | 是否调用 setTimeout(0) | **是，每帧一次**（2308；未就绪时 2335；启动 2366）。因此相邻帧之间的**定时器最短延迟（HTML 规范 4ms clamp）与任务调度开销都计入 elapsed** | `2308/2335/2366` |
| 10 | 是否等待 GPU 完成 | **不等**：全程没有 `gl.finish()` / `fenceSync` / `clientWaitSync`；帧内也没有强制同步的 `readPixels`（唯一一次在第 1 帧覆盖率采样里，且在计时起点附近、不在区间内） | 全文无 `finish`（只有 dispose 路径有，与测帧无关） |
| 11 | 最后一帧 render 时间是否计入 elapsed | **计入**：第 N 帧先 render（2263），再 `benchmarkFrameCount++`（2306），再在 `>= target` 分支读 `performance.now()` 作为终点（2310） | `2306-2311` |
| 12 | FPS 的准确公式 | `elapsed = (t_end − t_firstRenderEnd)/1000`；`fps = benchmarkFrameCount / elapsed`，`benchmarkFrameCount === count`。**分母 N，区间只覆盖第 2…N 帧（N−1 个 render 周期）** ⇒ 相对"严格 N 周期均值"偏乐观 `1/(N−1)`（N=300 时 ≈ 0.33%） | `2310-2311`、`2319` |
| 13 | warmup 的准确实现 | **没有实现**。`runFluxBenchmark(count)` 只有 1 个参数，源码中不存在 `warmup` 字样。唯一"预热"在外部：`bench-flux.ts:568-570` 在 `warmup>0` 时**额外完整跑一次** `runFluxBenchmark(warmup)` 并丢弃结果。默认 `warmup=0` ⇒ 无预热 | `2351`、`bench-flux.ts:568-570` |
| 14 | 返回的 frames 是请求值还是实际完成值 | **恒等于请求值**：只有 `benchmarkFrameCount === benchmarkFrameTarget` 才结算，返回 `frames: benchmarkFrameCount`；模型未就绪时不提前返回而是继续 `setTimeout` 重试（2335） | `2307-2319`、`2334-2336` |

## A.4 协议不变量（实现必须逐条成立）

> **一句话**：`proto=flux` = 用 `setTimeout(…, 0)` 链连续调用 N 次完整 render；计时从**第 1 次 render 结束**起、
> 到**第 N 次 render 结束**止；`fps = N / 区间秒数`；无预热；相机冻结；不等 GPU；每帧都真的提交一次绘制。

1. **render 与 timer 的顺序**：每次迭代 = `render()` → `schedule(timer)`；**绝不** `await timer → render()`。
2. **timer 开销计入 elapsed**：区间内包含 `setTimeout(0)` 的调度延迟。
3. **第一帧**：计入分子（帧数），**不**计入分母的时间区间。
4. **最后一帧**：计入分子，也计入时间区间（终点在它 render 完成之后）。
5. **warmup = 0**（参考臂不预热）。
6. **相机全程冻结**（不更新、不改 carousel、不调 controls）。
7. **排序只发请求、不等结果**。
8. **测量区间内不得出现 `gl.finish()` / `readPixels` 等强制 GPU 同步**。
9. **测量期间不得更新任何 DOM**（Flux 官方页面在 2298 行每帧写 `fps.innerText`，那是它页面自身的行为；
   本方法在测帧窗口内必须零 DOM 写入，避免引入与渲染无关的布局/合成开销——即验收项 11）。

## A.5 口径边界：论文协议 = **unknown**（检索证据）

必须把三件事分开，谁也不能替代谁：

| # | 对象 | 我们证明了什么 | 状态 |
| --- | --- | --- | --- |
| 1 | **本地内嵌副本新增的 `runFluxBenchmark()` 钩子** | 本方法新协议与它**同序同式**（§A.2/A.3 + 测试 3~7） | ✅ 已对齐（源码行号级） |
| 2 | 官方 gh-pages 渲染器的"原始行为" | 官方原版**没有任何可调用的测帧 API**（原版 `frame()` 无条件 `requestAnimationFrame`，页面 FPS 是 EMA 显示值，`main.js:2245-2246`）；"原版 benchmark 口径"不存在 | ⚠️ 无对比对象 |
| 3 | **Flux-GS 论文的 benchmark 口径** | **未做任何证明** | ❌ **unknown** |

论文口径的检索证据（2026-09-15 在本仓库内复核）：

- 仓库内**没有 Flux-GS 论文 PDF**：`paper/` 下只有 `paper/output/point_cloud_quantised_half.ply`；
  全仓 PDF 检索只命中 `glm/doc/manual.pdf`、`thesis_project/data/` 的两篇**他论文**
  （*Monte Carlo Energy Aggregation for Mobile 3D Gaussian Splatting*、*Reducing the Memory Footprint of 3DGS*）
  以及用户自己的论文 PDF。
- 本环境**没有 PDF 文本抽取库**（`pypdf` / `PyPDF2` / `fitz` / `pdfminer` 均未安装，`python -c` 返回 `[]`）。
- **官方作者代码里不存在 FPS 测量协议**：对 `Flux-GS/**` 检索 `fps|warmup|setTimeout` 只命中
  `gaussian_renderer/network_gui.py:32,39` 的 `socket.settimeout()` 与 glm 文档里的前端脚本。
- 唯一"与原论文一致"字样来自**用户自己的草稿**
  （`thesis_project/移动端口设备部署_替换清单（草稿）.md:38`，声称"与原论文第 5.1 节所述测量方法完全一致"）：
  无页码引文、无原文摘录，**不能作为证据**。

因此：

| 命题 | 判定 |
| --- | --- |
| 论文 FPS 用 `setTimeout(0)` 链 | **unknown**（来源只可追溯到内嵌副本钩子） |
| 论文用 300 帧 | **unknown**（300 是本项目默认值） |
| 论文无预热 | **unknown**（`warmup=0` 是 `proto=flux` 的本地默认；同项目另有一套 `benchmarkFPS(n)` 预热 30 帧的实现） |
| 第一帧不计入 elapsed | **unknown（论文层面）**；"内嵌副本钩子确实这么写"是**已证实**（`main.js:2305`） |

## A.6 指标命名与 GPU 同步规则

本协议在整段测量窗口内**没有任何 GPU 同步**（无 `gl.finish()` / `fenceSync` / `clientWaitSync` /
`readPixels`），因此：

```
metric = unsynchronized-webgl-frame-submission-throughput
gpuSynced = false
presentedFps = false
```

- 它测的是**主线程提交帧的吞吐**，**不得**称为 GPU FPS / GPU 渲染吞吐 / 呈现 FPS / 屏幕 FPS
  （`driver=timer` 绕过 rAF，与刷新率没有直接关系）。
- 只能说"当 GPU 饱和、驱动队列回压到 CPU 时，它在量级上接近 GPU 吞吐的上界"，但队列深度未知，
  **不能**反推 GPU 时间。

### A.6.1 最后一帧尚未完成的影响

`t1`（终点）在"发起最后一帧 draw"之后立即读取（`main.js:2310`，本方法同构），因此最多还有 `k` 帧
（管线/队列深度）GPU 工作尚未完成，这段"尾部排水时间"被排除在 elapsed 之外：

- **方向**：通常**偏乐观**（分子含该帧、分母不含它的 GPU 完成时间）。
- **大小**：**未知**（取决于队列深度/驱动/是否被隐式回压）。`k≈2~3` 的**假设**下可估算
  `≈ k·T_GPU帧 / elapsed`，N=300 时约 0.7%~1% —— 这只是一个**示例估计**，不是测得值，
  不得写成"实测约 1%"。
- 协议自身的"首帧 render 不计入 elapsed 但计入分子"是**解析可算**的：偏乐观 `1/(N−1)`
  （N=300 时 ≈ +0.33%）。

### A.6.2 若要做 GPU 排水指标，必须另立协议

`gl.finish()` / fence **只有在等待完成之后才记录终点**时才有效；如果等待本身不计入 elapsed，
那它**不能**产生任何 synchronized/GPU FPS（只是把尾部时间藏到了计时窗口之外）。正确做法：

1. 等最后一帧的 GPU 工作真正完成（`gl.finish()` 或 `fenceSync` + `clientWaitSync`）**之后**读终点；
2. 使用**不同的 protocol/metric 名称**（例：`gpu-drain-synchronized-throughput`，`gpuSynced=true`）；
3. 与 `unsynchronized-webgl-frame-submission-throughput` 的结果**分开列示**，不得混在同一列里比较。

## A.7 相对官方渲染代码的改动拆分（不再用单一 `none`）

内嵌副本相对官方 gh-pages **只有一个文件含代码改动**（`render_shared/main.js`，186+/4−），
但改动**不止"渲染算法"一类**。因此结果里必须拆成四个独立布尔（`FLUX_VENDOR_DIFF.md §4` 的 hunk 证据）：

| 字段 | 值 | 依据（本地行号） | 生效条件 |
| --- | --- | --- | --- |
| `algorithmModified` | **false** | 11 hunks 中 0 处触及 shader / 排序 / 剔除 / VQ 解码 / draw；`gl.drawArraysInstanced(gl.TRIANGLE_FAN,0,4,vertexCount)`（`main.js:2263`）参数未变 | 恒定 |
| `benchmarkLoopModified` | **true** | hunk 10：新增计帧/调度分支（`main.js:2303-2339`），并**删除**官方那句无条件的 `requestAnimationFrame(frame)`；钩子本体 `2351-2367` 也是新增 | 恒定（文件已改） |
| `resolutionModified` | **会话相关** | hunk 5：`projW/projH`（`1671-1676`）、`getProjectionMatrix` 实参（`1682-1683`）、`u_viewport`（`1686`）、`gl.canvas.width/height` 覆盖（`1690-1694`）。**不带 `?benchres=` 时 `projW === innerWidth` ⇒ 与官方等价（false）**；带 `?force=`/`?res=` ⇒ true | `?force=WxH` / `?res=WxH` |
| `cameraModified` | **会话相关** | hunk 2：`?fluxcam=N` ⇒ `camera = cameras[N]` + `carousel = false` + `viewMatrix = getViewMatrix(camera)`（`1509-1513`）；`?benchres=` ⇒ `carousel = false`（`1514-1518`）；hunk 9：外部注入 `__FLUXGS_SET_CAM__`（`2344-2349`）。**auto 机位且无 benchres ⇒ false** | `?cam=flux` / `?fluxcam=N` / 注入 viewMatrix |

结果头输出（替代旧的单一字段）：

```
algorithm_modified=<0|1>
benchmark_loop_modified=<0|1>
resolution_modified=<0|1>
camera_modified=<0|1>
modification_notes=<分号分隔的说明，空格替换为下划线>
```

## A.8 `setTimeout(0)` 的 4ms 节拍：**条件判定**，不是常量

HTML 规范里嵌套超时的最短延迟是 4ms，因此 `setTimeout(0)` 链会把两臂共同压在 ~250fps 附近。
但**是否真的观测到**这一点必须由数据判定：

```
timerClampObserved = (相邻帧开始间隔样本 ≥ 30) 且 (落在 [3.5, 4.6]ms 的占比 ≥ 50%)
```

- 阈值常量：`TIMER_CLAMP_MIN_SAMPLES=30`、`TIMER_CLAMP_GAP_MIN_MS=3.5`、`TIMER_CLAMP_GAP_MAX_MS=4.6`、
  `TIMER_CLAMP_FRACTION=0.5`（`bench-flux-protocol.ts`）。
- 只要没有实测到 4ms 聚集，`timerClampObserved` **必须是 false**；
  不得把"约 250fps 上限"写成既定结论（例如帧耗时远大于 4ms，或本来就被 rAF/合成器节流时就不是它）。
- 同时输出 `timer_gap_med_ms` / `timer_gap_p95_ms` / `timer_gap_count` 作为原始依据。
  间隔定义 = **相邻两次 render 开始时刻之差**（= 上一帧 render + 定时器调度延迟），
  与旧 rAF 口径的 `gapMedMs` 定义一致，**只作诊断、不参与任何计时**。
- 内嵌副本的钩子**没有**上报逐帧间隔 ⇒ Flux 臂这一项为 `na`（不要伪造）。

## A.9 验证状态（必须照实写）

### A.9.1 代码级检查（2026-09-15 复跑）

| 检查 | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| 全量类型检查 | `node_modules\.bin\tsc.cmd -p tsconfig.benchcheck.json --noEmit` | **失败**：仅 1 条**既有**错误 `src/renderers/webgl/utils/SortWorker.ts(232,13) TS2322`（该文件未被本次改动触及：`git diff --stat HEAD -- <file>` 为空） | **2** |
| 专项类型检查 | `node_modules\.bin\tsc.cmd --noEmit --target ES2019 --module ESNext --moduleResolution bundler --lib ESNext,WebWorker,DOM,DOM.Iterable --strict --skipLibCheck --esModuleInterop bench-flux-protocol.ts bench-flux-protocol.test.ts` | 通过（无输出） | **0** |
| Lint（7 个改动文件） | `node_modules\.bin\eslint.cmd bench-flux-protocol.ts bench-flux-protocol.test.ts bench-shared.ts bench-measure.ts bench.ts bench-case.ts bench-flux.ts` | 通过（无输出） | **0** |
| 单元测试 | `set CI=1&& node_modules\.bin\vitest.cmd run` | 通过：**35 passed** / 3 skipped（含既有 skip） | **0** |

> 注意：`bench-measure.ts` 通过 `./src/index` 依赖整个渲染器源码，**任何覆盖它的检查都会连带编译 `src/**`**，
> 因此"专项"只能覆盖不含 `src` 的两个文件（协议模块 + 其测试）；其余 bench 文件只能以
> "全量输出里没有指向它们的错误"来间接成立。
>
> 状态字段：`fullTscPassed=false, exitCode=2` / `targetedTscPassed=true, exitCode=0` /
> `eslintPassed=true` / `vitestPassed=true`。

### A.9.2 真机验证状态

**没有**任何双臂/双页面真机结果（`thesis_project/data/ch7_measurements/` 下 `raw_desktop`、
`raw_flux_native`、`out_desktop` 为空目录；`raw/0-poses.txt` 是**单臂、旧版本格式**结果，
没有 `driver=`/`view_hash=`/`protocol_matched=` 字段；`z1/z2/q.log` 中检索 `engine=|driver=|view_hash`
与 `Flux-GS Offscreen Benchmark` 均 0 命中）。

因此最终状态必须写：

```
implemented but not runtime-validated
```

**一次单臂真机 run（2026-09-15，WeChat XWEB / Android 14）**：`driver=timer`、`frames=300`、
`renders=300`、`elapsed_ms=1348`、garden `ok=1`；但其新口径字段全为空——原因是**父页面逐字段复制缺陷**
（已于本次修复，见 `FLUX_RUNTIME_VALIDATION_PLAN.md §0`），且该轮是在**修复前的构建**上跑的；
第 2/3 轮因设备上下文耗尽失败 ⇒ 仍**不能**算双臂验证。

真机核对方案见 `FLUX_RUNTIME_VALIDATION_PLAN.md`（URL + 逐字段核对表 + 结果模板）。

---

# B. 现状审计（第 3 阶段）

审计对象：`bench.html`（10 386 B / 146 行）、`bench.ts`（1 231 行）、`bench-case.html`（33 行）、
`bench-measure.ts`（789 行），以及被它们共用的 `bench-shared.ts`（512 行）、`bench-case.ts`（327 行）。

## B.1 现状对照表

| 维度 | 内嵌副本钩子协议（参考） | 现状（`bench.html`） | 是否一致 |
| --- | --- | --- | --- |
| 驱动 | `setTimeout(0)` 链 | `requestAnimationFrame`（默认） | **不一致** |
| 每帧顺序 | render → 排下一帧 | 先 `await nextFrame()` → 再 render | **不一致** |
| 计时起点 | 第 1 帧 render **结束**后 | 第 1 帧 render **之前**（预热循环之后立即 `t0`） | **不一致**（本方法多算 1 帧） |
| 计时终点 | 第 N 帧 render 结束后 | 第 N 帧 render 结束后 | 一致 |
| 帧计数 | 分子 = N（含第 1 帧） | 分子 = `frames` 计划值，`rendered` 只作诊断 | 一致（但 aborted 时仍用计划值，见 B.3-6） |
| warmup | 0 | `proto=flux` 时默认 0（`bench-shared.ts:43-46`） | 一致（**仅因 `proto=flux` 已改 warmup 默认值**） |
| 相机 | 冻结、`carousel=false` | `cam=flux` → `applyFluxCamera()` + `cameraLocked=true`（`bench-measure.ts:388-400`） | 一致 |
| 分辨率 | 原生策略：>500k 点 → 1×CSS，否则 CSS×DPR | 固定 1600×1063（`bench-shared.ts:52-55`） | **不一致**（默认口径不同，属"旧 1600×1063 口径"） |
| GPU 同步 | 无 | 无（`gl.finish()` 只在 dispose/validate 里，区间外） | 一致 |
| DOM | 参考页面自己每帧写 `#fps` | 父页面 `?diag=1` 时每 500ms 轮询写诊断行；子页面只在阶段切换时写 | **部分不一致**（见 B.3-7） |

## B.2 现状实现的关键代码（引用）

```ts
// bench-shared.ts:38-61 —— 口径常量的唯一来源（父子两页共用）
export const PROTO_FLUX = param("proto", "") === "flux";              // 39 只表示"是 flux 参考协议"
export const CAM_FLUX   = param("cam", "")   === "flux";              // 41
export function warmupFrames(): number {                              // 43
    const n = parseInt(param("warmup", PROTO_FLUX ? "0" : "10"), 10); // 44 ★ proto=flux 已改 warmup 默认
    return Number.isFinite(n) && n >= 0 ? n : 0;
}
export function benchFrameCount(): number {                           // 48
    return parseInt(param("frames", "300"), 10) || 300;               // 49
}
export function resolution(): { w: number; h: number } {              // 52
    const parts = param("res", "1600x1063").split("x");               // 53 ★ 默认仍是旧 1600×1063 口径
    return { w: parseInt(parts[0], 10) || 1600, h: parseInt(parts[1], 10) || 1063 };
}
export function effectiveFocalPx(): number {                          // 58
    const fx = parseFloat(param("fx", PROTO_FLUX ? "1159.588" : "0"));// 59 ★ proto=flux 已改焦距默认
    return Number.isFinite(fx) && fx > 0 ? fx : 1132;
}
```

```ts
// bench-measure.ts:163-227 —— 现有测帧循环（默认 rAF）
async runThroughputFrames(frames: number, warmup = 10): Promise<ThroughputStats> {   // 171
    const driver = param("driver", "raf") === "timer" ? "timer" : "raf";              // 172 ★ 默认 raf
    const nextFrame = (): Promise<void> => new Promise<void>((resolve) => {           // 173
        if (driver === "raf") requestAnimationFrame(() => resolve());                  // 176
        else setTimeout(resolve, 0);                                                   // 178
    });
    const tWarmup0 = performance.now();                                                // 182
    for (let i = 0; i < warmup; i++) { this.frameRender(); await nextFrame(); }        // 183-187 ★先 render 再等
    const warmupMs = performance.now() - tWarmup0;                                     // 188
    const t0 = performance.now();                                                      // 190 ★计时起点
    while (rendered < frames) {                                                        // 196
        await nextFrame();                                                             // 201 ★先等再 render
        gaps.push(now - last); last = now;                                             // 203-204
        this.frameRender();                                                            // 205
        rendered++;                                                                    // 206
    }
    const t1 = performance.now();                                                      // 208 ★计时终点
    // fps: elapsedMs > 0 ? frames / (elapsedMs / 1000) : 0                            // 218 ★公式同、分子用计划值
}
```

## B.3 七个必答问题

### B.3-1. `proto=flux` 是否真的自动把 driver 设为 timer？

**没有。** `proto=flux` 目前只做两件事：把 `warmup` 默认值从 10 改成 0（`bench-shared.ts:44`）、
把焦距默认值改成 Flux 的 COLMAP 焦距 `1159.588`（`bench-shared.ts:59`、`bench-measure.ts:363`）。
`driver` 只有两处取值，都不读 `proto`：

```ts
const driver = param("driver", "raf") === "timer" ? "timer" : "raf";            // bench-measure.ts:172 实际驱动
lines.push(`driver=${param("driver","raf")==="timer"?"timer":"raf"}`);          // bench.ts:369 仅打印
```

`bench.ts:372` 只把 `proto=` 原样打印，不参与任何决策。

### B.3-2. 如果没有，当前默认 driver 是否仍为 raf？

**仍然是 raf。** 两处默认值都是 `"raf"`（`bench-measure.ts:172`、`bench.ts:369`）；
`bench-case.ts:280-281` 传给 `measureOneRound` 的只有 `frames`/`warmup`。

### B.3-3. 当前 URL 未传 `driver=timer` 时采用什么驱动？

**`requestAnimationFrame`**，且循环结构是 `await nextFrame() → frameRender()`（`bench-measure.ts:201-205`），
即"**先等 vsync，再渲染**"——与 Flux 的"**先渲染，再用 timer 排下一帧**"正好相反。

### B.3-4. `cam=flux` 是否只控制相机，不控制计时器？

**是，只控制相机。** 引用链：`bench-shared.ts:41`（`CAM_FLUX`）→ `bench-case.ts:243`
（`if (CAM_FLUX) await ctx.loadFluxCamera()`）→ `bench-measure.ts:652`
（`if (!(CAM_FLUX && ctx.applyFluxCamera())) ctx.frameScene(splat)`）→ `bench-measure.ts:388-400`
（设 `fx/fy` + `position/rotation` + `camera.update()` + `cameraLocked = true`）。
`cameraLocked` 只在 `frameRender()`（`bench-measure.ts:136`）里用于跳过 `controls.update()`，
与 `runThroughputFrames` 的 driver/计时**无任何耦合**。

### B.3-5. 本方法的计时起止位置与 Flux 是否一致？

**不一致（差一帧）**：

| | Flux | 现状 |
| --- | --- | --- |
| 起点 | 第 1 帧 render **结束**后（`main.js:2305`） | 第 1 帧 render **之前**、预热结束后（`bench-measure.ts:190`；循环 196 才开始渲染） |
| 终点 | 第 N 帧 render 结束后（`main.js:2310`） | 第 N 帧 render 结束后（`bench-measure.ts:208`） |
| 后果 | elapsed 覆盖 N−1 个"render+timer"周期，分母 N | elapsed 覆盖 N 个"wait+render"周期，分母 N ⇒ **系统性偏悲观**（多算了第 1 帧 render 时间） |

### B.3-6. 两边最后一帧是否采用相同同步策略？

**相同**：两边都在最后一帧 render 返回后立即读时间戳，**都不等 GPU**。
（现状唯一的 `gl.finish()` 在 `bench-measure.ts:243/287`（测帧前的存活探针）与 `537`（dispose），
都在测量区间之外。）
**但语义有一处不同**：现状 `fps` 的分子是**计划帧数** `frames`（`bench-measure.ts:218`）而非 `rendered`；
只有 `perf.aborted || perf.rendered < opts.frames` 时才整轮判失败（`bench-measure.ts:736-741`）。
正常轮次数值等价，但没有 Flux 的 `benchmarkFrameCount` 严格。

### B.3-7. 两边是否同样包含/排除 timer 调度开销？

**不一致**：Flux 的区间包含 `setTimeout(0)` 的调度延迟（含 4ms clamp）；现状默认 rAF，
区间包含的是 vsync 等待（60Hz 平均 8.3ms，且被合成器节流），两者**不可比**。
`bench-measure.ts:164-167` 的注释也承认 `?driver=timer` 才是对照口径，但**默认是 raf**，
且 `proto=flux` 不会把它切过去。

**下半段**：即使显式传了 `driver=timer`，现状帧序仍是"先等 timer，再 render"（`bench-measure.ts:201→205`），
而 Flux 是"先 render，再排 timer"（`main.js:2308`）——timer 延迟归属"迭代开头"还是"迭代结尾"不同，
加上第 1 帧边界口径不同（B.3-5），因此**仍不能算同一协议**，必须走第 C 章的 `runFluxCompatibleBenchmark`。

## B.4 其他与协议相关的现状事实

| 事实 | 位置 |
| --- | --- |
| 分辨率被硬设成 `res=WxH`、`pixelRatio=1`、`disableAutoResize()` | `bench-measure.ts:126-132` |
| 每轮断言 `canvas.width/height/drawingBuffer == res`，不一致只打 ⚠ 不判失败 | `bench-measure.ts:633-639` |
| 画布统计只有 `canvas= / drawingBuffer= / css=`，缺 `viewport`、内部渲染尺度、`adaptiveResolution` | `bench-measure.ts:142-161` |
| 测帧前跑"存活探针"（最多 20 帧 + `gl.finish()` + `readPixels`），默认开启 | `bench-measure.ts:463-494`、`709-726` |
| 测帧后再 `frameRender()` 一次做覆盖率采样（不进 FPS） | `bench-measure.ts:747`、`279-307` |
| 相机资产 = Flux 的 `default_view`（位置 + 四元数），注入后 `cameraLocked = true` | `bench-measure.ts:377-400` |
| 结果头已打印 `proto=` / `cam=` / `warmup=` / `driver=`，但没有 `protocolMatched=` / 分辨率模式 / 相机哈希 | `bench.ts:363-382` |
| `?diag=1` 时父页面每 500ms 轮询子页面 DOM 并改自己的诊断行（会跑在测量期间） | `bench.ts:308-332` |

---

# C. 对齐规范（第 4~8 阶段的实现口径）

实现落点：

| 文件 | 角色 |
| --- | --- |
| **`gsplat.js/bench-flux-protocol.ts`（新增）** | **共享 harness**：Flux 协议的**唯一实现**（纯逻辑、不 import `src/`、不碰 GL/DOM），父子两页与单元测试共用 |
| `bench-shared.ts` | 口径常量改由 harness 提供；保留原有导出以兼容旧调用 |
| `bench-measure.ts` | `BenchCase.runFluxCompatibleBenchmark()`：把 harness 接到真实 GL 上（`render` = `frameRender`，`schedule` = `setTimeout(…,0)`） |
| `bench.ts` | 结果头字段、`protocolMatched` 显著警告、`resolution mode`、相机哈希、实际 drawing buffer |
| `bench-case.ts` | 把协议/驱动参数带进测量；测量期间零 DOM 更新 |
| `bench-flux-protocol.test.ts`（新增） | 第 9 阶段验收测试（vitest） |

## C.1 `proto=flux` 的语义（第 4 阶段）

```ts
// bench-flux-protocol.ts（设计契约）
export interface FluxProtocolSpec {
    protocol: "flux" | "custom";
    driver: ThroughputDriver;          // flux 协议 ⇒ "timer"（setTimeout(0) 链）
    driverSource: "flux-protocol" | "explicit-override" | "default";
    frames: number;                    // flux 协议默认 300
    warmup: number;                    // flux 协议默认 0
    cameraFrozen: boolean;             // flux 协议 ⇒ true
    adaptiveResolution: boolean;       // flux 协议 ⇒ false
    resolutionMode: "flux-native" | "flux-fixed";
    forcedRes: { w: number; h: number } | null;
    overrides: string[];               // 允许的显式覆盖，例：["frames=500","warmup=30"]
    conflicts: string[];               // 冲突参数，例：["driver=raf"]
    protocolMatched: boolean;          // conflicts 为空且 driver==="timer" 才为 true
    sourceCommit: string;              // "d062af33bab6e74ed45f9c4b6e8ec6b3d6cff752"
    modifications: string[];           // 相对官方 Flux 的渲染改动（本仓库为 []）
}
```

**规则（逐条绑定验收测试）**

1. `proto=flux` **自动**给出：`driver=timer`、`warmup=0`、`frames=300`、`cameraFrozen=true`、
   `adaptiveResolution=false`、`resolutionMode=flux-native`；**不要求**用户同时写 `driver=timer`。
   *不可被静默覆盖*：这些默认值不会因为别处代码再读一次 `param("driver","raf")` 而失效。
2. **允许的显式覆盖**：`warmup=N`、`frames=N`、`force=WxH`（或显式 `res=WxH`）。被覆盖项记入
   `overrides`，`protocolMatched` 仍为 `true`（帧数/预热/分辨率属协议允许变体）。
3. **冲突参数**：`driver=` 的任何非 `timer` 取值（典型 `driver=raf`）。
   - 行为：**按用户显式要求执行**（真的用 rAF 跑），但
   - `conflicts += "driver=raf"`、`protocolMatched = false`；
   - 页面顶部显示**显著警告**（红底横幅 + `console.warn`）；
   - 结果头写 `protocol_matched=0`、`flux_compatible=0`：**禁止**把该轮归类为 Flux-compatible FPS。
   - 理由：跑了什么就标什么；而默认路径（只写 `proto=flux`）一定是 timer。
4. 未传 `proto` 时：`protocol="custom"`、`driver` 默认 `"raf"`（保持旧行为）、`protocolMatched=false`。

## C.2 协议复刻方式与"本方法运行时 ↔ 测试"的代码复用（第 5 阶段）

**Flux 一侧不共享任何运行时代码**（`render_shared/main.js` 里检索 `bench-flux-protocol` = 0 命中；
`bench-flux.html:110` 只加载 `./bench-flux.ts`，`render_<scene>/index.html:18-19` 只加载
`main.js` 与 `../render_shared/main.js`）。因此本方法对 Flux 的复制方式是：

- **协议复刻（protocol replica）**：把 `main.js:2303-2339 + 2351-2367` 的行为按行移植（§A.2 的星号 ↔ 行号）；
- **共享 harness 只指**：本方法运行时（`bench-measure.ts` 注入 `render/schedule/now`）与**单元测试**
  （假调度器）调用的是同一个 `runFluxLoop()`；再加一份**同源对拍实现** `runFluxLoopReference()` 用于测试比对。

```ts
// bench-flux-protocol.ts —— 与 render_shared/main.js:2303-2339 一一对应
export interface FluxLoopHooks {
    render: () => void;                    // 一次完整 render（相机冻结 / 排序只发请求 / 纹理绑定 / 一次 draw）
    schedule: (cb: () => void) => void;    // setTimeout(() => cb(), 0)
    now: () => number;                     // performance.now()
    shouldAbort?: () => string | null;     // "hidden" | "context-lost" | … ⇒ 本轮作废
    onFrame?: (index: number) => void;     // 诊断回调（**不得**写 DOM）
}
export interface FluxLoopResult { frames: number; renders: number; elapsedMs: number; fps: number; abortedReason: string }
export function runFluxLoop(frames: number, warmup: number, hooks: FluxLoopHooks): Promise<FluxLoopResult>;
```

`runFluxLoop` 的执行顺序（**去掉 GL 之后的 A.2**）：

```
warmup 次：render(); schedule(下一帧)       // 参考臂 warmup 默认 0；>0 时语义 = 额外完整跑一次
startTime = null; count = 0
tick():
  render()                                   // ★ 先 render（main.js:2263）
  if (startTime === null) startTime = now()  // ★ main.js:2305 计时起点
  count++
  if (count < frames) schedule(tick)         // ★ main.js:2308 先 render 后 setTimeout(0)
  else { elapsedMs = now() - startTime;      // ★ main.js:2310
         resolve({ frames: count, renders: count, elapsedMs, fps: count / (elapsedMs/1000) }) }  // ★ 2311
```

接入本方法渲染器（`bench-measure.ts`）：

```ts
runFluxCompatibleBenchmark(frames: number, warmup: number): Promise<FluxLoopResult> {
    return runFluxLoop(frames, warmup, {
        render: () => this.frameRender(),
        schedule: (cb) => { window.setTimeout(cb, 0); },   // 复刻 setTimeout(0)，不用 rAF
        now: () => performance.now(),
        shouldAbort: () => (this.stopped ? "stopped"
            : (typeof document !== "undefined" && document.visibilityState === "hidden") ? "hidden"
            : this.contextLost ? "context-lost" : null),
    });
}
```

`runThroughputFrames(frames, warmup)` 退化为**调度器**：

- `spec.driver === "timer"`（`proto=flux` 默认）→ 走 `runFluxCompatibleBenchmark`（精确复刻）；
- `spec.driver === "raf"` → 保留旧 rAF 循环，结果标 `fluxCompatible=false`。

两侧调用**同一个** `runFluxLoop`，因此第 9 阶段的时序测试只需在 node 里用假调度器/假时钟驱动它，
即可证明"render/timer 顺序、计时起止、FPS 公式"与参考实现一致（测试 5/6/7），
而不是靠人工比对两个近似实现。

## C.3 两种分辨率协议（第 6、7 阶段）

### C.3.1 `flux-native`（默认：`proto=flux` 且未给 `force`/`res`）

复刻 `main.js:1551-1552` + `1688-1689`：

```
downsample = pointCount > 500000 ? 1 : 1 / devicePixelRatio      // main.js:1551-1552
bufW = round(cssW / downsample);  bufH = round(cssH / downsample) // main.js:1688-1689，cssW/H = iframe 视口
fx_render = fluxFocalPx / downsample
   // 依据：Flux 的投影是 [(2*fx)/innerWidth, …]（main.js:164），即焦距按 CSS 宽度归一；
   //       本方法投影是 (2*fx')/bufW（CameraData.ts:28）⇒ fx' = fx * bufW/innerWidth = fx/downsample
renderer.setPixelRatio(1); renderer.setSize(bufW, bufH)
```

输出 `protocol=flux-native`；**不要**把 CSS 显示尺寸当成渲染分辨率（CSS 只记录）。 
`res=` 若显式给出则**不**再适用本模式（进入 flux-fixed），因为原生模式的分辨率由设备视口决定。

### C.3.2 `flux-fixed`（`force=1600x1063` 或显式 `res=1600x1063`）

- 两边强制完全相同的 drawing buffer：Flux 侧走 `?benchres=WxH`（`main.js:1690-1694`，
  同时把投影/viewport 的 `projW/projH` 也换成 `WxH`，见 `main.js:1674-1675`）；
  本方法侧 `renderer.setPixelRatio(1); renderer.setSize(W, H)`（`bench-measure.ts:126-132` 已有）；
- 焦距口径：官方在 `benchres` 模式下投影用的是 `projW = benchres.w = W`（`main.js:1674-1675`），
  焦距保持 `1159.588` ⇒ 本方法 `setSize(W,H)` 后**直接沿用同一个焦距**（**不要**按 CSS 缩放）
  —— 这样两边的 `2*fx/W` 完全相同。实现见 `replicationFocalPx()`。
- 实现细节：`buildCasePageUrl()` 在 native 模式下**不会**把 `res=` 写进子页面 URL，
  否则子页面会把它当成强制分辨率而切到 flux-fixed（父子口径分叉）。
- 输出 `protocol=flux-fixed`。
- **措辞约束**：`flux-fixed`（例如 1600×1063）**不得**被称作"论文原始分辨率"，
  除非论文明确写了它就是在该分辨率下测的。

### C.3.3 每轮必须输出的分辨率审计块（第 6 阶段）

```json
{ "canvasWidth": 1600, "canvasHeight": 1063,
  "drawingBufferWidth": 1600, "drawingBufferHeight": 1063,
  "viewport": [0, 0, 1600, 1063],
  "cssWidth": 0, "cssHeight": 0, "devicePixelRatio": 0,
  "internalRenderScale": 1, "adaptiveResolution": false }
```

- `cssWidth/cssHeight/devicePixelRatio` 由**子页面自己**上报真实值（`canvas.clientWidth/Height`、
  `window.devicePixelRatio`）；父页面拿不到时填 `0`，**不允许**用 CSS 尺寸冒充渲染分辨率；
- `internalRenderScale`：本方法固定为 `1`（无内部缩放）；`adaptiveResolution`：本方法为 `false`；
- **有效性判据**：下列字段必须两边完全相同，否则该轮标 `resMatch=false`（结果作废）：
  `canvasWidth`、`canvasHeight`、`drawingBufferWidth`、`drawingBufferHeight`、`viewport`、内部 framebuffer。

## C.4 相机对齐（第 8 阶段）

测帧开始时两边必须同时满足：**相机冻结**（本方法 `cameraLocked=true`，Flux 侧 `carousel=false`）、
**同一初始 view matrix**（`bench-flux-camera.json` 的 `default_view`，或 `?fluxcam=N`）、
**同一 projection/focal**（`focal_px = 1159.5880733038064`）。

每轮额外输出：

```
viewMatrix                  完整 16 个数（不再是只取前 6 个的 poseKey）
viewHash                    对 round(v*1000)/1000 后的 16 个数做 FNV-1a 32bit 哈希（十进制）
focalPx / fx / fy
coveredPct                  首帧覆盖率（两边各自 readPixels 采样）
visibleGaussianCount        视锥/排序后真正参与绘制的实例数
submittedGaussianCount      提交给 drawArraysInstanced 的实例数
```

- **哈希不同 ⇒ 该轮无效**（`camMatch=false` → `ok=0`，`err=camera-unsuitable`）；
- **投影不可比整矩阵**：本方法 `CameraData.ts:9-10` 用 near=0.1/far=100，内嵌副本 `main.js:161-162`
  用 znear=0.2/zfar=200 ⇒ `projection[10]`、`projection[14]` 必然不同。
  跨臂投影判据只能是 **FOV 项**：`fov_key = "2*fx/w,2*fy/h"` 及其哈希 `fov_hash`
  （两边公式逐字节相同：`CameraData.ts:28-29` ↔ `main.js:164-165`）。
- `submittedGaussianCount`：本方法取模型 gaussian 总数（= draw 调用的 instanceCount），
  Flux 侧同样取它自己的 `vertexCount`；
- `visibleGaussianCount`：本方法取自排序 worker 回传的 `keptCount/totalCount`
  （`RenderProgram.ts:406-416` → `cullStats`，仅在 `?cull=1` 时非零，否则退化为 = submitted 并在
  `gaussianLoadNote` 里注明）；Flux 侧无该统计，只报 `coveredPct` 并在 `gaussianLoadNote=flux:covered-only` 注明。
- 这些量与 `coveredPct` 一起回答"矩阵相同、实际画面负载是否显著不同"。

## C.5 最终页面必须显示的内容

`bench.html` 结果卡（`#rc-summary`）与结果头文本（`buildResultText`）都会出现下面这些行：

```
engine=gsplat
flux_renderer_source=xiaobiaodu/flux-gs-project@d062af33bab6e74ed45f9c4b6e8ec6b3d6cff752
benchmark_protocol=Flux setTimeout(0) throughput
proto=flux
protocol_matched=yes              # 冲突时 no（并在页面顶部显示红色警告横幅）
flux_compatible=1                 # protocol_matched && driver=timer 才为 1
resolution_mode=flux-native       # 或 flux-fixed
drawing_buffer=1600x1063          # 每轮实际值（父页表头写请求值）
driver=timer                      # 或 raf（此时 protocol_matched=no）
frames=300
warmup=0
camera_hash=...                   # viewMatrix 的 FNV-1a 哈希
rendering_modifications=none      # 官方渲染改动清单（本仓库为空；有则列出）
```

每轮（`--- per-round ---`）追加：

```
res=<W>x<H> db=<drawingBufferW>x<drawingBufferH> viewport=<0,0,W,H> css=<cssW>x<cssH> dpr=<dpr>
view_hash=<...> cam_match=<0|1> res_match=<0|1> focal=<fx>
covered=<..>% visible_gauss=<n> submitted_gauss=<n> gauss_note=<...>
renderer_src=<commit> modifications=<none|…>
```

## C.6 第 9 阶段：验收测试清单（`bench-flux-protocol.test.ts`）

| # | 验收项 | 断言方式 | 对应用例名（**与代码逐字一致**） |
| --- | --- | --- | --- |
| 1 | `proto=flux` 默认得到 `driver=timer` | `fluxProtocolSpec("?proto=flux").driver === "timer"` 且 `driverSource==="flux-protocol"` | `1) proto=flux 默认得到 driver=timer（无需另传 driver）` |
| 2 | `proto=flux&driver=raf` 产生协议冲突 | `conflicts` 含 `driver=raf`、`protocolMatched===false`、`fluxCompatible===false` | `2) proto=flux&driver=raf 是协议冲突：按用户要求跑 raf，但标记协议不匹配` |
| 3 | 两边都是 300 个实际 render 调用 | 假调度器驱动 `runFluxLoop(300,0)`：`frames===300`；`runFluxLoopReference(300,0)` 同样 `frames===300`；trace 里 render 事件数各为 300 | `3) 两侧都恰好发生 300 次真实 render` |
| 4 | 两边 warmup 都为 0 | `fluxProtocolSpec("?proto=flux").warmup===0`；`runFluxLoop(5,0).startMs` 等于"首个 timer + 首帧 render"；`warmup>0` 时两份实现都多渲染且 `startMs`/trace 完全一致 | `4) 两侧预热都是 0：第一帧 render 结束即计时起点，且无额外预热帧` |
| 5 | 两边 timer/render 顺序一致 | trace 严格等于 `["timer","render","timer","render",…]`（先 schedule 起步、每次 render 后紧跟 timer） | `5) 两侧 timer/render 顺序完全一致：先 render 再排 timer，严格交替` |
| 6 | 两边 elapsed 起止位置一致 | 假数据下 `startMs===cycle`、`endMs===N*cycle`、`elapsedMs===(N-1)*cycle`，且与 `runFluxLoopReference` 完全相同 | `6) 两侧 elapsed 起止位置一致：从第 1 帧 render 结束 到 第 N 帧 render 结束` |
| 7 | 两边 FPS 公式一致 | `fps === frames/(elapsedMs/1000)` 且与参考实现数值相等 | `7) 两侧 FPS 公式一致：fps = frames / (elapsed/1000)` |
| 8 | 两边 drawing buffer 为 1600×1063 / native 策略正确 | `force=1600x1063` ⇒ `flux-fixed`；`fluxNativeDownsample/BufferSize` 覆盖 `字节/32 > 500000` 两侧分支；`replicationFocalPx` 的 fixed/native 两支；审计块字段与"CSS 不参与判定" | `8a) force=1600x1063 → flux-fixed…`、`8b)…`、`8c) flux-native 复刻官方画布策略…`、`8d) 焦距口径…`、`8e) 分辨率审计块字段齐全…`、`8f) 示例：两边都是 1600×1063…` |
| 9 | 两边相机哈希一致 | `viewMatrixHash` 同矩阵同值、1e-4 扰动仍同值、0.01 位移不同值；`viewMatrixMatches` 容差判定 | `9a)…9d)`（`9b) 相同矩阵 → 相同哈希；1e-4 的扰动 → 不同哈希` 等） |
| 10 | rAF 驱动结果绝不会被标记为 Flux-compatible | `?proto=flux&driver=raf` / `?driver=raf` / `?proto=flux&driver=RAF` 全为 `false`；`?proto=flux` 为 `true` | `10) 任何 rAF 口径都不可能被标记为 flux-compatible` |
| 11 | 测量期间不更新诊断 DOM | 用 Proxy 记录 harness 读到的 hook 键，必须 ⊆ `{render,schedule,now,shouldAbort}`；并断言模块源码不含任何 DOM **写**模式（`innerHTML/.style/createElement/getElementById/appendChild/textContent=/body./document.write`） | `11) 测量窗口内不接触 DOM：harness 只能读到 render/schedule/now/shouldAbort` |
| 12 | 页面隐藏或 context lost 时该轮作废 | `shouldAbort` 返回 `"hidden"` / `"context-lost"` → `abortedReason` 非空、`frames < requested` | `12) 页面隐藏 / 上下文丢失时该轮作废（frames 少于请求值且带 abortedReason）` |
| 13 | 改动拆分 / 指标命名 / 节拍条件判定 / 投影 FOV | `1c2)` 指标字段；`1c3)` 改动拆分按会话（`force⇒resolution`、`cam|fluxcam⇒camera`）；`13a)` `timerClampObserved` 只在实测 4ms 聚集时为 true；`13b)` 两份实现 gap 统计一致；`13c)` 投影只比 FOV 项 | `1c2) 指标命名…`、`1c3) 改动拆分按会话计算…`、`13a) timerClampObserved 只在**实测到** ~4ms 聚集时为 true`、`13b) 两份实现的 gap 统计一致…`、`13c) 投影对齐只比 FOV 项…` |

运行（**退出码状态见 §A.9.1**）：

```bash
cd gsplat.js
node_modules/.bin/vitest run                       # 35 passed / 3 skipped，exit=0
node_modules/.bin/eslint <7 个改动文件>              # 无输出，exit=0
node_modules/.bin/tsc --noEmit --target ES2019 ... bench-flux-protocol.ts bench-flux-protocol.test.ts   # 专项：exit=0
node_modules/.bin/tsc -p tsconfig.benchcheck.json --noEmit   # 全量：exit=2（仅既有 SortWorker.ts 错误）
```

## C.7 一致性证明的**强度**（协议复刻 + 同源对拍，不是独立验证）

1. **本方法侧**：运行时（`bench-measure.ts` 注入 `render/schedule/now`）与单元测试（假调度器）
   调用的是**同一个** `runFluxLoop()`，其 `render→schedule→计时起点→结算` 顺序按 `render_shared/main.js:2303-2339`
   移植（§A.2 的星号 ↔ 行号）。
2. **Flux 侧**：不共享运行时代码（§C.2），只能**协议复刻**；`runFluxLoopReference()`
   （`bench-flux-protocol.ts`）是**同一文件内的第二份手写实现**，用于对拍测试 5/6/7。
   ⇒ 这属于**同源转录自证（same-author transcription check）**：
   它能发现"两份实现之间"的分叉，**不能**发现"两份实现共同误读 vendor 源码"的错误。
   残余风险点（按语义补齐、非逐字符可推）：`benchmarkStartTime === 0` 哨兵、`frames` 的 `max(1,…)` 钳制、
   `warmup>0` 路径（vendor 无此路径，语义取自 `bench-flux.ts:568-570`）、以及用 `frameRender()` 近似 `frame()`。
3. **渲染语义等价性**由 `FLUX_VENDOR_DIFF.md` §4 保证：内嵌副本除仪器化外未改
   shader/排序/剔除/解码/绘制。
4. **当前状态**：`implemented but not runtime-validated`（无双臂真机数据，见 §A.9.2 与
   `FLUX_RUNTIME_VALIDATION_PLAN.md`）。

## C.8 本次实现落点（改动清单）

| 文件 | 改动 |
| --- | --- |
| `bench-flux-protocol.ts`（**新增**） | 协议描述（spec/conflicts/overrides/cameraMode/metric/paperProtocolVerified）、参考循环 `runFluxLoop` + 同源对拍 `runFluxLoopReference`、画布策略（`fluxNativeDownsample/BufferSize`、`replicationFocalPx`）、分辨率审计块、相机哈希、**投影 FOV key/hash**、**timer gap + `timerClampObserved` 条件判定**、**改动拆分 `fluxModificationBreakdown`** |
| `bench-flux-protocol.test.ts`（**新增**） | 第 9 阶段验收（**38 用例**：原 12 条 + `1c2/1c3/13a/13b/13c`） |
| `bench-shared.ts` | `fluxSpec()` 成为口径唯一来源；`warmupFrames/benchFrameCount/resolution/effectiveFocalPx` 全部委托；`RoundResult` 增加协议/指标/改动拆分/分辨率/相机/投影/节拍/可见性/跨臂占位字段；`buildCasePageUrl` 不再在 native 模式注入 `res=` |
| `bench-measure.ts` | 新增 `applyResolutionProtocol()` / `resolutionAudit()` / `cameraAudit()` / `abortReason()` / `gaussianLoad()` / **`runFluxCompatibleBenchmark()`**；`runThroughputFrames` 退化为"按 spec.driver 选调度器"并输出节拍诊断；`measureOneRound` 输出协议/指标/改动/分辨率/相机/投影/负载审计，不一致即判该轮无效 |
| `bench-case.ts` | 上下文丢失时置 `contextLost`（让 harness 立即作废） |
| `bench.ts` | 结果头新增 `metric/gpu_synced/presented_fps/paper_protocol_verified/protocol_source` + **四个改动布尔**（替代 `rendering_modifications=none`）；每轮新增投影/节拍/可见性/跨臂占位字段；协议冲突红色警告；`?diag=1` 轮询在测量期间暂停；native 模式 iframe 按设备视口布局 |
| `bench-flux.ts` | 结果头写明"内嵌副本钩子"来源 + 指标 + 改动拆分；每轮输出 `view_hash`、`db`、`viewport`、`focal`、`fov_key/fov_hash`（fixed 模式推导，native 模式标 `na` 并说明原因）、跨臂占位字段 |
| `tsconfig.benchcheck.json` | 纳入新增的两个文件 |


