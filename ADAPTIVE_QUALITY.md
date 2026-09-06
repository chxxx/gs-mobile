# WebGL 3DGS 设备自适应质量（Adaptive Quality）设计

> 针对本项目（splat-shq 渲染器）移动端 / 桌面端统一的自适应质量控制器设计稿。
> 相关代码钩子：`RenderProgram.maxSplatSize`、`__PERF__.setResolutionScale()`、`PerfDebug` 帧计时。

## 1. 目标与约束

1. **保帧优先**：用户可感知的"卡"＝帧间隔超预算；策略目标是一段时间内的帧达标率（而非平均帧率）。
2. **视觉代价按可感知度排序**：改 `maxSplatSize`（只裁剪 >阈值的巨高斯外尾）几乎无感 < 降低渲染分辨率（全局糊一点）< 砍点数（结构损失）。因此**降级顺序必须固定为：先动 cap → 再动渲染倍率 → 最后（可选）动点数**。
3. **满足"默认不主动降分辨率"的诉求**：只有 cap 已压到下限仍不达标时，才允许触碰渲染倍率（DPR），且倍率走小步长。
4. **控制开销必须极小**：评估周期 0.5~1s，不在逐帧路径上做任何排序/判定。
5. **不振荡**：升降都要滞回窗口；升档不得因"刚好顶满刷新率"而误判有余量。

## 2. 对你所提议阶梯的客观评价

提议语义：

| 档 | maxSplatSize | 渲染倍率 | 含义 |
|---|---|---|---|
| 好 | 不限（1024） | 物理 DPR | 全画质 |
| 中 | 256 | 物理 DPR | 压 overdraw |
| 差 | 256 | DPR→2 | 压 overdraw + 降分辨率 |

**优点**
- 方向正确：cap 是实测有效的第一优先降级轴（scale6 掉帧→流畅）；分辨率最后动，符合直觉。
- 只含 2 个正交参数，好解释、好写论文、好 A/B。

**客观问题**
1. **档间跳变过大**：中→差 直接让像素从 4.33M→1.08M（4 倍差），`canvas.resize` 会重建全部纹理，那一帧必卡；且中间缺少"cap 已尽、只降一点点倍率"的过渡态。
2. **缺测量闭环**：设备好坏是**运行态**问题（温控降频、电池模式、场景点数、视野内可见复杂度都动态变化）。静态定档要么过保守（浪费好设备），要么在负载突增时掉帧。
3. **缺场景规模维**：280K 点的"差档"用在 610K 点或 1M 点场景可能仍不够，需要档位能随 `N`（总点数/可见点数）下移。
4. **缺刷新率感知**：60Hz 预算 16.7ms，120Hz 预算 8.3ms——同一档在不同高刷屏上含义不同。
5. **缺运动态**：旋转相机时（排序+上传+overdraw 升高）与静止时的承受力不同；运动时人眼对细节不敏感，适合"瞬态低档、静止回档"。
6. **"差档"应开放继续降**：例如 cap 可到 128/96，渲染倍率可到 DPR1.5/1.25，而不是止步于 DPR2。

**结论**：你的阶梯可作为"手动静态预设"，但更稳的做法是保留这三个档为**用户偏好锚点**，在其上套一个按实测帧时间自动在相邻档内微调的控制环（见 §4）。

## 3. 生态调研小结（2026）

| 项目 | 相关机制 | 是否有自适应质量 |
|---|---|---|
| antimatter15/splat | CPU worker 排序节流（~4fps），无 DPR 控制 | 无 |
| mkkellogg/GaussianSplats3D | 八叉树剔除、WASM SIMD 排序；项目已停更、自述移动端性能欠佳 | 无 DRS |
| dylanebert/gsplat.js | 无性能自适应 API | 无 |
| sparkjsdev/spark | 活跃开发（THREE 生态），LOD/材质等高级特性 | 未见公开 DRS 文档 |
| 游戏引擎 DRS / three.js `adaptive-dpr` 类 | 按上一帧渲染耗时/`getRenderInfo` 闭环缩放 pixelRatio | 是（参考范式） |

结论：**没有可直接抄的 3DGS 专用自适应方案**；建议按"游戏 DRS 测量闭环 + 3DGS 特有 cap 轴"自行组合。

## 4. 推荐策略：双轴分层贪心 + 测量闭环

### 4.1 可调轴（按降级优先级排列）

