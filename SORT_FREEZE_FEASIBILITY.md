# 排序冻结可行性审计（阶段 7A，只读）

> **状态：`audit-complete-read-only`**（本轮**未修改**任何正式代码：`RenderProgram.ts` / `SortWorker.ts` /
> Flux `main.js` / `bench-case.ts` 均未触碰）
>
> 项目状态词：`core-implemented-adapters-not-implemented`
>
> TypeScript 检查声明（不得笼统称"类型检查全部通过"）：
> - **新模块专项 tsc = exit 0**：`bench-audit.ts` / `bench-controller.ts` / `bench-gl-probe.ts`（+ 各自单测，
>   命令行显式列出文件）；
> - **全量 `tsc -p tsconfig.benchcheck.json` = exit 2**，唯一错误为**既有**错误
>   `src/renderers/webgl/utils/SortWorker.ts(232,13) TS2322`（本轮之前即存在，非本次引入）。
>
> ⚠️ 阶段 7B 要改的 `SortWorker.ts` **正是**该既有错误的载体文件，处理策略见 §5.4（待拍板）。

---

## 0. 六个事件必须分开建模（本轮核心结论）

```text
sortRequested         主线程向排序 worker 发出一次请求
sortWorkerCompleted   worker 内部排序函数返回（含失败分支）
sortResultReceived    主线程收到 postMessage（可能为空结果）
sortIndexUploaded     结果写入 GL 索引缓冲（gl.bufferData）
sortResultActivated   该索引成为"下一次绘制将要使用的索引"
sortResultUsedByDraw  某次 draw 真正以该索引为实例顺序完成提交
```

**仅观察 `depthIndex` 或 `bufferData` 不能证明目标排序已被当前 draw 使用。** 三方可得证据：

| 事件 | Ours / Reduced | Flux-GS |
| --- | --- | --- |
| `sortRequested` | `RenderProgram.ts:761` 出站消息（**无序号**） | `main.js:2243` 出站消息（**无序号**） |
| `sortWorkerCompleted` | `SortWorker.ts:209-243`（失败分支 247） | `main.js:555-607`（**早期返回 558-565 无回传**） |
| `sortResultReceived` | `RenderProgram.ts:404` 的 handler | `main.js:1707` 的 handler |
| `sortIndexUploaded` | `RenderProgram.ts:436`（`bufferData`） | `main.js:1782`（`bufferData`） |
| `sortResultActivated` | `RenderProgram.ts:438` 翻转 `activeDepthBuffer`（与上传同一同步步） | **无显式概念**：单一 `indexBuffer` 就地覆盖 ⇒ 上传即激活 |
| `sortResultUsedByDraw` | `RenderProgram.ts:779`(bind) + `784`(draw) | `main.js:2263`（draw） |
| **结果 ↔ 相机归因** | ❌ 回传**不带**相机（`SortWorker.ts:235-243`） | ✅ **回传带 `viewProj`**（`main.js:604-606`），可哈希比对 |

⇒ **ours/reduced 必须新增 `sortSerial` 才能把 6 个事件严格建模；Flux 已有 `viewProj` 回声，只缺序号与冻结开关。**

---

## 1. Ours / Reduced 排序时序图

两臂共用同一 renderer（`src/renderers/webgl/programs/RenderProgram.ts` + `…/utils/SortWorker.ts`）。

```text
[主线程 _render()]                                     [排序 Worker]
753  this._camera.update()   ← 每帧重算相机矩阵
761  worker.postMessage({ viewProj: camera.data.viewProj.buffer,
                          cullEnabled })  ──────────►  266 self.onmessage
                                                       288-292 若新 viewProj "不同" 才 dirty = true
                                                       294      throttledSort()
                                                       254-264 单飞 + setTimeout 自重排；if (dirty) runSort()
                                                       209-220 wasm _sort(...)
                                                       228-233 cullFrustum
                                                       235-243 postMessage({depthIndex, workerMs,
                                                                          keptCount, totalCount})
                                                                            │
404  worker.onmessage = (…)  ◄──────────────────────────────────────────────┘
428      this._depthIndex = depthIndex          ← instance 数来源（784 使用 .length）
436      gl.bufferData(indexBuffers[(activeDepthBuffer+1)%3], depthIndex, DYNAMIC_DRAW)
438      activeDepthBuffer = target               ← 上传 + 激活同一步（主线程原子）
779  bindBuffer(indexBuffers[activeDepthBuffer])  ← 下一次 _render 生效
784  drawArraysInstanced(TRIANGLE_FAN, 0, 4, this.depthIndex.length)
```

关键源码事实：

1. **请求发出点**：`RenderProgram.ts:761`，在 `_render()` 内 **每帧无条件**（仅当 `this._worker` 存在）。
   另有**加载期**一次性 `sortData` 消息：`RenderProgram.ts:732`（`renderData.dataChanged` 时）。
