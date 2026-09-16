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


## §4 追加：H6–H12 接线 hunk 记录（仅 ?bridge=1 生效）

| Hunk | 位置（render_shared/main.js） | 内容 | 默认路径影响 |
|---|---|---|---|
| H6-1 | worker.onmessage 之前（约 L1830–L1904） | __fxBenchEnabled(?bridge=1) / __fxBench(session+pending token+active) / __fxFact(postMessage 元数据) / __fxAuthorizeUpload(同步 fail-closed 上传门) / window.__FLUXGS_BENCH_SORT__(薄原语 sortRequested·contextLost·dispose·frameOnce) / webglcontextlost 监听 | 无：__fxBench===null 时全部惰性早退 |
| H6-2 | e.data.depthIndex 分支 | 上传前发 result-received；门控失败则不触碰 GL 并发 sort-failed(pre-upload-gate)；成功则在原 bufferData 后发 index-uploaded + index-activated 并记录 draw 前 active 快照 | 无：条件首位为 __fxBench |
| H6-3 | gl.drawArraysInstanced 处 | draw 前冻结 active 快照；draw 返回后发 draw-completed / draw-failed | 无 |
| H6-4 | 两处 rafId=requestAnimationFrame(frame) + 三处 setTimeout(()=>frame(...),0) | 统一加 if (!__fxBench) 守卫 ⇒ bridge 模式不自驱调度，改由父侧 frameOnce 单次驱动 | 无：__fxBench 为 null 时表达式逐字不变 |
| H6-5 | worker.onmessage 末支 | worker 的 skipped/failure/bench-sort-rejected ⇒ sort-failed / sort-rejected 事实 + token 置 settled | 无：条件首位为 __fxBench，否则仍为原“忽略”行为 |

事实集合（冻结）：sort-requested, worker-completed, result-received, index-uploaded, index-activated, draw-completed, draw-failed, sort-rejected, sort-failed, barrier-ack, context-lost。depthIndex 字节不进入事实对象、不离开 iframe。

### 独立于 Git 的快照差异审计

快照 C:UsershuangAppDataLocalTemp\flux-main-h1-h5-baseline-20260915.js（sha256 d08e83215d108e970e5c8ef6b4e12bc9938f39dd507daa883d8d2f0d568a9f3f）→ 完成版：

pre 101326 B / 2613 行；post 108564 B / 2743 行（+130 行）

__fxBenchEnabled 0→3, __fxBench 0→36, __fxFact 0→10, __fxAuthorizeUpload 0→2, __FLUXGS_BENCH_SORT__ 0→1, __fxDrawSnap 0→6, frameOnce 0→1, webglcontextlost 0→1, 自驱调度守卫 rafId 0→2 / setTimeout 0→3

全部改动为新增；快照中上述标记零出现。

### 验收

- tools/check_flux_vendor_diff.py（接线后重跑）：EXIT=0，identical=41 lf_only=0 modified=4 missing=4 extra=17

- 默认非 bridge 路径不变量：bench-flux-bridge.test.ts 8 项静态断言 + 7 项 B2 事实驱动断言，EXIT=0（15 passed）

- 仍 pending：真实 Chromium smoke、运行时 Worker 交错采样

### 审计脚本计数分类说明（missing=4 / extra=17 不是零差异）

check_flux_vendor_diff.py 以冻结清单 tools/flux_gh_pages_tree.json 为基线比对 vendor 树：

- identical=41：逐字节一致；lf_only=0：仅行尾差异；modified=4：内容有差异（含 render_shared/main.js，即 H1′–H12 全部改动）；
- missing=4 / extra=17：基线清单与当前树的结构性差异（清单侧有而工作树无 / 工作树新增而清单无），属已知计划内差异；
- 脚本对上述计数返回 EXIT=0；两者**不代表无差异**，也不代表验收失败。

### §4 追加：H13（vendor render-only 静态帧）