| 轴 | 参数 | 改变代价 | 视觉代价 | 触发优先级 |
|---|---|---|---|---|
| A 巨高斯 cap | `maxSplatSize` | 极低（一次 uniform1f，逐帧生效） | 仅 >cap 的巨高斯外尾被裁 | 1（最优先） |
| B 渲染倍率 | `pixelScale = DPR × dprFactor` | 高（canvas resize → 重建纹理，一帧卡） | 全局变糊 | 2（cap 用尽后） |
| C 点数/LOD（预留） | 未来：子采样/稀疏加载 | 高（需重新上传索引） | 结构损失 | 3 |
| D 排序频率（运动轴） | 运动中隔帧全排 | 低 | 运动帧序旧、瞬态伪影 | 仅运动期 |

### 4.2 参数阶梯（连续可切）

```
capLadder     = [1024, 640, 384, 256, 160, 96]        // px
dprLadder     = [1.0, 0.85, 0.7, 0.55]                // ×devicePixelRatio，不再放大
降级顺序：先沿 capLadder 下行；到 96 仍不达标，才走 dprLadder；
满足后回档时反序（先回 dpr，再回 cap）。
```

你的三档语义映射到本阶梯（作为用户预设锚点）：
- "好/默认"：cap=1024（或视画质验证结果保留 256 作为新默认），dprFactor=1.0；
- "中"：cap=256，dprFactor=1.0 —— **与你的方案一致**；
- "差"：cap=160，dprFactor=0.55（≈DPR2）—— 并把"更差"继续开放到 cap=96 / dprFactor=0.5。

> 说明：cap=256 是实测证明代价最小的第一阶；因此**建议默认就从 cap=256 起步**（保留 ?splatPx=1024 可回到全画质），把它当作新的"默认档"，而不是"降级档"。

### 4.3 测量信号（每 0.5~1s 评估一次，非逐帧）

- `frameMsAvg`：近 0.5s 内帧间隔的 EMA（复用现有 rAF 计时，不另起开销）。
- `frameMsP95`：近 1s 的 P95，捕捉偶发抖动。
- `droppedFrames`：超预算帧计数（预算 = 1000 / 显示刷新率，取安全系数 0.9）。
- `refreshHz`：由 rAF 长时中值估计（60/90/120）。
- `splatCount N`：当前场景总点数（加载后一次）。
- `gpuTimer`（仅桌面，可选）：用于升级试探的"真实余量"判据。

### 4.4 状态机

```
[INIT] 加载完成：
   档位 = 用户预设（URL/设置）或 默认档(cap=256, dpr=1.0)
   进入 [MEASURE]（2s 预热，期间不调档）

[STEADY] 每评估窗：
   if 帧达标率<90% 且 frameMsAvg>预算×1.15 → 降一档（先 cap，见 4.1）
       进入 [DOWN_LOCK]（2s 内不再降，防抖；每窗至多降一档）
   else if 连续 Y 个窗口 帧达标率≥99% 且 frameMsAvg<预算×0.55
       且处于"可升"状态 → 尝试升一档（乐观试探，见下）

[UPGRADE PROBE]（默认关闭；?adaptive=aggressive 打开）
   升一档后观察 2 个窗口：
   若仍达标 → 保留并继续试探
   若掉帧 → 立即回退一档并进入 [UPGRADE_COOLDOWN]（60s 内不再升）

[EVENT RE-EVAL]
   相机大幅瞬移/场景切换/新场景加载/电池或窗口模式变化检测 → 回到 [INIT] 重测
```

**为什么默认不允许自动升档**：手机/桌面在 rAF 恰好顶满刷新率（如 60/165）时，**无法观测到真实 GPU 余量**——"满帧"既可能因为刚好够，也可能因为余量很大。此时自动升档会误判。所以自动升档只走"试探+回滚"，且默认关闭；保守策略是：升档只在重新加载/场景切换时重新评估，或用桌面 GPU timer 得到客观余量再升。

### 4.5 运动瞬态（可选增强）

- 检测到相机连续运动（视角在动）且当前档位已低于"默认"时，可再压一级 cap（如 256→160），同时**排序频率降半**（对应此前"运动中排序优化"讨论）；
- 相机静止 1s 后回到 [STEADY] 档位。
- 依据：运动期人眼对细节与透明伪影不敏感，且运动期每帧确有排序+上传+overdraw 附加成本。

