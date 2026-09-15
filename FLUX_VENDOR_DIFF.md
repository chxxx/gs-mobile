# Flux-GS 官方仓库 vs 本地内嵌副本 —— 差异审计（第 1 阶段）

> 目的：确认 `flux-gs-project-gh-pages/` 相对官方仓库到底改了哪些东西，把每一处改动**归类**，
> 并据此判定「本地内嵌副本能不能当作官方 Flux-GS 的 FPS 基线」。
>
> 本文的每一处结论都给出**文件 + 行号**，不接受"注释里写了什么"作为证据（注释本身也是本地新增的）。

---

## 0. 结论摘要（先看这里）

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| 本地副本基于官方哪个 commit？ | `xiaobiaodu/flux-gs-project@gh-pages` 的 **`d062af33bab6e74ed45f9c4b6e8ec6b3d6cff752`**（tree `78f28725b906d7af3501daf04a072fdea1bfca64`，提交时间 2026-09-01T14:29:12Z） | 官方树内 49 个 blob 中 **41 个与本地逐字节相同**（见 §3） |
| `runFluxBenchmark()` 是官方原有代码还是本地新增钩子？ | **本地新增的可测试钩子**。官方 `render_shared/main.js`（blob `e882ce7f…`，2307 行）里**完全没有** `runFluxBenchmark` / `__FLUXGS_STATS__` / `benchres` / `fluxcam` 这些符号 | §4 hunk 2/10 |
| 它是否复用了官方完整的 render 函数？ | **是**。它**没有**新建任何渲染路径：`runFluxBenchmark` 只是把官方 `frame()` 用 `setTimeout(…, 0)` 链驱动，并在官方 `frame()` 的**末尾**（`gl.drawArraysInstanced` 之后）插入了计帧/结束分支 | 本地 `render_shared/main.js:2351-2367` + `2303-2339` |
| 是否改了 shader / 排序 / 剔除 / 解码 / 绘制逻辑？ | **没有**。11 个 hunk 中：着色器源码 0 处、SortWorker/排序算法 0 处、剔除 0 处、解码公式 0 处、绘制调用 0 处。唯一"碰到渲染"的是 `resize()` 里的画布尺寸与投影 viewport 取值（只在 `?benchres=` 会话生效），以及 `frame()` 末尾的调度语句（`requestAnimationFrame(frame)` → 包在 `if (isBenchmarking) … else …` 里） | §4 hunk 5/10 |
| 是否只是把官方 FPS 循环包装成 Promise/API？ | **是**，但**不是等价**包装：它在官方 `frame()` 尾部新增了一条 `setTimeout(0)` 自驱链，并把计时锚点放在"第一帧 render 结束之后"，因此 **fps 公式 = N / (第 2 帧 render 结束 − 第 1 帧 render 结束)**。这一点是本仓库需要逐行复刻的关键（见 `FLUX_FPS_PROTOCOL.md`） | 本地 `main.js:2303-2339` |

**一句话**：本地副本 = 官方 gh-pages 原样 + 一层**纯测量用**的仪器化（instrumentation），渲染语义未变；
`runFluxBenchmark()` 复用官方 `frame()`，因此它测出来的是"**内嵌副本的 `frame()` 在 `setTimeout(0)` 链下的吞吐**"——
可以当作**本仓库的唯一参考口径**，但**不能**称为"Flux-GS 论文协议"（论文口径未验证，见
`FLUX_FPS_PROTOCOL.md §A.5`；官方原版页面只有 rAF + EMA 显示值，没有任何可调用的测帧 API）。

---

## 1. 审计方法（可复现）

官方工作区没有 `git` 历史（下载的是 GitHub Pages 静态产物），因此不能靠"本地 git log"取证。
本审计用 **GitHub Git Data API 的 blob SHA** 做逐字节比对：

