/**
 * bench-shared.ts — bench.html（父页面：队列/UI/结果）与 bench-case.html（子页面：单场景 × 单轮测量）
 * 共用的纯逻辑与父子通信协议。
 *
 * 设计约束（重要，改动前请先读）：
 *   1. 本文件**不导入 src/ 下的任何渲染代码**。父页面在 mode=bench 下绝不创建 WebGL 上下文，
 *      它的模块图里也不能出现 renderer / loader / wasm —— 否则会把渲染器与 wasm 一起拉进父页面。
 *   2. 只放"两页都要用、且与 GL 无关"的东西：URL 参数、场景清单、profile 分组、结果类型、
 *      状态存储键、父子消息协议、口径常量。
 *   3. 计时口径相关的取值（proto/cam/warmup/frames/res）全部放在这里，父子两页读同一份实现，
 *      避免"父页显示的口径"和"子页实际跑的口径"分叉。
 */
import { chipSlug, guessChip } from "./bench-chip";

// ------------------------------------------------------------------ URL 参数与数据格式
export function param(name: string, dflt = ""): string {
    try {
        const v = new URLSearchParams(location.search).get(name);
        return v === null ? dflt : v;
    } catch {
        return dflt;
    }
}
export function fmt(n: number | undefined, digits = 1): string {
    return n === undefined || !Number.isFinite(n) ? "-" : n.toFixed(digits);
}
export function median(nums: number[]): number | undefined {
    if (nums.length === 0) return undefined;
    const a = [...nums].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------ 测帧口径开关（与 Flux-GS 臂对齐）
/** 参考协议（Flux-GS 原协议）：`?proto=flux` → 焦距取它的 COLMAP 焦距、计帧前不预热。 */
export const PROTO_FLUX = param("proto", "") === "flux";
/** 三方同视角：`?cam=flux` → 用 Flux-GS 原代码里的相机（见 bench-measure 的 applyFluxCamera）。 */
export const CAM_FLUX = param("cam", "") === "flux";
/** 计帧前预热帧数：参考协议（Flux-GS 原协议）为 0，旧 1600×1063 口径为 10；`?warmup=N` 可显式覆盖。 */
export function warmupFrames(): number {
    const n = parseInt(param("warmup", PROTO_FLUX ? "0" : "10"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}
/** 测帧数（与旧口径一致：默认 300 帧，`?frames=N` 覆盖）。 */
export function benchFrameCount(): number {
    return parseInt(param("frames", "300"), 10) || 300;
}
/** 测帧分辨率（与旧口径一致：默认 1600×1063，`?res=WxH` 覆盖）。 */
export function resolution(): { w: number; h: number } {
    const parts = param("res", "1600x1063").split("x");
    return { w: parseInt(parts[0], 10) || 1600, h: parseInt(parts[1], 10) || 1063 };
}
/** 相机焦距参数所对应的实际像素焦距（与 bench-measure 的 applyFocalFromParam 一致）。
 *  父页面没有 camera 对象，结果头 `fx=` 优先用子页面每轮上报的真实值，取不到时才回退到这里。 */
export function effectiveFocalPx(): number {
    const fx = parseFloat(param("fx", PROTO_FLUX ? "1159.588" : "0"));
    return Number.isFinite(fx) && fx > 0 ? fx : 1132;
}

// ------------------------------------------------------------------ 场景清单
export interface SceneMeta {
    id: string;
    name: string;
    file: string;
    dataset: string;
    demo: boolean;
    points?: number;
    /** 第7章对比方法臂标记（如 "reduced-3dgs"）：仅用于 profile 分组，不进入 full/演示清单 */
    baseline?: string;
    /** 量化模型文件体积（MB），用于报表核对 */
    storageMB?: number;
}

/** 内置兜底清单：两份 JSON 都取不到时使用（离线/清单未部署）。 */
export const FALLBACK_SCENES: SceneMeta[] = [
    {
        id: "garden",
        name: "Garden (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-garden.ply",
        dataset: "mip360",
        demo: true,
        points: 610000,
    },
    {
        id: "bicycle",
        name: "Bicycle (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-bicycle.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "flowers",
        name: "Flowers (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-flowers.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "stump",
        name: "Stump (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-stump.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "treehill",
        name: "Treehill (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-treehill.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "room",
        name: "Room (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-room.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "counter",
        name: "Counter (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-counter.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "kitchen",
        name: "Kitchen (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-kitchen.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "bonsai",
        name: "Bonsai (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-bonsai.ply",
        dataset: "mip360",
        demo: false,
    },
    {
        id: "truck",
        name: "Truck (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-truck.ply",
        dataset: "tnt",
        demo: true,
        points: 273169,
    },
    {
        id: "train",
        name: "Train (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-train.ply",
        dataset: "tnt",
        demo: false,
    },
    {
        id: "drjohnson",
        name: "DrJohnson (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-drjohnson.ply",
        dataset: "db",
        demo: true,
        points: 432000,
    },
    {
        id: "playroom",
        name: "Playroom (r7 QPLY)",
        file: "scenes/point_cloud_quantised_half_r7-playroom.ply",
        dataset: "db",
        demo: false,
    },
];

/** 站点清单：默认场景（`bench-scenes.json`）与第7章对比方法场景（`baseline-scenes.json`）合并。 */
export const MANIFEST_URLS = ["./bench-scenes.json", "./baseline-scenes.json"];

/** 读取并合并清单；任一清单不可达时跳过，全部不可达时退回内置 FALLBACK_SCENES。 */
export async function loadManifest(): Promise<SceneMeta[]> {
    const merged: SceneMeta[] = [];
    for (const url of MANIFEST_URLS) {
        try {
            const res = await fetch(url);
            if (!res.ok) continue;
            const json = (await res.json()) as { scenes?: SceneMeta[] };
            if (Array.isArray(json.scenes)) merged.push(...json.scenes);
        } catch {
            /* dev 模式下静态清单可能不可达，跳过该清单 */
        }
    }
    return merged.length > 0 ? merged : FALLBACK_SCENES;
}
export function sceneById(list: SceneMeta[], id: string): SceneMeta | undefined {
    return list.find((s) => s.id === id);
}
export function expandProfile(list: SceneMeta[], profile: string): string[] {
    if (profile === "full") return list.filter((s) => !s.baseline).map((s) => s.id);
    if (profile === "mip360" || profile === "tnt" || profile === "db") {
        return list.filter((s) => !s.baseline && s.dataset === profile).map((s) => s.id);
    }
    if (profile === "quick") {
        return ["garden", "truck", "drjohnson"].filter((id) => sceneById(list, id) && !sceneById(list, id)?.baseline);
    }
    if (profile === "reduced3dgs") return list.filter((s) => s.baseline === "reduced-3dgs").map((s) => s.id);
    return [];
}

// ------------------------------------------------------------------ 设备信息（纯计算：由调用方把 GL renderer 名传进来）
export function deviceInfo(glRenderer: string): Record<string, string | number> {
    const chip = guessChip(glRenderer);
    return {
        ua: navigator.userAgent,
        gl_renderer: glRenderer,
        vendor: chip.vendor,
        chip: chip.chip,
        screen: `${window.screen.width}x${window.screen.height}`,
        dpr: window.devicePixelRatio || 1,
        hardwareConcurrency: navigator.hardwareConcurrency || 0,
        deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory || 0,
        timestamp: new Date().toISOString(),
    };
}
export function shortDeviceLabel(glRenderer: string): string {
    return glRenderer ? guessChip(glRenderer).chip : "GPU 名待读取…";
}
export function defaultUserLabel(glRenderer: string): string {
    return param("u") || chipSlug(glRenderer);
}

// ------------------------------------------------------------------ 结果与状态
/** 单轮结果。前 14 个字段与旧 bench.ts 完全同名同义（论文口径不变）；
 *  `jobId` / `retryCount` / `contextLost` / `disposeMs` / `iframeCreateMs` 是 iframe 改造新增的**诊断**字段，
 *  不参与 fps / first_frame_ms / fetch_ms / parse_ms 的任何计算。 */
export interface RoundResult {
    scene: string;
    /** 场景所属数据集（mip360/tnt/db）：与 bench-flux 臂同名字段，供 tools/ch7_baseline_report.py 分组 */
    dataset?: string;
    round: number;
    ts: string;
    ok: boolean;
    err?: string;
    drawOk?: boolean;
    coveredPct?: number;
    keptPct?: number;
    points?: number;
    bytes?: number;
    fetchMs?: number;
    parseMs?: number;
    firstFrameMs?: number;
    fps?: number;
    cpuMs?: number;
    /** 本轮实际使用的像素焦距（结果头 fx= 取自它，与旧口径"打印相机真实 fx"一致） */
    fx?: number;
    /** 本轮实际渲染分辨率（核对用；父页表头 res= 仍是请求值） */
    resW?: number;
    resH?: number;
    /** 本轮实际使用的 GL renderer 名（与结果头 gl_renderer 同源） */
    gl?: string;
    /** 本轮 iframe 的任务号（诊断：用于区分失败轮次与重试轮次） */
    jobId?: string;
    /** 本轮建 WebGL2 上下文用了几次尝试（诊断：>1 说明设备上一轮回收不干净） */
    ctxCreate?: number;
    /** 本轮是否主动调用了 loseContext()（诊断） */
    loseCtx?: boolean;
    /** 重试次数（0 = 首次即成功/失败，1 = 重试了一次） */
    retryCount?: number;
    /** 重试前那一轮的失败原因（诊断，只记录字符串，不与重试轮数据拼接） */
    prevErr?: string;
    /** 本轮是否遇到 WebGL 上下文丢失 */
    contextLost?: boolean;
    /** 子页面释放资源耗时（诊断，不计入任何性能指标） */
    disposeMs?: number;
    /** 父页面创建 iframe 到子页面 ready 的耗时（诊断，不计入任何性能指标） */
    iframeCreateMs?: number;
    /** 本轮生命周期轨迹（诊断，空格已替换为下划线）：create/ready/result/dispose/ack 的相对毫秒 */
    trace?: string;
    /** 测帧驱动方式（诊断）：raf = 每个 requestAnimationFrame 渲染一帧（默认）；timer = 旧 setTimeout(0) 链 */
    driver?: string;
    /** 本轮实际完成的测帧数（应等于 frames 参数） */
    frames?: number;
    /** 测帧区间墙钟毫秒（FPS = frames / elapsedMs*1000） */
    elapsedMs?: number;
    /** 测帧区间内 frameRender() 的真实调用次数（应等于 frames） */
    renders?: number;
    /** 相邻测帧间隔的中位/最小/最大毫秒（诊断：间隔过小说明没有真正提交帧） */
    gapMedMs?: number;
    gapMinMs?: number;
    gapMaxMs?: number;
    /** 预热阶段墙钟毫秒 */
    warmupMs?: number;
    /** 首帧像素验证得到的覆盖率（?validateframe=1；验证发生在测帧之前，不计入 FPS） */
    firstFrameCoveredPct?: number;
    /** 首帧验证用掉了几个渲染帧才通过（>1 说明"第一帧还没画完"，属正常时序） */
    validateFramesUsed?: number;
    /** CPU 侧可见性探针：模型顶点经当前 viewProj 后落在裁剪盒内的采样比例（0 表示相机看不到模型） */
    visibilityInsidePct?: number;
    /** 本轮时间线（诊断）：mark 名:相对毫秒，用 / 分隔 */
    timeline?: string;
}

export interface BenchState {
    v: number;
    busy: boolean;
    u: string;
    sceneIds: string[];
    rounds: number;
    cold: boolean;
    resW: number;
    resH: number;
    benchFrames: number;
    idx: number;
    roundDone: number;
    results: RoundResult[];
    started: number;
}

export const STATE_KEY = "gsm-bench-v1";
export const ARCHIVE_KEY = "gsm-bench-archive-v1";

// ------------------------------------------------------------------ 父子消息协议（iframe 隔离测试）
/** 子页面文件名（与父页面同目录，GitHub Pages 相对路径部署下可用）。 */
export const CASE_PAGE = "./bench-case.html";

/** 单个 job 的完整描述：一个 job = 一个场景的一轮（或该轮的一次重试）。 */
export interface CaseJobSpec {
    /** 全局唯一任务号：父页面生成，用于丢弃上一轮的迟到消息 */
    jobId: string;
    sceneId: string;
    /** 场景所属数据集（mip360/tnt/db）：原样带进子页面，写进本轮结果 */
    dataset: string;
    round: number;
    /** 0 = 首次执行，1 = 该轮的唯一一次重试 */
    attempt: number;
    /** 本轮真正要 fetch 的模型 URL（已带 ts= 令牌，与旧口径完全一致） */
    modelUrl: string;
    /** cache-busting 令牌：子页面用它从 Resource Timing 里定位本轮的下载段 */
    token: string;
}

/** 父页面创建 job 时额外带上运行态口径（子页面从 URL 读回，因此续跑时也不会与父页表头分叉）。 */
export interface CaseJobRequest extends CaseJobSpec {
    resW: number;
    resH: number;
    frames: number;
}

/** 子页面阶段（仅用于 UI 显示，不参与计时）。 */
export type CasePhase = "boot" | "loading" | "sorting" | "measuring" | "done" | "disposing";

/** 子页面写入日志的阶段标记（父页面把它转发到自己的控制台，便于把一轮的生命周期对齐看）。 */
export type CaseLogPhase = "boot" | "load" | "sort" | "measure" | "result" | "dispose" | "contextlost" | "error";

/** 子页面 → 父页面。所有消息都必须带 jobId。 */
export type CaseToParentMessage =
    | { type: "bench-case-ready"; jobId: string; resW: number; resH: number; glRenderer: string }
    | { type: "bench-case-progress"; jobId: string; phase: CasePhase; detail?: string }
    | { type: "bench-case-log"; jobId: string; phase: CaseLogPhase; message: string }
    | { type: "bench-case-result"; jobId: string; result: RoundResult }
    | { type: "bench-case-error"; jobId: string; code: string; message: string; contextLost: boolean }
    | { type: "bench-case-disposed"; jobId: string; disposeMs: number };

/** 父页面 → 子页面。 */
export type ParentToCaseMessage =
    { type: "bench-case-dispose"; jobId: string } | { type: "bench-case-abort"; jobId: string; reason?: string };

/** 错误码：父页面据此判断能否重试（`CONTEXT_LOST_WEBGL` 与超时允许重试一次）。 */
export const ERR_CONTEXT_LOST = "CONTEXT_LOST_WEBGL";
export const ERR_WEBGL_UNAVAILABLE = "WEBGL2_UNAVAILABLE";
export const ERR_LOAD_FAILED = "LOAD_FAILED";
export const ERR_MEASURE_FAILED = "MEASURE_FAILED";
export const ERR_READY_TIMEOUT = "READY_TIMEOUT";
export const ERR_RESULT_TIMEOUT = "RESULT_TIMEOUT";
export const ERR_ABORTED = "ABORTED";

// ------------------------------------------------------------------ 超时与轮间回收（都不计入任何性能指标）
/** 子页面启动（HTML/JS/wasm 就位 + 建出上下文）的上限。 */
export const CASE_READY_TIMEOUT_MS = 90000;
/** 单轮测量上限（模型下载 + 解码 + 排序首帧 + 测帧），`?jobtimeout=ms` 可覆盖。 */
export const CASE_RESULT_TIMEOUT_DEFAULT_MS = 300000;
/** 等子页面回报 bench-case-disposed 的上限；超时则强制删 iframe。 */
export const CASE_DISPOSE_TIMEOUT_MS = 15000;
/** 失败（含上下文丢失）自动重试当前 job 的次数上限：1 次，不允许无限重试。 */
export const CASE_RETRY_LIMIT = 1;
/** 销毁旧 iframe 后到创建新 iframe 之间的固定回收间隔（ms）：
 *  让"旧上下文的显存归还"与"新上下文的创建"在时间上确定地分开，避免新上下文撞上还没还完的显存。
 *  这段等待（以及 iframe 创建/销毁）都在测量区间之外，不计入 fetch/parse/首帧/FPS。
 *  `?recyclems=` 可覆盖。 */
export const CASE_RECYCLE_DEFAULT_MS = 1000;
/** 轮间回收等待：`?recyclems=` 覆盖，默认 1000ms（两帧 RAF 之外再等这段）。 */
export function recycleDelayMs(_cold: boolean): number {
    const raw = param("recyclems", "");
    const n = raw === "" ? NaN : parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
    return CASE_RECYCLE_DEFAULT_MS;
}

/**
 * 一个顶层文档内最多跑几个 job，超过就保存断点 + `location.replace()` 整页重启（默认 4）。
 *
 * 为什么需要：移动端浏览器的 WebGL context 配额/回收很紧——"每轮新建 context + 删除 iframe"
 * 在第 8~9 个任务时会让 `canvas.getContext('webgl2')` 开始返回 **null**（不是 context lost）。
 * 整页重启走的是浏览器自己的文档销毁路径，能把这一个文档内累积的 context/显存/worker 一起确定性回收。
 * 整页重启发生在**测量之后**，不影响任何指标；进度落在 sessionStorage，重启后自动续跑。
 *
 * `?perpage=1` = 每轮都重启（最保守）；`?perpage=0` = 完全重启；`?docjobs=N` = 自定义 N。
 */
export const MAX_JOBS_PER_DOCUMENT_DEFAULT = 4;
export function jobsPerDocument(): number {
    const p = param("perpage", "");
    if (p === "1") return 1;
    if (p === "0") return 0;
    const n = parseInt(param("docjobs", String(MAX_JOBS_PER_DOCUMENT_DEFAULT)), 10);
    return Number.isFinite(n) && n >= 0 ? n : MAX_JOBS_PER_DOCUMENT_DEFAULT;
}

/** 整页重启时附加在**页面 URL** 上的参数（绝不加进模型 URL，避免污染 cold/cache 协议）。 */
export const PAGE_RESTART_PARAM = "_doc";
export const PAGE_RETRY_PARAM = "_docretry";
/** 因"拿不到 WebGL 上下文"整页重启后，新页面等这么久再开跑（让 GPU 进程把上一个文档的资源放掉）。 */
export const CASE_DOC_RETRY_DELAY_MS = 1500;

/**
 * 生成"整页重启"的 URL：同一个页面地址 + 一个新的 `_doc` 令牌（只改动页面 URL 的查询串）。
 * `withDocRetry` = true 时附带 `_docretry=1`，表示这一轮已经用掉了"整页重试一次"的额度。
 * 注意 `crypto.randomUUID()` 只在安全上下文可用，局域网 http 访问时必须回退到时间戳+随机串。
 */
export function restartPageUrl(withDocRetry: boolean): string {
    const url = new URL(location.href);
    let token: string;
    try {
        token =
            typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                ? crypto.randomUUID()
                : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    } catch {
        token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }
    url.searchParams.set(PAGE_RESTART_PARAM, token);
    if (withDocRetry) {
        url.searchParams.set(PAGE_RETRY_PARAM, "1");
    } else {
        url.searchParams.delete(PAGE_RETRY_PARAM);
    }
    return url.href;
}
export function jobTimeoutMs(): number {
    const n = parseInt(param("jobtimeout", "0"), 10);
    return Number.isFinite(n) && n > 0 ? n : CASE_RESULT_TIMEOUT_DEFAULT_MS;
}

/**
 * 每轮是否"整页重启"（默认开启，`?perpage=0` 关闭）。
 *
 * 为什么默认开启：手机上"同一个顶层文档内连续新建 iframe"跑到第 2~3 轮时，
 * `canvas.getContext('webgl2')` 会开始返回 **null**（不是 context lost）——这是设备级 GPU 资源上限，
 * 清理与等待都救不回来。旧的 `cold=1` 口径本来就是**每轮整页刷新**，因此"每轮整页重启"既更稳、
 * 也更贴近原协议；测量本身仍在一个全新的子 iframe 里完成，重启发生在测量**之后**，
 * iframe 创建/销毁/重启都不计入任何性能指标。进度落在 sessionStorage，重启后自动续跑。
 */
export function perPageMode(): boolean {
    return param("perpage", "1") !== "0";
}

/** 同源 postMessage 的目标 origin：`file://` 下 origin 为 "null"（直接传会抛错），退回 "*"。
 *  接收端仍然做同源 + event.source + jobId 三重校验，因此不会因此放宽信任边界。 */
export function postTo(target: Window | null, message: CaseToParentMessage | ParentToCaseMessage): void {
    if (!target) return;
    const origin = location.origin;
    try {
        target.postMessage(message, !origin || origin === "null" ? "*" : origin);
    } catch {
        /* ignore */
    }
}

/** 父页面：把 job 拼成子页面 URL。**整份父页面查询参数原样透传**，
 *  这样子页面的 `location.search` 与旧 bench.ts 的页面级 search 等价
 *  （`?cull=1` 之类由渲染器直接读 location.search 的开关因此行为不变）。 */
export function buildCasePageUrl(spec: CaseJobRequest): string {
    const url = new URL(CASE_PAGE, location.href);
    for (const [k, v] of new URLSearchParams(location.search)) {
        url.searchParams.set(k, v);
    }
    url.searchParams.set("jobId", spec.jobId);
    url.searchParams.set("scene", spec.sceneId);
    url.searchParams.set("dataset", spec.dataset);
    url.searchParams.set("round", String(spec.round));
    url.searchParams.set("attempt", String(spec.attempt));
    url.searchParams.set("token", spec.token);
    url.searchParams.set("model", spec.modelUrl);
    // 用运行态覆盖 res/frames：resume 续跑（URL 里没有参数）时子页面与父页面口径仍然一致
    url.searchParams.set("res", `${spec.resW}x${spec.resH}`);
    url.searchParams.set("frames", String(spec.frames));
    return url.href;
}

/** 子页面：从自身 URL 读回 job 描述。缺 jobId/model 时返回 null（调用方报 error 并释放）。 */
export function caseSpecFromUrl(): CaseJobSpec | null {
    const jobId = param("jobId");
    const sceneId = param("scene");
    const modelUrl = param("model");
    if (!jobId || !sceneId || !modelUrl) return null;
    return {
        jobId,
        sceneId,
        dataset: param("dataset", ""),
        round: parseInt(param("round", "1"), 10) || 1,
        attempt: parseInt(param("attempt", "0"), 10) || 0,
        modelUrl,
        token: param("token", ""),
    };
}
