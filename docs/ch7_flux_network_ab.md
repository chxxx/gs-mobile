# Flux 网络口径 A/B（本地副本 vs 默认 HF）— 供决策，**不预设结论**

> 生成 2026-10-04。依据：`docs/ch7_flux_runtime.md`（13/13 场景运行时实测）与 `_tmp_ch7probe/probe_*` 源码定位。
> 结论：**两个方案都不需要改渲染逻辑**；差别只是"数据从哪取"。

## 事实（实测，非推断）

* Flux 页面的数据基址：`flux-gs-project-gh-pages/render_shared/main.js:1668-1678`
  ```js
  const modelBaseUrl = viewerConfig.modelBaseUrl
        || "https://huggingface.co/datasets/mobile-gs2/mobile-gs2/resolve/main/";
  const url = new URL(params.get("url") || defaultModel, modelBaseUrl);
  ```
  ⇒ **两个可覆盖点**：① 页面 URL 的 `?url=` 查询参数（值可为绝对 URL）；② `window.FLUX_GS_CONFIG.modelBaseUrl`（由 `render_<scene>/main.js` 设置）。
* `render_<scene>/main.js` 只设 `defaultModel`，**没设** `modelBaseUrl` ⇒ 当前默认走 HF。
* 仓库内 `flux-gs-project-gh-pages/scene/<scene>.json`（13 个）与 HF 上的同名文件**字节等价**（garden：本地 7,287,834 B = HF `Content-Length` 7,287,834 B；13/13 实测 HF 传输字节 = 本地大小 + 2.3~3.3 KB HTTP 头）。
* 13/13 场景的**唯一远程请求**就是 HF 的 `<scene>.json`；无 `.wasm`/`xyz.*` 请求（`docs/ch7_flux_runtime.md`）。

## 方案 A（默认：HF 远程）+ 说明

* **改动：零**（就是现在生成链接的方式）。
* 风险/已知问题：
  1. **网络不可控且未记录**：已有真机 Flux 记录的 `fetch_ms` 1,882–61,872 ms（中位 6,390 ms）——同一批里就能差 30×；记录里**没有**带宽/延迟/是否代理字段 ⇒ 加载耗时**无法归因**，也不可复现。
  2. 与本文臂（本地 `scenes/*.ply`，走同一隧道）**不同源**：两臂的网络路径不同 ⇒ 任何"加载/首帧"对比都不是同条件。
  3. 依赖外网可达（HF 在部分网络下会限速/不可达），长跑批次有中断风险。

## 方案 B（本地副本：仅用 `?url=` 覆盖，**不改任何文件**）

* **具体改动（链接级，零文件改动、零渲染逻辑改动）**：在 Flux 链接的页面 URL 上追加
  `&url=<同一隧道下的本地副本绝对 URL>`，例如
  `…/render_garden/index.html?url=https://<隧道域名>/flux-gs-project-gh-pages/scene/garden.json`
  （`new URL(绝对URL, modelBaseUrl)` ⇒ 绝对 URL 直接生效，HF 基址被覆盖）。
* **备选写法（要改文件的版本，供对比）**：在 `render_<scene>/main.js` 里把
  `window.FLUX_GS_CONFIG = { defaultModel: "garden.json" }` 改成
  `{ defaultModel: "garden.json", modelBaseUrl: new URL("../scene/", location.href).href }`
  ⇒ 需改 13 个 `main.js`（各一行），**不推荐**（违反"不改代码"且易与官方站点口径分叉）。
* 风险：
  1. 副本必须**随站点可达**（本机 dev server 已提供；若以后走 gh-pages，`scene/` 目录需一并发布——仓库里该目录已存在）。
  2. 与"官方站点默认口径"不同：论文必须注明"本地副本（与 HF 同字节）"，并说明这是为了**消除网络变量**。
  3. 首次仍需经隧道下载同一体积（受隧道带宽限制），但**可复现、与本文臂同源同隧道**，便于冷/热成组对比。
  4. 若隧道/本地文件被改动，需要重新核对字节（本次已核对 13/13）。

## 待你决策

* **A（默认 HF）** ⇒ 我按 A 生成 Flux 链接（现状方式，`?url=` 不传）。
* **B（本地）** ⇒ 我按 B 生成 Flux 链接（在链接上追加 `&url=<隧道>/flux-gs-project-gh-pages/scene/<scene>.json`，逐场景链接；分 3 批时每批 3~9 条链接）。
* 本文 FINAL 的链接（3 批 × 冷/热）**已生成可先发**：`_tmp_ch7probe/c_links_final.md`。