| Hunk | 位置 | 内容 | 默认路径影响 |
|---|---|---|---|
| H13-1 | `frame()` 之前 | 抽出唯一绘制主体 `drawActiveFrame(viewMatrixForDraw, {writeDom})`：返回 boolean；无索引时只 clear；`writeDom=false` 不碰 DOM；内含 H12 的 draw 前快照与 `draw-completed/draw-failed` 事实 | 无（frame() 语义不变） |
| H13-2 | `frame()` 内原绘制块（62 行） | 改为 `__fxLastActualView = actualViewMatrix` + `drawActiveFrame(...)`；`!drawn ⇒ start = Date.now()+2000` | 逐字等价行为 |
| H13-3 | bridge 块 + 激活点 | `let __fxLastActualView = null`；active 快照增加 `viewMatrix` | 无（仅 bridge 模式写入） |
| H13-4 | `window.__FLUXGS_BENCH_SORT__` | 新增 `frameStatic()`（不排序/不改相机/不写 DOM/不调度；单次一 draw）与 `stats()`（`vertexCount>0` 才返回，否则 `null`） | 无（仅 bridge=1 注册） |
| H13-5 | bridge 块 | 父子 session 一致性：优先读取 `?fxsession=<id>`（父侧下发），缺失才自生成 | 无 |

**`frameStatic()` 负面保证（硬性）**：不调用 `worker.postMessage({view})`、不产生 `sort-requested/sort-completed`、不调用 `gl.bufferData` 上传索引、不更新相机、不写 FPS/benchmark DOM、不安排 rAF/setTimeout；只绘制当前已激活索引与既定 view；draw 返回后产生 `draw-completed`；每次调用恰好一次 controller render call。
**[H22-A]** 返回值 = **同步归属描述** `{drawn, serial, viewMatrix}`（不再返回裸布尔）：父侧只能在**同一任务**内
通过跨 realm 调用的返回值得知"本帧真实画了什么"，`draw-completed` 事实保留（审计/幂等确认）但**不再**是
父侧同步归因的依据。

**`stats()` workload 语义**：仅当 `vertexCount > 0` 返回 `{vertexCount}`，否则 `null`；适配器 `getWorkloadAudit()` 在无有效值时**显式抛错**（禁止用 0/null 冒充有效值，§12.6）。

**`fxsession` 一致性机制**：父侧 `injectBridgeParams(url,w,h,sessionId)` 幂等注入 `bridge=1`/`benchres`/`fxsession`；vendor 以该参数为 session，父子必须一致，否则 Adapter `init()` fail closed。

`missing=4` / `extra=17` 的计数分类说明见上一节（结构性差异，不代表零差异，也不代表验收失败）。

### §4 追加：协议纠错 —— bench 强制排序改为**显式 serial 绑定**（H16）

理由（跨 postMessage 结构化克隆使对象引用同一性恒为假）：

```text
原判定：main.js `benchPendingView !== null && benchPendingView === viewProj`
worker 侧：`benchPendingView = e.data.view`（结构化克隆副本）
⇒ benchForcedThisRun 恒 false ⇒ sortSerial 恒 null ⇒ 父侧 token 永不匹配 ⇒ waitForSortApplied 超时
```

| Hunk | 位置 | 内容 |
|---|---|---|
| H16-1 | worker `runSort` | 判定改为 `typeof benchFrameSerial === "number" && Number.isSafeInteger(benchFrameSerial) && benchPendingSerial !== null && benchFrameSerial === benchPendingSerial`；`benchFrameSerial = null` 一次性消费 |
| H16-2 | worker `{view}` 分支 | 采集 `benchFrameSerial = typeof e.data.benchSerial === "number" ? e.data.benchSerial : null`（未启用 bridge 时恒 null） |
| H16-3 | 主线程 `frame()` | 存在待处理 serial 时 `worker.postMessage({ view, benchSerial: __fxBench.pendingSerial })`；否则保持原 `{ view: viewProj }` 逐字不变 |
| H16-4 | 薄原语 `sortRequested` | 记 token + `pendingSerial` 并**转交 worker**：`{ type: "bench-sort", sortSerial, view, force: true }`（worker 的 benchPendingSerial 只由该分支设置） |
| H16-5 | 终态清理 | 成功上传 / 上传门失败 / context-lost / dispose / sort-rejected·failed 分支清 `pendingSerial`；迟到或不匹配 serial **不得**清除当前合法 pending |