```bash
# 1) 官方 gh-pages 最新 commit + tree（脚本与产物都在 gsplat.js/tools/）
curl -sS "https://api.github.com/repos/xiaobiaodu/flux-gs-project/commits?sha=gh-pages&per_page=1" \
     -o gsplat.js/tools/flux_gh_pages_commit.json
#    → d062af33bab6e74ed45f9c4b6e8ec6b3d6cff752 / tree 78f28725b906d7af3501daf04a072fdea1bfca64
curl -sS "https://api.github.com/repos/xiaobiaodu/flux-gs-project/git/trees/78f28725b906d7af3501daf04a072fdea1bfca64?recursive=1" \
     -o gsplat.js/tools/flux_gh_pages_tree.json

# 2) 逐文件 sha1(blob <len>\0 + content) 与本地副本比对（脚本 + 产物都在 tools/ 下）
python gsplat.js/tools/check_flux_vendor_diff.py
#    → identical=41 lf_only=0 modified=4 missing=4 extra=17
#    报告：gsplat.js/tools/flux_vendor_diff_report.txt

# 3) 关键文件取回官方原文后做行级 diff
curl -sSL -w "HTTP=%{http_code} SIZE=%{size_download}\n" -o _flux_official_main2.js \
  https://raw.githubusercontent.com/xiaobiaodu/flux-gs-project/gh-pages/render_shared/main.js
git diff --no-index --ignore-cr-at-eol -U3 \
  _flux_official_main2.js gsplat.js/flux-gs-project-gh-pages/render_shared/main.js
#    → 11 hunks, 186 insertions(+), 4 deletions(-)
```

> ⚠️ 注意：`raw.githubusercontent.com` 偶发返回**截断**内容（本次第一次下载只有 19 292 B / 538 行）。
> 以 `curl -w "%{size_download}"` 校验收到的字节数（官方 `render_shared/main.js` = **85 835 B**）之后再比对。

关键哈希（留档）：

| 文件 | 官方 blob sha1 | 官方字节数 | 本地字节数 |
| --- | --- | --- | --- |
| `render_shared/main.js` | `e882ce7fdd0b0e3b36de3e717e7a70248816f18d` | 85 835 | 95 356 |
| `render_shared/viewer.css` | （本地逐字节相同） | — | — |
| `render_bicycle/index.html` | 本地逐字节相同 | — | — |
| `render_bicycle/main.js` | `4d215345706a21f31320c64b34e167f966c931b4` | 63 | 63 |
| `tools/tmc3.js` / `tools/tmc3.wasm` | 本地逐字节相同 | — | — |

官方 `main.js` 另存 SHA256 = `093052fd54f94584b85f14ecc1062a682edd11c26db773fc4ddaa4a245a9a296`
（本地副本 SHA256 = `fb789364bc01f1a5f7efdffc1deede85d1768a2edd9f30faf62240af5f720499`）。

---

## 3. 逐文件比对结果（官方 tree 内 49 个 blob）

### 3.1 逐字节相同（41 个；渲染路径相关的文件**全部**相同）

```
= README.md                       = render_shared/viewer.css
= render_bicycle/index.html       = render_bicycle/main.js
= render_counter/index.html       = render_counter/main.js
= render_drjohnson/index.html     = render_drjohnson/main.js
= render_flowers/index.html       = render_flowers/main.js
= render_garden/index.html        = render_garden/main.js
= render_kitchen/index.html       = render_kitchen/main.js
= render_playroom/index.html      = render_playroom/main.js
= render_room/index.html          = render_room/main.js
= render_train/index.html         = render_train/main.js
= render_treehill/index.html      = render_treehill/main.js
= render_truck/index.html         = render_truck/main.js
= tools/tmc3.js                   = tools/tmc3.wasm
= static/js/*.js (5 个)           = static/css/*.css (5 个)
= static/images/*.png (4 个)      = .gitignore
```

→ 官方 11 个场景目录的 `index.html`（699~763 B）与 `main.js`（60~65 B）**逐字节相同**：
本地副本沿用的就是官方那套加载方式（`render_<scene>/main.js` 只设 `window.FLUX_GS_CONFIG`，
`index.html` 依次加载 `main.js` 与 `../render_shared/main.js`）。
**没有**替换渲染器、**没有**改画布 CSS、**没有**改配置。

### 3.2 被修改（4 个）

