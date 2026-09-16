# 三方法 FPS Benchmark 设计文档（实现中版本）

> **状态：`implemented-but-not-runtime-validated`**（实现进行中：阶段 1–4 = `bench-audit.ts` /
> `bench-controller.ts` / `bench-gl-probe.ts` 及其单测已完成且全绿；阶段 5–10 = adapter / Flux bridge /
> 三方法页面 / Chromium smoke 尚未开始）
>
> **状态演进（固定顺序，不得跳级）**：
>
> ```
> designed-but-not-implemented
>   → implemented-but-not-runtime-validated
>   → browser-validated
>   → target-device-validated
> ```
>
> 本文回答：实施计划、将修改的文件、三个 adapter 的接入点、Flux-GS / Reduced-3DGS 能否暴露 WebGL context、
> 风险清单、D1–D5 拍板结果、共同场景矩阵、Reduced-3DGS 模型来源审计、yield 敏感性实验计划、
> Flux `benchSlaveMode` 精确伪代码。
>
> **实验标题（D1 拍板）**：`Three-representation mobile WebGL system comparison`
> 表注必须写明：**Ours 与 Reduced-3DGS 共用本项目的 WebGL renderer；Flux-GS 使用它自己的官方 WebGL
> renderer。因此臂间差异不能归因于"renderer"或"模型表示"中的单一因素。**
> 禁止称为"三渲染器对比"，也禁止称为"三种方法各自原生端到端实现"。
> 必须拆成两句解释：① Ours vs Reduced-3DGS = **同一 renderer 下的模型表示/资产对比**；
> ② Ours system vs Flux-GS system = **不同模型表示 + 不同 renderer 构成的系统级对比**。
>
> **硬性命名约束**：
>
> 1. 本地新增 `runFluxBenchmark()` 钩子只能叫
>    **`local-flux-hook-compatible-unsynchronized-submit-throughput`**（协议 `local-flux-hook-unsynchronized-submit-v1`），
>    不得称"Flux-GS 论文官方协议"。
> 2. 主 FPS 指标 = **`gpu-drain-synchronized-throughput-fps`**（协议 `gpu-drain-synchronized-throughput-v1`）。
> 3. 旧 ~222FPS 数据只能进附录：`Appendix: local Flux-hook-compatible unsynchronized submission results`。
>
> **D3 拍板（据此删除了旧版"finish 可能假同步"的表述）**：
> 只要还是同一个未丢失的 WebGL context，`gl.finish()` 就是正式的**阻塞式完成边界**。
> 主协议只用 `gl.finish()`；`fenceSync/clientWaitSync` 仅作开发验证/附录模式，
> 不作为主表第二套正式协议，也不与 finish 结果混合。

---

## 1. 四个协议（名称 / 驱动 / 用途）

| 协议               | 名称                                                                              | 驱动                                                                                         | 用途                  | 表               |
| ------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------- | ---------------- |
| **主 FPS（静态）** | `gpu-drain-synchronized-throughput-v1`（测试名 `static-synchronized-throughput`） | `yieldMode=none`（**优先**）或 `messagechannel` + `batchSize`；**不用 setTimeout、不用 rAF** | 论文主对比            | 表 1             |
| **动态相机**       | `moving-camera-pipelined-throughput`                                              | 同上，但每帧 `setCamera(trace[i])`                                                           | 排序开销（**单列**）  | 表 1 附列 / 附录 |
| **呈现 FPS**       | `presentation-raf-v1`                                                             | 统一 controller 的 rAF                                                                       | 交互体验 / 刷新率上限 | 表 3             |
| **兼容口径（旧）** | `local-flux-hook-unsynchronized-submit-v1`                                        | `setTimeout(0)`（Flux 钩子/历史数据）                                                        | 附录                  | 附录             |

- 主指标名：**`gpu-drain-synchronized-throughput-fps`**。
- 旧协议（附录）必须输出：`metric=unsynchronized-webgl-frame-submission-throughput`、`gpuSynced=false`、
  `presentedFps=false`、`paperProtocolVerified=false`、`timerClampObserved=<运行时计算值>`，
  并**新增** `postSubmitDrainDiagnosticMs`（`diagnosticOnly=true`，D5）。
- **主协议不输出 `postSubmitDrainDiagnosticMs`**，而是直接输出 `submitPhaseMs`、`drainPhaseMs`、
  `totalSyncedMs`（D5）。
- 表注（主表逐字写）：`包含 JavaScript、WebGL 驱动提交和 GPU 队列完成时间；不等同于 EXT_disjoint_timer_query
测得的纯 GPU 时间。`

### 1.1 主协议状态机（三方共用同一份实现）

```
init → loadScene → upload → setResolution(仅一次) → setCamera
     → waitUntilReady → waitUntilSortReady → warmup(N_w)
     → preFinish()            ← gl.finish()（D3：正式的阻塞式完成边界）
     → t0 = now()             ← 必须在 preFinish 返回之后
     → 提交 N 帧：
           yieldMode=none        : for i in 1..N: renderOneFrame()
           yieldMode=messagechannel: 每个 batch(batchSize) 后 yield()（MessageChannel）
     → lastSubmitMs = 第 N 次 render 返回时刻
     → postFinish()           ← gl.finish()
     → t1 = now()             ← 必须在 postFinish 返回之后
     → submitPhaseMs = lastSubmitMs - t0
       drainPhaseMs  = t1 - lastSubmitMs
       totalSyncedMs = t1 - t0                     ← 必须 ≈ submitPhaseMs + drainPhaseMs（计时精度内）
       fps           = completedFrames * 1000 / totalSyncedMs
```

事件日志（**独立验证的唯一依据**，不写第二份手写 reference 自证）：

```
finish-start → t0 → render-1 … render-N → finish-end-start → finish-end-return → t1
```

### 1.2 主表设置的选择规则（D5/§5 要求，先做敏感性实验再定）

- 默认候选：**`yieldMode=none`**（连续提交，无固定调度开销，最能保留快速方法之间的差异）。
- `messagechannel + batchSize=10` 只作为**兼容/稳定性模式**；在完成 §5.2 的敏感性实验之前，
  **不得**把它当作唯一主协议。
- 若 `yieldMode=none` 导致页面在提交窗口内无响应（长任务），这是**允许**的（窗口内禁止 DOM 更新）；
  但必须在结果里记录 `yieldMode` 与 `batchSize`，并在表注说明主表用的是哪一种。

要求落实清单：`preMeasureFinish` 在 `t0` 前 ✓；`postMeasureFinish` 在 `t1` 前 ✓；
排水计入 elapsed ✓；批次 yield 时间计入 elapsed ✓（t0/t1 之间不做任何"暂停计时"）；
`completedFrames` 必须等于 controller 下发的 N **且**等于**外部计数**（见 §2.2 的 wrap 计数）✓；
`visibilityState!=="visible"` / `contextLost` / 异常 / 计数不等 ⇒ `valid=false` + `invalidReason` ✓。

---

## 2. 三个 adapter 的接入点与"能否拿到 WebGL context"

### 2.1 接入点矩阵

| 方法               | 入口页（iframe）                                                                     | adapter 文件（新增）                                                      | 单帧驱动                                                   | 能否拿到 WebGL2 context                                                                                        | 证据                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **ours**（本方法） | `bench-case.html?slave=1&…`                                                          | `bench-adapters.ts` → `OursAdapter`（驱动 `bench-case.ts` 的 slave 通道） | ✅ `BenchCase.frameRender()`（`bench-measure.ts:134-139`） | ✅ `renderer.gl`（`src/renderers/WebGLRenderer.ts:124` 的 `get gl()`），canvas 由 `bench-case.html` 提供       | 已存在                                                                                                               |
| **reduced-3dgs**   | 同上（**同一入口**，只换模型 URL）                                                   | `Reduced3dgsAdapter`（复用 `OursAdapter`，只换 scene manifest 的 `file`） | ✅ 同上                                                    | ✅ 同上                                                                                                        | `baseline-scenes.json`（5 个 `r3dgs-*` 场景，模型 `reduced-3dgs/quantized_*.ply`）                                   |
| **flux-gs**        | `flux-gs-project-gh-pages/render_<scene>/index.html?bridge=1&benchres=WxH&fluxcam=N` | `FluxGsAdapter`（调 `__FLUXGS_BENCH_BRIDGE__`）                           | ❌ 需 bridge（`frame()` 是 `main()` 内闭包，未导出）       | ✅ 父页面 `iframe.contentWindow.document.getElementById("canvas").getContext("webgl2")` 返回**同一个** context | 画布 id：`main.js:1399/1574`；context 创建：`main.js:1580-1582`；draw：`main.js:2263`；排序回传：`main.js:1779-1782` |

