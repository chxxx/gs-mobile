# splat-shq.js

A JavaScript/WebGL2 Gaussian Splatting renderer with **3rd-order Spherical Harmonics (SH)** and **QPLY** support.

This project extends the original [gsplat.js](https://github.com/dylanebert/gsplat.js) with view-dependent color rendering for standard 3DGS PLY files and quantized-half PLY (QPLY) files produced by vector-quantized 3DGS pipelines.

> **Part of the [BAPQ](https://gitee.com/chxxx/Plasticity-Pruning-GS) project** — this renderer is the WebGL 2.0 deployment end of the BAPQ compression pipeline (budget-aware pruning + low-rank SH + QPLY). It renders the quantized models produced by the BAPQ training pipeline directly in the browser, including **low-rank QPLY** files (shared-basis low-rank SH decomposition, decoded once at load time). See the [BAPQ main repository](https://gitee.com/chxxx/Plasticity-Pruning-GS) for the training/compression side and the thesis.

**[中文文档](README_CN.md)**

## Features

- **Standard 3DGS PLY loading** with full 3rd-order SH (`f_dc_*` + `f_rest_0..44`)
- **QPLY loading** for quantized-half PLY outputs (`vertex_0..3` + `codebook_centers`)
- **Single WebGL2 shader pipeline** that handles both standard SH and adaptive-degree QPLY
- **Half-float packing utilities** for compact SH texture storage
- **Examples** covering vanilla JS, file loading, PLY conversion, FPS controls, and scene editing

## Quick Start

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

For QPLY files, use the same `PLYLoader` API:

```ts
await SPLAT.PLYLoader.LoadAsync("path/to/point_cloud_quantised_half.ply", scene);
```

The loader auto-detects QPLY headers and routes them through the dedicated QPLY decoder.

## Examples

| Example | Description |
|---|---|
| [`examples/vanilla-js`](examples/vanilla-js) | Minimal browser usage without a bundler |
| [`examples/file-loader`](examples/file-loader) | Drag-and-drop PLY viewer |
| [`examples/ply-converter`](examples/ply-converter) | Convert between `.ply` and `.splat` |
| [`examples/simple-server`](examples/simple-server) | Vite-based local server setup |
| [`examples/fps`](examples/fps) | First-person camera controls |
| [`examples/editor`](examples/editor) | Real-time scene editing |

Run any example with:

```bash
cd examples/<name>
npm install
npm run dev
```

## Build

```bash
# Build WASM utilities and the library
npm run build

# Lint and format
npm run lint
npm run format
```

## Technical Notes

### SH Texture Layout

Both standard PLY and QPLY share the same SH texture format:

- Three `RGBA32UI` textures (R, G, B channels)
- Each texel packs two half-float coefficients via `unpackHalf2x16`
- A single `ivec3 u_bandIndex` uniform marks degree boundaries for adaptive QPLY rendering

### QPLY Decoder

`src/loaders/QPLYLoaderUtils.ts` implements:

- Multi-element header parsing (`vertex_0..3`, `codebook_centers 256`)
- Half-float position decoding
- Codebook lookups for scale, rotation, DC features, opacity, and rest SH coefficients
- Adaptive degree handling (degree 0 vertices skip SH texture allocation)

## Acknowledgments

This project is based on [gsplat.js](https://github.com/dylanebert/gsplat.js) by Dylan Ebert, released under the MIT license.

Additional references:

- [three.js](https://github.com/mrdoob/three.js), MIT License
- [antimatter15/splat](https://github.com/antimatter15/splat), MIT License
- [UnityGaussianSplatting](https://github.com/aras-p/UnityGaussianSplatting), MIT License
Please note that the license of the original [3D Gaussian Splatting](https://github.com/graphdeco-inria/gaussian-splatting) research project is non-commercial. This library provides an open-source rendering implementation; users should consider the source of their splat data separately.

## License

MIT
