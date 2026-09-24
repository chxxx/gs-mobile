# 部署与线上验证（GitHub Pages）

> 线上地址：<https://chxxx.github.io/gs-mobile/>
> 本文只记录两件事：**线上当前是什么状态**、**怎么自己复验**。
> 部署链路的原理、`git remote` 约定与日常「改代码 → 自动部署」流程见 [部署使用说明.md](../部署使用说明.md)，本文不重复。

---

## 1. 线上状态一览（2026-09-24 实测）

| 项 | 值 |
| -- | -- |
| 站点 URL | <https://chxxx.github.io/gs-mobile/>（HTTP 200） |
| 托管方式 | GitHub Pages，Source = `pages` 分支根目录 |
| 源码分支 | `cleanup/resume-prep`（当前开发分支）/ `main` |
| 自动部署 | `.github/workflows/deploy-pages.yml`：push → `npm ci` → `npm run site:build` → 把 `site-dist/` 强推为 `pages` 的一次性提交 |
| 站点构建配置 | `vite.site.config.js`（`base: './'`，产物 `site-dist/`，静态复制 `scenes/`、`scenes.json` 与各 bench 清单） |
| 演示页 JS 包 | `assets/index-DNw9vmHu.js`（11 kB / gzip 4.7 kB）；本地 `npm run site:build` 产物哈希与之**完全一致** |
| 最近一次部署 | commit `ea3e4f1`（`demo: add ?scene= deep-link preset …`）→ 工作流 run #26 成功后，线上即引用该包 |
| 场景清单 | `scenes.json`（3 个 r7 低秩 QPLY 场景） |

### 场景文件体积（决定首帧快慢的直接因素）

| 场景 | 文件 | 大小 |
| ---- | ---- | ---- |
| Truck (r7 QPLY) | `scenes/point_cloud_quantised_half_r7-truck.ply` | **6.3 MB**（6,564,642 B）← 最适合做"点开即看"的直达演示 |
| DrJohnson (r7 QPLY) | `scenes/point_cloud_quantised_half_r7-drjohnson.ply` | 9.9 MB（10,376,586 B） |
| Garden (r7 QPLY) | `scenes/point_cloud_quantised_half_r7-garden.ply` | 14.0 MB（14,648,586 B） |

> `scenes/` 目录下还有 bicycle / bonsai / counter / kitchen / playroom / room / stump / train / treehill 等模型，
> 但它们不在 `scenes.json` 里，页面下拉框不会显示。

---

## 2. 验证证据（2026-09-24，本机 Edge headless + RTX 4060 Laptop）

全部由 `tools/verify_demo.mjs` 自动完成（真实浏览器打开真实 URL、模拟用户操作、截图后按像素统计）：

| # | 运行 | 场景 | 首帧 | `.ply` 下载耗时 | 画面非黑 / 高亮占比 | 拖动前后画面差异 |
| - | ---- | ---- | ---- | --------------- | ------------------- | ---------------- |
| 1 | 线上 · 桌面 | DrJohnson 9.9 MB | 10.652 s | 10.42 s | 0.9999 / 0.1557 | 31.13 |
| 2 | 线上 · 手机模拟（390×844，DPR 3，Android UA） | Truck 6.3 MB | 2.396 s | 2.24 s | 0.9938 / 0.3716 | 41.28（触摸） |
| 3 | 本地构建冒烟 · `?scene=truck` 直达 | Truck 6.3 MB | 0.220 s | 0.025 s | 0.9907 / 0.3592 | 42.72 |
| 4 | 线上 · 桌面 · Truck | Truck 6.3 MB | 2.987 s | 2.26 s | 0.9907 / 0.3592 | 42.72 |
| 5 | 本地构建 · 下拉框选 Truck（脚本重构后的回归） | Truck 6.3 MB | 0.237 s | 0.075 s | 0.9907 / 0.3592 | 42.72 |
| 6 | **线上 · `?scene=truck` 直达（部署完成后复验）** | Truck 6.3 MB | 2.378 s | 2.20 s | 0.9907 / 0.3592 | 42.72 |

原始报告与截图：`_verify/live-desktop.json`、`_verify/live-mobile.json`、`_verify/live-desktop-truck.json`、
`_verify/local-scene-param.json`、`_verify/local-dropdown.json`、`_verify/live-scene-param.json`
及对应 `*-after-drag.png`（`_verify/` 目录不入库）。