**"拿到同一个 context"的语义说明（重要）**：同一 canvas + 同 type 调 `getContext()` 返回**已存在的上下文对象**，
**不会**新建上下文、不占额外名额；因此这不违反 `main.js:1585` 那条"外层不要自己探测上下文"的注释
（那条警告针对的是"新建 canvas/getContext 探测"）。控制器必须**复用既有 canvas**，绝不新建。

### 2.2 计数与观测的拆分（D5/§3 拍板：不得用 draw 次数冒充 renderCalls）

控制器在拿到 context 后**包裹**（非侵入、不改第三方源码）：

```
wrap gl.drawArraysInstanced  → drawCalls / drawInstances       （**工作量字段**，不是帧数）
wrap gl.bufferData           → indexBufferUploads              （Flux 的"排序回传"观测点）
wrap gl.finish / gl.flush    → preFinishCalls / postFinishCalls / finishMs
wrap iframeWindow.requestAnimationFrame / cancelAnimationFrame  → rafCalls / unexpectedFrameCallbacks
wrap iframeWindow.setTimeout                                    → timerSchedules / unexpectedTimerSchedules
wrap Worker？                 不可行（worker 在页面脚本内创建）⇒ sortRequests 记为 null，表注写明
```

每轮必须**分开记录**（互不代替）：

| 字段                       | 含义                                                        | 来源                         |
| -------------------------- | ----------------------------------------------------------- | ---------------------------- |
| `controllerRenderCalls`    | controller 发出的 `renderOneFrame()` 次数                   | controller 自计              |
| `adapterFrameSerial`       | adapter 内部帧序号（`adapterFrameDelta = 结束值 − 开始值`） | adapter                      |
| `drawCalls`                | 测量窗口内 `drawArraysInstanced` 次数（**工作量**）         | wrap                         |
| `drawInstances`            | 该窗口内每次 draw 的 `instanceCount` 之和（**工作量**）     | wrap                         |
| `unexpectedDrawCalls`      | 窗口内未被 controller 归因的 draw 次数                      | wrap − controllerRenderCalls |
| `unexpectedFrameCallbacks` | slave 模式下页面自行发生的 rAF 回调次数（应为 0）           | wrap rAF                     |

**有效性判据**：`controllerRenderCalls === N` **且** `adapterFrameDelta === N`
（`drawCalls` 只进工作量表；`drawCalls != controllerRenderCalls` 不直接判无效，但必须记录并在诊断里复核：
若窗口内出现 `unexpectedDrawCalls > 0` 或 `unexpectedFrameCallbacks > 0` ⇒ `valid=false`）。

---

## 3. 统一 adapter 接口与 Flux-GS 的最小 bridge

### 3.1 统一接口（三个 adapter 同签，controller 只认它）

```ts
interface ThreeWayBenchmarkAdapter {
    name: "ours" | "flux-gs" | "reduced-3dgs";
    init(config: BenchmarkConfig): Promise<void>;
    loadScene(scene: SceneConfig): Promise<void>;
    setCamera(camera: CameraFrame): Promise<void>;
    waitUntilReady(): Promise<void>; // 模型上传完成（纹理已建）
    waitUntilSortReady(): Promise<void>; // 至少一次真实排序回传
    renderOneFrame(): void; // 恰好一次完整帧
    finishGpu(): void; // gl.finish()（或 fence 模式，见 §10-D3）
    getRenderCount(): number; // 外部 wrap 计数（权威）
    getResolutionAudit(): ResolutionAudit;
    getCameraAudit(): CameraAudit;
    getWorkloadAudit(): WorkloadAudit;
    getContextState(): ContextState;
    dispose(): Promise<void>;
}
```

`renderOneFrame()` 之外的**所有**计时/状态机/批量/yield/事件日志都在 `bench-controller.ts` 里；
adapter 只做一件事：提交一帧。

### 3.2 本方法 / reduced-3DGS 侧：`bench-case.ts?slave=1`（新增 slave 模式）

现 `bench-case.ts:275-289` 一启动就自动跑 `measureOneRound()`。slave 模式必须：

1. 建上下文、加载模型、设分辨率、设相机、等待排序 —— 全部由 controller 下命令驱动；
2. **不启动**任何自驱循环（不测帧、不 rAF、不 timer）；
3. 暴露 `window.__CASE_BENCH__ = { renderOneFrame, finishGpu, setCamera, waitUntilReady, waitUntilSortReady, audits, contextState }`；
4. 保留既有 `dispose` / `contextlost` 上报协议，并把 `contextLost` 计入 `invalidReason`。

### 3.3 Flux-GS 侧：`benchSlaveMode` + 最小 bridge（**唯一被允许的第三方改动**，D5/§4 拍板）

位置：现有 hook 块内、`window.runFluxBenchmark`（`main.js:2351-2367`）之后（`frame`/`gl`/`canvas` 在该作用域内可见）。

**hunk 1（纯追加，模块级 flag）**

```js
// [BENCH BRIDGE] slave 模式：由外层 controller 逐帧驱动，frame() 不再自挂 rAF
let benchSlaveMode = false;
```

**hunk 2（改 `frame()` 尾部一处：把原来的 `else { rafId = requestAnimationFrame(frame); }` 拆成两个分支）**

```js
if (isBenchmarking) {
    /* …原有计帧/调度分支，完全不动… */
} else if (benchSlaveMode) {
    rafId = null; // ← slave 模式：不自挂 rAF
} else {
    rafId = requestAnimationFrame(frame); // ← 默认路径：与现在完全一致
}
```

**hunk 3（纯追加，bridge 本体）**

```js
window.__FLUXGS_BENCH_BRIDGE__ = {
    protocol: "gpu-drain-synchronized-throughput-v1",
    version: 1,

    /** 进入 slave：先掐掉在飞的 rAF，再置位；返回是否成功 */
    enterSlaveMode: () => {
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        benchSlaveMode = true;
        return { rafIdIsNull: rafId === null, benchSlaveMode: benchSlaveMode };
    },
    exitSlaveMode: () => {
        benchSlaveMode = false;
        if (rafId === null) rafId = requestAnimationFrame(frame); // 恢复常驻循环
        return { rafIdIsNull: rafId === null };
    },

    /** 恰好提交一次完整帧（相机冻结、worker.postMessage(view)、drawArraysInstanced） */
    renderOneFrame: () => {
        if (!benchSlaveMode) throw new Error("renderOneFrame 前必须 enterSlaveMode()");
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        } // 兜底：任何残留 rAF 都掐掉
        frame(performance.now());
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        } // 兜底：即使有分支漏网也掐掉
        if (rafId !== null) throw new Error("slave 模式下 frame() 仍挂上了 rAF");
        return { vertexCount: vertexCount, rafIdIsNull: true };
    },

    finishGpu: () => {
        gl.finish();
    },
    flushGpu: () => {
        gl.flush();
    },
    setBenchResolution: (w, h) => {
        /* 覆盖 __fluxBenchRes.w/h 后调用 resize()：参数级，不改公式 */
    },
    setCameraMatrix: (view16) => {
        viewMatrix = Array.from(view16);
        carousel = false;
    },

    getRuntimeAudit: () => ({
        vertexCount: vertexCount,
        resW: gl.canvas.width,
        resH: gl.canvas.height,
        viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        viewMatrix: viewMatrix.slice(),
        projectionMatrix: projectionMatrix.slice(),
        focal: { fx: camera.fx, fy: camera.fy },
        near: 0.2,
        far: 200, // 见 §4.2（D2 统一后由 controller 覆盖）
        rafRunning: rafId !== null,
        slaveMode: benchSlaveMode,
    }),
};
```

**验收要求（controller 侧强制）**：

1. `enterSlaveMode()` 必须在 `warmup` 之前调用，并断言返回 `rafIdIsNull === true`；
2. 测量窗口内 `unexpectedFrameCallbacks === 0`（由 §2.2 的 rAF wrap 计数）——否则 `valid=false`；
3. `exitSlaveMode()` 必须在 `dispose()` 前调用（恢复页面常态，避免遗留死页面）；
4. 该改动必须记录为 **`benchmarkLoopModified=true`**（§3.4），且 `algorithmModified` 仍为 `false`。

**逐 hunk 记录**：hunk 1/3 是纯追加，hunk 2 只改这一个 `else` 分支（**必须逐字 diff 记录**）。
改完必须重跑 `tools/check_flux_vendor_diff.py` 并更新 `FLUX_VENDOR_DIFF.md §4`（hunk 11 → 13/14）。

