# 双臂真机核对方案（只做验证，不改核心逻辑）

> **当前状态：`implemented but not runtime-validated`**
> 仓库内没有任何双臂/双页面真机结果（`thesis_project/data/ch7_measurements/` 的 `raw_desktop`、
> `raw_flux_native`、`out_desktop` 为空目录；`raw/0-poses.txt` 是**单臂、旧版本格式**、
> 不含 `driver=`/`view_hash=`/`protocol_matched=`；`z1/z2/q.log` 中检索相关关键字 0 命中）。
> 因此本文只给**核对方案与模板**，**不**声称任何"已匹配"结论。

---

## 0. 已修复的运行时缺陷（本轮回归，**责任在本次改动**）

**症状**（2026-09-15 真机 run，WeChat XWEB / Android 14 / 401×881 / dpr 3.6）：

```
Actual drawing buffer: undefinedxundefined          ← 结果卡
res=x db=x viewport= css=-x- dpr=- view_hash= cam_frozen= res_match=
submitted_gauss= visible_gauss= camera_mode= fov_key= fov_hash=
timer_gap_med_ms=- timer_gap_p95_ms=- timer_clamp_observed= visibility= metric= gpu_synced=
（头部 protocol_matched=yes / metric=… / algorithm_modified=0 等**是正常的**）
```

**根因**：`bench.ts` 的 `runCaseJob()` 在收到子页面结果后，用**手写的逐字段复制列表**
（`out.resW = clean.resW; out.driver = clean.driver; …`）把 `clean` 拷进 `out`。
本次新增的口径字段（`canvasW/drawingBufferW/viewport/viewHash/camFrozen/focalPx/
projectionFov*/timerGap*/visibilityState/metric/…`）只进了 `sanitizeRoundResult()` 的**白名单**，
却**没有**加进这个复制列表 ⇒ 结果对象里根本没有这些键 ⇒ 打印成空值 / `undefinedxundefined`。
（`resolution_mode=`、`overrides=`、`profiles` 里同样的空值都来自这一处。）

**修复**（`bench.ts`）：删掉逐字段列表，改为**整体覆盖**——

```ts
const clean = sanitizeRoundResult(run.result);
Object.assign(out, clean);   // 白名单里只有基本类型；缺省的键不会覆盖父页面自维护的 jobId/retryCount
```

并加了**回归守卫测试**（`bench-flux-protocol.test.ts` 14a/14b）：
断言 `bench.ts` 源码里存在 `Object.assign(out, clean);`、不再出现旧的逐字段写法，
且新口径字段都在 sanitize 白名单里。

**必须重跑**：上面那次真机结果是在**修复之前**的构建上产生的，其空字段属于这个 bug，
不代表口径本身缺字段。

### 0.1 那次真机留下的有效信息（单臂、部分）

| 事实 | 值 |
| --- | --- |
| 轮次 | garden `ok=1 drawOk=1`；truck / drjohnson `ok=0` |
| 驱动与帧数 | `driver=timer`、`frames=300`、`renders=300` |
| 计时 | `elapsed_ms=1348` ⇒ 299 个间隔共 1.348s ≈ **4.51 ms/帧**（与 `cpu_ms=4.49` 一致） |
| 时序 | `trace=create=7/ready=294/result=9515/iframeRemoved=9579/recycled=10850` |
| 首帧/加载 | `fetch_ms=578 parse_ms=607 first_frame_ms=961` |
| 设备 | WeChat XWEB 1500135 / Chrome 150 / Android 14；`gl_renderer=` 为空、`chip=unknown` |
| 后续失败 | `WebGL 上下文耗尽（整页重启后仍无法创建）` → 断点停手（设计行为） |

推论（**待重跑确认，不作为结论**）：4.51 ms/帧落在 `setTimeout(0)` 的 ~4ms 节拍带内，
修复后该轮的 `timer_clamp_observed` 很可能为 1；`garden covered=0.0%` 与旧单臂记录一致（非本次引入）。