协议边界不变：单飞（存在 pending 时新请求被 rejected，不覆盖）；默认路径消息形状与排序启发式逐字不变；view 仍用于数据与诊断（`authorizeUpload()` 继续校验 serial + session + token + view）；不匹配 serial 不上传、不推进 accepted/uploaded/active。

静态不变量测试已从"引用同一性"升级为"serial 绑定"（bench-flux-bridge.test.ts #8/#9），并新增默认路径消息形状断言。


---

## §4.H19 运行时接线修复：单一视图基线 + 上传门精确诊断 + 终态快速失败

**触发证据（Chromium 烟雾，build `8B-5`）**：`reasons=controller-invalid:exception:waitForSortQuiescence(1) aborted`，
页面 `diag` 事实日志（末 4 条）：

```
#1 sort-requested serial=1 ok          ← 父侧登记成功（requestSortOnce）
#2 sort-requested serial=1 failed      ← vendor 回显事实（父侧 default 分支，不改状态）
#3 result-received  serial=1 accepted  ← 强制排序真实完成（worker 回传 serial + view）
#4 sort-failed      serial=1 failed    ← vendor 上传门拒绝 ⇒ 无 index-uploaded ⇒ pending 永不消费 ⇒ 30s 超时
```

**定位（不需要浏览器的证据）**：把 #1→#3 三条事实在 `FluxBenchBridge` 上逐步重放（真实桥 + 假 transport），
`authorizeUpload()` 返回 **true** ⇒ **父侧门被排除**（不是失败点）。失败因此只剩 vendor 侧 `__fxAuthorizeUpload()` 的
四项检查；其中最可能的失败项是**1e-6 逐项比较**：token 内保存的是父侧登记视图（`sortRequested(serial, view16)` 写入
`{view: viewProj.slice()}`），比较对象却是 vendor 动画 `frame()` 自己重算的 `viewProj = multiply4(projectionMatrix, actualViewMatrix)`
（`actualViewMatrix` 还经过 `translate4/rotate4(jumpDelta)` + `invert4` 往返）⇒ 两者存在**浮点/动画漂移**，门拒绝上传。
同序列 `dot ≈ 1`（近乎等价机位）与"漂移"情形一致。

> **（H20 更正）** 上述"最可能的失败项 = vendor 侧 1e-6 逐项比较"**已被 build `8B-6` 的烟雾证伪**：
> 实际 reason 是 `pre-upload-gate:parent:reject` ⇒ vendor 的 1e-6 舍入比较**通过**了，拒绝发生在**父侧**逐位严格比较。
> 结论：漂移确实存在，但**门主体选错了视图对象**，而不是 vendor 门太严。详见 §4.H20。

> **证据边界（诚实标注）**：重放只能**排除父侧**、把失败点收敛到 vendor 门；门内究竟是哪一项（`no-token` / `token-settled` /
> `view-not-16` / `view-drift` / `parent:reject`）需要下一次 Chromium 烟雾的 `pre-upload-gate:<reason>` 才能**直接**读出。
> H19-1 消除最可能的成因（视图漂移）；H19-3 保证残余成因**自我声明**，不再有"未知原因"。

| Hunk | 位置 | 内容 |
|---|---|---|
| H19-1 | 主线程 `frame()` | bridge 模式排序输入改为**登记 token 视图**：`const __fxTok = __fxBench.pending.get(__fxBench.pendingSerial)` → `__fxSortView = __fxTok && Array.isArray(__fxTok.view) && __fxTok.view.length === 16 ? __fxTok.view : viewProj` → `worker.postMessage({ view: __fxSortView, benchSerial: __fxBench.pendingSerial })`；默认路径 `worker.postMessage({ view: viewProj })` 逐字不变 |
| H19-2 | `__fxBench` 对象 | 新增 `lastAuthReason: null` |
| H19-3 | `__fxAuthorizeUpload()` | 每条拒绝路径写入精确原因：`vendor:no-token` / `vendor:token-settled` / `vendor:view-not-16` / `vendor:view-drift@<i>=<delta>` / `parent:reject` / `parent:throw` |
| H19-4 | 上传门失败事实 | `reason: "pre-upload-gate:" + (__fxBench.lastAuthReason || "unknown")`（不再输出 generic 原因，杜绝二次猜测） |

