/**
 * bench-slave-url.test.ts — 阶段 8B（H23）：三臂入口 URL 构造器的**行为锁**。
 *
 * 每一条都对应一个实测缺陷或设计约束：
 *   1) ours / reduced-3dgs 必须落在 `bench-case.html?slave=1`，且带齐 `caseSpecFromUrl()` 需要的
 *      `jobId/scene/model`——缺任一 ⇒ 子页面报 NO_JOB 且**不**挂 `window.__CASE_BENCH__`
 *      ⇒ 父页面 30s 后 `等待超时：__CASE_BENCH__(…)`（浏览器实测）；
 *   2) ours 的入口 URL **不得**再指向 flux 目录（H23 回归锁：旧实现把 ours 送进了 flux 页面）；
 *   3) reduced-3dgs 用清单 id（`r3dgs-*`）作 `scene`，模型取 `reduced-3dgs/*.ply`；
 *   4) flux-gs 原样返回清单声明的页面，且本模块**不**注入 `bridge=`（注入点唯一：
 *      `FluxGsAdapter.injectBridgeParams()`）；
 *   5) 缺字段一律显式抛错（禁止静默退化成长达 30s 的"等待超时"）；
 *   6) `readSceneEntries()` 的旧 schema 归一：清单的 `file` → `modelUrl`、`page` → `iframeUrl`；
 *   7) `SLAVE_PAGE` 必须与 `bench-shared.ts` 的 `CASE_PAGE` 一致，且该页确实存在于仓库根目录。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SLAVE_PAGE, describeSlaveUrl, isCaseSlaveMethod, slaveIframeUrl } from "./bench-slave-url";
import type { SlaveUrlEntry } from "./bench-slave-url";
import { readSceneEntries } from "./bench-three-way";

/** 归一后的 ours 条目：`file` 已进 `modelUrl`，`iframeUrl` 仍是旧实现的 flux 保守默认值。 */
const OURS: SlaveUrlEntry = {
    id: "bicycle",
    dataset: "mip360",
    modelUrl: "scenes/point_cloud_quantised_half_r7-bicycle.ply",
    iframeUrl: "flux-gs-project-gh-pages/render_bicycle/index.html",
};
/** 归一后的 reduced-3dgs 条目（清单 id 带 `r3dgs-` 前缀，模型另有目录）。 */
const REDUCED: SlaveUrlEntry = {
    id: "r3dgs-bicycle",
    dataset: "mip360",
    modelUrl: "reduced-3dgs/quantized_bicycle.ply",
    iframeUrl: "flux-gs-project-gh-pages/render_r3dgs-bicycle/index.html",
};
/** 归一后的 flux 条目：`page` 已进 `iframeUrl`，没有可用的本地模型 URL。 */
const FLUX: SlaveUrlEntry = {
    id: "bicycle",
    dataset: "mip360",
    modelUrl: "",
    iframeUrl: "flux-gs-project-gh-pages/render_bicycle/index.html",
};
const OPTS = { jobId: "3way-ours-bicycle-abc", resW: 1600, resH: 1063 };

/** 回读 URL 查询参数（模拟子页面 `param()` 看到的解码值）。 */
const params = (url: string): URLSearchParams => new URLSearchParams(url.slice(url.indexOf("?") + 1));