第 2/3 轮的 `context lost / 上下文耗尽` 属于**既有设备级问题**（`bench-shared.ts` 已记载：
手机端一个文档累积 8~9 个 WebGL context 就会拿不到新上下文；本页已有 `perpage`/整页重启兜底），
不是本次改动引入。当前**没有**"只跑某一个场景"的 URL 参数（`profile` 只支持 quick/full/mip360/tnt/db），
在 WeChat 内核上的可行做法是：按页面提示**重启浏览器后重开同一链接**（进度在 sessionStorage，
会自动从断点继续），或把 `u=` 换成每个场景单独采集、逐场景汇总。

---

## 1. 两条最终测试 URL

同一台设备、同一个浏览器实例、先跑 Flux 臂再跑本方法臂（或反过来），中间不要刷新/切页。
`<host>` 用开发服务器地址（`npm run dev` → `http://localhost:5173/`；手机用 `http://<PC-IP>:5173/`）。

### 1.1 口径 A：`flux-fixed`（两边强制同一 drawing buffer，**跨臂可比**）

```
① Flux 臂（内嵌副本钩子）
http://<host>/bench-flux.html?profile=quick&rounds=1&cold=1&frames=300&warmup=0&force=1600x1063&u=runtime-check-fixed

② 本方法臂
http://<host>/bench.html?mode=bench&profile=quick&rounds=1&cold=1&proto=flux&cam=flux&force=1600x1063&frames=300&warmup=0&diag=1&u=runtime-check-fixed
```

要点：

- **不要**在两个 URL 里加 `driver=`（`proto=flux` 自己就是 `driver=timer`；加了 `driver=raf` 会变成协议冲突）。
- `force=1600x1063` 在两边是同一语义：本方法侧 ⇒ `resolution_mode=flux-fixed` + `setSize(1600,1063)`；
  Flux 侧 ⇒ `?benchres=1600x1063`（`main.js:1690-1694`）。
- 本方法臂带 `diag=1` 才会打印 `driver=/frames=/elapsed_ms=/renders=/timeline=` 等诊断字段
  （`bench.ts` 的 `if (diag)` 分支），核对 `renderCalls` 必须打开它。
- `rounds=1` 便于对齐；要测稳定性时用 `rounds=3` 并比较 P50。

### 1.2 口径 B：`flux-native`（两边都用各自的原生画布策略）

```
① Flux 臂          http://<host>/bench-flux.html?profile=quick&rounds=1&cold=1&frames=300&warmup=0&u=runtime-check-native
② 本方法臂         http://<host>/bench.html?mode=bench&profile=quick&rounds=1&cold=1&proto=flux&cam=flux&frames=300&warmup=0&diag=1&u=runtime-check-native
```

要点：两边都**不带** `force`/`res`（本方法侧若带 `res=` 会切到 `flux-fixed`，见
`bench-flux-protocol.ts` 的 `fluxSpec()`；`buildCasePageUrl()` 也已保证不给子页面注入 `res=`）。
本方法侧 `bench.ts` 会把测试 iframe 按**设备视口**布局，与 Flux 臂的 iframe 视口一致。

---

## 2. 逐字段核对表

`read from` 一列给出**结果文本里的字段名**（可直接在结果卡/导出的 `[RESULT]` 里搜）。