**为什么不能只靠"render 前后 cancelAnimationFrame"**：`cancelAnimationFrame` 只对"已入队未执行"的句柄有效，
无法阻止 `frame()` 在**同一次调用内**重新入队并触发额外回调；`benchSlaveMode` 让 `frame()` 根本不入队，
再用 wrap 计数验证 `unexpectedFrameCallbacks=0`，才能证明测量窗口内的每一帧都来自 controller。

**为什么不能绕过 bridge**：`runFluxBenchmark(N)` 内部是 `setTimeout(0)` 逐帧链（违反主协议"不得 setTimeout 驱动"），
且结束时会 `rafId = requestAnimationFrame(frame)` 恢复常驻循环（污染窗口）；`frame()` 未导出 ⇒ bridge 是必须的。

### 3.4 每轮必须输出的"改动性质"

```text
algorithmModified=false            # 三方法都不改 shader/排序/剔除/解码/draw 参数
benchmarkBridgeModified=<0|1>      # ours=1(既有钩子) / flux=1(新增 bridge) / reduced=1(复用 ours 的 slave)
resolutionOverrideActive=<0|1>     # 本轮是否强制分辨率
cameraOverrideActive=<0|1>         # 本轮是否覆盖相机（三方统一相机 ⇒ 1）
```

---

## 4. 统一分辨率 / 相机 / 工作量审计

### 4.1 分辨率（每轮开始前断言，不符即 `valid=false; invalidReason=resolution-mismatch`）

```json
{
    "requested": [1600, 1063],
    "canvas": [1600, 1063],
    "drawingBuffer": [1600, 1063],
    "viewport": [0, 0, 1600, 1063],
    "internalFramebuffer": [1600, 1063],
    "renderScale": 1,
    "adaptiveResolution": false
}
```

必须关闭：DPR 自动放大、动态分辨率、自适应质量、自动 render scale、CSS 驱动后备缓冲变化。
CSS 显示尺寸**单独记录**（`cssWidth/cssHeight`），不得当渲染分辨率。
`1600×1063` 只能描述为"受控实验分辨率"，不得称论文原始分辨率（除非有原文证据）。

### 4.2 相机与投影（三方法语义一致）

```ts
interface CameraFrame {
    viewMatrix: number[];
    projectionMatrix: number[];
    viewProjectionMatrix: number[];
    fx: number;
    fy: number;
    near: number;
    far: number;
    width: number;
    height: number;
}
```

1. 每轮输出 `view / projection / viewProjection` 的 **SHA-256**、`rowMajor|columnMajor`、`worldToCamera|cameraToWorld`；
2. 测量期间关闭 OrbitControls / carousel / 惯性；主吞吐默认**静止相机**；
3. 另设**固定 camera trace**（预生成、三方共享）用于排序开销，单列 `moving-camera-pipelined-throughput`，不与静止相机混表；
4. 跨臂输出 `crossCameraMatched / crossProjectionMatched / crossViewProjectionMatched`；任一 false ⇒ 该组不进三方法主表。

⚠️ **已知阻塞点（需 §10-D2 决策）**：两个实现的 near/far 不同——本方法 `CameraData.ts:9-10` = 0.1/100，
内嵌副本 `main.js:161-162` = 0.2/200 ⇒ **`projectionMatrix` 的 SHA-256 必然不同**；
在 D2 决定之前，`crossProjectionMatched` 只能按 FOV 项（`2fx/w, 2fy/h`）判定。

#### 4.2.1 D2 拍板（上述阻塞点按方案 (a) 解决）

统一项（三方在测量前必须被设置成同一组值；Flux 侧由 bridge 覆盖，**只改参数、不改投影公式**）：

```text
near = 0.1      far = 100        # 本方法默认即此
fx = fy = 1159.5880733038064     # 三方同一焦距（Flux 的 COLMAP 焦距）
drawing buffer = 1600×1063       renderScale = 1      adaptiveResolution = false
```

**SHA-256 只用于结果追溯，不作为语义一致性的唯一判据。** 必须同时输出并判定：

| 判据                                                                         | 定义                                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `viewMatrixSha256` / `projectionMatrixSha256` / `viewProjectionMatrixSha256` | 完整 16 数（行主序、world→camera）的 SHA-256，**仅追溯**                                                                   |
| `matrixToleranceCheck`                                                       | 规范化后逐元素比较 `maxAbsDiff(view / projection / viewProj)`，容差 `1e-6`                                                 |
| **世界锚点投影验证**                                                         | 三方共享一组**世界空间锚点**（由场景包围盒分位数生成、随场景固定）：对每个锚点算 `clip = viewProj · a`，比较三方的像素坐标 |
| **`maxProjectedAnchorErrorPx`**                                              | `max_k` 锚点像素差（按 1600×1063 换算）                                                                                    |
| **`projectionEquivalent`**                                                   | `matrixToleranceCheck === true` **且** `maxProjectedAnchorErrorPx ≤ 1.0 px`                                                |

- **进入主表的依据是 `projectionEquivalent` 与 `maxProjectedAnchorErrorPx`，不是"字节哈希相同"。**
- `crossProjectionMatched := projectionEquivalent`；`crossViewProjectionMatched :=`（viewProj 容差通过
  **且** 锚点误差 ≤ 1 px）。

### 4.3 工作量与质量

每轮 `workload`（取不到的字段写 `null`，不得伪造）：

```json
{
    "modelBytes": 0,
    "gaussianTotal": 0,
    "gaussianVisibleMean": 0,
    "gaussianSubmittedMean": 0,
    "shDegree": null,
    "drawCallsMean": 0,
    "sortRequests": null,
    "sortCompleted": 0,
    "sortWaited": false,
    "lodEnabled": false,
    "cullingEnabled": false,
    "adaptiveQuality": false
}
```

| 字段                                      | ours / reduced-3dgs                                                                                   | flux-gs                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------- |
| `gaussianTotal` / `gaussianSubmittedMean` | `Splat.vertexCount`（= draw 实例数）                                                                  | bridge 的 `vertexCount`   |
| `gaussianVisibleMean`                     | `cullStats`（未开剔除时 = submitted，并标 `cullingEnabled=false`）                                    | `null`（Flux 无剔除统计） |
| `drawCallsMean`                           | wrap `drawArraysInstanced` 计数                                                                       | 同                        |
| `sortCompleted`                           | wrap `bufferData`（SortWorker 回传后上传索引）                                                        | 同（`main.js:1782`）      |
| `sortRequests`                            | `null`（worker 在页面脚本内创建，无法包裹）                                                           | `null`                    |
| `shDegree`                                | 由 loader 元数据推断，取不到 `null`                                                                   | `null`                    |
| `modelStorageBytes`                       | 磁盘文件字节数（`stat`）                                                                              | 同                        |
| `networkTransferBytes`                    | `transferSize`（网络实际传输）                                                                        | 同                        |
| `decodedBodyBytes`                        | `decodedBodySize`（解压后 body）                                                                      | 同                        |
| `modelHash`                               | 文件 SHA-256（前 24 位记录 + 完整值存档）                                                             | 同                        |
| `sourceCommit`                            | ours=本仓库 commit；flux=内嵌副本上游 commit `d062af33…`；**reduced=`null`**（官方只给 URL，见 §5.3） | 同                        |

> **不得**只用 Resource Timing 的 `decodedBodySize` 代表"模型大小"（D/§8 拍板）：
> 磁盘大小、网络传输、解压后长度、文件哈希、来源 commit 必须**分别**输出（取不到的写 `null`）。

质量指标（PSNR/SSIM/LPIPS、模型 MB、Gaussian 数）**不在浏览器内计算** ⇒ 表 2 由离线工具填充
（仓库已有 `metrics.py`、`tools/compare_images.py`）；页面只额外输出**同机位截图**（三方各一张）供人工核对。
标题口径：三方使用**各自已发布的模型表示** ⇒ 只能写
`System-level comparison using method-specific published model representations`（**不得**再写
`each method's native end-to-end implementation` / `using each method's native representation`）。
并且每次陈述结论都必须同时给出这三句：
① Ours 与 Reduced-3DGS **共用本项目的 WebGL renderer**；② Flux-GS **使用它自己的官方 renderer**；
③ 因此臂间差异**不能归因于单一因素**。

---

## 5. 场景矩阵、轮次、顺序与统计

```text
正式主表：warmupFrames=120   measureFrames=300   rounds=12   resolution=1600x1063
预实验  ：rounds=7（六种排列 + 1 随机）——**不得**作为主表
diagnosticDomUpdates=false   consoleLoggingDuringMeasure=false   camera=static
```

平衡顺序（**正式主表 rounds=12**：六种排列各出现两次；7 轮只用于预实验）：