父侧配套（`bench-flux-bridge.ts`，**非** vendor 文件）：`ConditionWaiter` 记录关联 `serial`；`fail()` 在结算单飞 waiter
**之前**先 `rejectConditionWaiters(serial, reason)` ⇒ 终态事实（rejected / failed / protocol-failure）**立即**以真实原因
中止 `waitForSortApplied` / `waitForSortQuiescence` / `waitForDrawn`，不再把"精确协议失败"伪装成 30s "aborted"。

不变量保持：严格单飞；session+serial+token+view 五元 fail-closed；`?bridge=1` 之外的默认路径零行为变化；
depthIndex 字节仍不离开 iframe。

静态/行为锁定测试：`bench-flux-bridge.test.ts` #9（改为断言 token 视图基线，并 `not.toMatch` 旧的 `view: viewProj` 形式）、
#10（断言上传门精确原因 + `pre-upload-gate:<reason>`）、行为 #8（终态事实必须立即 reject 条件等待者）。

---

## §4.H20 上传门主体纠错：单一规范视图 + 父侧拒绝自证

**触发证据（Chromium 烟雾，build `8B-6`）**：

```
round=1 method=flux-gs valid=false
reasons=controller-invalid:exception:pre-upload-gate:parent:reject|pendingSortsAtStart=-1|pendingSortsAtEnd=-1
        |controllerRenderCalls=0≠30|adapterFrameDelta=2≠30|sort-not-frozen-before-warmup|warmup-draw-not-verified|sort-token-not-proven
   diag #1 sort-requested serial=1 ok
   diag #2 sort-requested serial=1 failed
   diag #3 result-received serial=1 accepted
   diag #4 sort-failed serial=1 failed
```

三条结论同时成立：
1. H19-3/H19-4 **生效**：原因从 generic 变为**精确** `pre-upload-gate:parent:reject`；
2. H19-5 **生效**：失败**立即**中止（不再是 30s `aborted`）；`controllerRenderCalls=0` 说明轮次在首个 `requestSortOnce`
   之后即中止，从未进入测量窗口（`adapterFrameDelta=2` = `waitUntilReady` 的 prologue 帧 + 该次排序帧）；
3. **H19 关于"哪一项检查失败"的猜想被本次证据证伪**：门没有停在 vendor 自己的 1e-6 漂移比较（否则 reason 会是
   `vendor:view-drift@…`），而是走完了四项 vendor 检查、进入**父侧 validator** 才被拒绝。

**真正的根因（可静态证明）**：两侧比较**语义不同**，而门主体选错了对象。

| 侧 | 比较 | 语义 |
|---|---|---|
| vendor `__fxAuthorizeUpload` | `tok.view` vs `viewProj`（1e-6 **四舍五入**） | 宽松：≤ ~5e-7 的漂移**通过** |
| 父侧 `FluxBenchBridge.authorizeUpload` | `acceptedResults[serial]` vs `viewProj`（`flux-bench-state.sameView`，**逐位 `!==`**） | 严格：任何一位不同即拒 |

调用点传入的是 **frame 局部重算** 的 `viewProj = multiply4(projectionMatrix, actualViewMatrix)`
（`actualViewMatrix` 经 `translate4/rotate4(jumpDelta)` + `invert4` 往返），而父侧 `acceptedResults` 存的是
`result-received` 上报的**规范视图** `__fxView`（= 父侧登记视图 = 送 worker 的排序输入视图）。
⇒ vendor 侧宽松检查通过、父侧严格检查拒绝；两侧**各自都没错**，错的是**把浮点漂移量当成了授权主体**。