| 字段 | 本方法臂（`bench.html`） | Flux 臂（`bench-flux.html`） | 匹配规则 |
| --- | --- | --- | --- |
| driver | 头部 `driver=`（`proto=flux` ⇒ `timer`） | 头部 `driver=timer（内嵌副本 runFluxBenchmark 内部的 setTimeout(0) 链）` | 两边都必须 **timer** |
| requestedFrames | 头部 `frames=`（默认 300；被 URL 覆盖时标 `（override）`） | 头部 `frames=` | 相等 |
| completedFrames | 每轮 `frames=`（`perf.rendered`） | 每轮 `frames`（等价于钩子返回的 `frames`） | 相等且 = requestedFrames |
| renderCalls | 每轮 `renders=`（需 `diag=1`）：`frameRender()` 的真实调用次数 | **na**：钩子未上报；契约上 `frames` 恒等于 `target`（`main.js:2307-2319`），无法独立复核 | 本方法侧 `renders === frames`；Flux 侧标 `na（钩子未上报）` |
| canvas size | 每轮 `res=<W>x<H>`（`canvas.width/height`） | 每轮 `res=<W>x<H>` | 相等 |
| drawing buffer | 每轮 `db=<W>x<H>`（`gl.drawingBufferWidth/Height`） | 每轮 `db=<W>x<H>`（钩子回报的 `gl.canvas.width/height`，即 drawing buffer） | 相等 |
| viewport | 每轮 `viewport=<x,y,w,h>`（`gl.getParameter(gl.VIEWPORT)`） | 每轮 `viewport=0,0,<W>,<H>`（推导：内嵌副本只有一处 `gl.viewport(0,0,canvas.width,canvas.height)`，`main.js:1695`） | 相等 |
| internal framebuffer | 与 drawing buffer 相同：**两个实现都没有内部 FBO**（`gsplat.js/src/**` 全量检索 `framebuffer` = 0 命中；内嵌副本检索 `bindFramebuffer/createFramebuffer` = 0 命中）⇒ 都渲染到默认帧缓冲 | 同左 | 相等（都 = drawing buffer，`fbo=none`） |
| view matrix hash | 每轮 `view_hash=`（完整 16 个数、`round(v*1000)/1000`、FNV-1a） | 每轮 `view_hash=`（同一哈希函数，来自钩子回报的 `view` 16 个数） | 相等 |
| projection matrix hash | 每轮 `fov_hash=`（**只能比 FOV 项**，见 §4） | 每轮 `fov_hash=`（fixed 模式由 `focal_px + res` 推导；native 标 `na`） | 相等（或两边同时 `na`） |
| focal | 每轮 `focal=`（fixed = `1159.588`；native = `1159.588/bufferW*cssW` 的缩放值） | 每轮 `focal=1159.588`（恒为 COLMAP 焦距） | fixed 模式相等；native 模式需按 `fov_key` 判定 |
| cameraFrozen | 每轮 `cam_frozen=1`（测帧起止的 `view_hash` 相同） | 结构性冻结：测帧期间 `carousel=false`（`main.js:2364`）；钩子不回报该标志 ⇒ 由 `view_hash` 稳定性间接确认 | 本方法侧必须 `cam_frozen=1` |
| timer gap median/P95 | 每轮 `timer_gap_med_ms=` / `timer_gap_p95_ms=`（相邻帧开始间隔） | **na**（钩子未上报逐帧间隔） | 仅本方法侧可判定；Flux 侧 `na` |
| timerClampObserved | 每轮 `timer_clamp_observed=0/1`（条件判定，见 `FLUX_FPS_PROTOCOL.md §A.8`） | **na** | 只作为本方法侧的观测记录 |
| visibilityState | 每轮 `visibility=`（`document.visibilityState`） | **na** | 必须 `visible` |
| contextLost | 每轮 `ctxlost=`（`diag=1`）+ 失败行 `err=` | 头部/每轮 `ok=`/`err=` | 两边都必须 `0` |
| protocolMatched | 头部 `protocol_matched=` + 每轮 `protocol_matched=1` | 头部 `protocol_source=`（本臂恒为内嵌副本钩子） | 本方法侧必须 `yes/1`（带 `driver=raf` 时会变 `no`） |
| metric / gpuSynced / presentedFps | 头部 `metric=` / `gpu_synced=0` / `presented_fps=0` | 头部同名三行 | 两边一致（`unsynchronized-webgl-frame-submission-throughput`） |
| paperProtocolVerified | 头部 `paper_protocol_verified=0` | 头部 `paper_protocol_verified=0` | 两边都必须是 **0**（论文口径未验证） |
| 改动拆分 | 头部 `algorithm_modified=0` / `benchmark_loop_modified=1` / `resolution_modified=` / `camera_modified=` | 头部同名四行（Flux 臂恒为 `0/1/<force?1:0>/1`） | 语义一致即可（Flux 臂 `camera_modified=1` 因为其 `carousel` 冻结与注入点） |
| covered / visible_gauss | 每轮 `covered=` / `visible_gauss=` / `submitted_gauss=` | 每轮 `covered=`（无 cull 统计） | 作为"矩阵相同但负载是否不同"的辅助判据（差值大 ⇒ 需人工复核） |
| fps | 每轮 `fps=` | 每轮 `fps=` | **不要求相等**（协议不等于性能相等）；但两者必须是**同一 metric**下的值 |

