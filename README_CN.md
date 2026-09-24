<div align="center">

# splat-shq.js

**基于 JavaScript / WebGL 2.0 的高斯泼溅（Gaussian Splatting）渲染器，支持三阶球谐（SH）与 QPLY 格式。**

[![WebGL 2.0](https://img.shields.io/badge/WebGL-2.0-brightgreen.svg)](https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![BAPQ](https://img.shields.io/badge/Part%20of-BAPQ-purple)](https://gitee.com/chxxx/Plasticity-Pruning-GS)

**▶️ [在线 Demo —— 点开即看，手机浏览器同样可玩](https://chxxx.github.io/gs-mobile/?scene=truck)**

[**English README**](README.md) · [**在线 Demo**](https://chxxx.github.io/gs-mobile/?scene=truck) · [**线上验证记录**](docs/DEPLOYMENT.md) · [**BAPQ 主仓库**](https://gitee.com/chxxx/Plasticity-Pruning-GS)

</div>

---

## 1. 🎯 项目介绍

本仓库是 [gsplat.js](https://github.com/dylanebert/gsplat.js) 的扩展分支，为标准 3DGS PLY 文件和量化半精度 PLY（QPLY）文件提供**视角相关颜色渲染**，并在 Shader 端实时求值完整的三阶球谐。

> **BAPQ 项目的部署端** —— 本渲染器是 BAPQ 压缩流水线（预算感知剪枝 + 低秩 SH 分解 + QPLY）的 WebGL 2.0 部署出口。它直接在浏览器中渲染 BAPQ 训练流水线产出的量化模型，包括**低秩 QPLY** 文件（共享基低秩 SH 分解，在加载期一次性解码）。训练 / 压缩端与论文请见 [BAPQ 主仓库](https://gitee.com/chxxx/Plasticity-Pruning-GS)。

### ✨ 核心特性

- **标准 3DGS PLY 加载**：完整三阶 SH（`f_dc_*` + `f_rest_0..44`）；
- **QPLY 加载**：量化半精度 PLY 输出（`vertex_0..3` + `codebook_centers`）；
- **低秩 QPLY 加载**：共享基低秩重建 + CPU 端并行解码（Web Worker），加载期一次完成，不进入逐帧渲染路径；
- **单一 WebGL2 Shader 管线**：同时处理标准 SH 与自适应阶数 QPLY；
- **半精度打包工具**：紧凑的 SH 纹理存储（`unpackHalf2x16`）；
- **加载与渲染路径零神经网络推理**：不需要 MLP，也不需要 WebGPU；
- **丰富示例**：原生 JS、文件拖拽加载、PLY 转换、FPS 相机控制、场景编辑等 9 个示例工程。

---

## 2. 🌐 在线 Demo 与线上验证

渲染器以 **GitHub Pages 静态站点**的形式公开部署（由本仓库的 `index.html` + `demo.ts` 经 `vite.site.config.js` 构建）：

| 链接 | 打开后是什么 |
| ---- | ------------ |
| <https://chxxx.github.io/gs-mobile/> | 场景选择页 —— **不选场景就不会下载任何模型** |
| <https://chxxx.github.io/gs-mobile/?scene=truck> | 直达链接：自动加载 **Truck**（最小场景，6.3 MB） |
| <https://chxxx.github.io/gs-mobile/?scene=garden> | 直达链接：自动加载 **Garden** |
| <https://chxxx.github.io/gs-mobile/?scene=2> | 按序号直达（1 起算，不含占位项） |

`?scene=` 支持文件路径、显示名子串、1 起序号或完整 URL（`0` / `off` 表示关闭）；**不带该参数时行为与以前完全一致**（仍需手动选择）。

线上实测（**2026-09-24**，由 [`tools/verify_demo.mjs`](tools/verify_demo.mjs) 自动完成：真实浏览器打开线上页面、模拟用户操作、抓取全部网络请求、截图后做像素统计）：

| 环境 | 场景 | 首帧 | `.ply` 下载 | 交互证据 |
| ---- | ---- | ---: | ----------: | -------: |
| 线上 · 桌面 | DrJohnson（9.9 MB） | 10.65 s | 10.42 s | 拖动 Δ = 31.1 |
| 线上 · 手机模拟（390×844，DPR 3） | Truck（6.3 MB） | 2.40 s | 2.24 s | 触摸 Δ = 41.3 |
| 线上 · `?scene=truck` 直达 | Truck（6.3 MB） | 2.38 s | 2.20 s | 拖动 Δ = 42.7 |
| 本地生产构建（`npm run site:build`） | Truck（6.3 MB） | 0.22 s | 0.03 s | 拖动 Δ = 42.7 |

- 每次运行 WebGL2 均可用；截图非黑像素占比 ≈ 99% → **没有黑屏，也没有几何爆炸**；
- 首帧 ≈ 下载耗时 + 约 0.15 s 解码：真实网络下**模型字节数才是瓶颈**，这正是 BAPQ 压缩要解决的问题；
- Δ = 拖动前后 32×18 灰度签名的平均绝对差（数值大即"相机真的动了"）；
- 原始报告、截图与复验命令见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

> 验证脚本里的 FPS 数字来自桌面独显，**不代表真机性能**，请勿当作结论引用。

---



## 3. 🚀 快速开始

```bash
npm install
npm run build
```

```ts
import * as SPLAT from "splat-shq";

const scene = new SPLAT.Scene();
const camera = new SPLAT.Camera();
const renderer = new SPLAT.WebGLRenderer();
const controls = new SPLAT.OrbitControls(camera, renderer.canvas);

async function main() {
    await SPLAT.PLYLoader.LoadAsync(
        "path/to/baseline_scene.ply",
        scene,
        (progress) => console.log(progress),
    );

    const frame = () => {
        controls.update();
        renderer.render(scene, camera);
        requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
}

main();
```

加载 QPLY 文件使用同一个 `PLYLoader` API：

```ts
await SPLAT.PLYLoader.LoadAsync("path/to/point_cloud_quantised_half.ply", scene);
```

加载器会自动识别 QPLY 头部并路由到专用的 QPLY 解码器；低秩 QPLY 则由 `LowRankQPLYWorker` 在 Web Worker 中并行完成低秩重建。

---

## 4. 🖥️ 示例

| 示例 | 说明 |
|---|---|
| [`examples/vanilla-js`](examples/vanilla-js) | 无需打包器的极简浏览器用法 |
| [`examples/file-loader`](examples/file-loader) | 拖拽 PLY 文件查看器 |
| [`examples/ply-converter`](examples/ply-converter) | `.ply` 与 `.splat` 互转 |
| [`examples/simple-server`](examples/simple-server) | 基于 Vite 的本地服务器 |
| [`examples/fps`](examples/fps) | 第一人称相机控制 |
| [`examples/editor`](examples/editor) | 实时场景编辑 |
| [`examples/4d`](examples/4d) | 4D 高斯展示 |
| [`examples/camera-updates`](examples/camera-updates) | 相机更新 |
| [`examples/scene-transformations`](examples/scene-transformations) | 场景变换 |

运行任意示例：

```bash
cd examples/<name>
npm install
npm run dev
```

---


## 5. 🛠️ 构建与部署

```bash
# 构建 WASM 工具与库（产出 dist/）
npm run build

# 本仓库自带 viewer 的本地开发服务器（index.html + demo.ts）
npm run dev

# 构建可部署的静态站点到 site-dist/，并本地预览
npm run site:build
npm run site:preview

# 代码检查与格式化
npm run lint
npm run format
```

> 推到开发分支即自动重建并重新发布线上站点（`.github/workflows/deploy-pages.yml`：
> `npm ci` → `npm run site:build` → 把 `site-dist/` 强推为 `pages` 分支）。
> 链路细节见 [部署使用说明.md](部署使用说明.md)，验证记录见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

---

## 6. 📋 技术说明

### 6.1 SH 纹理布局

标准 PLY 与 QPLY 共用同一套 SH 纹理格式：

- 三张 `RGBA32UI` 纹理（R / G / B 通道各一张）；
- 每个纹素通过 `unpackHalf2x16` 打包两个半浮点系数；
- 单个 `ivec3 u_bandIndex` uniform 标记阶数边界，用于自适应 QPLY 渲染。

### 6.2 QPLY 解码器

`src/loaders/QPLYLoaderUtils.ts` 实现：

- 多元素头部解析（`vertex_0..3`、`codebook_centers 256`）；
- 半精度位置解码；
- 尺度、旋转、DC 特征、不透明度与 rest SH 系数的码本查找；
- 自适应阶数处理（0 阶顶点跳过 SH 纹理分配）。

### 6.3 低秩 QPLY 重建

`src/loaders/LowRankQPLYWorker.ts` 实现共享基低秩重建的 **CPU 端并行解码**：

- 低秩系数码本查找 + 共享基矩阵乘法，重建完整 45 维 rest SH；
- Web Worker 并行化，避免阻塞主线程；
- 重建在**加载期一次性完成**，渲染循环与标准 QPLY 完全一致，无任何逐帧开销。

---

## 7. 📁 仓库结构

```text
.
├── index.html / demo.ts          # 线上 viewer（场景选择、拖拽加载、FPS 计数）
├── src/
│   ├── index.ts                 # 库入口
│   ├── loaders/                 # PLY / QPLY / 低秩 QPLY / SplatV 加载器
│   │   ├── PLYLoader.ts
│   │   ├── QPLYLoaderUtils.ts   # QPLY 头部解析 + 码本解码
│   │   ├── LowRankQPLYWorker.ts # 低秩重建 Web Worker
│   │   └── ...
│   ├── renderers/
│   │   └── webgl/               # WebGL2 渲染管线（SH 纹理打包 + Shader 查表）
│   ├── cameras/  controls/  splats/  math/  events/  types/  utils/
│   └── wasm/                    # WASM 工具（compile_wasm.sh 构建）
├── examples/                    # 9 个示例工程（vanilla-js / file-loader / ...）
├── scenes/  scenes.json         # 演示场景（r7 低秩 QPLY）
├── tools/verify_demo.mjs        # 无依赖 headless 浏览器部署验证脚本
├── docs/DEPLOYMENT.md           # 线上状态与验证证据
├── vite.site.config.js          # 站点构建（site-dist/ → GitHub Pages）
├── dist/                        # 构建产物
└── package.json
```

---

## 8. 🙏 致谢

本项目基于 [gsplat.js](https://github.com/dylanebert/gsplat.js)（作者 Dylan Ebert，MIT 许可）。

其他参考：

- [three.js](https://github.com/mrdoob/three.js)，MIT License
- [antimatter15/splat](https://github.com/antimatter15/splat)，MIT License
- [UnityGaussianSplatting](https://github.com/aras-p/UnityGaussianSplatting)，MIT License

请注意：原始 [3D Gaussian Splatting](https://github.com/graphdeco-inria/gaussian-splatting) 研究项目的许可是非商用的。本库提供开源的渲染实现，使用者应自行确认 splat 数据的来源与授权。

---

## 9. ⚖️ 许可证

MIT