> **（H21 更正）** 上述"父侧逐位严格 vs vendor 1e-6 舍入"确实是**真实存在的语义差异**，但**不是本次 `parent:reject` 的成因**：
> 本分支内的 `viewProj` 其实是 `{ depthIndex, viewProj } = e.data` 解构出的**消息视图**（worker `runSort` 原样回显，
> 与 `__fxView` **逐位相等**），父侧拒绝它不可能是"视图不一致"，只能是 `acceptedResults` 里**还没有**该 serial ——
> 即**事实送达时序**问题。§4.H21 给出反证与修复。H20-1（门主体显式写 `__fxView`）作为"身份链一眼可查"的
> 可读性改动保留，H20-2（`parent:reject@drift=`）作为诊断保留。

| Hunk | 位置 | 内容 |
|---|---|---|
| H20-1 | 结果消息处理（`gl.bufferData` **之前**） | 门主体改为**规范视图**：`!__fxAuthorizeUpload(__fxSerial, __fxView)`（此前为 frame 局部 `viewProj`） |
| H20-2 | `__fxAuthorizeUpload()` 父侧分支 | 裸 `parent:reject` 升级为 `parent:reject@drift=<maxᵢ|tok.view[i]-viewProj[i]|>`：`drift=0` ⇒ 非视图原因（session/单飞/未 force/dispose），`drift>0` ⇒ 视图不一致 |

父侧配套（`bench-flux-bridge.ts` + `bench-flux-adapter.ts`，**非** vendor 文件）：新增 verdict `authorize-rejected`
与 `FluxBridgeEvent.reason`；`authorizeUpload()` 的**每条**拒绝路径都在事实日志留下精确原因
（`malformed-serial` / `view-not-16` / `session-mismatch` / `disposed` / `not-in-flight` / `not-forced` / `view-mismatch` / `exception`）；
`getBridgeEventLog()` 仅在 reason 非空时追加 ` reason=<r>` ⇒ 页面 `diag` 行一次读全
（例：`#5 sort-rejected serial=1 authorize-rejected reason=not-forced`）；成功路径不写日志，形状不变。

**新增不变量**：授权门的判定主体只能是一个**单一规范视图**，其身份链必须逐位同源：
`父侧 requestSortOnce(view16)` = `vendor token.view` = `worker 排序输入` = `result-received.viewProj` = `门主体`。
禁止用"自身重算的浮点近似值"当门主体；也禁止用宽松（1e-6 舍入）比较**替代**父侧的逐位严格门——两者是**不同**的保证。

**已知未闭合（诚实标注）**：绘制路径仍使用 vendor 自身的 `actualViewMatrix`
（`frameStatic` → `drawActiveFrame(__fxBench.active.viewMatrix)`），它与规范视图只保证"**同一相机 + 浮点噪声**"，
**不是逐位相等**；噪声量级由 H20-2 在失败路径直接报出，**H22-A 起成功路径也会在同步归属日志里报出**
（`reason=sync-return drift=<max>`）⇒ 论文协议描述应写成
"同一相机（float 噪声级）"；若要逐位相等需另开一项（bridge 模式用规范视图覆盖绘制矩阵）。
**`browser-validated` 仍为 pending**，直到 Chromium 烟雾真正通过。

测试锁定：`bench-flux-bridge.test.ts` #12（静态：门主体必须是 `__fxView`、不得是 `viewProj`；`parent:reject@drift=` 存在
且裸 `"parent:reject"` 消失）、行为 #11（精确视图 ⇒ `true`；仅低位漂移 `1e-12` ⇒ `false` 且日志
`authorize-rejected reason=view-mismatch`；`session` / `in-flight` / 长度 / 未 force 四条路径各自自证）。

不变式保持：严格单飞；session+serial+token+view 五元 fail-closed；`?bridge=1` 之外的默认路径零行为变化；
depthIndex 字节仍不离开 iframe。

---