2. **是否每帧发出**：是（761）⇒ 当前口径下静态渲染窗口内必然持续产生排序请求。
3. **是否允许多个请求积压**：允许，但 worker 侧同一时刻只跑一次排序（`SortWorker.ts:255-263` 的
   `sorting` 单飞 + `dirty` 合并）⇒ **N 个请求可能只产出 1 个结果**（合并），**1 个请求也可能产出 0 个结果**
   （`dirty` 为 false 时 `runSort` 不执行，见 289-292）。
4. **是否有 request ID**：**没有**（请求与回传都不带序号/相机）。
5. **Worker 是否可能乱序返回**：单 worker 单线程、单飞执行 ⇒ **不会乱序**；但会**合并/丢结果**（见 3）。
6. **结果接收点**：`RenderProgram.ts:404`；失败时 worker 回传空 `depthIndex`（`SortWorker.ts:247`）⇒
   "收到结果" ≠ "有效排序"。
7. **索引上传点**：`RenderProgram.ts:436`；三缓冲轮转（521-526 `indexBuffers.length=3`，529
   `activeDepthBuffer=0`）⇒ 不会覆盖"刚提交那一帧"正在使用的缓冲。
8. **draw 如何使用索引**：779 把 `indexBuffers[activeDepthBuffer]` 绑为整型实例属性，784 以
   `depthIndex.length` 为实例数绘制；着色器用该实例号去 `u_texture` / `u_transformIndices` 取属性
   （per-index `texelFetch` 路径，`RenderProgram.ts:170-250`）。
9. **如何证明目标相机的排序结果已成为 active index**：
   - 现状：**不能证明**。现有 `bench-measure.ts:513-540 waitForSortedFrame()` 只用
     `renderProgramCullTotal()`（`bench-measure.ts:619` → `RenderProgram.ts:901 cullStats.total`）判断
     "worker 至少回过消息"，且**轮询期间每帧仍在发新请求**（`bench-measure.ts:516`），既不能定位相机，
     也不能排除后续请求改写。
   - 可达方案：①（ours/reduced）新增 `sortSerial` 并经 worker 原样回传 + 记录"请求时的相机哈希"，
     且**两次请求之间不再发第二个请求**（单飞 + 冻结）；②用 `activeDepthBuffer`/`depthIndex` 变化作
     副作用证据；③用探针的按实例计数（1 请求 / 1 完成 / 1 上传）作交叉验证。
10. **如何冻结后只 draw**：`_render()` 的全部排序副作用只有 761 一行 ⇒ 加 `_benchFreezeSortRequests`
    开关跳过该行即可；其余（`camera.update()` / uniform / clear / bind / draw）保持原样。
    **不建议**用探针"吞掉" `postMessage` 的方式冻结（会把观察者变成控制者，且让请求计数失真）。
11. **能否在不改默认路径的情况下拆出 `renderStaticFrame`**：能。默认路径是
    `renderer.render(scene, camera)` → `RenderProgram._render()`；`renderStaticFrame()` 只是"同一路径 +
    冻结排序开关"，默认开关为 false ⇒ 默认行为不变。
12. **Reduced 的多 vertex 分组如何参与排序与 draw**：分组在**加载期**被 `RenderData`（DataWorker）解析成
    `positions / transforms / transformIndices`；渲染期**只有一次** instanced draw，分组通过
    `u_transformIndices` 纹理在着色器内做间接寻址（非多次 draw）。`sortData.vertexCount`
    （`RenderProgram.ts:732`）即被排序的顶点数，`depthIndex` 覆盖全部顶点
    ⇒ **分组不产生额外排序请求、不产生额外 draw call**。审计注意：`gaussianTotal`（顶点数）与
    `drawInstances`（= `depthIndex.length`）语义不同，必须分别记录。

---

## 2. Flux-GS 排序时序图

`flux-gs-project-gh-pages/render_shared/main.js`（worker 代码以 `createWorker.toString()` 注入 Blob）。

```text
[主线程 frame(now)]                                    [排序 Worker: createWorker(self)]
2064 frame()
 2200-2242 摇杆/键盘相机积分 + invert4/multiply4
2240 gl.uniform3fv(u_camPos, …)
2242 const viewProj = multiply4(projectionMatrix, actualViewMatrix)
2243 worker.postMessage({ view: viewProj }) ─────────►  609-618 throttledSort()
                                                       610-613 单飞 + runSort(lastView)
                                                       555-565 runSort：同 vertexCount 且
                                                                |dot(lastProj,viewProj)-1| < 0.01
                                                                ⇒ **直接 return，无任何回传**
                                                       587-599 16bit 计数排序
                                                       604-606 postMessage({depthIndex, viewProj,
                                                                            vertexCount})
                                                                            │
1707 worker.onmessage = (…) ◄─────────────────────────────────────────────────┘
1779-1784  e.data.depthIndex ⇒ gl.bindBuffer(indexBuffer)
                               gl.bufferData(ARRAY_BUFFER, depthIndex, DYNAMIC_DRAW)   ← 就地覆盖
                               vertexCount = e.data.vertexCount
                               （1780 解构出的 viewProj **未被使用**）
2248 if (vertexCount > 0) { … gl.clear … }
2263 gl.drawArraysInstanced(TRIANGLE_FAN, 0, 4, vertexCount)
2308/2332/2335/2338 自挂调度：测帧分支 setTimeout(…,0)；常态 requestAnimationFrame(frame)
```