> 运行 #5 是给 `tools/verify_demo.mjs` 新增 `--serve` / `--no-select` 之后，对"下拉框选场景"这条原路径的回归验证：
> 数字与 #3 完全一致（同一场景、同一机位），说明本次改动没有影响原有行为。
> 运行 #6 是**部署完成后**对线上直达链接的复验：`autoSelectedFromUrl: true`、控制台
> `[scene] ?scene= 预选：Truck (r7 QPLY)`、`resourceTimings` 里已是新包 `index-DNw9vmHu.js`。

### 结论

- **能不能跑**：六次运行 WebGL2 均可用（`ANGLE (NVIDIA …)`）；线上桌面与手机模拟都渲染出内容——非黑像素占比 ≈ 99%，
  不存在黑屏或几何爆炸。
- **能不能交互**：拖动（桌面鼠标 / 手机触摸）后画面灰度签名差异 31~43，远大于"几乎静止"的判据（见第 3 节），
  OrbitControls 正常。
- **首帧耗时几乎全是模型下载**：桌面 DrJohnson 首帧 10.652 s 中有 10.42 s 是 `.ply` 网络时间；换成最小的 Truck，
  线上桌面首帧 2.987 s（下载 2.26 s）、手机模拟 2.396 s（下载 2.24 s）；同一个 Truck 在**本机**托管时首帧只要
  0.220~0.237 s（下载 0.03~0.08 s）。首帧 ≈ 下载 + 约 0.15 s 解码/装配。
- **手机端分辨率策略生效**：273169 splats ≤ 500000 → 采用物理 DPR 3.0，渲染分辨率 1170×2532
  （控制台可见 `pixel ratio set to: 3.00 (splat-count policy: 273169 <= 500000 -> physical DPR)`）。
- **唯一网络异常**是站点没有 favicon（`favicon.ico` 404），无害。
- ⚠️ 报告里的 `FPS: 163` 是本机**无头 + 独显**测出来的，**不代表真机手机性能**，不要当结论引用。

---

## 3. 复验工具：`tools/verify_demo.mjs`

无 npm 依赖：只用 Node 内置模块（`node:http` / `node:fs` / `node:zlib`）+ 全局 `fetch`/`WebSocket`
（需 **Node ≥ 21**，本机 v22.16），用本机已装的 Edge/Chrome 无头模式，通过 Chrome DevTools Protocol 遥控页面。

| 参数 | 说明 |
| ---- | ---- |
| `--url=<url>` | 要验证的页面地址（可带查询串）；配合 `--serve` 时可省略 |
| `--scene=<值>` | 模拟用户在下拉框里选场景：文件路径 / 显示名子串 / 1 起序号；缺省选第一个 |
| `--no-select` | **不碰下拉框**，只检查页面是否按 `?scene=` 自己预选并加载（验证直达链接用） |
| `--mobile` | 手机模拟：390×844、DPR 3、Android UA、开启触摸事件 |
| `--serve=<dir>` | 由脚本自带静态服务器托管该目录（如 `site-dist/`），一条命令完成"离线冒烟"，不必另开服务 |
| `--http-port=<n>` | `--serve` 的监听端口（默认 4173） |
| `--out=<png>` | 截图路径（默认 `_verify/demo-desktop.png` / `demo-mobile.png`），拖动后再存一张 `*-after-drag.png` |
| `--wait=<ms>` / `--settle=<ms>` | 等场景加载上限（默认 240000）/ 加载后停留采样（默认 4000） |
| `--port=<n>` | DevTools 端口（默认 9333），并行跑多个实例时需错开 |
| `--browser=<path>` / `--extra-args=<a,b>` | 指定浏览器可执行文件 / 追加给浏览器的启动参数 |

报告 JSON 打到 stdout（进度日志走 stderr），关键字段与判定口径：

| 字段 | 含义 | 判"线上正常"的口径 |
| ---- | ---- | ------------------ |
| `webgl.webgl2` | WebGL2 是否可用 | `true` |
| `firstFrameSeconds` | 控制台 `First Frame: x s` | 与 `plyNetworkMs` 同量级即可（差值 ≈ 解码时间） |
| `screenshot.stats.nonBlackRatio` | 非黑像素占比（阈值 16/255） | `> 0.9`（≈ 0 即黑屏 / 几何爆炸） |
| `screenshot.stats.meanLuma` / `brightRatio` | 平均亮度 / 高亮占比 | 仅作参考，需配合人工看截图 |
| `afterDrag.signatureDiff` | 拖动前后 32×18 灰度签名平均绝对差 | `> 3` 视为"画面确实随交互变化" |
| `networkProblems` | 状态码缺失或 ≥ 400 的请求 | 只允许 `favicon.ico` 404 |
| `pageErrors` / `consoleHighlights` | 控制台错误与关键日志 | 不应出现异常栈 |