describe("阶段 8B（H23）：三臂入口 URL", () => {
    it("1) ours ⇒ bench-case.html?slave=1，且 caseSpecFromUrl 需要的三参数齐全", () => {
        const url = slaveIframeUrl("ours", OURS, OPTS);
        expect(url.startsWith(`${SLAVE_PAGE}?`)).toBe(true);
        const q = params(url);
        expect(q.get("slave")).toBe("1");
        expect(q.get("jobId")).toBe(OPTS.jobId);
        expect(q.get("scene")).toBe("bicycle");
        expect(q.get("dataset")).toBe("mip360");
        expect(q.get("model")).toBe("scenes/point_cloud_quantised_half_r7-bicycle.ply");
        expect(q.get("res")).toBe("1600x1063");
        // 三参数缺一 ⇒ 子页面 NO_JOB（不允许）
        expect(q.get("jobId")?.length ?? 0).toBeGreaterThan(0);
        expect(q.get("scene")?.length ?? 0).toBeGreaterThan(0);
        expect(q.get("model")?.length ?? 0).toBeGreaterThan(0);
    });

    it("2) ours 的入口 URL 不得指向 flux 目录（H23 回归锁）", () => {
        const url = slaveIframeUrl("ours", OURS, OPTS);
        expect(url).not.toContain("flux-gs-project-gh-pages");
        expect(url).not.toContain("bridge=1"); // bridge 只属于 flux 注入点
        expect(url).not.toContain("fxsession");
        expect(isCaseSlaveMethod("ours")).toBe(true);
        expect(isCaseSlaveMethod("reduced-3dgs")).toBe(true);
        expect(isCaseSlaveMethod("flux-gs")).toBe(false);
    });

    it("3) reduced-3dgs ⇒ 同一 slave 页；scene=清单 id，model=reduced-3dgs/*.ply", () => {
        const url = slaveIframeUrl("reduced-3dgs", REDUCED, { ...OPTS, jobId: "3way-reduced-abc" });
        expect(url.startsWith(`${SLAVE_PAGE}?`)).toBe(true);
        const q = params(url);
        expect(q.get("scene")).toBe("r3dgs-bicycle");
        expect(q.get("model")).toBe("reduced-3dgs/quantized_bicycle.ply");
        expect(url).not.toContain("flux-gs-project-gh-pages");
    });

    it("4) flux-gs ⇒ 原样返回清单页面（bridge 参数由 adapter 注入，本模块不注入）", () => {
        const url = slaveIframeUrl("flux-gs", FLUX, OPTS);
        expect(url).toBe(FLUX.iframeUrl);
        expect(url).not.toContain("slave=1");
        expect(url).not.toContain("jobId=");
    });

    it("5) 缺字段一律显式抛错（禁止静默退化成长达 30s 的等待超时）", () => {
        expect(() => slaveIframeUrl("ours", { ...OURS, modelUrl: "" }, OPTS)).toThrow(/缺少模型 URL/);
        expect(() => slaveIframeUrl("reduced-3dgs", { ...REDUCED, modelUrl: "" }, OPTS)).toThrow(/缺少模型 URL/);
        expect(() => slaveIframeUrl("flux-gs", { ...FLUX, iframeUrl: "" }, OPTS)).toThrow(/缺少入口页 URL/);
        // 错误信息必须点名清单字段，便于直接改数据而不是猜
        expect(() => slaveIframeUrl("ours", { ...OURS, modelUrl: "" }, OPTS)).toThrow(/file/);
        expect(() => slaveIframeUrl("flux-gs", { ...FLUX, iframeUrl: "" }, OPTS)).toThrow(/page/);
    });

    it("6) readSceneEntries 归一旧 schema：file → modelUrl、page → iframeUrl", () => {
        const [ours] = readSceneEntries([
            { id: "bicycle", file: "scenes/point_cloud_quantised_half_r7-bicycle.ply", dataset: "mip360" },
        ]);
        expect(ours.modelUrl).toBe("scenes/point_cloud_quantised_half_r7-bicycle.ply");
        // 出处字段同步归一（否则 ours/reduced 的 modelSourceUrl 会是 null，报表里丢出处）
        expect(ours.modelSource.modelSourceUrl).toBe("scenes/point_cloud_quantised_half_r7-bicycle.ply");
        const [flux] = readSceneEntries([
            { id: "bicycle", dataset: "mip360", page: "flux-gs-project-gh-pages/render_bicycle/index.html" },
        ]);
        expect(flux.iframeUrl).toBe("flux-gs-project-gh-pages/render_bicycle/index.html");
        const [reduced] = readSceneEntries([
            { id: "r3dgs-bicycle", file: "reduced-3dgs/quantized_bicycle.ply", dataset: "mip360" },
        ]);
        expect(reduced.modelUrl).toBe("reduced-3dgs/quantized_bicycle.ply");
        // 两者都缺时保留既有保守默认（锁住 bench-three-way.test.ts 已固定的语义）
        expect(readSceneEntries([{ id: "truck", dataset: "tnt" }])[0].iframeUrl).toBe(
            "flux-gs-project-gh-pages/render_truck/index.html",
        );
    });

    it("7) SLAVE_PAGE 与 bench-shared.ts 的 CASE_PAGE 一致，且页面确实存在", () => {
        const src = readFileSync(fileURLToPath(new URL("./bench-shared.ts", import.meta.url)), "utf-8");
        const m = /CASE_PAGE\s*=\s*"([^"]+)"/.exec(src);
        expect(m).not.toBeNull();
        expect(SLAVE_PAGE).toBe("./bench-case.html");
        expect(m?.[1]).toBe(SLAVE_PAGE);
        // 与 runner 页面（bench-three-way.html）同级 ⇒ 相对路径在 dev/静态站点两种部署下都成立
        expect(existsSync(fileURLToPath(new URL("./bench-case.html", import.meta.url)))).toBe(true);
    });

    it("8) 端到端（纯函数链）：清单条目 → 入口 URL → 子页面三参数；诊断串可读", () => {
        const [entry] = readSceneEntries([
            { id: "bicycle", file: "scenes/point_cloud_quantised_half_r7-bicycle.ply", dataset: "mip360" },
        ]);
        const url = slaveIframeUrl("ours", entry, { jobId: "job-42", resW: 1600, resH: 1063 });
        const q = params(url);
        expect(q.get("jobId")).toBe("job-42");
        expect(q.get("scene")).toBe("bicycle");
        expect(q.get("model")).toBe(entry.modelUrl);
        const line = describeSlaveUrl(url);
        expect(line).toContain(`page=${SLAVE_PAGE}`);
        expect(line).toContain("scene=bicycle");
        expect(describeSlaveUrl("bench-case.html")).toBe("page=bench-case.html params=none");
    });
});