关键源码事实（与 ours/reduced 的差异用 **粗体**）：

1. **请求发出点**：`main.js:2243`，在 `frame()` 内**每帧无条件**。
2. **是否每帧发出**：是。
3. **是否允许多个请求积压**：允许；worker 侧 `sortRunning` 单飞 + `lastView !== viewProj` 补排（614-617）
   ⇒ 同样会**合并**。
4. **是否有 request ID**：**没有**；但**回传携带 `viewProj`**（604）⇒ 结果可归因到某个相机（当前被忽略）。
5. **Worker 是否可能乱序返回**：不会（单 worker 单线程）；**但会"无回传"**（558-565 早期返回）——
   这是静态协议最大的坑：**"请求后必有结果"在 Flux 上不成立**。
6. **结果接收点**：`main.js:1707`。
7. **索引上传点**：`main.js:1782`，**单一 `indexBuffer` 就地覆盖**（无三缓冲）⇒ **上传即激活**，
   且不存在"哪一块缓冲是 active"的歧义，但也没有 ours 那样的"不覆盖在用缓冲"保护。
8. **draw 如何使用索引**：`main.js:2263`，实例数用主线程 `vertexCount`（1783 由回传更新）。
9. **如何证明目标相机的排序结果已成为 active index**：
   - 可行且**比 ours 更强**：比较 `activeSortViewProj`（604 回传的 `viewProj` 的哈希）与目标相机哈希；
   - 若 worker 走了早期返回（558-565），则**没有**新结果，但此时可用 Worker **自己的**等价判据
     `|dot(lastProj, targetProj) − 1| < 0.01` 证明"当前 active 索引对目标相机方向等价"
     （`lastProj` 只在真正排序时更新，603）⇒ 合法但必须**显式记录 dot 与证据类型**。
10. **如何冻结后只 draw**：冻结 `frame()` 中的四段：相机积分（2200-2242）、排序请求（2243）、
    DOM/FPS 写入（`fps` 句柄 1575、2245-2246）、自挂调度（2303-2339）。
    ⇒ 这正是 §3.3 `benchSlaveMode` 的职责范围，**必须**落地，否则静态协议无法成立。
11. **能否在不改默认路径下拆出 `renderStaticFrame`**：能，但**必须**改 `main.js`
    （`frame()` 把相机、排序、DOM、调度混在一起，无法从外部干净拆开）。
12. **worker 内 `console.time("sort")` / `timeEnd`（571/601）**：冻结排序后窗口内不再产生该日志；
    未冻结时每帧一条 ⇒ 与 `consoleLoggingDuringMeasure=false` 冲突，可作"是否真的冻结"的交叉信号。

---

## 3. Worker 探针安装时机审计

**结论：对 Flux 存在"安装过晚"风险；外部 wrap 一律降级为交叉验证，权威来源改为 renderer bridge。**

`bench-gl-probe.ts` 的包装目标是**调用方传入的对象**（`attach({ gl, workerProto, rafOwner, timerOwner })`），
**不是**父页面全局。因此：

1. **Ours / Reduced**：必须装在 **case iframe 自己的 realm**
   `contentWindow.Worker.prototype`（子页 `bench-case.html` 自己创建 canvas / WebGLRenderer / worker：
   `bench-case.ts:238-246`）。若装到父调度页 `bench.ts` 的 `window.Worker.prototype` ⇒ **完全无效**。
   worker 创建时机：`RenderProgram.ts:402-403`，在 `_initialize()`（**首次 render**）内
   ⇒ 探针在 adapter 引导阶段安装时**早于** worker 创建，`onmessage` 赋值（404）会经过替换后的原型
   accessor ⇒ **on-message 拦截在这一臂上可靠**（但仍受"3 个 worker"问题影响，见 3.3）。
2. **Flux**：`bench-flux.html` 以**同源 iframe**（`#frame-host`，第 30-31 行 HTML）驱动 Flux 自带页面
   ⇒ 必须装到 `iframe.contentWindow.Worker.prototype`。worker 在 `main()` 内、**fetch 之后**创建
   （`main.js:1559`），`worker.onmessage` 赋值在 **1707**。父页 `iframe.onload` 通常早于 1707
   （网络往返 ≫ onload），但**不是保证**（缓存命中时 fetch 可在 onload 前完成）
   ⇒ **不能把 prototype accessor 当作权威排序完成来源**（与任务书判断一致）。