## §4.H21 同步上传门的时序死角：门不得依赖异步送达的事实

**反证（纯静态推导，无需浏览器即可验证）**：

1. iframe 侧结果处理是**同一任务**内的顺序代码（`main.js` 的 `e.data.depthIndex` 分支）：
   `__fxFact("result-received")`（postMessage ⇒ **异任务**投递给父侧）→ **同栈**调用
   `window.parent.__fxbenchAuthorize(...)`（父侧门在 iframe 的**本任务内**同步执行）→ `gl.bufferData`
   → `__fxFact("index-uploaded")`。
2. HTML 事件循环保证：任务 T 内 postMessage 的消息只能在 T **之后**的新任务里被父侧处理
   ⇒ 门执行时父侧**必然**尚未处理 `result-received`。
3. 于是 `flux-bench-state.acceptedResults` 没有该 serial ⇒ H20 之前的门 `hasAccepted() === false`
   ⇒ **永远** `parent:reject`（且唯一可能的 reason 就是 `view-mismatch`）。
4. 排除其余分支：`session` 已由 adapter `init()` 校验一致（不一致会提前抛错）；`forced` 每次请求由 adapter 置位；
   `inFlight` 只在 `markActive` 释放（在 upload **之后**）；`disposed` 不成立（`sort-failed` 事实仍被父侧入账）。
   ⇒ 只剩第 3 条。

**协议教训**：跨 realm 的**同步**门只能依据"父侧**同步可达**的知识"（登记 + 单飞 + session + dispose）；
需要**异步事实**才能建立的知识（"结果已被合法接收"）只能放在**后验**校验点。

| Hunk | 位置 | 内容 |
|---|---|---|
| H21-1 | `FluxBenchBridge` 字段 | 新增 `requestedViews: Map<serial, view16>`；`requestSortOnce()` 在 `begin.ok` 之后 `clear()+set()`（严格单飞 ⇒ 至多一条，无无界增长）；`dispose()` 清理 |
| H21-2 | `authorizeUpload()` | 末项判定由 `state.hasAccepted(serial, view)` 改为**登记表**：`not-registered` / `view-mismatch`（逐位相等，复用 `flux-bench-state.sameView`） |
| H21-3 | `onFact()` 的 `index-uploaded` / `index-activated` | **后验**校验失败 ⇒ 新增 `abort(serial, reason)`（`markWorkerFailure` + `fail`，立即中止条件等待者）：`protocol-failure:upload-not-accepted` / `protocol-failure:activate-rejected` |
| H21-4 | `flux-bench-state.ts` | `sameView` 导出，作为"逐位严格"的**唯一**语义权威（禁止各处自造近似比较） |
| H21-5 | `onFact()` 首次显式处理 `sort-requested` | 该事实在 `FLUX_FACTS` 中**已声明**，但此前落到 `default:` 被记为 `failed` ⇒ diag 里出现**假失败**信号（上轮 `#2 sort-requested serial=1 failed` 即此）。现按"父侧登记 + iframe 回显一致 ⇒ `ok`"处理；顺带补齐"已声明事实必须显式处理"的结构不变量 |

**为什么门没有变松（fail-closed 仍完整）**：
- 上传**前**：session 一致 ∧ 未 dispose ∧ serial === 当前单飞 ∧ 登记存在 ∧ view 与登记**逐位相等**（否则不触碰 GL）；
- 上传**后**：`index-uploaded` 处理点（同一 postMessage 队列已**先**处理过 `result-received`）仍要求
  `acceptedResults[serial]` 与该 view 逐位相等，否则**立即终态**且不得推进 `uploaded/active`；
- ⇒ "结果合法性"只在**顺序可证**的点校验；非法上传下 `waitForSortQuiescence` 依旧不可能成立。

**布局事实（本轮新澄清，写入文档以免再次误判）**：`render_shared/main.js` 把 `createWorker(self)` 字符串化后
当 Blob Worker 运行 ⇒ 该文件**同时**含 worker 侧（`runSort`、`self.onmessage`）与页面侧（`frame`、`worker.onmessage`）代码；
worker `runSort` 的成功消息 **原样回显** `viewProj`（页侧 `e.data.viewProj`）= 本次排序输入视图
（bridge 模式下 = token 视图 = 父侧登记视图，逐位相等）。