---

## 3. 跨臂比对必须输出的 5 个字段

这 5 个字段**由人工/离线比对填写**（单页看不到另一臂）。当前实现里它们默认**留空**，
结果文本会打印成 `cross_*_matched=`（空值），**不得**默认填 1：

| 字段 | 判定规则 |
| --- | --- |
| `crossResolutionMatched` | 两边 `res`（canvas）与 `db`（drawing buffer）逐字段相等 |
| `crossViewportMatched` | 两边 `viewport` 相等（并按 §4 的 FBO 结论确认都指向默认帧缓冲） |
| `crossCameraMatched` | 两边 `view_hash` 相等（本方法侧还要 `cam_frozen=1`） |
| `crossProjectionMatched` | 两边 `fov_key`/`fov_hash` 相等（**只比 FOV 项**；整矩阵因 near/far 不同必然不可比） |
| `crossProtocolMatched` | 两边 `driver=timer` **且** 本方法侧 `protocol_matched=yes` **且** 两边 `metric` 相同、`paper_protocol_verified=0` |

任一项为假 ⇒ 该轮标注**无效**，不得进入同一张横向对比表。

## 4. 已知限制（写进表注，避免误判）

1. **投影整矩阵不可比**：本方法 near=0.1/far=100（`CameraData.ts:9-10`），内嵌副本 znear=0.2/zfar=200
   （`main.js:161-162`）⇒ 只能比 FOV 项 `2fx/w`、`2fy/h`。
2. **Flux 臂的 `fov_key` 只在 `force=WxH`（benchres）下可推导**：native 模式官方投影用的是
   `innerWidth/innerHeight`，而钩子**没有上报**这两个值 ⇒ 该模式 Flux 侧 `proj_basis=css-viewport(...na...)`。
3. **Flux 臂没有逐帧间隔**（`timer_gap_*`、`timer_clamp_observed` = `na`），因此
   "两边都观测到 4ms 节拍"目前**无法**验证 —— 只能记录本方法侧是否 `timer_clamp_observed=1`。
4. **Flux 臂没有 render 调用次数**（`renderCalls` = `na`），只有"钩子契约上 frames=target"这一条结构性保证。
5. **内部 framebuffer**：两个实现都渲染到默认帧缓冲（无 FBO，见上表证据）⇒ 该项与 drawing buffer 等价。
6. `covered=` 在两边口径不同（本方法是测帧后的 `readPixels` 采样；Flux 是钩子在第 1 帧采的），
   只能作数量级粗看，不能当等式判据。

---

## 5. 结果填写模板

把两条 URL 的 `[RESULT]` 文本各粘一份，然后填下表：