3. **Worker 数量**：ours/reduced 实际有 **3 个 worker**——`RenderProgram.ts:1`（SortWorker）、
   `RenderData.ts:4`（DataWorker）、`PLYLoader.ts:19`（LowRankQPLYWorker）；Flux 1 个。
   把 `Worker.prototype.postMessage` 全量计为 `sortRequests` 会在 ours/reduced 上**误计**加载/数据构建消息
   ⇒ 必须 `probe.bindSortWorker(instance)` 按**实例**绑定。
   可用公开句柄：`WebGLRenderer.renderProgram`（`WebGLRenderer.ts:128`）→ `RenderProgram.worker`
   （`RenderProgram.ts:892-894`，**`_initialize()` 之前为 undefined**）。
4. **探针是否必须早于 worker 创建**：对"计数"不是必须（可按实例绑定包裹已存在的 worker），
   但对"on-message 拦截"是必须的；两者都要在报告里记录实际安装时刻与 worker 创建时刻的相对顺序。

### 3.1 与 `bench-gl-probe.ts` 现状的差距（阶段 7B 需要补的两项）

| 现状 | 需要补 |
| --- | --- |
| `attach({ workerProto })` 全局原型包装 | `bindSortWorker(workerInstance)`：只统计**排序 worker**的出站/入站 |
| `noteWorkerInbound` 以 `depthIndex` 字段判定完成 | 同时记录 `viewProj`/serial 命中情况，并输出 `unmatchedInbound` |

---

## 4. 三方是否都能实现 `renderStaticFrame`

| 臂 | 可行性 | 依据 |
| --- | --- | --- |
| Ours | ✅ | 排序副作用只有 `RenderProgram.ts:761` 一行；其余（uniform/clear/bind/draw）与排序无关 |
| Reduced | ✅ | 与 Ours **同一个 renderer**（同一 `RenderProgram`），分组不影响 draw 次数（§1.12） |
| Flux | ✅（需 `benchSlaveMode`） | `frame()` 已包含 draw 段（2248-2263）；须跳过相机积分 / 请求 / DOM / 自挂调度 |

⇒ 三方**都能**满足 `static-render-only-synchronized-throughput-v1` 的前置条件（在各自 bridge 落地后）。
在 Flux `benchSlaveMode` 落地前，Flux 只能标 `static-full-frame-function-synchronized-throughput`。

---

## 5. 最小修改点与风险

### 5.1 Ours / Reduced（**自有代码**，增量、默认行为不变）

| 文件 | 改动 | 必要性 |
| --- | --- | --- |
| `src/renderers/webgl/utils/SortWorker.ts` | 请求载荷加 `sortSerial`，回传原样带回（含失败分支 247） | **必须**（否则结果无法归因到相机/请求） |
| `src/renderers/webgl/programs/RenderProgram.ts` | ① `_benchFreezeSortRequests` + setter/getter；② 审计字段（`requestSerial` / `completedSerial` / `uploadedSerial` / `activeSerial` / `pendingCount` / `outOfOrderResults` / `activeCameraHash`）+ `getSortAudit()` | **必须**（冻结 + 权威审计） |
| `src/renderers/WebGLRenderer.ts` | 无需修改（`gl` 124 / `renderProgram` 128 已公开） | — |

### 5.2 Flux-GS（允许的唯一第三方改动面）

| 位置 | 改动 |
| --- | --- |
| `main.js` 2243 区域 | `benchSlaveMode` 时**不发** `worker.postMessage({view})` |
| `main.js` 2200-2246 区域 | slave 时跳过相机积分与 DOM/FPS 写入 |
| `main.js` 2303-2339 区域 | slave 时**不入队**（rAF 与 setTimeout 两处都要覆盖：2332/2338 与 2308/2335） |
| `main.js` 1707-1785 区域 | 记录 `activeSortViewProj`（604 回传值）及其哈希 |
| `main.js` 新增导出 | `window.__FLUXGS_BENCH_SORT__`（`getSortAudit()`）、`renderStaticFrame()`、`renderPipelinedFrame(camera)` |
| `FLUX_VENDOR_DIFF.md §4` | hunk 计数由 11 → 13/14（阶段 6 完成后更新并重跑 `tools/check_flux_vendor_diff.py`） |

### 5.3 风险清单（7A 新发现）

| # | 风险 | 级别 | 缓解 |
| --- | --- | --- | --- |
| F1 | **Flux `runSort` 早期返回（558-565）⇒ 请求后可能永远没有结果**，"等该次结果"会死锁 | **高** | `waitForSortApplied` 支持 `equivalent-camera-no-new-sort` 证据（dot 判据），并记录 `dot` |
| F2 | 两臂 worker 都会**合并请求**（`dirty` 289-292 / `lastView` 614-617），1 请求 ↔ 1 结果**不成立** | 高 | 只允许"请求一次 → 等"（单飞），禁止并发多请求；用 serial + 计数交叉验证 |
| F3 | ours/reduced 有 3 个 worker，全局 `postMessage` 计数会误计 | 中 | `probe.bindSortWorker(instance)`（`renderProgram.worker`） |
| F4 | Flux 探针可能装得比 `worker.onmessage` 赋值（1707）晚 ⇒ 漏事件 | 中 | 权威来源改为 bridge；探针仅交叉验证 |
| F5 | Flux 单一 `indexBuffer` 就地覆盖（1782）⇒ 上传与 draw 可能交错 | 中 | 冻结后窗口内不再有上传 ⇒ 静态协议无此问题；动态协议必须报告 |
| F6 | `SortWorker.ts` 携带**既有** TS 报错（232） | 中 | 见 §5.4（待拍板） |
| F7 | 冻结开关若在测量窗口外忘记复位，会污染后续轮次 | 中 | 每轮 `unfreeze` + 审计 `frozen` 字段 + 轮末断言 |

