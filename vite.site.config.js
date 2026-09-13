import { defineConfig } from "vite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { viteStaticCopy } from "vite-plugin-static-copy";

const dirname = fileURLToPath(new URL(".", import.meta.url));

/** 可选同源资产：目录存在才复制。CI 里若拉取失败（或未拉取），构建不应因此失败。 */
function optionalAsset(src, dest) {
    if (existsSync(resolve(dirname, src))) return [{ src, dest }];
    console.warn(`[site] 跳过可选资产（目录不存在）：${src}（该臂在站点上会被标记为资产缺失）`);
    return [];
}

/**
 * GitHub Pages 站点专用构建配置（与根目录 vite.config.js 的库模式相互独立）。
 *
 * 用途：把最新 viewer（根目录 index.html + demo.ts）构建为一份"自包含静态站点"，
 * 产物输出到 site-dist/，CI 将其推送到 pages 分支根目录供 GitHub Pages 托管。
 *
 * 用法：
 *   npm run site:dev        # 本地开发
 *   npm run site:build      # 产出 site-dist/
 *   npm run site:preview    # 本地预览 site-dist/
 */
export default defineConfig(() => ({
    root: dirname,
    base: "./", // 相对路径，保证可部署在 https://<user>.github.io/<repo>/ 这类子路径下
    publicDir: false,
    plugins: [
        viteStaticCopy({
            targets: [
                // 场景数据在构建时静态复制，保持与根目录同源（场景 .ply 不入 site-dist 的版本管理）
                { src: "scenes", dest: "." },
                { src: "scenes.json", dest: "." },
                // 测试页专用场景清单（bench.html 读取，与演示页 scenes.json 相互独立）
                { src: "bench-scenes.json", dest: "." },
                // 第7章对比方法清单（bench.html 的 reduced3dgs 分组 + bench-flux.html）
                { src: "baseline-scenes.json", dest: "." },
                { src: "flux-baseline-scenes.json", dest: "." },
                { src: "bench-cameras.json", dest: "." },
                { src: "bench-flux-camera.json", dest: "." },
                { src: "bench-resolutions.json", dest: "." },
                // ---- 第7章对比方法实测所需的"同源资产"（互联网实测必须同源，不能跨域直链）----
                // Flux-GS：渲染器页面 + 压缩模型 + tmc3 解码器（约 50MB，已入库）
                { src: "flux-gs-project-gh-pages", dest: "." },
                // reduced-3DGS：量化 PLY（约 105MB，仓库里不入库，构建前用 tools/fetch_reduced3dgs_assets.py 拉取到本地）
                //   若嫌 site-dist 太大，可先用 --scenes 只拉当前要测的数据集，或注释掉本行分批轮换。
                ...optionalAsset("reduced-3dgs", "."),
            ],
        }),
    ],
    build: {
        outDir: resolve(dirname, "site-dist"),
        emptyOutDir: true,
        target: "esnext",
        sourcemap: false,
        chunkSizeWarningLimit: 6000,
        rollupOptions: {
            input: {
                index: resolve(dirname, "index.html"),
                bench: resolve(dirname, "bench.html"),
                benchFlux: resolve(dirname, "bench-flux.html"),
            },
        },
    },
}));