```
=== 环境 ===
设备 / GPU：______________________   UA：______________________
浏览器：____________  innerWxH=________  dpr=________
测试时间：______________________   两端 URL 的 u=：__________
口径： [ ] flux-fixed(force=1600x1063)   [ ] flux-native

=== 原始结果（各粘一份完整 [RESULT]）===
--- Flux 臂（bench-flux.html）---
<粘贴>
--- 本方法臂（bench.html）---
<粘贴>

=== 逐字段核对（填 yes/no/na + 证据字段）===
metric                    两边一致？ ________   （值：___________________）
driver                    timer / timer ? ________
requestedFrames           300 / 300 ? ________
completedFrames           ____ / ____ ? ________
renderCalls               ____ / na ? ________
canvas size               ____x____ / ____x____ ? ________
drawing buffer            ____x____ / ____x____ ? ________
viewport                  ____ / ____ ? ________
internal framebuffer      都 = drawing buffer（无 FBO）? ________
view matrix hash          ______ / ______ ? ________
projection (FOV) hash     ______ / ______ ? ________（na 时写 na + 原因）
focal                     ______ / ______ ? ________
cameraFrozen              cam_frozen=1 ? ________
timer gap median/P95      ____ms / ____ms  ,  na ? ________
timerClampObserved        ____ ,  na ? ________
visibilityState           visible / na ? ________
contextLost               0 / 0 ? ________
protocolMatched           yes / (本臂恒为钩子) ? ________
paperProtocolVerified     0 / 0 ? ________

=== 跨臂结论 ===
crossResolutionMatched = ______
crossViewportMatched   = ______
crossCameraMatched     = ______
crossProjectionMatched = ______
crossProtocolMatched   = ______
本轮整体： [ ] 有效   [ ] 无效    原因：______________________

=== 性能（仅记录，不作匹配判据）===
Flux 臂 fps = ______  （每轮：______）
本方法臂 fps = ______ （每轮：______）
备注（是否出现 timer_clamp_observed、fps 是否贴着 ~250 上限）：______________________

=== 状态 ===
runtime validation: [ ] 已完成（上面全部 yes）  [ ] 仍然 implemented but not runtime-validated
```

> 填完之前，任何文档/表格都只能写 `implemented but not runtime-validated`。

---

## 6. 手机端（上下文配额受限内核，如微信 XWEB）参数建议

**症状**：`WebGL 上下文耗尽（整页重启后仍无法创建）`（`bench.ts:1030-1031`，断点已保存）。
**机制**：该内核的 WebGL 上下文配额是**进程级**的，且销毁文档后归还很慢；
每次"新建 iframe 建上下文"都在消耗配额，配额耗尽后 `canvas.getContext('webgl2')` 返回 `null`。

### 6.1 关键参数（默认值 → 建议值）

| 参数 | 默认 | 作用（证据） | 建议 |
| --- | --- | --- | --- |
| `perpage` | **未给 ⇒ 走 `docjobs`，默认 4** | `jobsPerDocument()`（`bench-shared.ts:560-565`）；`perpage=1` ⇒ 每个 job 都整页重启；`perpage=0` ⇒ 永不重启 | **`perpage=1`** ← 最直接：每个 job 用**全新文档**，每文档只建 **1 个**上下文 |
| `docjobs` | 4 | 同上（等价写法） | `docjobs=1` 与 `perpage=1` 等价；`docjobs=2` 只是折中（每文档 2 个上下文，本机很可能不够） |
| `recyclems` | 1000 | 同一文档内"销毁上一个 iframe → 建下一个"的等待（`bench-shared.ts:540-546`，`bench.ts:965/1078`） | **`recyclems=3000`**（配额紧的机器可 5000） |
| `cold` | — | **对回收等待没有任何作用**：`recycleDelayMs(_cold)` 忽略该参数 | 留着即可，它不是杠杆 |
| `validateframe` | 1 | 测帧前最多 20 帧 + `gl.finish()` + 6.8MB `readPixels` 的存活探针（`bench-measure.ts:981`） | 负载吃紧时可 `validateframe=0`（代价：少了"首帧非空"门禁） |
| `losectx` | 0 | 轮末主动丢上下文（`bench-measure.ts:746`；注释说在手机上**更糟**） | **不要开**（可各跑一次作对照） |
| `ctxretry` | 0 | 同文档内换 canvas 重试建上下文（`bench-case.ts`；注释说基本无效且更糟） | **不要开** |
| `res` | — | 本机 dpr=3.6 ⇒ native 模式约为 CSS×3.6（401×881 ⇒ ≈1444×3172，≈4.6M 像素），比 `res=1600x1063`（1.7M 像素）**更大** | 保留 `res=1600x1063`（fixed 更省显存） |
| `profile` | — | 决定 job 数：`quick`=3、`tnt`=2、`db`=2、`mip360`=9、`full`=13 | 越少越稳；本机建议 ≤3 |

### 6.2 推荐 URL（本方法臂）