### 5.4 `SortWorker.ts:232` 既有 TS 错误与本次改动的交集（**待你拍板**）

阶段 7B 的改动就在该文件内。两种处理方式：

- **(a) 顺带修掉**（例如 `new Uint32Array(depthIndex.slice().buffer as ArrayBuffer)` 或放宽字段类型），
  使全量 `tsc -p tsconfig.benchcheck.json` 从 exit 2 → exit 0；但这属于"修改既有错误"，
  超出"最小改动"范围，且需确认不影响其他构建（`vite.config.js` / `vite.site.config.js`）。
- **(b) 不动它**，报告里始终区分："新模块专项 tsc = 0 / 全量 benchcheck = 2，唯一错误与改动前相同"。

本轮**未**做任何选择（只读审计）。

---

## 6. 最终 slave API（建议定稿）

```ts
export interface SortToken { serial: number; cameraHash: string; viewProjSha256: string }

export type SortAppliedProof =
  | { proven: true; serial: number; cameraHash: string; evidence: "worker-echo" }
  | { proven: true; serial: number; cameraHash: string; evidence: "request-log-single-in-flight" }
  | { proven: true; serial: number; cameraHash: string; evidence: "equivalent-camera-no-new-sort"; dot: number }
  | { proven: false; reason: string };

export interface SortAudit {
  requestSerial: number; completedSerial: number; uploadedSerial: number; activeSerial: number;
  pendingCount: number; frozen: boolean; outOfOrderResults: number;
  requestsDuringMeasure: number; completionsDuringMeasure: number; uploadsDuringMeasure: number;
  activeCameraHash: string | null;
}

export interface BenchSlave {
  init(cfg: BenchConfig): Promise<void>;
  setResolution(w: number, h: number): Promise<void>;        // 每轮一次（D5②）
  setCamera(view16: readonly number[], focalPx: number): Promise<void>;
  requestSortOnce(camera: CameraInput): Promise<SortToken>;  // 单飞：调用前 pendingCount 必须为 0
  waitForSortApplied(token: SortToken, timeoutMs?: number): Promise<SortAppliedProof>;
  freezeSortRequests(): void;
  unfreezeSortRequests(): void;
  renderStaticFrame(): void;                                 // 只 draw：不更新相机、不发请求、不写 DOM、不挂 rAF
  renderPipelinedFrame(camera: CameraInput): void;           // 更新相机 + 发请求 + draw，不自挂 rAF
  finishGpu(): void;                                         // gl.finish()
  getSortAudit(): SortAudit;
  getResolutionAudit(): ResolutionAudit;
  getCameraAudit(): CameraAudit;
  getWorkloadAudit(): WorkloadAudit;
  dispose(): Promise<void>;
}
```

各臂 `capabilities`（bridge 落地后）：

```text
Ours    : staticFrameRenderOnly=true, sortFreezeSupported=true, movingSortMode="pipelined"
Reduced : staticFrameRenderOnly=true, sortFreezeSupported=true, movingSortMode="pipelined"
Flux-GS : staticFrameRenderOnly=true, sortFreezeSupported=true, movingSortMode="pipelined"
          （阶段 6 完成前 = staticFrameRenderOnly=false ⇒ 自动降级 full-frame 协议）
```

### 静态主协议前置条件（测量前必须逐条证明）

```text
目标 camera 排序已 worker 完成   → sortResultReceived(serial = token.serial) 或等价证据
目标索引已上传                  → sortIndexUploaded(serial)
目标索引已成为 active index     → sortResultActivated(serial) / activeCameraHash == token.cameraHash
pendingCount = 0
sortFrozen  = true
```

测量窗口内必须成立：`sortRequestsDuringMeasure=0`、`sortCompletedDuringMeasure=0`、
`indexUploadsDuringMeasure=0`、`pendingSortsAtEnd=0`、`activeSortSerial 未变化`。
做不到 ⇒ 只能标 `static-full-frame-function-synchronized-throughput` 并如实报告排序活动。

---

## 7. 是否需要修改 controller 当前状态机

**需要，但为小改（不返工）**：