```
O-F-R  O-R-F  F-O-R  F-R-O  R-O-F  R-F-O          # O=ours, F=flux-gs, R=reduced-3dgs
（以上为一组，rounds=12 时整组重复两次）
```

**热漂移（thermalDrift）**：每个场景单独采集并逐轮记录 FPS；若**最后两轮相对前两轮的中位性能下降 > 10%**
⇒ `thermalDrift=true`，**该组不得直接进主表**，必须让设备冷却后重测（判定函数：`computeThermalDrift()`）。

每轮之间：完整 `dispose()` → 确认上下文释放 → 记录 `contextLost` → 固定冷却（`coolms`，默认 3000）
→ 记录电池/充电与温度（可获取时）。**不得**让某方法因先跑而长期占用更多 GPU 上下文。

统计输出：每轮原始值 + median + mean + IQR + stddev + P95 + 首轮/末轮差 + 测试顺序。
**主结果取中位数，不取最佳值。**

### 5.1 指标 B（`presentation-raf-v1`）

```text
warmupFrames=120   measureFrames=600   同一 controller 的 rAF 驱动，每个 rAF 每方法只 render 一次
输出：mean FPS、median frame time、P90/P95/P99、min/max gap、dropped frames、
      screen refresh interval（rAF 间隔中位数估计）、vsyncCapped
```

不得与高于刷新率的吞吐数字直接比较；三方都达上限时只能写"均满足该刷新率"。

### 5.2 最终共同场景矩阵（三方主表只有这 5 个）

**入表条件（三条全部满足）**：① 三方模型都存在；② `dataset` 一致；③ `modelHash` 与来源明确。

| 场景    | dataset | ours（本方法 QPLY r7）                                                       | flux-gs（官方 json）                                     | reduced-3dgs（官方 quantized PLY）                           |
| ------- | ------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| bicycle | mip360  | `scenes/point_cloud_quantised_half_r7-bicycle.ply`（580 000 pts / 13.28 MB） | `flux-gs-project-gh-pages/scene/bicycle.json`（4.99 MB） | `reduced-3dgs/quantized_bicycle.ply`（2 410 512 / 48.28 MB） |
| bonsai  | mip360  | `…-bonsai.ply`（220 000 / 5.04 MB）                                          | `…/bonsai.json`（3.24 MB）                               | `quantized_bonsai.ply`（517 904 / 10.05 MB）                 |
| counter | mip360  | `…-counter.ply`（250 000 / 5.73 MB）                                         | `…/counter.json`（2.43 MB）                              | `quantized_counter.ply`（499 049 / 11.16 MB）                |
| kitchen | mip360  | `…-kitchen.ply`（250 000 / 5.73 MB）                                         | `…/kitchen.json`（3.58 MB）                              | `quantized_kitchen.ply`（838 257 / 18.73 MB）                |
| truck   | tnt     | `…-truck.ply`（273 169 / 6.26 MB）                                           | `…/truck.json`（2.90 MB）                                | `quantized_truck.ply`（854 249 / 16.53 MB）                  |

- 交集由 **reduced-3DGS 官方发布范围**决定（官方只发布了这 5 个；其余 8 个场景在其路径下 404），
  是硬约束而非主观挑选（来源：`reduced-3dgs-urls.json` 的 note + 2026-09 实测）。
- **`profile=quick`（garden/truck/drjohnson）不得作为三方主表**：garden / drjohnson 在 reduced 官方未发布。
  它们只能出现在单臂/两臂的补充表里。
- 采集入口：ours / flux 两臂各跑 `profile=mip360`（9）+ `profile=tnt`（2），reduced 臂跑 `profile=reduced3dgs`（5）；
  报表只保留上表 5 行。

### 5.3 Reduced-3DGS 模型来源审计（D1 要求，2026-09-15 实测）

**来源与二次处理**：

| 项                                      | 结论                                                                                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 来源 URL                                | `https://repo-sam.inria.fr/fungraph/reduced_3dgs/scenes/{scene}/quantized_{scene}.ply`（`reduced-3dgs-urls.json` 的 `overrides` 逐场景直链）                                                                                                     |
| 官方仓库/页面                           | `https://repo-sam.inria.fr/fungraph/reduced_3dgs/`                                                                                                                                                                                               |
| `sourceCommit`                          | **`null`（无 commit 信息可考）** — 如实记录，不编造；以 URL + 文件哈希 + 下载日期代替                                                                                                                                                            |
| 是否经本项目二次量化                    | **否**：`tools/fetch_reduced3dgs_assets.py` 的 `download()` 只把 HTTP 原始字节写成 `.part` 再 `os.replace`，没有任何重写/量化代码；`audit_ply()` 只读头部                                                                                        |
| 字节一致性                              | `reduced-3dgs-urls.json` 的 note 记录"返回 200 且**字节数与本地一致**"                                                                                                                                                                           |
| 本地文件哈希（SHA-256 前 24 位 / 字节） | bicycle `d34fa041bbb38091344704c2` / 50 622 759；bonsai `2c982333f3525277aa993297` / 10 535 404；counter `80ac81f4f366c04cbe4d2348` / 11 704 358；kitchen `1ef7f4806fbb370a06b3af1c` / 19 641 094；truck `ebc9f7f45c35f9a9e1941e1c` / 17 332 330 |

**格式与属性保留（`tools/inspect_ply_header.py` 实测）**：

```
quantized_bonsai.ply  format=qply_naive  vertex_total=517904  codebook_props=20  has_basis=0
   vertex_0    473601  x,y,z(short) f_dc_0..2(uchar) opacity scale_0..2 rot_0..3           → SH 0 阶
   vertex_1       518  同上 + f_rest_0..8                                                   → SH 1 阶
   vertex_2     12288  同上 + f_rest_0..23                                                  → SH 2 阶
   vertex_3     31497  同上 + f_rest_0..44                                                  → SH 3 阶
   codebook_centers(256): features_dc + features_rest_0..14 + opacity + scaling + rotation_re/im
```

⇒ reduced-3DGS 用的是**混合 SH 阶数**的逐阶量化（绝大多数高斯只有 DC），
`x/y/z` 为 `short`、其余属性为 `uchar`，码本 256 项/20 个属性，**没有** `sh_basis` 元素。

**对照 ours（`point_cloud_quantised_half_r7-bonsai.ply`）**：

```
format=qply_lowrank  vertex=220000  codebook_props=12  has_basis=1
  vertex: x,y,z(short) f_dc_0..2(uchar) f_rank_0..6(uchar) opacity scale_0..2 rot_0..3
  codebook_centers(256): features_dc + features_rank_0..6 + opacity + scaling + rotation_re/im
  sh_basis: 7 个基函数 × 45 个系数（低秩 SH 基）
```

⇒ 三方的 SH 表示互不相同（Flux-GS：一阶 SH；ours：低秩 SH 基；reduced-3DGS：混合逐阶 SH），
这正是 D1 要求用 `Three-representation mobile WebGL system comparison` 的原因。

### 5.4 `yieldMode` / `batchSize` 敏感性实验计划（D5/§5：先做实验再定主表）

| 变量        | 取值                         | 说明                                                                         |
| ----------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `yieldMode` | **`none`**、`messagechannel` | `none` = 连续提交（t0…t1 之间不 yield）；`messagechannel` = 每批后让出主线程 |
| `batchSize` | `1`、`5`、`10`、`30`         | 仅对 `messagechannel` 有意义；`none` 时等价于 `batchSize=N`                  |

执行顺序（每个场景、每个方法）：

```
基线：yieldMode=none
对照：yieldMode=messagechannel × batchSize ∈ {1,5,10,30}
```

- 每个组合 **3 轮**，每轮之间完整 dispose + 冷却（`coolms`）；每个组合前 `preFinish()`。
- 输出 `yieldModeReport`：每个组合的 `medianFps`、相对 `none` 的 `deltaPct`、`submitPhaseMs`、`drainPhaseMs`。
- **判定规则**：若 `messagechannel` 各组合相对 `none` 的 `|deltaPct| ≤ 2%` 且三个方法同向、且 `drainPhaseMs` 无系统性变化
  ⇒ 可用 `messagechannel + batchSize=10` 作为主表（兼容/稳定性更好）；
  **否则主表用 `yieldMode=none`**（避免固定调度开销压缩快速方法之间的差异）。
- 无论选哪个，主表表注必须写明本轮使用的 `yieldMode` 与 `batchSize`。

### 5.5 设备口径（D4 拍板）与轮次