| 文件 | 官方 → 本地字节 | 分类 | 说明 |
| --- | --- | --- | --- |
| `render_shared/main.js` | 85 835 → 95 356 | **benchmark instrumentation**（含 canvas/resolution control、timing-loop change） | 本次唯一需要关心代码语义的文件，逐 hunk 见 §4 |
| `index.html` | 11 071 → 16 207 | unrelated change | GitHub Pages **项目主页**（论文介绍页）加了本地导航/文案 |
| `static/css/index.css` | 14 011 → 2 299 | unrelated change | 同上（主页样式裁剪） |
| `static/js/index.js` | 1 031 → 2 346 | unrelated change | 同上（主页脚本） |

后 3 个属于站点首页；`bench-flux.html` 只 iframe `render_<scene>/index.html`，
**不会加载**它们，对 FPS 无影响。

### 3.3 本地新增（官方 tree 中不存在，17 个）

| 新增内容 | 大小 | 分类 | 说明 |
| --- | --- | --- | --- |
| `render_bonsai/{index.html,main.js}` | 720 / 65 B | unrelated change | 官方 gh-pages 只有 11 个场景页；本地按官方模板补了 bonsai。内容与 `render_bicycle/index.html` **除行尾（CRLF）外完全一致**（`git diff --no-index --ignore-cr-at-eol` 无输出） |
| `render_stump/{index.html,main.js}` | 720 / 64 B | unrelated change | 同上 |
| `scene/*.json`（13 个） | 1.99 MB ~ 7.29 MB | unrelated change | 模型数据镜像；官方是靠 `modelBaseUrl = https://huggingface.co/datasets/mobile-gs2/…` 在线取（本地 `main.js:1527-1530` 与官方相同） |

### 3.4 本地缺失（官方有、本地没有，4 个）

```
- .openai/hosting.json         (63 B)          部署元数据
- static/css/authors.css       (3 654 B)       主页样式
- static/videos/bicycle.mp4    (14 097 154 B)  主页视频
- static/videos/teaser.mp4     (6 491 987 B)   主页视频
```

→ 全部是**主页资源**（为控制体积未镜像），与渲染器/FPS 无关。



---

## 4. `render_shared/main.js` 的行级 diff（11 个 hunk）

`git diff --no-index --ignore-cr-at-eol` 结果：**186 insertions(+), 4 deletions(−)**。
下表按 hunk 给出"官方行号 → 本地行号"、内容与**分类**。