| 现状（`bench-controller.ts`） | 需要的改动 |
| --- | --- |
| `requestSortAndWait(): Promise<number>` + `freezeSortRequests()` | 改为 `requestSortOnce(camera): Promise<SortToken>` + `waitForSortApplied(token)` |
| 无 sort proof 字段 | 结果对象新增 `sortAppliedProof`（`evidence` / `dot` / `serial` / `cameraHash`） |
| 无效原因集合 | 新增 `sort-not-proven`、`active-sort-changed`（窗口首尾 `activeSortSerial` 不同） |
| 探针 `sortRequests` / `sortCompleted` 为全局计数 | 改为按实例绑定（`bindSortWorker`）后才作为有效性输入 |
| `protocol` 自动选择逻辑 | **不变**（仍由 `staticFrameRenderOnly && sortFreezeSupported` 决定） |

其余（`t0`/`t1` 语义、`controllerRenderCalls`、draw 作用域归因、`rounds=12`、热漂移判定）**无需改动**。

---

## 8. Go / No-Go 结论

**结论：GO**（三方都能做到 render-only），附 3 个硬前置：

1. **ours/reduced 必须新增 `sortSerial`**（自有代码，增量、默认行为不变）；
2. **Flux 必须落地 `benchSlaveMode` + bridge**（允许的 hunk）；未落地前其
   `capabilities.staticFrameRenderOnly=false`，自动降级为 full-frame 协议；
3. **探针必须按 worker 实例绑定**，并记录安装时机（realm + 是否早于 worker 创建）；
   **权威来源为 bridge 的 `getSortAudit()`**，外部 wrap 仅作交叉验证。

执行顺序（与任务书一致）：

```text
阶段 5  bench-case slave（按 §6 最终 API）
阶段 7B ours/reduced 排序冻结（§5.1）
阶段 6  Flux benchSlaveMode + 冻结 + bridge（§5.2）
阶段 8  三个 adapter（OursAdapter / Reduced3dgsAdapter / FluxGsAdapter）
阶段 9  Chromium 单场景 smoke
```

**待你拍板的一项**：§5.4 —— 是否在阶段 7B 顺带修 `SortWorker.ts:232` 既有 TS 错误。

---

## 9. 本轮落地结果（阶段 7B + 步骤 1/3/探针权威，已实现并验证）

> **拍板已执行**：§5.4 取 **(a) 顺带修复**，且作为**独立 hunk / 独立变更项**处理，
> 修复方式为**只改类型声明**（不改变运行时数据、复制次数与 transferable 语义）。

### 9.1 修改文件

| 文件 | 改动 | 性质 |
| --- | --- | --- |
| `src/renderers/webgl/utils/SortWorker.ts` | **hunk A（独立）**：`cullFrustum(order: Uint32Array<ArrayBuffer>): Uint32Array<ArrayBuffer>` 纯类型注解 ⇒ 消除既有 TS2322 | 类型 only |
| 同上 | **hunk B**：请求携带 `sortSerial` / `force`，结果原样回传（含失败分支）；`force===true` 强制 `dirty=true`（绕过等价相机启发式） | 增量字段，默认路径行为不变 |
| `src/renderers/webgl/programs/RenderProgram.ts` | 导出 `sortCameraHash()`（唯一哈希实现）+ `RenderProgramSortAudit`；私有 bench 字段；结果回传时推进 `completed/uploaded/active` 序号与 `activeCameraHash`；draw 处记录 `lastDrawSortSerial/lastDrawCameraHash`；`_benchFreezeSortRequests` 冻结开关；`requestSortOnce(force)` / `setBenchFreezeSortRequests` / `setBenchForceNextSort` / `cameraHash()` / `getSortAudit()` | 增量，默认（非 bench）路径行为不变 |
| `bench-controller.ts` | `SortToken` / `SortAppliedProof`（四项证明 + evidence）/ `SortAudit`；adapter 接口改为 `requestSortOnce(camera,{force})` + `waitForSortApplied(token)` + `freeze/unfreeze` + `getSortAudit()`；主表静态协议强制 `force=true`；新增无效原因 `sort-not-forced` / `sort-not-proven` / `sort-proof-heuristic-not-accepted` / `warmup-draw-not-verified` / `sort-not-frozen` / `sort-pending-nonzero` / `active-sort-changed` / `last-draw-serial-changed` / `warmup-frames-too-few-for-sort-proof` | 接口小改 |
| `bench-gl-probe.ts` | `bindSortWorker(instance)`（按实例绑定；绑定后原型级计数**收敛为仅绑定实例**）；`ProbeAuthority`（`sortAuditAuthority="renderer-bridge"`、`probeRealmMatched`、`probeBoundToSortWorkerInstance`、`probeInstalledBeforeWorkerCreation`、`probeReattachedExistingHandler`）；入站 handler 幂等包装（迟到绑定可补救） | 交叉验证层 |

### 9.2 强制约束（新增，写入 `THREE_WAY_BENCH_DESIGN.md` §12）

```text
requestSortOnce(camera, { force: true })   ← 主表静态协议必须 force=true
SortAppliedProof 必须四项齐全：completed / uploaded / activated / usedByDraw
测量前至少一次冻结后的 static warmup draw，且
  lastDrawSortSerial === token.serial ∧ lastDrawCameraHash === token.cameraHash
窗口结束后：activeSerial 未变化 ∧ lastDrawSortSerial 未变化
vendor-equivalence-heuristic（Flux 的 dot 跳过启发式）**只能进附录/诊断**，不满足主表 sortAppliedProof
探针权威：sortAuditAuthority = "renderer-bridge"；外部 wrap 仅交叉验证
```