```
https://chxxx.github.io/gs-mobile/bench.html?mode=bench&profile=quick&rounds=1&cold=1
  &res=1600x1063&cam=flux&proto=flux&frames=300&warmup=0&diag=1
  &perpage=1&recyclems=3000
```

最保守一档（仍失败时再用）：

```
...&perpage=1&recyclems=5000&validateframe=0
```

Flux 臂同理（同一台机器、同一 device viewport）：

```
https://chxxx.github.io/gs-mobile/bench-flux.html?profile=quick&rounds=1&cold=1
  &frames=300&warmup=0&force=1600x1063&perpage=1&recyclems=3000&u=<label>
```

### 6.3 为什么这比"失败后自动整页重试"更有用

自动重试（`_docretry=1`，等 `CASE_DOC_RETRY_DELAY_MS=1500ms`，**无 URL 参数可调**）发生在
**同一个文档已经试过一次并失败之后**——那时该文档已经创建/尝试了 2 个上下文；
而 `perpage=1` 是在**每个 job 成功之后、从干净状态**就换新文档，并且等待时间由 `recyclems` 控制。

### 6.4 仍然失败时

按页面提示**重启浏览器 → 重开同一链接**（`_doc` 令牌 + sessionStorage 断点，会自动续跑）；
或把 `u=` 改成每场景一个值、逐场景采集后汇总；或改用 `profile=tnt|db`（各 2 个 job）继续压低单次会话的上下文数。

---

## 7. 三臂对比（Flux-GS / 本方法 / reduced-3DGS）的公平性与操作步骤

### 7.1 两个臂是否公平（逐项）

| 维度 | Flux 臂（`bench-flux.html`） | 本方法臂（`bench.html`） | 是否公平 |
| --- | --- | --- | --- |
| drawing buffer | `force=1600x1063` ⇒ `?benchres=` ⇒ canvas 1600×1063 | `res=1600x1063` + `proto=flux` ⇒ `flux-fixed` ⇒ canvas 1600×1063 | ✅ |
| 投影 / FOV | focal 1159.588，`projW/H = benchres` | focal 1159.588（`replicationFocalPx` 的 fixed 分支），投影用 buffer 尺寸 | ✅（FOV 项 `2fx/w`、`2fy/h` 相同） |
| 驱动 / 协议 | `runFluxBenchmark()` 内部 `setTimeout(0)`，300 帧 | `proto=flux` ⇒ `driver=timer`（同一 harness），300 帧 | ✅ |
| 预热 | `warmup=0`（不额外跑一轮） | `warmup=0` | ✅ |
| 场景集 | `profile=quick` = garden/truck/drjohnson | 同 3 个 id | ✅ |
| **机位** | Flux 用它自己的默认 `viewMatrix`（硬编码，2 位小数） | `cam=flux` ⇒ 用 `default_view` 的**位置+四元数**经本方法相机数学重算 | ⚠️ **差 ≤0.32°**（`Camera.fluxParity.test.ts`）⇒ `view_hash` 不同、`crossCameraMatched=false` |
| CSS 布局 | iframe = 1600×1063（`forceSize`） | 默认 iframe 铺满渲染区（fixed 模式下不影响 buffer/投影，只影响显示缩放） | ✅（要更严格可加 `&fit=1`） |
| 标签 `u=` | 需显式给 | 不给会用 GPU 型号自动命名 | ⚠️ 两边写同一个 `u=` |
| `diag=1` / `perpage` / `recyclems` | 不支持 / 不需要 | 只影响日志与轮间回收，**不影响被测负载** | ✅ 无需镜像 |

**机位要做到逐位相同**：生成并部署 `bench-camviews.json`
（`python gsplat.js/tools/make_bench_camviews.py --raw-dir <本方法臂结果目录>`），
然后 Flux 臂加 `&pose=ours`。**现状**：线上 `bench-camviews.json` = **404** ⇒ 加 `pose=ours` 会静默回退
（`poseInjected=false`），等于没对齐；所以**当前只能接受 0.32° 的机位差**并在表注写明。
`?fluxcam=N` **不能**用于对齐：它只由 `bench-flux.ts` 透传给 Flux 页；本方法臂仅把它用于
`cameraMode` 标注，并未应用 `cameras[N]`（这是本方法臂的既有缺口）。