| 用途             | 设备/浏览器                                        |
| ---------------- | -------------------------------------------------- |
| **主表**         | **目标手机的系统浏览器**（Chrome / Edge / Safari） |
| 附录             | 同一台手机的**微信 / XWeb**                        |
| 开发、回归、补充 | 桌面 Chromium                                      |

- **不接受"用桌面替代移动端主结果"。** 若 XWeb 出现上下文耗尽，主表就用该手机的**系统浏览器**完成，
  而不是换桌面。
- 轮次：`rounds=7`（6 种平衡排列 + 第 7 轮随机）；若要每种排列出现两次则 `rounds=12`。
- 每轮之间：完整 `dispose()` → 确认上下文释放 → 记录 `contextLost` → 固定冷却（`coolms=3000`）
  → 记录电池/充电状态与温度（可获取时）。**不得**让某方法因先跑而长期占用更多 GPU 上下文。
- 统计：每轮原始值 + median + mean + IQR + stddev + P95 + 首轮/末轮差 + 顺序；**主结果取中位数**。

### 5.6 动态相机（`moving-camera-pipelined-throughput`）的严格语义

每一正式帧必须记录：

```
setCamera(trace[i])
sortRequestedThisFrame = <bool>
sortCompletedBeforeRender = <bool>
waitedForSort = <bool>
usedSortResult = current | previous        # 当前帧用的是本次还是上次的排序结果
```

- 若实现是**流水线式**（不等待排序、当前帧用上次结果）⇒ 只能用协议名
  `moving-camera-pipelined-throughput`；
- 若实现是**阻塞式逐帧等待排序** ⇒ 另立 `moving-camera-blocking-throughput`，**两者不得混表**；
- **禁止**"连续快速提交 300 帧后声称测到了逐帧新视角的完整排序性能"——
  如果 trace 变化快于排序完成速度，那测的是"提交 + 上一帧排序结果"的流水线吞吐，必须如实命名。

---

## 6. 将新增 / 将修改的文件（第二步执行清单）

### 6.1 新增（全部在 `gsplat.js/`）

| 文件                        | 职责                                                                                                                                                                    | 备注                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `THREE_WAY_BENCH_DESIGN.md` | 本文档                                                                                                                                                                  | 已提交                                                |
| `bench-three-way.html`      | 顶层页面：三方法 UI + 表 1/2/3 + 导出                                                                                                                                   | 需加入 `vite.site.config.js` 的 `rollupOptions.input` |
| `bench-three-way.ts`        | 页面接线：URL 参数、平衡顺序、进度、表渲染、导出                                                                                                                        | 不支持 `?only=` 则受限设备无法单场景采集（见 D5）     |
| `bench-controller.ts`       | **唯一状态机**：四个协议（`gpu-drain-synchronized-throughput-v1` / `moving-camera-*` / `presentation-raf-v1` / legacy）的全部计时、`yieldMode/batchSize` 调度、事件日志 | 纯逻辑，不 import `./src`、不碰 GL/DOM ⇒ 可单测       |
| `bench-adapters.ts`         | `OursAdapter` / `Reduced3dgsAdapter` / `FluxGsAdapter`（`adapter.name = ours / reduced-3dgs / flux-gs`）                                                                | 三个 adapter 实现同一接口（§3.1）                     |
| `bench-gl-probe.ts`         | 复用**既有** canvas 取 WebGL2 context，并 wrap `drawArraysInstanced`/`bufferData`/`finish`/`requestAnimationFrame`/`setTimeout` 计数（§2.2）                            | **绝不新建 canvas**（尊重 `main.js:1585` 的告诫）     |
| `bench-audit.ts`            | `ResolutionAudit`/`CameraAudit`/`WorkloadAudit` 结构、SHA-256、`cross*` 判定、`invalidReason`                                                                           | 纯逻辑 ⇒ 可单测                                       |
| `bench-controller.test.ts`  | mock adapter ×3 + 事件顺序断言（任务 §11 的 12 条）                                                                                                                     | vitest                                                |
| `bench-audit.test.ts`       | 哈希/交叉判定/无效原因                                                                                                                                                  | vitest                                                |
| `tools/three_way_report.py` | 汇总表 1/2/3、median/mean/IQR/stddev/P95、顺序记录                                                                                                                      | 可选，与现有 `ch7_baseline_report.py` 同风格          |

### 6.2 修改

| 文件                                                                               | 改动                                                                                            | 风险级别                                                   |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `flux-gs-project-gh-pages/render_shared/main.js`                                   | **纯追加** `window.__FLUXGS_BENCH_BRIDGE__`（§3.3）                                             | **高**（第三方文件；需重跑 vendor diff + 更新 §4 hunk 表） |
| `bench-case.ts`                                                                    | 新增 `?slave=1`：暴露 `__CASE_BENCH__`，不自动测帧                                              | 中                                                         |
| `bench-measure.ts`                                                                 | 暴露 `renderOneFrame/finishGpu/setCamera/audits`；slave 下禁用自动 `measureOneRound`            | 中（已有 `runThroughputFrames` 等，保留不动）              |
| `bench-shared.ts`                                                                  | 协议/指标常量、`BenchMethod` 枚举、三方法结果类型、默认参数                                     | 低                                                         |
| `bench-flux-protocol.ts`                                                           | **改名**：协议 `local-flux-hook-unsynchronized-submit-v1`、metric 不变；文案去掉"论文/参考协议" | 低                                                         |
| `bench.ts` / `bench-flux.ts`                                                       | 旧口径结果头加 `protocol=local-flux-hook-unsynchronized-submit-v1`、`appendix=true`             | 低                                                         |
| `vite.site.config.js`                                                              | `input` 增加 `benchThreeWay: bench-three-way.html`                                              | 低                                                         |
| `tsconfig.benchcheck.json`                                                         | `include` 增加新文件                                                                            | 低                                                         |
| `FLUX_FPS_PROTOCOL.md` / `FLUX_VENDOR_DIFF.md` / `FLUX_RUNTIME_VALIDATION_PLAN.md` | 命名、hunk 数、三方法流程更新                                                                   | 低                                                         |

---

## 7. 测试与验证计划

### 7.1 单元测试（必须覆盖任务 §11 的 12 条，用 mock adapter + 事件日志）

| #   | 验收项                              | 断言方式                                                                                                          |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | 开始 `gl.finish()` 在 `t0` 之前     | 事件序列 `finish-start` 先于 `t0`                                                                                 |
| 2   | 结束 `gl.finish()` 在 `t1` 之前     | `finish-end-return` 先于 `t1`                                                                                     |
| 3   | 结束排水进入 elapsed                | 把 `finishGpu` 人为延迟 D 后，`elapsedMs` 增加 ≈D                                                                 |
| 4   | `renderCalls` 恰等于 N              | 三个 mock adapter 都断言 N（含 batch=1/5/10/30）                                                                  |
| 5   | 三个 adapter 用同一 controller      | 同一实例驱动三者，事件序列结构一致                                                                                |
| 6/7 | 不用每帧 `setTimeout(0)` / 不用 rAF | 断言调度只经 `yield()`；`yield` 计数 = ceil(N/batch)；源码守卫（不允许出现 `setTimeout`/`requestAnimationFrame`） |
| 8/9 | 隐藏 / context lost ⇒ 无效          | `valid=false`、`invalidReason=hidden                                                                              | context-lost` |
| 10  | 分辨率不一致 ⇒ 无效                 | `invalidReason=resolution-mismatch`                                                                               |
| 11  | 相机/投影不一致 ⇒ 不进主表          | `cross*Matched=false` ⇒ 该组被主表过滤                                                                            |
| 12  | 测量窗口内零诊断 DOM 更新           | DOM 写入 spy 计数 = 0（沿用现有 11 号守卫思路）                                                                   |

**独立验证**：不给 controller 写第二份"手工同构 reference"；改为**事件日志**验证真实 controller
（`finish-start → t0 → render-1…render-N → finish-end-start → finish-end-return → t1`），
并对三个 mock adapter 各跑一遍，断言顺序与计数一致。

### 7.2 浏览器集成测试

在真实 Chromium（开发/回归）与**目标手机系统浏览器**（主表前置验证）跑三个最小场景
（`only=truck`、`frames=30`、`warmup=5`、`rounds=1`、`yieldMode=none`），输出并**逐条断言**：