**测试锁定**：`bench-flux-bridge.test.ts` 静态 #12（门主体 = `__fxView`）；行为 #11（逐位严格 + 拒绝自证）、
#12（**无任何事实**即可授权 = 本时序不变量的关键回归；1e-12 漂移仍拒；随后真实事实序列达静止）、
#13（后验校验失败 ⇒ 精确原因立即 reject，不是 30s 超时）、#14（`sort-requested` 回显不得记为 failed）、
#15（`FLUX_FACTS` 每个事实都必须被 `onFact` 显式处理）；#1/#5 依新语义更新（门不再被误建模为"事实驱动"）。

**未改变的不变量**：严格单飞；`?bridge=1` 之外零行为变化；depthIndex 字节不离开 iframe。
**`browser-validated` 仍 pending**（须由 Chromium 烟雾给出最终判定）；论文主表采集继续禁止。

### 4.H22 —— 两个"跨 realm 同步不可观测"缺陷（H21 之后暴露的下一层）

**触发证据（build `8B-7` Chromium 烟雾，H21 已生效）**：`parent:reject` 与假失败 `sort-requested` 全部消失，
`controllerRenderCalls=30`、`adapterFrameDelta=30`、`sort-token-not-proven` 也不再出现，只剩：

```
reasons=controller-invalid:warmup-draw-not-verified|warmup-draw-not-verified|measure-window-audit:changed
fps=1829.27 frames=30 sortReq=0 sortDone=0 idxUpload=0
```

两条**互不相同**的根因（都不是"排序/上传/门"的问题）：

1. **H22-A：`lastDraw` 的归因只经异步事实可达，而校验点全是同步读取。**
   - controller 在 warmup 循环之后**同一任务内**读 `adapter.getSortAudit().lastDrawSortSerial`
     做 `warmupDrawVerified`；`draw-completed` 事实走 `postMessage` ⇒ 至少晚一个任务
     ⇒ 该值**恒为 0**（合法轮也判 `warmup-draw-not-verified`）。
   - adapter 的窗口基线 `windowStartLastDraw` 取在 **`freezeSortRequests()` 时刻**（warmup draw 之前）
     ⇒ 第 1 轮必然为 0 ⇒ `warmupDrawMissingAtWindowStart=true`（第 2 轮起才"看起来正常"= 更危险的假阳性）。
   - 单元测试未拦住是因为 fake/`MockAdapter` 在**同一任务**里更新父侧状态（真实跨 realm 不会）。
2. **H22-B：`finishGpu()` 从未真正同步过 GPU。**
   `FluxBenchBridge.finishGpu()` 只是 `postMessage({prim:"finish-gpu"})`，而 vendor **没有任何
   `window.addEventListener("message")`** ⇒ 该消息**无消费者**、finish 静默变成空操作。
   于是 `totalSyncedMs` 只含 CPU 提交时间：30 帧「1829 fps」≈ 16ms —— 这不是 synchronized throughput，
   而是**提交吞吐**被贴上了同步 FPS 的标签（比"轮次无效"更危险：它可能让 round **valid=true**）。

**修复原则（与 H21 同一条）**：跨 realm 的**同步**判定只能依据"同一任务内可达"的信息；
父侧**发起**调用的那一刻，唯一同任务可达的返回通道就是**调用返回值**。

