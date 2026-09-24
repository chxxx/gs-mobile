<div align="center">

# splat-shq.js

**A JavaScript/WebGL 2.0 Gaussian Splatting renderer with 3rd-order Spherical Harmonics (SH) and QPLY support — full 3rd-order SH evaluated in the shader, no MLP, no WebGPU requirement.**

[![WebGL 2.0](https://img.shields.io/badge/WebGL-2.0-brightgreen.svg)](https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![BAPQ](https://img.shields.io/badge/Part%20of-BAPQ-purple)](https://gitee.com/chxxx/Plasticity-Pruning-GS)

**▶️ [Live demo — open it in a browser, phone included](https://chxxx.github.io/gs-mobile/?scene=truck)**

[**中文文档**](README_CN.md) · [**Live demo**](https://chxxx.github.io/gs-mobile/?scene=truck) · [**Verified deployment**](docs/DEPLOYMENT.md) · [**BAPQ main repo**](https://gitee.com/chxxx/Plasticity-Pruning-GS)

</div>

---

This project extends the original [gsplat.js](https://github.com/dylanebert/gsplat.js) with view-dependent color rendering for standard 3DGS PLY files and quantized-half PLY (QPLY) files produced by vector-quantized 3DGS pipelines.

> **Part of the [BAPQ](https://gitee.com/chxxx/Plasticity-Pruning-GS) project** — this renderer is the WebGL 2.0 deployment end of the BAPQ compression pipeline (budget-aware pruning + low-rank SH + QPLY). It renders the quantized models produced by the BAPQ training pipeline directly in the browser, including **low-rank QPLY** files (shared-basis low-rank SH decomposition, decoded once at load time). See the [BAPQ main repository](https://gitee.com/chxxx/Plasticity-Pruning-GS) for the training/compression side and the thesis.

## Live Demo & Verified Deployment

The renderer ships as a public static site on GitHub Pages (built from this repo's `index.html` + `demo.ts` by `vite.site.config.js`):

| Link | What it opens |
| ---- | ------------- |
| <https://chxxx.github.io/gs-mobile/> | Scene picker — **nothing is downloaded until you pick a scene** |
| <https://chxxx.github.io/gs-mobile/?scene=truck> | Direct link: auto-loads **Truck** (smallest scene, 6.3 MB) |
| <https://chxxx.github.io/gs-mobile/?scene=garden> | Direct link: auto-loads **Garden** |
| <https://chxxx.github.io/gs-mobile/?scene=2> | Direct link by index (1-based, placeholder row excluded) |

`?scene=` accepts a file path, a display-name substring, a 1-based index, or a full URL (`0` / `off` disables it). Without the parameter the page behaves exactly as before (manual selection only).

Re-verified on **2026-09-24** with [`tools/verify_demo.mjs`](tools/verify_demo.mjs) — a dependency-free Chrome DevTools Protocol verifier that drives a real headless browser, selects/loads a scene, tracks every request, screenshots the canvas and analyses the pixels:

| Environment | Scene | First frame | `.ply` download | Interaction proof |
| ----------- | ----- | ----------: | --------------: | ----------------: |
| Live site · desktop | DrJohnson (9.9 MB) | 10.65 s | 10.42 s | drag Δ = 31.1 |
| Live site · phone emulation (390×844, DPR 3) | Truck (6.3 MB) | 2.40 s | 2.24 s | touch Δ = 41.3 |
| Live site · `?scene=truck` | Truck (6.3 MB) | 2.38 s | 2.20 s | drag Δ = 42.7 |
| Local production build (`npm run site:build`) | Truck (6.3 MB) | 0.22 s | 0.03 s | drag Δ = 42.7 |

- WebGL 2.0 available in every run; screenshots are ≈99% non-black → **no black screen, no geometry explosion**.
- First frame ≈ download time + ~0.15 s decode: on a real network the model bytes dominate, which is exactly what the BAPQ compression targets.
- Δ = average absolute difference of a 32×18 luma signature before/after a drag (a large value means the camera really moved).
- Raw reports, screenshots and one-line reproduce commands: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

> The verifier's FPS figures come from a desktop GPU and are **not** phone performance claims.

## Features

- **Standard 3DGS PLY loading** with full 3rd-order SH (`f_dc_*` + `f_rest_0..44`)
- **QPLY loading** for quantized-half PLY outputs (`vertex_0..3` + `codebook_centers`)
- **Low-rank QPLY loading** — shared-basis low-rank SH reconstruction (`F ≈ C·B`) decoded in parallel Web Workers **once at load time**; the per-frame render path stays identical to standard QPLY
- **Single WebGL2 shader pipeline** that handles both standard SH and adaptive-degree QPLY
- **Half-float packing utilities** for compact SH texture storage
- **Zero neural inference** on the load or render path — no MLP, no WebGPU
- **A live deployment** plus a no-dependency verifier ([`tools/verify_demo.mjs`](tools/verify_demo.mjs)) and a public static site for this demo page

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
| [`examples/4d`](examples/4d) | 4D Gaussian Splatting viewer |
| [`examples/camera-updates`](examples/camera-updates) | Driving the camera from code each frame |
| [`examples/scene-transformations`](examples/scene-transformations) | Applying transforms to a loaded scene |

Run any example with:

```bash
cd examples/<name>
npm install
npm run dev
```

## Build & Deploy

```bash
# Build WASM utilities + the library (dist/)
npm run build

# Local dev server for this repo's own viewer (index.html + demo.ts)
npm run dev

# Build the deployable static site into site-dist/, then preview it
npm run site:build
npm run site:preview

# Lint and format
npm run lint
npm run format
```

> Pushing to the development branch rebuilds and republishes the live site automatically
> (`.github/workflows/deploy-pages.yml`: `npm ci` → `npm run site:build` → `site-dist/` is force-pushed to the `pages` branch).
> Pipeline details: [部署使用说明.md](部署使用说明.md) · verification record: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

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

### Low-rank QPLY reconstruction

`src/loaders/LowRankQPLYWorker.ts` rebuilds the full 45-D rest SH on the CPU, in parallel Web Workers:

- codebook lookup for the per-point low-rank coefficients + shared-basis matrix multiply (`F ≈ C·B`);
- one-shot work at **load time** — the render loop stays identical to standard QPLY, with zero per-frame cost;
- measured overhead for 280k points: **130 ms** for low-rank reconstruction + texture packing, i.e. faster than the standard (non-low-rank) parse path (282 ms).

### Repository layout

```text
.
├── index.html / demo.ts          # the deployed viewer (scene picker, drag & drop, FPS counter)
├── src/
│   ├── index.ts                  # library entry point
│   ├── loaders/                  # PLY / QPLY / low-rank QPLY / SplatV loaders
│   ├── renderers/webgl/          # WebGL2 pipeline: SH texture packing + shader lookup
│   ├── cameras/ controls/ splats/ math/ events/ types/ utils/
│   └── wasm/                     # WASM utilities (compile_wasm.sh)
├── examples/                     # 9 standalone example projects
├── scenes/ scenes.json           # demo scenes (r7 low-rank QPLY)
├── tools/verify_demo.mjs         # headless-browser deployment verifier
├── docs/DEPLOYMENT.md            # live-site status + verification evidence
├── vite.site.config.js           # static-site build (site-dist/ → GitHub Pages)
└── package.json
```

## Acknowledgments

This project is based on [gsplat.js](https://github.com/dylanebert/gsplat.js) by Dylan Ebert, released under the MIT license.

Additional references:

- [three.js](https://github.com/mrdoob/three.js), MIT License
- [antimatter15/splat](https://github.com/antimatter15/splat), MIT License
- [UnityGaussianSplatting](https://github.com/aras-p/UnityGaussianSplatting), MIT License
Please note that the license of the original [3D Gaussian Splatting](https://github.com/graphdeco-inria/gaussian-splatting) research project is non-commercial. This library provides an open-source rendering implementation; users should consider the source of their splat data separately.

## License

MIT