| # | hunk 头（官方 → 本地） | 本地位置 | 内容 | 分类 |
| --- | --- | --- | --- | --- |
| 1 | `@@ -995,6 +995,13 @@` | `main.js:998-1004` | worker 内 `self.postMessage({ xyz_dump: xyz_float.slice().buffer })`，导出解码后世界坐标 | benchmark instrumentation（数据导出，不影响渲染） |
| 2 | `@@ -1468,6 +1475,48 @@` | `main.js:1478-1519` | 新增 `__fluxBenchRes`（读 `?benchres=WxH`）、`window.__FLUXGS_STATS__`、`__fluxCamIdx`（读 `?fluxcam=N`，等价于按数字键 N 且 `carousel=false`）、`if (__fluxBenchRes) carousel = false` | benchmark instrumentation + camera change（**仅 URL 带参时**） |
| 3 | `@@ -1486,6 +1535,7 @@` | `main.js:1538` | `window.__FLUXGS_STATS__.fetchStartAt = performance.now();`（置于 `fetch` 之前） | benchmark instrumentation |
| 4 | `@@ -1531,6 +1581,18 @@` | `main.js:1584-1595` | 用**已有**的 `gl` 读 `WEBGL_debug_renderer_info` 上报 GPU 名（外层零新建上下文） | benchmark instrumentation |
| 5 | `@@ -1606,20 +1668,35 @@` | 新增 `main.js:1671-1676`（`projW/projH`）、`1682-1683`（`getProjectionMatrix` 实参）、`1686`（`u_viewport` uniform）、`1690-1694`（`benchres` 覆盖 `gl.canvas.width/height`）、`1696-1699`（回写 `stats.resW/resH`）；**删除** 官方 `innerWidth,`/`innerHeight,` 与旧 `u_viewport` 行 | **canvas/resolution control**：投影/viewport/画布尺寸改用 `projW/projH`。**不带 `?benchres=` 时 `projW === innerWidth`、`projH === innerHeight`，与官方逐字节等价** | canvas/resolution control |
| 6 | `@@ -1677,6 +1754,10 @@` | `main.js:1757-1760` | 主纹理上传完成后记 `stats.decodeDoneAt` | benchmark instrumentation |
| 7 | `@@ -1689,6 +1770,12 @@` | `main.js:1773-1774`（SH 纹理上传完成）、`1775-1778`（`xyz_dump` 分支） | `stats.texUploadDoneAt` + 接收 worker 的 xyz 导出 | benchmark instrumentation |
| 8 | `@@ -1956,6 +2043,11 @@` | `main.js:2046-2050` | 新增 `isBenchmarking / benchmarkFrameCount / benchmarkFrameTarget=300 / benchmarkStartTime / rafId` | benchmark instrumentation（timing-loop state） |
| 9 | `@@ -2169,6 +2261,30 @@` | `main.js:2264-2267`（首帧时刻）、`2268-2287`（首帧 `readPixels` 采样 `coveredPct`） | 首帧打点 + 覆盖率采样（**仅 `isBenchmarking` 且为第 1 帧时**执行，`try/catch` 兜底） | benchmark instrumentation |
| 10 | `@@ -2184,9 +2300,72 @@` | `main.js:2303-2339`（`frame()` 尾部计帧/调度分支）、`2341-2350`（`__FLUXGS_SET_CAM__`/`__FLUXGS_DUMP_XYZ__`）、`2351-2367`（`window.runFluxBenchmark`）；**删除** 官方无条件的 `requestAnimationFrame(frame);` | **timing-loop change**：官方无条件 `requestAnimationFrame(frame)`；本地改为 `if (isBenchmarking) { … render 后 setTimeout(0) 或结算 … } else { rafId = requestAnimationFrame(frame) }` | timing-loop change（**只有测帧会话改变调度**） |
| 11 | `@@ -2292,6 +2471,9 @@` | `main.js:2474-2476` | 网络段结束打点 `stats.fetchEndAt` | benchmark instrumentation |
| — | — | — | **shader 源码 / SortWorker 排序算法 / 剔除 / VQ 解码公式 / `gl.drawArraysInstanced` 调用** | rendering·sorting·decode change = **无** |

### 4.1 符号级扫描（证明"没改渲染"）

| 符号 | 本地命中位置 | 判定 |
| --- | --- | --- |
| `runFluxBenchmark` | `render_shared/main.js:2351`（定义）；`bench-flux.ts:461`（调用） | 本地新增钩子 |
| `__FLUXGS_STATS__` | `main.js:1490,1538,1589,1696-1698,1758-1759,1774,2265-2266,2475` | 本地新增 |
| `benchres` | `main.js:1487`（解析）、`1674-1675`、`1690-1694` | 本地新增，仅 URL 带参生效 |
| `warmup` | **0 处** | 官方与本地都**没有** warmup；`runFluxBenchmark(count)` 只有 1 个参数 |
| `setTimeout` | `main.js:1470`（官方原有的 `hideProgress`）、`2308`、`2335`、`2366`（本地新增的测帧链） | 本地新增 3 处调度 |
| `requestAnimationFrame` | `main.js:2332`、`2338`（测帧结束后恢复） | 官方对应位置是 1 处无条件调用，被替换 |
| `carousel` | `1446`（官方 `let carousel = true;`）、`1511`/`1517`（`?fluxcam=`/`?benchres=` 置 false）、`1524`（官方原有：解析 `location.hash` 置 false）、`2331`（测帧后恢复原值） | 相机控制，未改相机数学 |
| `view matrix` | `viewMatrix` 仍由官方 `getViewMatrix(camera)`（官方 171 行 / 本地 171 行，逐字节相同）产生；本地只新增注入钩子 `__FLUXGS_SET_CAM__`（`2344-2349`）与回报字段 `view:`（`2324`） | 未改 |
| `canvas.width` / `canvas.height` | `main.js:1688-1689`（官方原有：`innerWidth/downsample`）+ `1692-1693`（本地：`benchres` 覆盖） | 仅 `?benchres=` 生效 |
| `devicePixelRatio` | `main.js:1552`（官方原有 `downsample` 策略，**未改**） | 未改 |
| `gl.viewport` | `main.js:1695`（官方原有语句，实参仍是 `gl.canvas.width/height`） | 未改语义 |