| 断言                                                                                                   | 期望                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 取得的是**被测 renderer 的同一个** context                                                             | `adapters[name].gl === iframe.contentWindow.document.getElementById("canvas").getContext("webgl2")`（同一对象引用；且**未新建 canvas**）     |
| `preFinishCalls`                                                                                       | **1**                                                                                                                                        |
| `postFinishCalls`                                                                                      | **1**                                                                                                                                        |
| `controllerRenderCalls` / `adapterFrameDelta`                                                          | 都等于 `N`                                                                                                                                   |
| `unexpectedDrawCalls`                                                                                  | **0**                                                                                                                                        |
| `unexpectedFrameCallbacks`                                                                             | **0**                                                                                                                                        |
| `contextLost`                                                                                          | **false**                                                                                                                                    |
| `totalSyncedMs`                                                                                        | ≈ `submitPhaseMs + drainPhaseMs`（允许计时精度误差，如 ≤ 0.5 ms 或 ≤ 0.1%）                                                                  |
| 分辨率审计                                                                                             | `canvas / drawingBuffer / viewport / internalFramebuffer` 全等于 `requested`                                                                 |
| 相机审计                                                                                               | `projectionEquivalent === true` 且 `maxProjectedAnchorErrorPx ≤ 1.0`                                                                         |
| 输出                                                                                                   | `render count`、`drawing buffer`、`viewport`、`camera hash`、`start finish`、`end finish`、`submit phase`、`drain phase`、`total synced FPS` |
| 依赖：`gsplat.js` 的 devDependencies **没有 puppeteer**（`package.json` 里未列出），                   |
| 但 `thesis_project/puppeteer-config.json` 与 `thesis_project/package-lock.json` 表明那侧已有 puppeteer |
| ⇒ 集成测试放在 `thesis_project` 侧运行，或给 `gsplat.js` 增加 devDependency（见 §10-D5）。             |

**没有真机数据前，一切状态只能写 `implemented-but-not-runtime-validated`。**

---

## 8. URL 草案

### 8.1 统一三方法入口（建议新增）

```
https://<host>/bench-three-way.html
  ?methods=ours,flux,reduced          # URL 用短名；adapter.name = ours | flux-gs | reduced-3dgs
  &protocol=gpu-sync                  # gpu-sync(主) | moving-camera | raf | legacy
  &profile=mip360,tnt,reduced3dgs     # 报表只保留 §5.2 的 5 个共同场景
  &res=1600x1063
  &warmup=120
  &frames=300
  &rounds=7
  &camera=static
  &yieldMode=none                     # 默认 none（先做 §5.4 敏感性实验再定主表）
  &batchSize=10                       # 仅 yieldMode=messagechannel 时生效
  &coolms=3000
  &only=truck                         # 可选：只跑指定场景（受限设备必用，D5①）
  &u=<设备标签>                        # 三个臂用同一个 u=
```

**主表设备**：目标手机的**系统浏览器**（D4）。同一台手机的微信/XWeb 只作为附录；桌面 Chromium 只用于开发/回归。

### 8.2 三条单方法 smoke URL（各自独立、便于先排错）

```
① ours       https://<host>/bench-three-way.html?methods=ours&only=truck&protocol=gpu-sync&yieldMode=none&res=1600x1063&frames=30&warmup=5&rounds=1&u=smoke
② flux-gs    https://<host>/bench-three-way.html?methods=flux&only=truck&protocol=gpu-sync&yieldMode=none&res=1600x1063&frames=30&warmup=5&rounds=1&u=smoke
③ reduced    https://<host>/bench-three-way.html?methods=reduced&only=truck&protocol=gpu-sync&yieldMode=none&res=1600x1063&frames=30&warmup=5&rounds=1&u=smoke
```

（三个 smoke 都强制 `only=truck`，因为它是三方法共同场景之一；
正式采集用 `profile=mip360` + `profile=tnt`，报表只保留 bicycle/bonsai/counter/kitchen/truck 五个共同场景。）

### 8.3 附录（旧口径，不改现状）

```
https://<host>/bench.html?mode=bench&proto=flux&cam=flux&res=1600x1063&frames=300&warmup=0&diag=1# 已有数据
```

结果头会带 `protocol=local-flux-hook-unsynchronized-submit-v1` 与 `appendix=true`，禁止进入主表。

---

## 9. 报告与表

**实验标题（逐字使用）**：`Three-representation mobile WebGL system comparison`
**表注（逐字使用）**：Ours 与 Reduced-3DGS 共用本项目的 WebGL renderer；Flux-GS 使用它自己的官方 WebGL
renderer。因此差异不能全部归因于渲染器或模型表示中的单一因素。分句说明：
① Ours vs Reduced-3DGS = 同一 renderer 下的模型表示/资产对比；
② Ours system vs Flux-GS system = 不同模型表示 + 不同 renderer 的系统级对比。
**主表只包含 §5.2 的 5 个共同场景**（bicycle / bonsai / counter / kitchen / truck）。

### 表 1 同步吞吐主结果（`gpu-drain-synchronized-throughput-fps`，median）

```
Scene | Ours median FPS | Flux-GS median FPS | Reduced-3DGS median FPS | crossCamera | crossProjection | crossViewProjection
```

表注（必须逐字写）：

```
包含 JavaScript、WebGL 驱动提交和 GPU 队列完成时间；
不等同于 EXT_disjoint_timer_query 测得的纯 GPU 时间。
```

### 表 2 工作量与质量

```
Scene | Method | Model MB | Gaussian count | Visible count | SH degree | PSNR | SSIM | LPIPS
```

（质量列来自离线评测 `metrics.py`；`null` 表示取不到，不得留空编造。）

### 表 3 rAF 交互体验（`presentation-raf-v1`）

```
Scene | Method | Mean presented FPS | P95 frame time | VSync capped
```

### 附录表

```
Appendix: local Flux-hook-compatible unsynchronized submission results
（protocol=local-flux-hook-unsynchronized-submit-v1，含当前 ~222FPS 的 timer 数据）
```

### 禁止项（任务 §3/§13）

1. 不得用 `300/(submit_elapsed + probe_finish_readPixels_elapsed)` 当正式 GPU FPS；
   只允许作为诊断 `postSubmitDrainDiagnosticMs` 并标 `diagnosticOnly=true`；**不得输出 `gpuFps`**。
2. 未完成真机验证前，不得声称 `fair benchmark validated` / `paper protocol reproduced` / `GPU FPS verified`；
   只能写 `synchronized three-renderer benchmark implemented`（真机后 → `implemented-but-not-runtime-validated`
   → 完成 §7.2 后才可写 validated）。

---

## 10. 决策点 D1–D5（已拍板）与风险清单

### 10.1 D1–D5 拍板结果（已确认，按此实现）

| #      | 拍板                                                                                                                                                                                                                                                                                                                                                          | 落地要求                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | 接受 (a)，但**改实验命名**：标题 `Three-representation mobile WebGL system comparison`；**禁止**"三渲染器对比"、**禁止**"三种方法各自原生端到端实现"；必须拆分解释（① Ours vs Reduced-3DGS = 同 renderer 下的表示/资产对比；② Ours system vs Flux-GS system = 表示+renderer 的系统级对比）；表注写明"差异不能归因于单一因素"                                  | 实现前完成 §5.3 的来源审计（来源 URL / 官方 commit / 是否二次量化 / 模型哈希 / 属性保留）——**已完成并写入 §5.3**（`sourceCommit=null`、无二次量化、5 个文件哈希与属性表） |
| **D2** | 选 (a)：统一 near/far、fx/fy、drawing buffer 与最终相机；**SHA-256 只作追溯**；同时实现统一后矩阵的容差比较、世界锚点投影验证、`maxProjectedAnchorErrorPx`、`projectionEquivalent`；**入主表依据 `projectionEquivalent` + 像素误差，而不是哈希相同**                                                                                                          | 见 §4.2.1；Flux 侧 near/far 覆盖只改参数、不改公式（记为独立 hunk）                                                                                                       |
| **D3** | 主协议**只用 `gl.finish()`**；**删除**"finish 可能假同步"的表述——同一未丢失的 context 下 `gl.finish()` 就是正式的阻塞式完成边界；`fenceSync/clientWaitSync` 仅作开发验证/附录，**不作为主表第二套协议、不与 finish 结果混合**                                                                                                                                 | 主协议：`preFinish 返回 → t0 → N 次 render → postFinish 返回 → t1`；结束 finish 的等待必须进入 elapsed（§1.1）                                                            |
| **D4** | **不接受"桌面作为移动端主表"**：主表 = **目标手机的系统浏览器**；同一手机的微信/XWeb = 部署附录；桌面 Chromium = 开发/回归/补充。若 XWeb 上下文耗尽，用目标手机的系统浏览器完成主表，**不得**改用桌面替代移动端主结果                                                                                                                                         | §5.5                                                                                                                                                                      |
| **D5** | ①②③④**全部纳入**：① `?only=<scene>` 单场景；② 分辨率每轮只设置一次（设置后仍审计 canvas/drawingBuffer/viewport/internalFramebuffer）；③ 修正 `bench-case.ts:20` 的 `losectx` 注释；④ 旧未同步协议**新增** `postSubmitDrainDiagnosticMs`（`diagnosticOnly=true`）；**新同步协议不使用该字段**，而是直接输出 `submitPhaseMs` / `drainPhaseMs` / `totalSyncedMs` | §1、§4.1、§6.2、实现时逐项勾对                                                                                                                                            |

