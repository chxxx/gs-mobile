import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { viteStaticCopy } from "vite-plugin-static-copy";

const dirname = fileURLToPath(new URL(".", import.meta.url));

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
            },
        },
    },
}));
