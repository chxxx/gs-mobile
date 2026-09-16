/**
 * bench-slave-url.ts — 阶段 8B（H23）：三臂 iframe 入口 URL 的**唯一**构造器。
 *
 * 为什么必须有这个文件（H23 实测缺陷，桌面 Chromium 组合跑）：
 *   `?methods=ours,flux-gs&only=bicycle&…` 在 `ours` 臂固定报 `等待超时：__CASE_BENCH__(ours)`。
 *   根因不在渲染器，而在**入口 URL 是"猜"出来的**：`bench-three-way.ts` 的 `readSceneEntries()`
 *   只认 `modelUrl` / `iframeUrl`，而两份清单用的是旧 schema（`file` / `page`）⇒
 *     · `iframeUrl` 落到保守默认 `flux-gs-project-gh-pages/render_<id>/index.html`，
 *       那是 **flux 自己的页**，里面没有 `__CASE_BENCH__` ⇒ 30s 后超时；
 *     · `modelUrl` = ""（清单里叫 `file`）⇒ 即使页面正确，slave 也会因缺 `model` 报 NO_JOB。
 *   flux 臂**只是碰巧**能跑：那条保守默认恰好就是它自己的页面路径。
 *
 * 本模块把"哪一臂用哪个入口页、带哪些参数"从**数据猜测**改成**显式构造**（纯函数，可单测）：
 *   · `ours` / `reduced-3dgs`：同一个 slave 页 `bench-case.html?slave=1&…`，只换 `model`
 *     （设计文档 §2.1 接入点矩阵 / §3.2）；
 *   · `flux-gs`：清单声明的 vendor 页面**原样返回**——`bridge=1&benchres=…&fxsession=…`
 *     只由 `FluxGsAdapter.injectBridgeParams()` 注入，本模块不重复注入（避免两处注入）。
 *
 * 失败语义：**一律显式抛错**（由 `runThreeWayPlan` 记成 `round-failed:<method>:<原因>`），
 * 禁止用空 model 静默退化成长达 30s 的"等待超时"。
 *
 * 子页面要求（`caseSpecFromUrl()`，见 `bench-shared.ts`）：必须同时给出 `jobId` / `scene` / `model`
 * 三个参数，否则 `bench-case.ts` 报 NO_JOB 且**不会**挂上 `window.__CASE_BENCH__`。
 * `round` / `attempt` / `token` 在 `?slave=1` 下无意义（slave 模式不进 `measureOneRound`，见
 * `bench-case.ts:342-354`），因此本模块不生成它们。
 */
import type { BenchMethod } from "./bench-controller";

/** slave 页文件名：必须与 `bench-shared.ts` 的 `CASE_PAGE` 一致（单测用源文本断言，避免扩大父页面模块图）。 */
export const SLAVE_PAGE = "./bench-case.html";

/** 入口 URL 需要的最小条目信息（= `bench-three-way.ts` 归一后的 `SceneEntry` 子集）。 */
export interface SlaveUrlEntry {
    id: string;
    dataset: string;
    /** 模型 URL：清单的 `modelUrl`（旧 schema 名 `file`，由 `readSceneEntries()` 归一） */
    modelUrl: string;
    /** 清单声明/归一出的 iframe 页面（flux 臂使用） */
    iframeUrl: string;
}

export interface SlaveUrlOptions {
    /** 子页面任务号（仅用于日志/消息关联；slave 模式下不影响测量） */
    jobId: string;
    resW: number;
    resH: number;
}

/** 走 `bench-case.html?slave=1` 的臂（同一个入口页，只换模型 URL）。 */
export function isCaseSlaveMethod(method: BenchMethod): boolean {
    return method === "ours" || method === "reduced-3dgs";
}

/**
 * 三臂统一入口 URL 构造器（纯函数）。
 * `flux-gs` ⇒ 清单声明的 vendor 页面；`ours`/`reduced-3dgs` ⇒ `bench-case.html?slave=1&…`。
 */
export function slaveIframeUrl(method: BenchMethod, entry: SlaveUrlEntry, opts: SlaveUrlOptions): string {
    if (!isCaseSlaveMethod(method)) {
        if (!entry.iframeUrl) {
            throw new Error(`[H23] ${method} 臂缺少入口页 URL（清单需要 iframeUrl 或 page 字段）：scene=${entry.id}`);
        }
        return entry.iframeUrl;
    }
    if (!entry.modelUrl) {
        throw new Error(`[H23] ${method} 臂缺少模型 URL（清单需要 modelUrl 或 file 字段）：scene=${entry.id}`);
    }
    const q = new URLSearchParams({
        slave: "1",
        jobId: opts.jobId,
        scene: entry.id,
        dataset: entry.dataset,
        model: entry.modelUrl,
        res: `${opts.resW}x${opts.resH}`,
    });
    return `${SLAVE_PAGE}?${q.toString()}`;
}

/** 诊断：把入口 URL 里的关键参数回读（父页面状态行/失败原因里打印，便于一步定位）。 */
export function describeSlaveUrl(url: string): string {
    const i = url.indexOf("?");
    if (i < 0) return `page=${url} params=none`;
    const q = new URLSearchParams(url.slice(i + 1));
    const keys = ["slave", "jobId", "scene", "dataset", "model", "res"];
    return `page=${url.slice(0, i)} ${keys.map((k) => `${k}=${q.get(k) ?? "-"}`).join(" ")}`;
}