### 4.2 官方画布策略（官方 1523-1524 / 本地 1551-1552，逐字节相同）

```js
// 官方 == 本地（未改）
const downsample = splatData.length / rowLength > 500000 ? 1 : 1 / devicePixelRatio;
// resize()（官方 1609-1615 / 本地 1688-1689，未改）
gl.canvas.width  = Math.round(innerWidth  / downsample);
gl.canvas.height = Math.round(innerHeight / downsample);
```

即 **点数 > 500000 → 1 × CSS（backing store = CSS 像素）；否则 CSS × devicePixelRatio**。
这就是第 7 阶段要复刻的 **`flux-native`** 协议。

---

## 5. 必答问题（证据化回答）

### Q1. `runFluxBenchmark()` 是官方原有代码，还是本地新增的可测试钩子？

**本地新增。** 官方 `render_shared/main.js`（blob `e882ce7f…`，2307 行）中不存在该符号，也不存在
`__FLUXGS_STATS__` / `benchres` / `fluxcam`（在官方原文上搜索 → **0 命中**）。
本地定义见 `render_shared/main.js:2351-2367`，属 §4 hunk 10。

### Q2. 如果是新增，它是否复用了官方完整 render 函数？

**是，完全复用。** 证据：

```js
// 本地 render_shared/main.js:2351-2367（逐行照抄）
window.runFluxBenchmark = (count = 300) =>
    new Promise((resolve) => {
        if (isBenchmarking) { resolve(null); return; }
        console.log('Starting Flux-GS offscreen benchmark: ' + count + ' frames (waiting for model load)');
        isBenchmarking = true;
        benchmarkFrameTarget = count;
        benchmarkFrameCount = 0;
        benchmarkStartTime = 0;
        __fluxBenchResolve = resolve;
        __fluxBenchCoveredPct = 0;
        carousel = false;
        if (rafId) cancelAnimationFrame(rafId);
        setTimeout(() => frame(performance.now()), 0);   // ← 驱动的仍是官方那个 frame()
    });
```

它驱动的就是**官方 `frame()`**：内含 `OrbitControls` 更新 / 相机矩阵计算、
`worker.postMessage({ view: viewProj })` 请求深度排序、`gl.uniform*` 上传、
`gl.clear` + `gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, vertexCount)` 绘制。
计帧分支插在官方 `frame()` **末尾**（`lastFrame = now;` 之后、原来那句
`requestAnimationFrame(frame);` 的位置），见 `main.js:2303-2339`。
**没有**第二套渲染函数、**没有**跳过排序等待、**没有**换绘制路径。

### Q3. 是否更改了 shader、排序、剔除、解码或绘制逻辑？

**没有。** 逐项证据：

- **shader**：11 个 hunk 没有一个落在 `vertexShaderSource`/`fragmentShaderSource`/`gl.shaderSource` 上；
  这些代码段在官方与本地**逐字节相同**。
- **排序**：`worker.onmessage` 对 `depthIndex` 的处理（本地 1779-1782 / 官方 1760-1763）逐字节相同；
  `createWorker()` 与 worker 内排序算法未改。hunk 7 只是在 `texdata_sh` 分支后**追加**互斥的
  `else if (e.data.xyz_dump)`，不改变任何既有分支。
- **剔除**：Flux 的视锥剔除（`cullFrustum`）在 worker 内，本地未改；hunk 1 的 `postMessage`
  位于 `console.time("VQ Decode")` 之前，与剔除逻辑无关。
- **解码**：`decodeVQAttributesConcat`、VQ 反量化、`sigma`/协方差计算全部相同
  （官方 400-538 与本地 400-538 逐字节相同，首个差异从本地 998 行才开始）。