| Hunk | 位置 | 内容 |
|---|---|---|
| H22-A-1 | `render_shared/main.js` 的 `frameStatic()` | 返回值由 `boolean` 改为**归属描述** `{drawn, serial, viewMatrix}`（只有 `drawActiveFrame` 真实执行才带 serial/view；`__fxBench.active` 在同任务内不会被替换 ⇒ 归属可信） |
| H22-A-2 | `FluxBenchState.markDrawnSync(serial)` | 新增**唯一同步**归因入口：只接受"当前 `activeSerial`"（fail-closed），写 `lastDrawSerial` + `drawnResults`；事实路径（`markDrawAttempt`）退化为**幂等确认** |
| H22-A-3 | `FluxBenchBridge.noteStaticDrawSync(res)` | 解析同步返回值；未 draw／无 serial（旧布尔返回）／serial ≠ active ⇒ **不记账**并留精确原因（`sync-not-drawn` / `sync-no-attribution` / `sync-stale-serial`）；成功时留痕 `draw-completed … ok reason=sync-return[ drift=<max>]`（**每个 serial 只在首次**留痕，其余帧由计数承担，避免 30 行同构日志淹没诊断尾部） |
| H22-A-4 | `bench-flux-adapter.ts` | `renderStaticFrame()` 消费同步返回值并把**窗口基线**改到 warmup draw **之后**；`warmupDrawMissingAtWindowStart := !同步归因成功 ∨ lastDraw ≠ 冻结时的 active`（与共享 slave 同语义） |
| H22-A-5 | `FluxBenchBridge.commitDraw()` | **每帧配对**计数：同步归属时记一个"待确认槽位"，随后的 `draw-completed` 事实优先消耗槽位（不计数）⇒ 同步路径与纯事实路径都恰好计 1 次，无双重计数 |
| H22-B-1 | `render_shared/main.js` 薄原语 | 新增 `finishGpu: () => { gl.finish(); return true; }`（`gl` 只存在于 iframe realm ⇒ 只能跨 realm **同步**调用） |
| H22-B-2 | `FluxBenchBridge` / `FluxGsAdapter` | **删除** `bridge.finishGpu()`（无人消费的 `prim:"finish-gpu"`）；`FluxGsAdapter.finishGpu()` 改为直连同名原语，**缺失/返回 false ⇒ 抛错**（round 以 `exception:` 失效，而不是悄悄给出不可比的数字） |
| H22-C | 文档/注释 | 8B 路径的"父 → iframe 驱动"全部走薄原语直接调用；`tx.post({prim:*})` 在本 vendor 中**没有监听者**（保留为既有 API，不参与判定） |

**fail-closed 仍完整**：H22-A 的同步归因只在 vendor 明确回报 `drawn===true ∧ serial===active` 时成立
（画了别的一代索引、`vertexCount<=0` 的 early return、旧布尔返回一律不记账）；
H22-B 在缺原语时**拒绝**给出任何 FPS；`?bridge=1` 之外零行为变化。

**测试锁定**：`bench-flux-bridge.test.ts` #16（同步归因：无任何事实即可推进 `lastDraw`；同 serial 多帧只计数不重复留痕；
异步事实只做确认、不翻倍计）、#17（三类 fail-closed 精确原因）、#18（**结构不变量**：vendor 必须暴露同步 `finishGpu`
与归属描述、父侧不得再用无人消费的 `prim:"finish-gpu"`）；`bench-flux-adapter.test.ts` #12（**本缺陷的关键回归**：
freeze 后基线是 fail-closed、warmup draw 之后 `lastDraw` **同步可见**且 `warmupDrawMissingAtWindowStart=false`）、
#13（缺同步 `finishGpu` ⇒ 抛错；存在 ⇒ 真实调用）；`flux-bench-state.test.ts` #11（`markDrawnSync` 只认 active）。

**运维提示**：烟雾/正式采集必须由**仓库根**提供页面（`gsplat.js/` 为 web root），因为
`site-dist/flux-gs-project-gh-pages/render_shared/main.js` 是**旧快照**（不含 `frameStatic` / `__fxbenchAuthorize` /
本次 H22 hunks）；若要公网复测，先 `npm run site:build` 重新生成 site-dist。

**`browser-validated` 仍为 pending**：`8B-7` 的失败已被完整归因，但 H22 结论必须由 build `8B-8` 的 Chromium 烟雾
（`valid=true`）给出；**在烟雾通过前，论文主表采集继续禁止**（这条禁令不因任何单测变绿而解除）。