> 状态词：本文件当前为 `designed-but-not-implemented`；实现完成 → `implemented-but-not-runtime-validated`；
> 浏览器集成测试通过 → `browser-validated`；目标手机系统浏览器采完 → `target-device-validated`。

### 10.2 风险清单

| #   | 风险                                                                     | 级别       | 缓解                                                                                                                                 |
| --- | ------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Reduced-3DGS 无自有 WebGL 实现 ⇒ 三方法表语义被高估                      | **已处置** | D1 拍板：标题与表注已收紧（§顶部 + §9），并完成 §5.3 来源审计                                                                        |
| R2  | 改 `render_shared/main.js`（第三方）                                     | 高         | 3 个 hunk（2 纯追加 + 1 处 `else` 分支）；逐 hunk 记录 + 重跑 `check_flux_vendor_diff.py` + 验证"未带 `bridge=1` 时默认路径逐字不变" |
| R3  | Flux `frame()` 自挂 rAF（`main.js:2338`）⇒ 窗口内混入额外帧              | 高         | `benchSlaveMode` 让 `frame()` 不入队（§3.3），并用 wrap 计数断言 `unexpectedFrameCallbacks=0` 才能 `valid=true`                      |
| R4  | `gl.finish()` 是否等于 GPU 完成                                          | **已定论** | D3：同一未丢失 context 下 `finish()` 即正式阻塞式完成边界；主协议只用它。`fenceSync` 仅开发/附录，不混表（不再作为风险项）           |
| R5  | 手机端上下文耗尽（已实测）                                               | 中         | D4（主表用目标手机**系统浏览器**）+ `?only=` + 每轮 dispose/冷却 + `ctxlost` 记录 + 先跑 smoke                                       |
| R6  | 指标 B 被刷新率封顶 ⇒ 无区分度                                           | 中         | 只输出"均满足 X Hz"；记录 `screenRefreshHz`；不排名                                                                                  |
| R7  | near/far 差异导致整投影不可比                                            | **已处置** | D2：统一 near/far/fx/fy/buffer + 容差比较 + 锚点投影 + `projectionEquivalent`（§4.2.1）                                              |
| R8  | 工作量字段部分为 `null`（Flux 无 cull 统计、`shDegree`、`sortRequests`） | 中         | 允许 `null`；表 2 标注来源与 `null` 含义                                                                                             |
| R9  | 质量指标不在浏览器内计算                                                 | 中         | 表 2 由离线 `metrics.py` 填充并在表注说明                                                                                            |
| R10 | 受限设备无法单场景采集                                                   | **已处置** | D5①：实现 `?only=<scene>`                                                                                                            |
| R11 | `gsplat.js` devDeps 无 puppeteer                                         | 低         | 集成测试放 `thesis_project` 侧，或新增 devDependency                                                                                 |
| R12 | 命名迁移：旧 222FPS 数据/文档需重新标注                                  | 低         | 统一加 `protocol=local-flux-hook-unsynchronized-submit-v1` + `appendix=true`                                                         |
| R13 | 第三方臂的模型必须同源（`main.js` 默认指向 HF）                          | 低         | adapter 强制用本地镜像（`flux-baseline-scenes.json` 已给本地 `scene/*.json`）                                                        |
| R14 | 视觉观感：窗口只有几秒，画面很快被销毁 ⇒ 误以为"没渲染完"                | 低         | UI 显示阶段文本 + 输出 `submitPhaseMs/drainPhaseMs`（现在这两个是主协议正式字段）                                                    |
| R15 | `yieldMode=none` 期间主线程长时间不响应                                  | 低         | 窗口内禁止 DOM 更新；先跑 §5.4 敏感性实验再定主表设置                                                                                |

---

## 11. 交付顺序（对齐任务 §13）

| 步  | 内容                                                                                                                           | 状态                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | **设计文档**（本文，含 D1–D5 拍板、共同场景矩阵、reduced 来源审计、yield 实验计划、`benchSlaveMode` 伪代码、§12 强制验收条件） | ✅ 已完成（状态 `designed-but-not-implemented`）                                   |
| 2   | 三个 adapter 的准确文件位置                                                                                                    | ✅ §2.1 / §6                                                                       |
| 3   | 三者能否暴露 WebGL context / `finishGpu`                                                                                       | ✅ 能（Flux 需 3 个 hunk 的 `benchSlaveMode` + bridge；ours/reduced 直接有）       |
| 4   | 实现唯一 three-way controller（`bench-controller.ts` + `bench-audit.ts` + 单测）                                               | ✅ **已实现**（`bench-controller.test.ts` 25 项、`bench-audit.test.ts` 14 项全绿） |
| 5   | `bench-gl-probe.ts`（wrap draw/bufferData/finish/Worker/rAF/timer + 作用域归因）                                               | ✅ **已实现**（`bench-gl-probe.test.ts` 13 项全绿）                                |
| 6   | 接入三个 adapter（`bench-adapters.ts`）                                                                                        | ⏳ 未开始（阶段 5–8）                                                              |
| 7   | 单元测试（§7.1 的 12 条 + 事件日志 + 计数器拆分）                                                                              | ✅ 已完成（并被 §12 条件 1/4/5 扩充）                                              |
| 8   | 浏览器集成测试（真实 Chromium + 目标手机系统浏览器）                                                                           | ⏳                                                                                 |
| 9   | 三条单方法 smoke URL                                                                                                           | ✅ 草案见 §8.2                                                                     |
| 10  | 统一三方法 URL                                                                                                                 | ✅ 草案见 §8.1（页面未创建）                                                       |
| 11  | 一次真实运行示例                                                                                                               | ⏳                                                                                 |
| 12  | 修改论文表格与文字                                                                                                             | ⏳（最后做，且在目标手机系统浏览器完成正式测试之前**禁止**修改）                   |

**实现顺序约定**（避免返工）：

1. `bench-controller.ts` + `bench-audit.ts`（纯逻辑）→ 7.1 的单测全绿；
2. `bench-gl-probe.ts`（wrap 计数 + 复用既有 context）；
3. `bench-case.ts` slave 模式 + `bench-measure.ts` 暴露接口（含 D5②③）；
4. Flux `benchSlaveMode` 3 个 hunk + 重跑 vendor diff；
5. `bench-adapters.ts` 三 adapter + `bench-three-way.html/.ts`；
6. §5.4 敏感性实验 → 定主表设置；再按 §8 采集。

在此之前，任何地方都不得声称 `fair benchmark validated` / `paper protocol reproduced` / `GPU FPS verified`。

---

## 12. 强制验收条件（2026-09-15 追加，与上文冲突处以本节为准）

> 本节 7 条是**实现阶段的强制验收条件**；`bench-controller.ts` / `bench-audit.ts` / `bench-gl-probe.ts`
> 已按此实现（对应单测在 `bench-controller.test.ts` / `bench-audit.test.ts` / `bench-gl-probe.test.ts`）。

### 12.1 静态吞吐必须处理 Worker 排序队列（条件 1）

静态主协议固定为：

```text
set camera → request one sort → wait for that exact sort result → disable further sort requests
→ warmup → wait for worker quiescence → preFinish → t0 → N 次静态 render → postFinish → t1
```

正式测量窗口**必须**输出：`sortRequestsDuringMeasure`、`sortCompletedDuringMeasure`、
`indexBufferUploadsDuringMeasure`、`pendingSortsAtStart`、`pendingSortsAtEnd`。

`static-render-only-synchronized-throughput-v1` 的有效性要求为这五项**全部 = 0**。
若某实现无法禁止排序请求，则**不得**称为 render-only，必须改名为
`static-full-frame-function-synchronized-throughput` 并**完整报告排序活动**（此时五项的 0 值不作要求）。
协议名由 `adapter.capabilities.staticFrameRenderOnly && sortFreezeSupported` 自动选择，禁止手工混称。

### 12.2 Flux bridge 区分两个入口（条件 2）

Flux 侧必须实现两个入口：`renderStaticFrame()`（不更新相机、不发新排序请求、不更新 benchmark DOM、
不挂 rAF，只用已完成的排序结果绘制）与 `renderPipelinedFrame()`（保留原始异步排序语义，但**不得自挂 rAF**）。
在确认一次 `frame()` 的全部工作内容之前，**禁止**把 `frame()` 等同于纯 render。