### 7.2 三臂共同场景（**不要用 `profile=quick` 做三方表**）

| 清单 | 内容 |
| --- | --- |
| 本方法臂（`bench-scenes.json`） | garden, bicycle, flowers, stump, treehill, room, counter, kitchen, bonsai, truck, train, drjohnson, playroom |
| Flux 臂（`flux-baseline-scenes.json`） | 同名 13 个 |
| reduced-3DGS（`baseline-scenes.json`） | **仅 5 个**：`r3dgs-bicycle / r3dgs-bonsai / r3dgs-counter / r3dgs-kitchen / r3dgs-truck` |

⇒ **三方交集 = bicycle / bonsai / counter / kitchen / truck（5 个）**。
本方法臂与 Flux 臂需各跑 `profile=mip360`（9）+ `profile=tnt`（2），报表里只保留这 5 行；
reduced 臂跑 `profile=reduced3dgs`（5）。

### 7.3 具体步骤（可直接转给别人）

**第 0 步 · 线上资源体检**（已实测：`bench.html` / `bench-case.html` / `bench-flux.html` /
`baseline-scenes.json` / `flux-baseline-scenes.json` / `bench-flux-camera.json` /
`reduced-3dgs/quantized_truck.ply` / `flux-gs-project-gh-pages/render_truck/index.html` 全部 **200**；
`bench-camviews.json` = **404**）。

**第 1 步 · 三条 URL**（`<host>` = 部署地址或局域网 dev 地址；**同一台被测试设备、同一浏览器、同一次会话**）

```
① Flux 臂      https://<host>/bench-flux.html?profile=mip360&rounds=1&cold=1&frames=300&warmup=0&force=1600x1063&perpage=1&recyclems=3000&u=<标签>
               再跑一次把 profile 换成 tnt
② 本方法臂     https://<host>/bench.html?mode=bench&profile=mip360&rounds=1&cold=1&res=1600x1063&cam=flux&proto=flux&frames=300&warmup=0&diag=1&perpage=1&recyclems=3000&u=<标签>
               再跑一次把 profile 换成 tnt
③ reduced 臂   https://<host>/bench.html?mode=bench&profile=reduced3dgs&rounds=1&cold=1&res=1600x1063&cam=flux&proto=flux&frames=300&warmup=0&diag=1&perpage=1&recyclems=3000&u=<标签>-r3dgs
```

**不要**加 `driver=`（`proto=flux` 自带 timer）；`perpage/recyclems` 只有②③认，①不需要。

**第 2 步 · 采集**：关掉同浏览器其它 WebGL 页面 → 打开 ①，跑完出现"测试完成"→ 点**复制结果**粘到记事本
→ 依次完成 ①②③ 的全部 5 次运行（每次先复制再关页）。

**第 3 步 · 失败处理**：出现 `WebGL 上下文耗尽`时**完全关闭浏览器**（微信要清后台）→ 重开同一链接
（断点保存在 sessionStorage，会自动续跑）。

**第 4 步 · 回传**：5 份 `[RESULT]` 文本 + 结果头里的设备信息（`ua/screen/dpr/gl_renderer`）。

**第 5 步 · 汇总**（`truck` 举例，其余 4 个共同场景同构）

| scene | arm | fps | res | db | viewport | view_hash | fov_hash | driver | frames | renders | covered% | ok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| truck | flux |  | 1600x1063 | 1600x1063 | 0,0,1600,1063 |  | （fixed 下可推导） | timer | 300 | na |  |  |
| truck | ours |  | 1600x1063 | 1600x1063 | 0,0,1600,1063 |  |  | timer | 300 | 300 |  |  |
| truck | r3dgs |  | 1600x1063 | 1600x1063 | 0,0,1600,1063 |  |  | timer | 300 | 300 |  |  |

再加 5 个跨臂布尔结论：`crossResolutionMatched / crossViewportMatched / crossCameraMatched /
crossProjectionMatched / crossProtocolMatched`，并标注 `covered≈0%` 的场景。
