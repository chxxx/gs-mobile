> ⚠️ **【2026-10-10 失效标注】本文件中的 Flux 臂离屏数据可能无效**（`clearColor` 泄漏，2026-09-29 起；见 `docs/ch7_invalidated_by_clearcolor_leak.md`）。其中**跨臂**段落按待重跑处理；**本文臂内部消融**段落不受影响。


# 第 7 章 · 消融：`u_colorTransforms` / `u_colorTransformIndices` 是否值得删除

> 生成：2026-10-10。代码：`src/renderers/webgl/programs/RenderProgram.ts` / `ShaderProgram.ts`（本轮新增，默认关）。
> 证据：`thesis_project/data/ch7_measurements/raw/stripct_20261010_*.txt`（真机 Adreno 740）。

---

## 0. 一句话结论

1. **在部署臂（FINAL）上，这两个 sampler 既未被声明也未被采样 ⇒ 对部署臂 FPS 零影响**，删不删都一样。
2. **在"声明但未采样"的变体里，删除这 2 行声明也没有可测收益**（Adreno 740：26.1 → 26.1/26.3 fps，落在噪声内）。
3. **阳性对照**（在同一基准上**再加** 2 个未使用 sampler）**同样无效应**（26.1 → 26.0/26.1）⇒ 该设备对"未使用 sampler 数量"**不敏感**。
4. ⇒ 不建议为这两个 sampler 做任何删除动作；`?strip_ct=1` 保持**默认关**。

---

## 1. 源码事实（先核对，再下结论）

这两个 sampler 在**顶点模板**里只被 `#ifndef NO_COLOR_TRANSFORM … #endif` 包着，且位于
`#if (!defined(SHPASS_PRE) && !defined(SHCACHE_FRAG)) || defined(SHPASS_TF)` 块**之外**
（所以 `SHPASS_PRE` / `SHCACHE_FRAG` 编译里照样"声明"，但主 pass 的活跃分支不采样）。

静态矩阵（`tools/ch7_strip_ct_analyze.mjs`，宏展开 + 剔注释后统计"声明数/采样数"）：