### 12.3 公共锚点必须固定为同一份数值（条件 3）

每场景唯一公共锚点文件：`bench-camera/<scene>-anchors.json`，并记录 `anchorSetHash`、
`coordinateSystem`（固定 `canonical`）、`source`；**禁止**三个模型各自从自己的包围盒生成锚点。
同时记录每臂的 `modelToCanonicalMatrix`（坐标系不同时由 adapter 负责变换），投影验证基于同一 canonical 锚点集。

### 12.4 draw 归因使用作用域（条件 4）

controller 固定调用 `probe.beginControlledFrame(frameSerial)` → `adapter.renderOneFrame()` →
`probe.endControlledFrame(frameSerial)`；每个 draw 记录所属 `frameSerial`。
`drawCallsPerFrame` 允许 > 1；**只有不属于任何 controlled frame 的 draw 才计 `unexpectedDrawCalls`**。
有效性：`controllerRenderCalls=N` ∧ `adapterFrameDelta=N` ∧ `unexpectedDrawCalls=0` ∧ `unexpectedFrameCallbacks=0`。

### 12.5 正式主表使用 12 轮（条件 5）

`rounds=12`（六种 O/F/R 排列各出现两次）；`rounds=7` 仅用于预实验。每场景单独采集并记录热漂移：
最后两轮相对前两轮中位性能下降 > 10% ⇒ `thermalDrift=true`，该组不进主表、冷却后重测。

### 12.6 数据字段（条件 6）

删除含糊的 `modelBytes`，统一使用 `modelStorageBytes` / `networkTransferBytes` / `decodedBodyBytes`；
并分开记录 `rendererSourceCommit` / `modelSourceCommit` / `modelSourceUrl` / `modelDownloadDate` / `modelHash`。
Flux **同样必须**输出实际 `vertexCount` 与模型哈希，不得只输出 JSON 文件大小。

### 12.7 文档措辞（条件 7）

统一为 `System-level comparison using method-specific published model representations`，
并始终说明：Ours 与 Reduced-3DGS 共用 renderer；Flux-GS 使用自己的 renderer；三方差异不能归因于单一因素。

### 12.8 状态词（条件 8）

每完成一阶段必须报告：修改文件、测试命令与退出码、尚未完成项、当前状态词。

### 12.9 排序强制证明（2026-09-15 追加，覆盖 12.1 的等待语义）

```text
requestSortOnce(camera, { force: true })     ← 主表静态协议**必须** force=true
force 请求不得被实现吞掉（Ours/Reduced: 绕过 dirty 启发式；Flux: 绕过 dot 阈值早期返回）
强制请求必须回传**同一** sortSerial
SortAppliedProof 四项齐全：completed / uploaded / activated / usedByDraw
vendor-equivalence-heuristic 只能作附录/诊断，**不得**满足主表 sortAppliedProof
```

测量前必须完成至少一次**冻结后的 static warmup draw**，并验证：

```text
lastDrawSortSerial === token.serial   ∧   lastDrawCameraHash === token.cameraHash
```

正式窗口结束后验证：`activeSerial` 未变化 ∧ `lastDrawSortSerial` 未变化。

### 12.10 探针权威等级

```text
sortAuditAuthority = "renderer-bridge"        ← getSortAudit() 是权威来源
probeRealmMatched / probeBoundToSortWorkerInstance /
probeInstalledBeforeWorkerCreation / probeReattachedExistingHandler   ← 必须写入结果
外部 Worker/GL wrap 仅作交叉验证，不得作为排序有效性的唯一依据
```

### 12.11 状态词（2026-09-15 修订）

状态词随实现进度**逐级**变化，不得跳级：

```text
core-implemented-adapters-not-implemented
  → slaves-implemented-adapters-not-implemented
  → case-adapters-implemented-flux-adapter-not-implemented   ← 当前（阶段 8A 完成）
  → flux-bridge-implemented-flux-adapter-not-implemented     ← 阶段 6 完成后
  → implemented-but-not-runtime-validated                    ← 三个 adapter 全部实现并通过构建
  → browser-validated                                        ← 真实 Chromium smoke 通过
  → target-device-validated                                  ← 目标手机系统浏览器完成正式测试
```

约束：

- 三个 adapter（Ours / Reduced-3DGS / Flux-GS）**全部**实现并通过构建之前，**不得**进入
  `implemented-but-not-runtime-validated`；
- 无 Chromium 的环境下 **smoke 一律保持 pending**，不得伪造运行数据；
- **目标手机系统浏览器完成正式测试之前**，禁止修改论文表格。

---

## 13. 落地记录 H23：三臂入口 URL（ours / reduced-3dgs 从未被浏览器跑过的缺口）

**症状**（桌面 Chromium，组合跑）：`bench-three-way.html?methods=ours,flux-gs&only=bicycle&res=1600x1063&frames=300&warmup=120&rounds=12&yieldMode=none` 在 `ours` 臂固定失败：

```
运行失败：Error: 等待超时：__CASE_BENCH__(ours)
    at waitFor (bench-three-way.ts:280)
    at async CaseSlaveAdapter.init (bench-adapters.ts:72)
```

**根因**（与渲染器 / 协议无关，纯接线）：`readSceneEntries()` 只认 `modelUrl` / `iframeUrl` 两个字段，
而 `bench-scenes.json` / `baseline-scenes.json` 用的是**旧 schema**（模型叫 `file`、vendor 页叫 `page`）⇒

| 臂           | 清单给的字段 | `readSceneEntries()` 产出                    | 实际 iframe                     | 结果     |
| ------------ | ------------ | -------------------------------------------- | ------------------------------- | -------- |
| ours         | `file`       | `modelUrl=""` + flux 保守默认页              | **flux 的页面**（无 `__CASE_BENCH__`） | 30s 超时 |
| reduced-3dgs | `file`       | 同上                                         | `render_r3dgs-*`（甚至不存在）  | 30s 超时 |
| flux-gs      | `page`       | `iframeUrl=`（flux 保守默认页）              | flux 页                         | ✅ 能跑  |

flux 臂**只是碰巧**能跑：那条保守默认（`flux-gs-project-gh-pages/render_<id>/index.html`）恰好就是它自己的页面路径。
因此"ours 臂从未在浏览器里真正启动过"这一点此前完全没有暴露。

**修复**（新增 `bench-slave-url.ts`；纯函数，单测 `bench-slave-url.test.ts` 8 条）：

1. `readSceneEntries()` 归一旧 schema：`modelUrl ← modelUrl | file`、`iframeUrl ← iframeUrl | page | <flux 保守默认>`；
2. `slaveIframeUrl(method, entry, { jobId, resW, resH })` 成为**唯一**入口 URL 构造器：
    - `ours` / `reduced-3dgs` ⇒ `bench-case.html?slave=1&jobId=…&scene=…&dataset=…&model=…&res=WxH`
      （`caseSpecFromUrl()` 要求 `jobId` / `scene` / `model` 三者齐全，缺一则子页报 NO_JOB 且**不会**挂 `__CASE_BENCH__`）；
    - `flux-gs` ⇒ 清单声明的 vendor 页原样返回（`bridge=1&benchres=…&fxsession=…` 只由
      `FluxGsAdapter.injectBridgeParams()` 注入，避免两处注入）；
    - 缺字段**显式抛错** ⇒ 由 `runThreeWayPlan` 记成 `round-failed:…`，不再退化成 30s 的"等待超时"；
3. 状态行加 `runner=H23`（确认加载的是这一版 runner），并在每个臂创建 iframe 前打印
   `[three-way] <method> iframe: page=… slave=… jobId=… scene=… model=…`（自诊断：下次一步定位）。

**与 §8.1 / §8.2 草案的差异（以实现为准）**：方法名是 `methods=ours,flux-gs,reduced-3dgs`
（短名 `flux` / `reduced` 被 `REJECTED_METHOD_ALIASES` 显式拒绝）；没有 `profile=` / `coolms=`；
`round` / `attempt` / `token` 在 `?slave=1` 下无意义（slave 模式不进 `measureOneRound`，见 `bench-case.ts:342-354`）。

**状态（诚实口径）**：`flux-gs` 臂单方法 smoke 已在桌面 Chromium 跑出 `valid=true`；
`ours` / `reduced-3dgs` 臂的浏览器验证 **pending**（本修复后必须重跑 §8.2 的 ①②③）。
在三条 smoke 全部 `valid=true` 之前，主表采集仍然禁止（§12.8 / §12.11 状态词不变：`browser-validated pending`）。