### 9.3 验证结果（四项分别报告）

| 检查 | 命令 | 退出码 |
| --- | --- | --- |
| 新模块专项 tsc | `tsc --noEmit … bench-audit.ts bench-controller.ts bench-gl-probe.ts` | **0** |
| 全量 benchcheck | `tsc -p tsconfig.benchcheck.json` | **0**（既有 TS2322 已修复；目标达成） |
| Vitest | `vitest run` | **0**（100 passed / 3 skipped） |
| ESLint | `eslint bench-*.ts src/renderers/webgl/{utils/SortWorker,programs/RenderProgram}.ts` | **0** |

### 9.4 仍未完成

阶段 5（bench-case slave）、阶段 6（Flux `benchSlaveMode` + forceSort + bridge）、阶段 8（三个 adapter）、
阶段 9（Chromium smoke）**均未开始**；论文表格未修改。

---

## 10. 阶段 5 落地结果（`?slave=1` + `window.__CASE_BENCH__`）

状态词：`slaves-implemented-adapters-not-implemented`。

### 10.1 薄封装原则（本层不重新实现任何底层能力）

| 能力 | 唯一来源（slave 只转发） |
| --- | --- |
| sort serial / sortViewProjHash / force | `RenderProgram.requestSortOnce(force)` + `RenderProgram.cameraHash()`（= `sortCameraHash`） |
| freeze 状态 | `RenderProgram.setBenchFreezeSortRequests()` + `getSortAudit().frozen` |
| sort audit（含 `lastDrawSortSerial/lastDrawCameraHash`） | `RenderProgram.getSortAudit()` |
| frame serial | `BenchCase.renderCalls`（既有计数） |
| 相机哈希实现 | `src/.../RenderProgram.ts` 的 `sortCameraHash()`（**全项目唯一实现**） |
| 相机矩阵/内参 | `CameraData`（`Quaternion.FromMatrix3` 与 `Matrix3.RotationFromQuaternion` 互逆） |

### 10.2 接口（`window.__CASE_BENCH__`）

`setResolution / setCamera / requestSortOnce / waitForSortApplied / freezeSortRequests /
unfreezeSortRequests / renderStaticFrame / renderPipelinedFrame / finishGpu / getSortAudit /
getResolutionAudit / getCameraAudit / getWorkloadAudit / getContextState / getFrameSerial /
getCanvas / getSortWorker / dispose` + 诊断：`ensureFirstFrame / beginMeasureWindow /
endMeasureWindow / getMeasureWindowAudit / eventLog / probeAuthority`。

关键语义：

```text
waitForSortApplied() 只证明 completed / uploaded / activated；usedByDraw 恒为 false
（由 controller 在冻结后的 warmup draw 之后依 lastDrawSortSerial/lastDrawCameraHash 派生）
renderStaticFrame() 在未冻结时**直接抛错**（结构性保证 render-only）
beginMeasureWindow() 记录窗口基线；endMeasureWindow() 二次审计分辨率四项
⇒ 四项变化时返回 invalidReason = "resolution-changed-during-measure"
beginMeasureWindow() 时若 activeSerial>0 且 lastDrawSortSerial≠activeSerial
⇒ warmupDrawMissingAtWindowStart=true（= 漏了冻结后的 warmup draw，不得进主表）
runRound(fn)/dispose() 的 finally 保证：unfreeze → probe.detach → scene.dispose（幂等）
```

### 10.3 禁止项（已在 `bench-case.ts` 结构性保证）

`?slave=1` 时：不进入 `measureOneRound`、不注册任何 rAF/timer 自驱循环、不自动切场景、
**不自动 dispose**（`onContextLost` 在 slave 模式下只标记 `contextLost=true` 后返回）。
非 slave 默认路径逐字未改。

### 10.4 验证

四项检查：专项 tsc 0 / 全量 benchcheck 0 / Vitest 0（118 passed, 3 skipped）/ ESLint 0。
浏览器端最小流程（load slave → force sort → wait applied → freeze → static draw → 验证
lastDrawSortSerial/hash → finish → unfreeze → dispose，**不计 FPS**）属于阶段 9 的 smoke，尚未执行。

---

## 11. 阶段 8A 落地结果（Ours/Reduced adapter）

状态词：**`case-adapters-implemented-flux-adapter-not-implemented`**

### 11.1 文件