| 主 pass 变体 | u_colorTransforms | u_colorTransformIndices | 判定 |
|---|---|---|---|
| 缺省 / `shfmt=f16`(`_incr`) / `shpass=produce` | 1/**4** | 1/**1** | 用了，禁删 |
| `shpass=pre` / `shpass=consume` | 1/**0** | 1/**0** | **声明但未采样** |
| `shcache=frag` / `shcache=frag&lr=1` | 1/**0** | 1/**0** | **声明但未采样** |
| `prep=1&shcache=frag`（`&slot=1`） | 1/**0** | 1/**0** | **声明但未采样** |
| `nocolortx=1`（含部署臂） | **0/0** | **0/0** | 已被 `#ifndef` 整段排除 |
| TF 第一遍（`shpass=*`） | 1/**4** | 1/**1** | 用了，禁删 |
| 方案 B / prep 生产遍 FS | 切片声明 + 采样 4 | 切片声明 + 采样 1 | 用了，禁删 |

**关键推论**：部署臂 `?shcache=frag&lr=1&notx=1&nocolortx=1` 带 `nocolortx=1` ⇒ 这两行在**驱动预处理阶段就被丢掉**
⇒ 在部署臂上"再删一次声明"是**空操作**（编译产物完全相同，`ACTIVE_UNIFORMS`/uniform 列表逐项一致，已实测）。
**所以：它们不影响部署臂的 FPS。**

> 注意区分两件事：
> ① **删除声明**（本消融的对象）——在部署臂上无意义；
> ② `nocolortx=1` 本身去掉的**逐点采样**（生产遍每点 5 次 `texelFetch`）——那是另一回事，且按既有记录（§21）"减少 fetch 次数"本身收益就很小。

---

## 2. 本轮新增开关（全部默认关，缺省路径逐字不变）

| 开关 | 作用 | 只在哪些变体生效 |
|---|---|---|
| `?strip_ct=1` | 在**拼好的最终顶点着色器源码**上删掉那 2 行声明（含整行）；断言"删前恰 2 处、删后恰 0 处"，否则抛错 | 仅主 pass 的 `SHPASS_PRE` / `SHCACHE_FRAG` / `PREP_MAIN` 变体；其余变体打印"跳过"并原样返回 |
| `?add_ct_positive=1` | 在最终源码**末尾追加 2 个**声明但绝不采样的 sampler（`u_ct_positive_a`/`_b`）——消融的**阳性对照臂** | 任意变体 |
| `?debug_shader=1` | link 后 dump 每个 program 的最终源码 + `ACTIVE_UNIFORMS` + 4~6 个目标 sampler 的 active 判定 | 任意变体；真机上看 Chrome 控制台 |

硬约束（已遵守）：**模板里那 2 行及其位置一字未动**（生产遍 FS 靠 `sliceShaderSource` 从模板切连续片段，改模板会切片失败/离屏 FPS=0）。
删除只发生在 `_getVertexSource()` 返回的字符串上。绑定逻辑未改：`getUniformLocation` 为 `null` 时 `gl.uniform1i(null, n)` 是规范允许的 no-op；
现役 sampler 的纹理单元都是**显式** `uniform1i`，删 3/4 号声明不会造成单元错位。

---

## 3. URL 参数逐项说明（本轮链接里出现的全部参数）

### 3.1 测帧协议（决定"测什么、怎么计时"）

| 参数 | 本轮取值 | 作用 | 依据 |
|---|---|---|---|
| `mode` | `bench` | 页面模式。`bench` = 自动跑批+回传；`view` = 手动浏览/实拍 | `bench.ts:1214-1215` |
| `benchmode` | `offscreen-paper-match` | 复刻 Flux-GS 论文的**离屏**协议：渲染到离屏 FBO、脱离屏幕 vsync | `bench-offscreen.ts` 头注释 |
| `res_mode` | `forced` | ⚠ **回显字段,URL 里写不写都一样**(无读取点);真开关见下行的 `force` | §3.3.2 |
| `force` | (缺省) | **真正的分辨率口径开关**:`force=native` 才关掉统一像素协议;缺省 = `forced` | `bench-shared.ts:1581-1583` |
| `res` | `1600x1063` | 渲染分辨率(1.70 Mpx);`forced` 时被 `setPixelRatio(1)+setSize(res)` 钉死 | 协议 §2 / `bench-measure.ts:428-434` |
| `dpr` | `1` | 见 §3.3.4(bench 路径不参与渲染分辨率,属口径自证) | `bench-view.ts:657` |
| `frames` | `20` | 每个 run 的计帧数 | 协议 §2 |
| `runs` | `5` | 每个 round 内 run 数；FPS = 5 run 均值 ± 标准差（**组内 std**） | `bench-offscreen.ts` |
| `warmup` | `20` | 每个 run 前的预热帧（不计入统计） | 同上 |
| `driver` | `msgchannel` | 帧驱动：不挂 rAF、不吃 `setTimeout(0)` 的 4ms 钳制 | `bench-shared.throughputTick()` |
| `sync` | `gputimer` | run 末 GPU 排空策略；**Adreno 无 timer-query 扩展 ⇒ 自动回落 `batch`** | `offscreen_sync_policy=…fallback=gputimer_unavailable->batch` |
| `fences` | `3` | 最大在途栅栏数（非阻塞进度检查上限） | `bench-offscreen.ts` |
| `rounds` | `3` | **同一次加载内**把整份 profile 跑 3 轮（"同会话"） | `bench.ts` |
| `cold` | `1` | 每轮冷启动（清缓存/重载资源） | `bench.ts` |
| `proto` | `flux` | 口径标识：FPS 定义/计时边界与 Flux-GS 臂同名同义 | `bench.ts:384-386` |
| `profile` | `garden` | 场景清单（可逗号多场景） | `bench-scenes.json` |
| `u` | `ct-A` 等 | **臂标签**，只影响回传文本标识 | `bench.ts` |
| `report`/`rtok` | `/__ch7/report?name=stripct` / `ch7-2026-phase4` | 自动回传端点与口令；落盘 `raw/<name>_<时间戳>.txt` | `tools/ch7_report_middleware.mjs` |

### 3.2 机位（决定"看的是不是同一个视角"）

| 参数 | 本轮取值 | 作用 |
|---|---|---|
| `cam` | `flux` | 用 Flux-GS 原相机（`bench-flux-camera.json` 的 `default_view`，**13 场景共用**）。**默认值就是 `flux`**（`bench-shared.ts:298`），不写也等于对齐；`cam=auto` 才退回包围盒取景 |

> 自证字段：结果头 `cam=flux` / `pose_src=flux`，逐轮 `pose=0.467561,0.035955,0.883327,0,-0.114043,0.993277`。这三项一致 = 同机位同视场。

### 3.3 三个容易被误解的参数（**重点**）

#### 3.3.1 `fpsoverlay=1` —— 只是"FPS 数字放大成大字"，给拍照/录屏

| 项 | 事实 |
|---|---|
| 做什么 | 左上角 FPS 数字 18px → **56px**：`bench.ts:1239` → `view.start({big: param("fpsoverlay")==="1",…})` → `bench-view.ts:123` `fontSize = options.big ? "56px" : "18px"`（`demo.ts` 实拍模式另含"隐藏默认 UI"） |
| 谁读 | 只有 `bench.ts:1239`，且**位于 `setupViewMode()` 内**（即只有 `mode=view` 执行） |
| `mode=bench` 下 | **零作用**：`bench.ts:1214` 注："只有 `setupViewMode()` 会创建 renderer；bench 模式下连 `bench-view.ts` 都不会被下载/执行" |
| 正确用法 | `bench.html?mode=view&scene=garden&fpsoverlay=1`（论文图 7-2 屏摄） |

#### 3.3.2 `res_mode=forced` —— URL 里写不写都一样；真正的开关是 `force`

- **`res_mode` 没有读取点**（全仓 `param("res_mode")` / `.get("res_mode")` 均无命中），它只是**结果头/逐轮行的回显字段**（报表脚本据此过滤主表）。
- **真正的输入是 `force`**（`bench-shared.ts:1581-1583`）：
  ```ts
  export function resolutionMode(): ResMode {
      return param("force","").trim().toLowerCase() === "native" ? "native" : "forced";
  }
  ```
  ⇒ **不写 `force` 就是 `forced`**；要关掉得写 `force=native`。
- **后备缓冲尺寸由两条路决定（关键，我此前写错过，这里更正）**：
  - `setSize(w,h)` → `canvas.width = w`，**原样写入、不乘任何 DPR**（`WebGLRenderer.ts:114-116`）；
  - `resize()` → `canvas.width = clientWidth × _pixelRatio`（**只有这条路会乘 DPR**），且只在 `_autoResize=true` 时才会被触发
    （window resize 事件 / `setPixelRatio()` 内部 / `enableAutoResize()`；`WebGLRenderer.ts:91-98,109-112`）。默认 `_pixelRatio = devicePixelRatio`（`WebGLRenderer.ts:15`）。
- 所以"统一像素协议"是**三件事一起做**才成立的：`disableAutoResize()`（关掉上面那条乘法路径）+ `setPixelRatio(1)` + `setSize(res)` 直写
  ⇒ 后备缓冲恒 = `res`（结果头 `offscreen_target=fbo:1600x1063` 自证）。
- **什么情况下会被 DPR 放大**（即"尺寸 + DPR"两者叠加）：
  - `mode=view` 且不传 `viewres=`：走 `bench-view.ts:646-663 _applyPixelRatio()` —— `want = ?dpr 或 devicePixelRatio`，然后**夹取**：单边 ≤ `min(MAX_TEXTURE_SIZE, MAX_RENDERBUFFER_SIZE, 4096)`、**总像素 ≤ 4.2 Mpx**。
    dpr=3.6 / CSS 401×881 的手机上，朴素值是 **1444×3172**（≈4.58 Mpx，比 1600×1063 多 **2.7×** 像素），会被 4.2 Mpx 夹小。
  - `demo.ts`（浏览页）：默认 `pixelRatio = devicePixelRatio`（`demo.ts:421-424`），且**没有** 4.2 Mpx 夹取 ⇒ 页面后备缓冲 = CSS × 3.6。
  - 任何没调 `disableAutoResize()` 的用法（浏览器一 resize 就重算 CSS×DPR）。
- **"1600×3.6 = 5760×3827" 这一档**只有在「**画布 CSS 视口本身是 1600×1063** 且 DPR=3.6」时才会出现（宽 CSS 视口 × 高 DPR）。
  实际手机上 CSS 只有 ~401 宽 ⇒ 是 **1444×3172** 那一档，不是 5760×3827；且在 `mode=view` 里还会被 4.2 Mpx 夹掉。
  **本文的 bench 离屏链接不会出现任何一种**（`disableAutoResize()+setPixelRatio(1)+setSize(res)`）。
- **为什么必须有**：离屏协议下 `bench-flux.ts:1339` 若 `resolutionMode()!=="forced"` **直接抛错**；主表只收 `res_mode=forced` 的行。

#### 3.3.3 `sync=gputimer` —— 决定"怎么确认 GPU 干完了、FPS 用哪个口径算"

缺省就是它（`bench-shared.ts:474` `param("sync","gputimer")`）。各档**实际行为**（`bench-shared.ts:460-471` + `OffscreenBenchTarget.ts:919-958`）：

| 档 | 逐帧 | run 末 | FPS 口径 |
|---|---|---|---|
| `gputimer` | 插 GPU 计时查询（`EXT_disjoint_timer_query_webgl2`），读**每帧 GPU 真实毫秒** | 排空 | `1000/中位 GPU 毫秒` → **GPU 口径** |
| `each` | 每帧 `gl.finish()` + 1×1 `readPixels` | — | **每帧全同步延迟**（不是吞吐；Gen2 实测 **13.8 fps**） |
| `fence` | 非阻塞栅栏 `fenceSync`+`clientWaitSync(…,0)`（在途上限 3） | 排空 | 受 GPU 反压的吞吐 |
| `batch` | **逐帧零同步** | **一次性** `finish()`+1×1 `readPixels`，计时终点取在**排空之后** | **吞吐口径** |
| `natural` | rAF + 每帧 1×1 `readPixels` | — | 30s 墙钟"体感代理" |
| `none` | 什么都不做 | 什么都不做 | 零仪器基准 |

**回落链**（`bench-offscreen.ts:116-135`）：请求 `gputimer` 但设备**没有**计时扩展 → **自动退到 `batch`**。

**本轮实测**（4 条记录一致）：`offscreen_sync_policy=batch_submit_drain_at_run_end|fallback=gputimer_unavailable->batch`、
`offscreen_gpu_diag=ext=0(name=-,…,null=1)`、`offscreen_fps_source=wall-clock`、`offscreen_gpu_samples=0/0`
⇒ **Adreno 740 拿不到计时扩展 ⇒ 实际按 `batch` 跑，26.1 fps 是"墙钟吞吐"口径**。
若回落到旧的 `each`，同一台 Gen2 只会给出 13.8 fps（每帧全同步延迟），量纲完全不同 —— 所以 `batch` 回落是**必须**的。

#### 3.3.4 `dpr=1`（顺带澄清）

**不改变离屏渲染分辨率**：`bench-case.ts`/`bench-measure.ts` 里**没有读取 `dpr`**（grep 为空）；分辨率由 §3.3.2 的
`setPixelRatio(1)+setSize(res)` 钉死（结果头 `offscreen_target=fbo:1600x1063` 自证）。它主要影响 `mode=view` 的展示画布。
协议里保留它只为跨设备口径自证。

### 3.4 臂开关（决定"跑哪条渲染路径"）

| 开关 | 含义 | 部署臂（FINAL）是否带 |
|---|---|---|
| `shcache=frag` | 方案 B：SH 求值移到**全屏片元遍**，颜色写 RGBA16F 纹理，主 pass 只 `texelFetch` | ✅ |
| `lr=1` | 低秩路径：加载期不做 `C·B` 重建，只打包 rank+DC；生产遍每点 1 次取样 | ✅ |
| `notx=1` | `#define NO_SPLAT_TRANSFORM`：用 uniform `u_splatTransform` 取代逐点变换取样 | ✅ |
| `nocolortx=1` | `#define NO_COLOR_TRANSFORM`：**连声明带采样**去掉颜色变换（生产遍省 4~5 次/点取样） | ✅ |
| `strip_ct=1` | 本轮新增：最终源码上删掉那 2 行声明 | ❌ 默认关 |
| `add_ct_positive=1` | 本轮新增：追加 2 个未使用 sampler（阳性对照） | ❌ 默认关 |
| `debug_shader=1` | 本轮新增：dump 最终源码 + active uniform | ❌ 默认关 |

**部署臂（FINAL）完整口径** = `?shcache=frag&lr=1&notx=1&nocolortx=1`
（`docs/ch7_project_status.md:40`、`docs/ch7_offscreen_batch_20261008.md:132`、`docs/ch6_code_facts.md:3`）

### 3.5 本轮消融基准为什么是"部署臂**去掉** `nocolortx`"

`strip_ct` 测的是"**声明但未采样**的 sampler 值不值钱"。部署臂带 `nocolortx=1` 时这两行根本不在编译产物里，
`strip_ct` 必然空操作 ⇒ 无法回答原问题。因此基准取
**`?shcache=frag&lr=1&notx=1`**（部署臂去掉 `nocolortx`）：此时主 pass 里它们是 **声明 1 / 采样 0**，才是任务书里的 (a) 状态。

---

## 4. 真机消融（Adreno 740 / Snapdragon 8 Gen 2）

- 设备：`Snapdragon 8 Gen 2 (Adreno 740)`，微信 XWEB（`MicroMessenger/8.0.78`），`dpr=3.6`，`screen=401x881`
- 机位：`cam=flux`、`pose_src=flux`、`pose=0.467561,0.035955,0.883327,0,-0.114043,0.993277`（4 条记录**完全一致**）
- `sync=gputimer` 在 4 条记录里**全部回落 batch**（`fallback=gputimer_unavailable->batch`）
- 臂：`A = lr+notx`、`B = A + strip_ct`、`C = A + add_ct_positive`、`deploy-C = lr+notx+nocolortx + add_ct_positive`

| 臂 | u= | round1 | round2 | round3 | 头聚合 (mean±std) | `cpu_ms`/帧 |
|---|---|---|---|---|---|---|
| A（基准） | `ct-A` | 26.1±0.3 | 26.1±0.1 | 26.1±0.1 | **26.1±0.2** | 38.35 / 38.28 / 38.30 |
| B（+删除 2 行声明） | `ct-B` | **33.7±0.4** | 26.1±0.2 | 26.3±0.2 | 28.7±0.3 | **29.70** / 38.38 / 38.04 |
| C（阳性对照 +2 sampler） | `ct-C` | 26.0±0.1 | 26.1±0.2 | 26.1±0.2 | **26.1±0.2** | 38.50 / 38.29 / 38.36 |
| deploy-C（部署臂 +2 sampler） | `deploy-C` | 26.0±0.2 | 26.2±0.2 | 26.0±0.1 | **26.1±0.1** | 38.42 / 38.22 / 38.53 |

所有轮 `ok=1`、`covered=99.8%`、`pose_src=flux`、`drawOk=1`。

### 4.1 异常点判定：B 的第 1 轮

- B-R1 = **33.7 fps**，而其第 2、3 轮（**完全相同**的配置）是 26.1 / 26.3 ⇒ **同配置不同轮结果不一致，R1 必为异常**。
- 该轮 `cpu_ms=29.70 ms/帧`，其余 11 轮全是 `38.2~38.5 ms/帧`（低 22%）⇒ **整机（含 GPU）当时处于更快的频段**，与"删了 2 行死声明"无关。
- 该次加载的头聚合频段标签为 `BANDmid`，其余三次加载为 `BANDslow`
  （`BAND` 是 `bandTag(每帧排空, 45/35 ms)` 的**整次加载聚合**标签，见 `bench-clearprobe.test.ts:119-123`；每文件只在第 49 行出现一次）。
- ⇒ **该轮作废**（它是设备频段瞬变，而不是被测改动）。

### 4.2 判定（套用任务书规则：B/A ≥ +2% 且 > 2×组内 std 且 3 轮方向一致）

| 检验 | 结果 |
|---|---|
| B 第 1 轮 vs A | +29.1%（但见 4.1，作废） |
| B 第 2/3 轮 vs A | +0.0% / +0.8%（组内 std 0.1~0.3，**落在噪声内**） |
| **方向一致性** | ❌ 不一致（一轮快、两轮平）⇒ **不满足** |
| **阳性对照 C vs A** | 26.0/26.1/26.1 vs 26.1/26.1/26.1 ⇒ **无效应** ⇒ 该设备对"未使用 sampler 数量" **不敏感** |
| 部署臂 `deploy-C` vs A | 26.1 vs 26.1 ⇒ 同一水位 |

**⇒ 结论：`strip_ct` 无可测收益（噪声内），且阳性对照证明本设备对未使用 sampler 数量不敏感。**

---

## 5. 结论与建议

| 问题 | 答案 | 依据 |
|---|---|---|
| 部署臂上这两个 sampler 影响 FPS 吗？ | **不影响**（它们已被 `nocolortx` 在预处理阶段排除，不在编译产物里） | §1；`strip_ct=1` 在部署臂下 uniform 列表逐项不变 |
| "声明但未采样"的配置里，删掉它们有收益吗？ | **没有**（26.1 → 26.1/26.3，噪声内；阳性对照无效应） | §4 |
| 该不该改代码去删？ | **不建议**。保持 `strip_ct` 默认关；模板那 2 行**不动** | §1 硬约束 + §4 数据 |
| 该不该动部署臂的 `nocolortx=1`？ | **不动**。它的价值来自去掉**采样**（4~5 次/点），与"删声明"是两件事 | §1 注 |

**可写进论文/报告的一句**：
> 在 Adreno 740 上，对"仅声明、未被采样的采样器"执行声明删除（2 个）与追加（2 个）均无可测帧率影响
> （26.1 fps 基准；删除 26.1/26.3、追加 26.0/26.1，组内 std ≤0.3）；部署配置下这两个采样器已被
> `nocolortx` 从编译产物中排除，故对部署臂帧率无影响。

---

## 6. 已知局限与复跑建议

1. **没有交错跑**：本轮按 A→B→C→deploy-C 顺序跑，B 正好落在设备"更快频段"（`BANDmid`）⇒ 出现一个 33.7 的异常轮。
   严格做法是 **ABABAB 交错**（同时间窗内两臂交替），让两臂采样到相同的频段混合。建议复跑时：
   `A, B, A, B, A, B`（各 3 轮）后再判定。
2. **单场景（garden）**：结论只覆盖 garden（610k 点）。若要写"设备级"结论，至少补 1 个不同点数/可见性的场景
   （如 truck/train），确认不是场景特异。
3. **未做颜色正确性闸门（PSNR/SSIM）**：本轮只看了 `ok=1` / `covered=99.8%`（几何口径）。
   由于被测改动只删"未被引用的声明"、不触碰采样逻辑，编译产物应完全一致；若要写进论文，仍建议用
   `?framedump=1` + `tools/compare_images.py` 出一次 PSNR/SSIM（期望 ∞ / 位级一致）。
4. **`sync` 口径**：真机 `gputimer` 不可用 ⇒ 实际是 `batch`；实验报告里应写实际生效的口径（结果头已自证）。

---

## 7. 本轮产物清单

| 文件 | 内容 |
|---|---|
| `src/renderers/webgl/programs/RenderProgram.ts` | 新增 `?strip_ct=1` / `?add_ct_positive=1` / `?debug_shader=1` 与断言；模板未动 |
| `src/renderers/webgl/programs/ShaderProgram.ts` | `strip_ct=1` 时把编译/链接失败升级为抛错（`undeclared identifier` 兜底） |
| `tools/ch7_strip_ct_analyze.mjs` | 抽取**真实**模板 + 复用 `sliceShaderSource` 语义 + 宏展开后统计"声明/采样" |
| `_tmp_ch7probe/strip_ct_links_min.mjs` | 生成最少一组 A/B/C 链接（`rounds=3`） |
| `_tmp_ch7probe/parse_stripct.mjs` / `parse_stripct_detail.mjs` / `parse_stripct_band.mjs` | 解析回传 txt → 表格/逐轮细节/频段标签 |
| `thesis_project/data/ch7_measurements/raw/stripct_20261010_1410*.txt`（4 个） | 真机原始证据（A/B/C/deploy-C） |
| `gsplat.js/_strip_ct_analyze.out` | 静态矩阵输出 |
| `_tmp_ch7probe/out/strip_ct_links_min.txt` | 本轮链接清单 |

---

## 附录 A. 对账：P0 批次 2「本文臂 FINAL vs Flux 臂」这一对是否公平

证据文件（同一台 Gen3、同会话，相隔 3 分 45 秒）：
`thesis_project/data/ch7_measurements/raw/helper01c2_20261007_130358.txt`（本文臂）
`thesis_project/data/ch7_measurements/raw/helper01f2_20261007_130743.txt`（Flux 臂）

| # | 维度 | 本文臂（`bench.html`） | Flux 臂（`bench-flux.html`） | 判定 |
|---|---|---|---|---|
| 1 | 设备/内核 | Snapdragon 8 Gen 3 / Adreno 750 / 微信 XWEB，`dpr=3.15`、`screen=400x889` | **逐字相同** | ✅ |
| 2 | 协议内核 | `benchmode=offscreen-paper-match` + `OffscreenBenchTarget` | **同一个类**（`src/renderers/webgl/utils/OffscreenBenchTarget.ts`，两臂共用） | ✅ |
| 3 | 分辨率 | `res_mode=forced`、`res=1600x1063`、`offscreen_target=fbo:1600x1063` | 同（它自己写 `force=res(1600x1063)`） | ✅ 同像素量 |
| 4 | 帧驱动 | `driver=msgchannel`（不挂 rAF、不吃 setTimeout 钳制） | 同 | ✅ |
| 5 | 计时口径 | `sync=gputimer` → **回落** `batch_submit_drain_at_run_end\|fallback=gputimer_unavailable->batch`；`offscreen_fps_source=wall-clock`；`ext=0(null=1)` | **完全相同**（同回落、同 wall-clock、同 ext=0） | ✅ **这条最关键，两边同口径** |
| 6 | FPS 定义 | `fps_def=first_frame_end_to_last_frame_end` / `cpu_def` / `frame_def` 同名字段（共用 `throughputFields`） | 同 | ✅ |
| 7 | 采样量 | `frames=20`、`offscreen_runs=5`、`offscreen_frames_per_run=20`、`warmup=20`、`rounds=3`、`cold=1` | 同 | ✅ |
| 8 | 场景/点数 | truck **273169** / train **287304** | **完全相同**（273169 / 287304） | ✅ 几何工作量一致 |
| 9 | 取景 | `covered=100.0%` | `covered=100.0%` | ✅ 可比性判据通过 |
| 10 | 机位 | `pose_src=flux` + 逐轮 `pose=0.467561,0.035955,0.883327,0,-0.114043,0.993277` | `pose_src=flux` + `pose=0.47,0.04,0.88,0,-0.11,0.99`（**只打 2 位**） | ✅ 数值一致（0.46756→0.47、0.03596→0.04、0.88333→0.88、−0.11404→−0.11、0.99328→0.99） |
| 11 | 设备频段 | `BANDfast`、`TK16` | `BANDfast`、`TK16` | ✅ 同频段、同时段 |
| 12 | 每臂开关 | `shcache=frag&lr=1&notx=1&nocolortx=1`（本仓库自研优化） | 无（Flux 自己的渲染器不认这些参数） | ✅ 按"每臂各跑自己实现的路径"（归属正确，见 `ch7_offscreen_batch_20261008.md` §7） |

**需要写进表注的三点（不算"不公平"，但必须声明）**：

1. **模型/格式不同**：本文臂 = r7 QPLY（truck **6.56 MB** / train **6.90 MB**）；Flux 臂 = 其自有压缩格式（truck **2.85 MB** / train **3.00 MB**）。
   **点数相同、集合相同，但每点载荷与格式不同** ⇒ 只能表述为"两套系统各自实现路径的端到端对比"，**不可**表述为"同格式对比"。
2. **加载耗时不在同一量级**：本文臂 `first_frame_ms≈1.9 s`；Flux 臂 `decode_ms≈24.6 s`、`first_frame_ms≈24.6 s`。
   它**不在 FPS 计帧窗口内**（窗口在预热之后），但必须与 FPS 分开列（加载期属表 7-5）。
3. **`sync=batch` 这一选择本身系统性有利于 Flux**（详见附录 A.1）。

### 附录 A.1 为什么 `batch` 相对有利于 Flux

**先对齐两个口径的时序定义**（`bench-shared.ts:467-470` + `OffscreenBenchTarget.ts:919-958`）：

| 口径 | 逐帧 | run 末 | 计时窗口覆盖什么 |
|---|---|---|---|
| `batch`（本例两臂实际生效） | **零同步**：不 `finish()`、不 `readPixels`、不插栅栏 | **一次性** `gl.finish()`+1×1 `readPixels` 排空，且**计时终点 `t1` 取在排空之后**（`timingEndAfterDrain=(gate.mode==="batch")`） | "本轮提交的全部 GPU 工作真正落地"的总时长（受 GPU 反压的**吞吐**）——**但窗口内 CPU 不被逐帧阻塞** |
| `natural`（对照口径，非论文口径） | 每帧 `gl.finish()`+1×1 `readPixels`（rAF） | — | 每帧都强制 **CPU↔GPU 串行** |

⇒ 差别只有一条：**`batch` 允许 CPU 领先 GPU 若干帧提交 ⇒ CPU 侧成本能被 GPU 执行时间"吸收"；`natural` 不允许。**

**为什么这会偏向 Flux**（数字来自 `docs/ch7_external_protocol_validation.md` §4/§7.2，同链接同设备，手机 1.70 Mpx、garden）：

| 事实 | 值 | 出处 |
|---|---|---|
| 两臂都在"画全部点"，点数 ours 610k、flux **739.4k**（ours 反而少 17%） | — | §7.2 |
| 但每帧耗时 ours 是 flux 的 **1.95×（natural）/ 3.7×（batch）** | ⇒ 差距**不在点数**，而在**每点/每像素着色成本** | §7.2 |
| ours 每点读 6 个 SH 纹素 + 变换/颜色变换取样；flux 只读 3 个、且把变换烘焙进几何 | ⇒ **ours GPU 受限；flux 每帧 GPU 很轻** | §3/§6 |
| GPU 轻 ⇒ flux 的帧预算里 **CPU 侧（worker 排序 + 每帧索引上传）占比相对大** | — | — |

于是：
- `batch` 下 flux 的 CPU 排序/提交**完全重叠**进 GPU 时间 ⇒ **57.2 fps**；
- `natural` 下每帧强制串行 ⇒ flux 的 CPU 排序被暴露 ⇒ **27.9 fps**（帧时 17.5→35.8 ms，**+105%**）；
- ours 两口径几乎不变 ⇒ **15.5 → 14.3 fps**（帧时 +8.2%），因为本来就在等 GPU。
- ⇒ **换口径把 flux/ours 从 3.70× 拉到 1.95×**；差异几乎全部来自"Flux 的 CPU 排序在 `natural` 下被暴露"。

**这不等于 `batch` 是坏口径**（§8.1 已定案）：
- 论文 p.12 §5.1 明写 "breaks the screen display **120 FPS limit**" ⇒ 报出的 147/132 FPS **不可能**由绑 vsync 的驱动测出 ⇒ 论文口径**必须**脱离屏幕刷新节流；
- 官方 WebGL viewer 用 rAF（受 vsync）⇒ 论文的 FPS **不是**用它测的，而是"离屏 + 非 vsync + 多 run 平均" ⇒ **`batch` 与论文口径同族，`natural` 是另一种口径**（体感代理，不进主表）。
- ⇒ 正确做法：**主表用 `batch`（两臂同口径）+ 表注声明"该口径允许 CPU/GPU 重叠，相对有利于 CPU 侧占比较高的实现" + 配对给出 `natural`/`sync=none` 作为稳健性与局限性区间 [1.95×, 3.70×]**；不得用 `natural` 的 1.95× 去"修正" 3.70×。
- ⚠ 另注：`+8.2% / +105%` 这两个数是**以 `batch` 为基准**算出的；文档 §7.1 计划改用 `sync=none`（零仪器，rAF、不做任何 GL 侧同步/查询/排空）重算仪器净开销 ⇒ 该拆分的最终表述**待那次 A/B 采数后才能定**。

> 与本轮 `strip_ct` 消融的关系：那次是**我们内部的 A/B/C**（同一实现、同一口径），**不涉及 Flux**，因此"batch 利于 flux"这一问题**不出现**；它只在"本文臂 vs Flux 臂"的跨系统对比里才需要声明。

**两个"核对方式"上的坑**：

- Flux 臂的 `pose_src=flux` 只是 `param("pose","flux")` 的**回显**（`bench-flux.ts:1731`），**不是**"相机确实应用了"的证据；
  本文臂的 `pose_src` 是**实测**（`base.poseSrc = ctx.cameraLocked ? "flux" : "auto"`，`bench-measure.ts:1661`）。
  ⇒ 跨臂对齐**必须比 `pose=` 指纹**，不能比 `pose_src` 字段。本对账已做（第 10 行）。
- Flux 臂逐轮带 `downsample=0.3175`（= 它自算的 `1/dpr`）。已验证**不影响实际画布**：逐轮 `res=1600x1063`、
  离屏 note 里 `PVP1600,1063`、`u_viewport` 同值 ⇒ 实际光栅化像素就是 1600×1063。

**结论**：这一对**在协议层面是公平的**（同设备、同分辨率/像素量、同点数、同机位、同驱动、同计时口径、同频段、同会话），
差异只来自"两套系统各自的实现路径 + 各自的模型格式"；表注必须写明模型体积/格式不同、加载耗时不同、以及 `batch` 口径对 Flux 相对有利。