### 4.6 伪码

```
state = { cap: 256, dprFactor: 1.0, downgradeLockUntil: 0, probeCooldownUntil: 0 }

onEvaluateWindow(now):
    budget = 0.9 * 1000 / refreshHz
    avgMs, p95Ms, hitRate = readMetrics(0.5s)

    if now < state.downgradeLockUntil: return
    if avgMs > budget * 1.15 and hitRate < 0.90:
        next = nextLower(state)          // 先 capLadder，后 dprLadder
        if next != state:
            applyQuality(next)           // cap: maxSplatSize=n；dpr: setResolutionScaleByDprFactor(f)
            state = next
            state.downgradeLockUntil = now + 2000
        return

    if adaptiveAggressive and now > state.probeCooldownUntil:
        if avgMs < budget * 0.55 and hitRate >= 0.99 for ≥3 windows:
            next = nextHigher(state)     // 反序：先 dpr，后 cap
            applyQuality(next)
            probeUntil = now + 2000       // 下两个窗口观察
            if metricsAfterProbe stillOk: keep
            else: revert(state) + probeCooldownUntil = now + 60000

onCameraMoveIntensityChange(intensity):
    if intensity > moving and state.cap > 96:  // 运动瞬态
        applyQuality({ cap: min(cap, 160), ... })
    if idle for 1000ms:
        returnToSteadyPreset(state)
```

### 4.7 实现落点（复用现有钩子）

| 组件 | 作用 |
|---|---|
| `demo.ts`/新模块 `QualityController.ts` | 状态机、评估窗、档位表、URL 参数 |
| `RenderProgram.maxSplatSize` setter | 轴 A 应用（已存在，uniform1f 即时生效） |
| `__PERF__.setResolutionScale` / `renderer.setPixelRatio` | 轴 B 应用（已存在；改走小步长 dprFactor） |
| `PerfDebug` / rAF 计时 | 帧间隔 EMA/P95（已存在） |
| URL：`?quality=best/mid/save`、`?adaptive=off/on/aggressive`、`?maxdpr=2` | 用户/部署层覆盖 |

## 5. 默认参数建议

```
// 现状（cap 默认不启用）：
base = { cap: 1024(不裁剪), dprFactor: 1.0 }
启用 cap 需显式 ?splatPx=n / __PERF__.setMaxSplatSize(n)，用于 A/B 与未来自适应控制器。
评估窗 500ms；降档锁 2s；升级试探默认关闭
```

## 6. 验证协议

| 实验 | 内容 | 判读 |
|---|---|---|
| A. 全画质 vs 默认 | `?quality=good` vs 默认，手机 scale4 静止 10s | 记录 fps/目测截图 |
| B. 负载阶梯 | truck(280K) 与更大场景(610K)+garden 对比 | 档位是否按 N 正确下落 |
| C. 抖动测试 | 让相机做正弦摆动 20s，观察档位变化次数与帧达标率 | 应 ≤2 次档变/10s，达标率升 |
| D. 试探开关 | `?adaptive=aggressive` 冷启动后 60s 档位收敛轨迹 | 无振荡、无反复横跳 |
| E. 论文画面 | 用 good 档出基准图，用默认档出移动端图 | 记录 maxSplat=256 对 PSNR/SSIM 影响 |

### 6.1 快速执行手册（good = cap1024 vs default = cap256）

**A/B 帧率（手机，同会话、静止）**
1. 刷新 `?perf=1`（默认 cap=256），静止 5s 记 rAF；控制台执行 `__PERF__.scanResolution([4], 5)` 记表。
2. `__PERF__.setMaxSplatSize(1024)` 切 good 档，再跑一次 `__PERF__.scanResolution([4], 5)` 记表。
3. 对比 scale=4 两档 fps；必要时可加到 scale=6 拉开差距。

**A/E 画质（桌面优先，视角必须完全不动）**
1. 刷新 `?perf=1`（默认 cap=256），摆一个信息量大的视角（含近处大高斯/高光/透明处）。
2. `__PERF__.captureFrame("cap256")` → 浏览器自动下载 `cap256_*.png`；等 2~3 秒。
3. `__PERF__.setMaxSplatSize(1024)`，再等 2~3 秒，`__PERF__.captureFrame("cap1024")` → 下载 `cap1024_*.png`。
4. 注意：两次截图之间**不要移动相机/窗口/画布尺寸**；画布会随 DPR 自动缩放，确认 console 打印的 Render resolution 两次一致。
5. 离线比较：
   ```bash
   python tools/compare_images.py cap256_*.png cap1024_*.png
   ```