- **绘制**：`gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, vertexCount)`（本地 2263）与官方一致；
  hunk 9 在它**之后**追加 `firstFrameAt` 打点与**仅首帧**的 `readPixels` 覆盖率采样
  （条件 `isBenchmarking && benchmarkFrameCount === 1`，包在 `try/catch` 内）。

### Q4. 是否只是把官方 FPS 循环包装成 Promise/API？

**不只是包装，还换了调度与计时锚点**——这正是"必须逐行复刻"的部分：

| 维度 | 官方 | 本地 `runFluxBenchmark` |
| --- | --- | --- |
| 每帧调度 | `requestAnimationFrame(frame)`（无条件） | 计帧期间 `setTimeout(() => frame(performance.now()), 0)`（`main.js:2308`） |
| 帧序 | rAF 回调内 render | **先 render，后 `setTimeout(0)` 排下一帧** |
| 计时起点 | 只有页面上显示的 EMA：`avgFps = avgFps*0.9 + currentFps*0.1` | `benchmarkStartTime` = **第一帧 render 结束时刻**（`main.js:2305`） |
| FPS 公式 | 无（EMA 显示值） | `fps = benchmarkFrameCount / elapsed`，`elapsed = (performance.now() - benchmarkStartTime)/1000`（`2310-2311`） |
| 返回值 | 无 | `Promise<{fps, frames, ms, resW, resH, coveredPct, view}>`（`2317-2325`） |

因此**不能**把 `bench.html` 现有默认的 rAF 口径当成"和 Flux 一样"（详见 `FLUX_FPS_PROTOCOL.md` 第 3 章）。

### Q5. 本地副本基于官方哪个 commit？

`gh-pages` 分支 **`d062af33bab6e74ed45f9c4b6e8ec6b3d6cff752`**（tree `78f2872…`，2026-09-01T14:29:12Z，
commit message: "Merge remote gh-pages and refresh Flux-GS site"）。
判定依据：该 tree 下 49 个 blob 有 **41 个与本地逐字节相同**（含全部 `render_*/index.html`、
`render_*/main.js`、`render_shared/viewer.css`、`tools/tmc3.js|wasm`），唯一含代码改动的文件是
`render_shared/main.js`（186+/4−，全部为仪器化）。本地另补的 `render_bonsai/`、`render_stump/`、
`scene/*.json` 在官方 tree 里**不存在**，属本地新增资源、不属于任何官方 commit 的内容。

---

## 6. 与 `bench.html` / `bench-flux.html` 的接线（供第 3 阶段引用）

```js
// bench-flux.ts:485-498 —— 它怎么打开本地内嵌副本
const pageUrl = new URL(meta.page, location.href);            // render_<scene>/index.html
pageUrl.searchParams.set("url", modelUrl.href);               // 模型地址（带 ts= 令牌）
if (/^\d+x\d+$/.test(forceRaw)) pageUrl.searchParams.set("benchres", forceRaw);  // ?force=1600x1063
if (/^\d+$/.test(fluxCam))      pageUrl.searchParams.set("fluxcam", fluxCam);    // ?fluxcam=N
// bench-flux.ts:460-470 —— 唯一的测帧入口
const result = await withTimeout(Promise.resolve(fn.call(cw, frames)), timeoutMs, `runFluxBenchmark(${frames})`);
// bench-flux.ts:568-571 —— warmup>0 时才额外跑一次；默认 0 ⇒ Flux 臂没有任何预热
if (st.warmupFrames > 0) await runBenchmark(cw, st.warmupFrames, 120000);
const bench = await runBenchmark(cw, st.benchFrames, 240000);
```

**结论**：`bench-flux.html` 一侧的 FPS 完全由 `runFluxBenchmark()` 产生、没有任何二次加工
（`fps` 原样写进结果行），所以它就是"**内嵌副本钩子口径**"的原样输出（不得称作论文口径）。
`bench.html` 要逐项对齐的目标是 §4.2 的画布策略 + hunk 10 的调度/计时顺序。