| 文件 | 内容 |
| --- | --- |
| `bench-adapters.ts`（新） | 共享 `CaseSlaveAdapter`（iframe/slave 通信只写一次）+ `IframeProbeProxy` + `createOursAdapter` / `createReduced3dgsAdapter`（只声明 name/scene/modelSource）+ `createUnimplementedAdapter("flux-gs")` |
| `bench-adapters.test.ts`（新，8 项） | 只转发/不自建 hash·FPS·rAF（源码守卫）、`static-warmup-draw → beginMeasureWindow` 顺序、模型来源分字段、dispose 幂等 + 异常路径 + iframe.remove、两臂工厂、Flux ⇒ `adapter-not-implemented`、分辨率守卫、controller 消费 `CaseMeasureWindowAudit` |
| `bench-controller.ts` | `unimplementedReason?` / `getMeasureWindowAudit?()` / `AdapterMeasureWindowAudit`；`runSyncedThroughputImpl()` + 未实现臂骨架（`invalidReason="adapter-not-implemented"`）；有效性新增 `resolution-changed-during-measure` / `warmup-draw-not-verified` / `active-sort-changed` / `last-draw-serial-changed` |
| `bench-constants.ts`（新） | **唯一共享常量**：`BENCH_FOCAL_PX=1159.5880733038064`、`BENCH_NEAR=0.1`、`BENCH_FAR=100`、`BENCH_WIDTH=1600`、`BENCH_HEIGHT=1063`（禁止各文件手写；`1159.5880738064` 为笔误） |
| `bench-case-slave.ts` | `ensureFirstFrame()` **幂等**并返回 `EnsureFirstFrameReport`（before/after frameSerial、drawCalls/instances、worker before/after）；`renderStaticFrame()` 打点 `static-warmup-draw` / `static-frame`；`setCamera` 输出 requested/effective viewProjection hash、`maxAbsViewMatrixError`、`cameraPosition`、`recomposeErrorMax`；API 增加 `probe`/`ensureFirstFrameReport()` |
| `bench-measure.ts` | `hashViewProjForSlave()`（转发 `SPLAT.sortCameraHash`，唯一实现）、`readCameraMatricesForSlave()` 增 `positionX/Y/Z`、其余 slave bridge 转发 |
| `bench-case.ts` | 探针 + `hashViewProj` 接线；`createSlaveApi(slave, probe, authority)` |

### 11.2 两臂状态

- **Ours / Reduced-3DGS adapter**：已实现（同一 renderer ⇒ 同一 adapter，仅 name/modelUrl/modelSource 不同）。
- **Flux adapter**：**未实现**。选择 Flux 时 controller 返回 `invalidReason=adapter-not-implemented`，**不降级**运行旧 `frame()`（自挂 rAF、自动排序、无强制排序、无权威 serial）。
- **Chromium smoke（两级：生命周期 / controller 短帧）**：**未执行**（本环境无 Chromium，不得伪造数据）。

### 11.3 检查（明确退出码）

```text
专项 tsc        EXIT=0
全量 benchcheck EXIT=0
Vitest          EXIT=0（124 passed / 3 skipped）
ESLint          EXIT=0
```

### 11.5 阶段 6 Worker 子阶段（已完成）与措辞修正

**已完成（worker 侧，`render_shared/main.js` 的 H1–H5）**：严格命名空间 `{type:"bench-sort"|"bench-barrier"}`、
force 才绕过 dot 早期返回、严格单飞（含明确 rejection）、`sortSerial` 在成功/跳过/无 buffer/拒绝四条路径回传、
barrier **异步** ack（四条件 quiescent）、bench 强制排序**绑定到具体 view 数组与 serial**（`benchPendingView === viewProj`，
legacy/replacement 的 `runSort()` 不会消费它）。

**措辞修正（必须严格区分，不得夸大）**：

```text
Worker 当前能证明的：completed / result-posted（结果消息已带原 sortSerial）
尚未实现（属主线程半）：GPU index uploaded、active（索引成为 draw 使用状态）、lastDraw（真实 draw 成功后）
本文 §11.3 第 4 节给的是**静态代码路径推导**（vendor 文件断言），**不是**真实运行事件日志
```

**仍未实现（主线程半）**：`?bridge=1` 启用与默认路径保护、自驱 rAF/timer 取消与隔离、static/pipelined
两入口复用唯一 draw 主体、resultReceived/uploaded/active/lastDraw 四阶段独立状态、原始 viewProj 快照、
Worker barrier + 主线程 pending/upload 的完整 quiescence、`finishGpu`、`getSortAudit`、failure/rejection 立即传播、
dispose 后忽略迟到结果、退出时最多恢复一个 rAF。

> 特别约束：barrier ack **不得**解释为 `uploaded=true`；`uploaded` 只能在真实 GPU index 上传后打点，
> `active` 只能在索引成为 draw 使用状态后打点，`lastDraw` 只能在真实 draw 成功后记录；bridge 不实现跨臂 hash。

```text
slave.dispose()  ：解冻 + 清理 renderer（iframe 内）——**不能**证明 iframe 被移除
adapter.dispose()：① 保存 AdapterDisposeAudit（移除前读最终 audit）② unfreeze ③ probe.detach
                   ④ slave.dispose ⑤ iframe.remove ⑥ 标记 iframeRemoved=true（幂等）
移除 iframe 之后**禁止**再调用 slave 的 getter（adapter 已置 api/handle=null）
```