6. 判读阈值：PSNR ≥ 45dB → 可放心保留 cap=256；35~45dB → 结合肉眼判断；<35dB → 谨慎采用。
7. 若画面有明显差异区域，再用图片编辑器做 difference/叠加查看差异集中在哪（预期只在近距超大高斯扩散尾）。

## 7. 风险与局限

1. rAF 顶满刷新率时无法观测 GPU 余量 ⇒ 自动升档默认关闭（见 4.4）。
2. `canvas.resize`（dpr 轴）每帧都伴随一瞬重建 → 必须低频、小步长、且不在运动高峰切换。
3. cap 只治理 fill 长尾；若瓶颈是"可见点数本身"（顶点/实例），需要轴 C（点数/LOD），本文未展开，属下一阶段。
4. 手机 WebGL 无 GPU timer，无法精确分离 CPU/GPU；本方案以"帧间隔实测"为唯一真相源，够用且稳。
5. 多 splat / 多对象场景下 maxSplat/scale 的联动阈值需按 N 归一化后测试。

## 8. 结论建议

- 采纳"默认 cap=256、物理 DPR"作为新默认档（与实测一致，视觉代价最小）；
- 在你三档基础上**加闭环微调与连续阶梯**，避免"档间 4 倍像素跳变"和"60fps 满帧误判余量"两个坑；
- 实现优先级：① QualityController（cap+按帧回落，默认 adaptive=off）→ ② dprFactor 小步降 → ③ 运动瞬态；点数轴 C 待 LOD 需求出现再做。

## 9. 与主流一致：按 splat 数量切换渲染倍率（flux-gs / MEGS-2 对照）

主流移动端渲染（flux-gs `render_shared/main.js`、MEGS-2）的做法不是"按设备档位"，而是**按场景点数切换画布分辨率**：

```js
// flux-gs / MEGS-2 原文语义：
const downsample = splatData.length / rowLength > 500000 ? 1 : 1 / devicePixelRatio;
canvas.width  = Math.round(innerWidth  / downsample);   // 点数>500k → CSS 1x
canvas.height = Math.round(innerHeight / downsample);   // 点数≤500k → 物理 DPR
```

等价映射到本项目（canvas = CSS × pixelRatio）：

| 场景点数 N | flux/MEGS-2 画布 | 本项目 pixelRatio |
|---|---|---|
| N ≤ 500,000 | 物理分辨率（×DPR） | `window.devicePixelRatio` |
| N > 500,000 | CSS 1x（不乘 DPR） | `1` |

### 本项目落点（已实现，`demo.ts`）

```ts
const SPLAT_COUNT_RES_THRESHOLD = 500000;      // 可被 ?nthresh=<n> 覆盖
function resolutionPolicyPixelRatio(vertexCount) {
    // ?dpr=<n> 手动覆盖优先级最高；
    // 否则 vertexCount > 500000 ? 1 : devicePixelRatio
}
// 加载完成后由 adjustPixelRatio() 调用，等价于 flux 在解析完数据后设 canvas 尺寸
```

### 与 flux 的差异 / 注意

1. **触发时机**：flux 在数据解析后一次性设 canvas；本项目 `adjustPixelRatio()` 在每个场景加载后调用一次，语义一致。动态改点数（编辑器）需重新触发。
2. **阈值写死 500k 是他们的设备结论**：我们的实测表明"低端手机 280K @ DPR4 已掉到 47fps"——同样的 500k 一刀切在更弱的设备上并不够。因此：
   - 完全复刻：直接使用 500k 默认；
   - 保守做法：部署时用 `?nthresh=` 或设备自适应控制器把阈值下调（例如 250k 起步），即让"点数阈值"成为可配置的轴，与 §4 的分层降级（先 cap → 后倍率）一起参与决策。
3. **它与 cap 的关系**：flux 只做分辨率一刀切，没有 cap。我们的实测说明：近景大高斯（cap 不可用）与点数规模（适合用此阈值策略）是两个独立维度——**点数阈值管"人多时整体降采样"，cap 管"个别巨型高斯的 fill 尾"**，两者可叠加但都默认关闭、按需启用。