---

## 4. `?scene=` 直达链接（已上线）

`demo.ts` 的 `resolvePresetScene()` 支持用 URL 参数直接打开某个场景；**不带参数时行为完全不变**
（访客仍需自己在下拉框选场景，页面不会预先下载任何模型）。

| 写法 | 行为 |
| ---- | ---- |
| `?scene=truck` | 按文件名 / 显示名子串匹配（大小写不敏感），命中 `Truck (r7 QPLY)` |
| `?scene=2` | 下拉框第 2 个可选场景（1 起算，不含占位项） |
| `?scene=scenes/point_cloud_quantised_half_r7-truck.ply` | 直接给相对路径 |
| `?scene=https://…/xxx.ply` | 直接给完整 URL（目标站需允许跨域） |
| `?scene=0` / `?scene=off` | 显式关闭预选 |

例子（把体积最小的 Truck 作为 README 里"点开即看"的链接）：

```text
https://chxxx.github.io/gs-mobile/?scene=truck
```

> 该参数**已随 commit `ea3e4f1` 部署到线上**，并在部署完成后用运行 #6 复验通过
> （`autoSelectedFromUrl: true` + 控制台 `[scene] ?scene= 预选：Truck (r7 QPLY)`）。
> 匹配失败时不会报错，只是回退成"不预选"（缺省行为与加参数前完全一致）。

---

## 5. 复验步骤（照抄即可）

```bash
# 0) 本地按生产方式构建并冒烟（脚本自带静态服务器，进程退出即关，不留后台服务）
npm run site:build
node tools/verify_demo.mjs --serve=site-dist --no-select --url="http://127.0.0.1:4173/?scene=truck"

# 1) 线上桌面复验（默认选第一个场景 = DrJohnson）
node tools/verify_demo.mjs --url=https://chxxx.github.io/gs-mobile/ --scene=truck

# 2) 线上手机模拟复验（触摸拖动 + 390x844 / DPR 3）
node tools/verify_demo.mjs --url=https://chxxx.github.io/gs-mobile/ --scene=truck --mobile

# 3) 只看部署是否成功（不跑浏览器）
curl -sI https://chxxx.github.io/gs-mobile/ | findstr /i "HTTP"
```

产物默认落在 `_verify/`（截图 + JSON 报告）。改版前后各跑一次，对比
`firstFrameSeconds` / `nonBlackRatio` / `signatureDiff` 这三个数字即可判断有没有退化。

---

## 6. 常见现象与排查

| 现象 | 判断 | 处理 |
| ---- | ---- | ---- |
| `nonBlackRatio ≈ 0`（截图全黑） | 模型没加载成功 | 看 `networkProblems`：`scenes.json` / `.ply` 出现 404 多为 `base` 路径问题；跨域被拦则是模型与外链不同源（见 `vite.site.config.js` 里"同源资产"注释） |
| `nonBlackRatio` 正常但 `brightRatio` 极小、`meanLuma` 很低 | 相机贴脸 / 几何爆炸 | 对比 `*-after-drag.png`，必要时换场景或检查相机适配逻辑 |
| `favicon.ico` 404 | 无害（站点没放 favicon） | 可选：在 `index.html` 加 `<link rel="icon" href="data:,">` 消掉 |
| `[SortWorker] 暂不能排序（lock=false allocPending=false …）` | 初始化阶段的一次性告警 | 只要随后出现 `sort: x ms` 并正常出帧即无影响 |
| 首帧十几秒 | 大场景 `.ply` 下载慢 | 用最小的 Truck（6.3 MB），或给 `?scene=truck` 直达链接 |
| `场景加载超时（>240000 ms）` | 页面侧没走完加载流程 | 先人工打开 URL 看是否卡在下载；脚本以 `drop-zone` 被隐藏作为"加载完成"信号 |

---

## 7. 相关文件

| 文件 | 作用 |
| ---- | ---- |
| `.github/workflows/deploy-pages.yml` | 部署流水线（构建 → 强推 `pages`） |
| `vite.site.config.js` | 站点构建配置（产物 `site-dist/`） |
| `scenes.json` / `scenes/` | 演示场景清单与模型 |
| `tools/verify_demo.mjs` | 本文所有验证数据的产生工具 |
| `_verify/` | 验证产物（截图 + JSON 报告，不入库） |
| [部署使用说明.md](../部署使用说明.md) | 部署链路原理、remote 约定、手工触发方式 |
