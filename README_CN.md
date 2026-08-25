<div align="center">

# splat-shq.js

**基于 JavaScript / WebGL 2.0 的高斯泼溅（Gaussian Splatting）渲染器，支持三阶球谐（SH）与 QPLY 格式。**

[![WebGL 2.0](https://img.shields.io/badge/WebGL-2.0-brightgreen.svg)](https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![BAPQ](https://img.shields.io/badge/Part%20of-BAPQ-purple)](https://gitee.com/chxxx/Plasticity-Pruning-GS)

[**English README**](README.md) · [**BAPQ 主仓库**](https://gitee.com/chxxx/Plasticity-Pruning-GS)

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
- **丰富示例**：原生 JS、文件拖拽加载、PLY 转换、FPS 相机控制、场景编辑。

---



## 2. 🚀 快速开始

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

## 3. 🖥️ 示例

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


## 4. 🛠️ 构建

```bash
# 构建 WASM 工具与库
npm run build

# 代码检查与格式化
npm run lint
npm run format
```

---

## 5. 📋 技术说明

### 5.1 SH 纹理布局

标准 PLY 与 QPLY 共用同一套 SH 纹理格式：

- 三张 `RGBA32UI` 纹理（R / G / B 通道各一张）；
- 每个纹素通过 `unpackHalf2x16` 打包两个半浮点系数；
- 单个 `ivec3 u_bandIndex` uniform 标记阶数边界，用于自适应 QPLY 渲染。

### 5.2 QPLY 解码器

`src/loaders/QPLYLoaderUtils.ts` 实现：

- 多元素头部解析（`vertex_0..3`、`codebook_centers 256`）；
- 半精度位置解码；
- 尺度、旋转、DC 特征、不透明度与 rest SH 系数的码本查找；
- 自适应阶数处理（0 阶顶点跳过 SH 纹理分配）。

### 5.3 低秩 QPLY 重建

`src/loaders/LowRankQPLYWorker.ts` 实现共享基低秩重建的 **CPU 端并行解码**：

- 低秩系数码本查找 + 共享基矩阵乘法，重建完整 45 维 rest SH；
- Web Worker 并行化，避免阻塞主线程；
- 重建在**加载期一次性完成**，渲染循环与标准 QPLY 完全一致，无任何逐帧开销。

---

## 6. 📁 仓库结构

```text
.
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
├── scenes/                      # 演示场景（point_cloud_quantised_half.ply 等）
├── dist/                        # 构建产物
└── package.json
```

---

## 7. 🙏 致谢

本项目基于 [gsplat.js](https://github.com/dylanebert/gsplat.js)（作者 Dylan Ebert，MIT 许可）。

其他参考：

- [three.js](https://github.com/mrdoob/three.js)，MIT License
- [antimatter15/splat](https://github.com/antimatter15/splat)，MIT License
- [UnityGaussianSplatting](https://github.com/aras-p/UnityGaussianSplatting)，MIT License

请注意：原始 [3D Gaussian Splatting](https://github.com/graphdeco-inria/gaussian-splatting) 研究项目的许可是非商用的。本库提供开源的渲染实现，使用者应自行确认 splat 数据的来源与授权。

---

## 8. ⚖️ 许可证

MIT
