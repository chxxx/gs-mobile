/**
 * bench-case.ts — 单个「场景 × 轮次」的隔离测量子页面（父页面 bench.html 每轮新建一个 iframe，用完即销毁）。
 *
 * 本页只做一件事：按 URL 里的 job 描述，用自己的 canvas / WebGLRenderer / Scene / Camera / Worker
 * 跑完**一轮**测量，把结果用 postMessage 交给父页面；然后等父页面的 dispose 指令，释放全部资源并回报。
 *
 * 为什么必须这样拆：手机端在同一个 document 里复用 WebGL 上下文/显存时，第二轮或切场景会撞上
 * `CONTEXT_LOST_WEBGL: loseContext: context lost`。把"一轮"限制在一个**独立文档**里，并在轮末
 * 显式释放 + 主动丢失上下文（`WEBGL_lose_context.loseContext()`），"释放旧上下文"和"创建新上下文"
 * 就变成两个确定性事件，而不是等浏览器几轮之后才 GC。
 *
 * 日志约定（父页面会把子页面的日志转发进同一个控制台时间线）：
 *   `[case][job=<jobId>][phase] message`
 *   phase ∈ boot | load | sort | measure | result | dispose | contextlost | error
 * 于是"这条 CONTEXT_LOST_WEBGL 属于旧轮的清理还是本轮的真实崩溃"可以直接由同一行的
 * `disposed=` / `resultSent=` 判断。
 *
 * 调试开关（父页面链接里的参数会原样透传到这里）：
 *   `?ctxlosttest=1`  attempt=0 时故意丢一次上下文，验证"失败 → 销毁旧 iframe → 整轮重试"链路；
 *   `?losectx=0`      关闭轮末的主动 loseContext（默认开启，见 bench-measure.dispose 注释）。
 */
import { BenchCase, measureOneRound } from "./bench-measure";
import {
    CAM_FLUX,
    ERR_CONTEXT_LOST,
    ERR_WEBGL_UNAVAILABLE,
    benchFrameCount,
    caseSpecFromUrl,
    param,
    postTo,
    resolution,
    sleep,
    warmupFrames,
} from "./bench-shared";
import type { CaseLogPhase, CasePhase, CaseToParentMessage, ParentToCaseMessage, SceneMeta } from "./bench-shared";

/** 上下文创建的尝试等待序列。**默认只用第 1 次**（`CTX_RETRY_DELAYS_MS[0]`）： */
/** 移动端 context 配额耗尽时，同一文档内 0/400/900ms 的快速重试基本无效，且每次重试都会新建 canvas，
 *  反而更糟。现在的策略是"这个文档建不出来 → 交给父页面保存断点 + 整页重启再试一次"。
 *  只有显式 `?ctxretry=1`（调试用）才恢复三次重试。 */
const CTX_RETRY_DELAYS_MS = [0, 400, 900];
const CTX_ATTEMPTS = param("ctxretry") === "1" ? CTX_RETRY_DELAYS_MS.length : 1;
/** `?ctxlosttest=1` 的强制丢失延迟：足够让模型开始下载，落到"加载/排序"这段里。 */
const FORCED_LOSS_DELAY_MS = 600;

let jobId = "";
let disposed = false;
let contextLost = false;
let resultSent = false;
let caseCtx: BenchCase | null = null;
let canvas: HTMLCanvasElement | null = null;
let forcedLossTimer = 0;
/** 取消 fetch/读取/解码：dispose 时 abort，避免旧轮的网络与内存占用拖到下一轮 */
let loadAbort: AbortController | null = null;
/** 建上下文用了几次尝试（诊断：>1 说明设备上一轮回收不干净） */
let ctxAttempts = 0;
/** 子页面启动时刻（日志里的相对时间，纯诊断） */
const tBoot = performance.now();

// ------------------------------------------------------------------ 上报与日志
function report(message: CaseToParentMessage): void {
    postTo(window.parent, message);
}
function reportProgress(next: CasePhase, detail?: string): void {
    report({ type: "bench-case-progress", jobId, phase: next, detail });
}
function reportError(code: string, message: string): void {
    report({ type: "bench-case-error", jobId, code, message, contextLost });
}
/** 本页日志：同时写本页控制台并转发给父页面，保证一个控制台里能看到完整时间线。 */
function log(phase: CaseLogPhase, message: string): void {
    console.log(`[case][job=${jobId}][${phase}] ${message} (+${Math.round(performance.now() - tBoot)}ms)`);
    report({ type: "bench-case-log", jobId, phase, message });
}
/** 同源判定：http(s) 下严格比对 origin；`file://` 下 Chrome 给的是 "null"，两边都放宽。 */
function sameOrigin(origin: string): boolean {
    const mine = location.origin;
    return origin === mine || (mine === "null" && (origin === "null" || origin === ""));
}

// ------------------------------------------------------------------ 上下文丢失
/**
 * WebGL 上下文丢失。
 *   - `disposed === true`：属于**本轮主动清理**（disposeCase 里的 loseContext）产生的正常事件，只记录不判失败；
 *   - 测量中丢失：本轮立即判失败——停止渲染、上报 CONTEXT_LOST_WEBGL、释放本 iframe 的资源。
 * 任何情况下都**不在同一个 iframe 里恢复上下文后继续计帧**（那会把抖动混进帧率）。
 */
function onContextLost(event: Event): void {
    event.preventDefault();
    const duringDispose = disposed;
    contextLost = true;
    clearForcedLoss();
    if (caseCtx) caseCtx.stopped = true; // 停帧：后续 frameRender() 全部空转
    log("contextlost", `webglcontextlost disposed=${disposed} resultSent=${resultSent} duringDispose=${duringDispose}`);
    if (duringDispose) return; // 主动清理引起的丢失：正常路径，不判失败、不重复清理
    if (!resultSent) {
        resultSent = true;
        reportError(ERR_CONTEXT_LOST, "WebGL 上下文丢失（CONTEXT_LOST_WEBGL）");
    }
    void disposeCase("context-lost");
}

// ------------------------------------------------------------------ 清理（幂等）
function clearForcedLoss(): void {
    if (forcedLossTimer) {
        clearTimeout(forcedLossTimer);
        forcedLossTimer = 0;
    }
}
/** 调试用：按 ?ctxlosttest=1 主动丢一次上下文，触发真实的上报/清理/重试链路。 */
function forceContextLoss(): void {
    try {
        const gl = canvas?.getContext("webgl2") as WebGL2RenderingContext | null;
        const ext = gl?.getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
    } catch {
        /* ignore */
    }
}

/**
 * 幂等清理：无论成功、失败、超时、context lost 还是被 abort，都可以安全调用（重复调用直接返回）。
 * 顺序：停止标志 → 计时器 → 事件监听 → 取消 fetch → controls/GPU/Worker（BenchCase.dispose）→
 *      断开大对象引用 → 通知父页面 disposed。
 * 注：本页测帧用 `setTimeout(0)` 链驱动（与旧 bench.ts 一致），**不使用 requestAnimationFrame**；
 * 若将来引入 RAF，请在此处一并 cancel（bench-view.ts 的 view 循环就是这样做的）。
 */
async function disposeCase(reason: string): Promise<void> {
    if (disposed) {
        log("dispose", `重复调用 disposeCase(${reason}) —— 已幂等忽略`);
        return;
    }
    disposed = true;
    reportProgress("disposing", reason);
    let disposeMs = 0;
    try {
        window.removeEventListener("message", onMessage);
        clearForcedLoss();
        canvas?.removeEventListener("webglcontextlost", onContextLost);
        try {
            loadAbort?.abort(); // 取消仍在进行的下载/读取/解码
        } catch {
            /* ignore */
        }
        loadAbort = null;
        if (caseCtx) {
            // renderer.dispose()：终止 SortWorker + RenderData worker，删除全部 texture/buffer/program/shader；
            // 随后主动 loseContext()，让这一个上下文的显存立刻进入回收流程
            disposeMs = caseCtx.dispose();
            log(
                "dispose",
                `资源已释放 disposeMs=${disposeMs.toFixed(1)} loseContext=${caseCtx.loseContextCalled ? 1 : 0}`,
            );
        }
    } catch (err) {
        log("dispose", `释放过程出错（已忽略）：${err instanceof Error ? err.message : String(err)}`);
    }
    caseCtx = null;
    canvas = null;
    log("dispose", `完成 reason=${reason}`);
    report({ type: "bench-case-disposed", jobId, disposeMs });
}

// ------------------------------------------------------------------ 父页面消息
/** 只接受"同源 + 来自父窗口 + jobId 一致"的消息，避免上一轮的迟到消息影响本轮。 */
function onMessage(event: MessageEvent): void {
    if (!sameOrigin(event.origin)) return;
    if (event.source !== window.parent) return;
    const data = event.data as ParentToCaseMessage | undefined;
    if (!data || typeof data !== "object" || data.jobId !== jobId) return;
    if (data.type === "bench-case-dispose") {
        void disposeCase("dispose");
        return;
    }
    if (data.type === "bench-case-abort") {
        if (caseCtx) caseCtx.stopped = true;
        void disposeCase(`abort:${data.reason ?? ""}`);
    }
}

// ------------------------------------------------------------------ 建上下文（换 canvas 重试）
function freshCanvas(previous: HTMLCanvasElement): HTMLCanvasElement {
    const next = document.createElement("canvas");
    next.id = previous.id;
    next.className = previous.className;
    next.addEventListener("webglcontextlost", onContextLost);
    previous.removeEventListener("webglcontextlost", onContextLost);
    previous.replaceWith(next);
    return next;
}

/** 建出渲染器。默认只尝试一次（见 CTX_ATTEMPTS）：建不出来就直接回报，由父页面整页重启再试。 */
async function createCaseWithRenderer(first: HTMLCanvasElement): Promise<BenchCase | null> {
    let target = first;
    let lastError = "";
    for (let i = 0; i < CTX_ATTEMPTS; i++) {
        const delay = CTX_RETRY_DELAYS_MS[i] ?? 0;
        if (delay > 0) await sleep(delay);
        if (disposed) return null;
        ctxAttempts = i + 1;
        if (i > 0) target = freshCanvas(target);
        try {
            const ctx = new BenchCase(target);
            // bench 测量路径：**不挂 FadeInPass**（两臂架构对等，结果头 fade=none）。
            // 原因见 bench-measure.BenchCase.createRenderer 的注释；展示路径（bench-view）传 true。
            ctx.createRenderer(false);
            canvas = target;
            log("boot", `WebGL2 上下文创建成功（第 ${i + 1}/${CTX_ATTEMPTS} 次，等待 ${delay}ms）`);
            return ctx;
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            log("boot", `第 ${i + 1}/${CTX_ATTEMPTS} 次创建 WebGL2 上下文失败：${lastError}`);
        }
    }
    return null;
}

// ------------------------------------------------------------------ 主流程
async function main(): Promise<void> {
    const spec = caseSpecFromUrl();
    if (!spec) {
        reportError("NO_JOB", "缺少 jobId/scene/model 参数：本页只能由 bench.html 以 iframe 方式打开");
        return;
    }
    jobId = spec.jobId;
    window.addEventListener("message", onMessage);
    log("boot", `job 开始 scene=${spec.sceneId} dataset=${spec.dataset} round=${spec.round} attempt=${spec.attempt}`);

    const first = document.getElementById("case-canvas") as HTMLCanvasElement | null;
    if (!first) {
        reportError("NO_CANVAS", "缺少 canvas 元素");
        return;
    }
    first.addEventListener("webglcontextlost", onContextLost);
    canvas = first;

    const ctx = await createCaseWithRenderer(first);
    if (!ctx) {
        reportError(ERR_WEBGL_UNAVAILABLE, "WebGL2 不可用：canvas.getContext('webgl2') 返回 null 或渲染器初始化失败");
        await disposeCase("webgl-unavailable");
        return;
    }
    caseCtx = ctx;
    ctx.applyFocalFromParam();
    if (CAM_FLUX) await ctx.loadFluxCamera(); // 三方同视角：读 Flux-GS 原相机（取不到则回退包围盒取景）
    if (disposed) return;

    const res = resolution();
    report({
        type: "bench-case-ready",
        jobId,
        resW: res.w,
        resH: res.h,
        glRenderer: ctx.glRendererName(),
    });
    log("boot", `ready res=${res.w}x${res.h} gl=${ctx.glRendererName() || "unknown"}`);
    // 此时还没有调用 setBenchmarkResolution（它在每轮 measureOneRound 里做），所以这里只报告尺寸；
    // 真正的"后备缓冲 == res"断言在 scale-set 打点处（见 measureOneRound）。
    log("boot", ctx.canvasStatsLine());

    // 调试开关：attempt=0 时故意丢一次上下文（重试轮不丢，便于验证"失败一次→重试成功"）
    if (param("ctxlosttest") === "1" && spec.attempt === 0) {
        forcedLossTimer = window.setTimeout(forceContextLoss, FORCED_LOSS_DELAY_MS);
        log("boot", `?ctxlosttest=1：${FORCED_LOSS_DELAY_MS}ms 后强制丢失一次上下文（调试用）`);
    }

    loadAbort = new AbortController();
    const meta: SceneMeta = {
        id: spec.sceneId,
        name: spec.sceneId,
        file: spec.modelUrl,
        dataset: spec.dataset,
        demo: false,
    };
    reportProgress("loading");
    log("load", `开始加载 ${spec.modelUrl}`);
    const result = await measureOneRound(ctx, meta, spec.round, {
        modelUrl: spec.modelUrl,
        token: spec.token,
        resW: res.w,
        resH: res.h,
        frames: benchFrameCount(),
        warmup: warmupFrames(),
        signal: loadAbort.signal,
        onPhase: (p) => {
            reportProgress(p);
            log(p === "loading" ? "load" : p === "sorting" ? "sort" : "measure", `阶段进入 ${p}`);
        },
        // 时间线打点：逐条写日志（父页面会转发进同一个控制台），便于逐轮核对"到底跑到哪一步"
        onMark: (name, detail) => log("measure", `timeline:${name}${detail ? " " + detail : ""}`),
    });
    clearForcedLoss();
    if (disposed || resultSent) {
        log("result", `本轮结果不再上报（disposed=${disposed} resultSent=${resultSent}）`);
        return;
    }

    result.jobId = jobId;
    result.contextLost = contextLost;
    result.ctxCreate = ctxAttempts;
    result.loseCtx = caseCtx ? caseCtx.loseContextCalled : false;
    resultSent = true;
    log(
        "result",
        `ok=${result.ok ? 1 : 0} driver=${result.driver ?? "-"} frames=${result.frames ?? 0} ` +
            `elapsed_ms=${result.elapsedMs === undefined ? "-" : result.elapsedMs.toFixed(0)} ` +
            `renders=${result.renders ?? 0} fps=${result.fps ?? "-"} ff_covered=${result.firstFrameCoveredPct ?? "-"} ` +
            `covered=${result.coveredPct ?? "-"} err=${result.err ?? ""}`,
    );
    reportProgress("done", result.ok ? "" : result.err);
    report({ type: "bench-case-result", jobId, result });
}

window.addEventListener("DOMContentLoaded", () => {
    // 任何未捕获异常都按"本轮失败"上报并就地释放，绝不让父页面一直等下去
    void main().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log("error", `子页面异常：${message}`);
        if (!resultSent) {
            resultSent = true;
            reportError("CASE_CRASH", `子页面异常：${message}`);
        }
        void disposeCase("crash");
    });
    // 兜底：父窗口若已经消失（例如被强制关掉），本页无从等待 dispose，直接自行清理
    window.addEventListener("pagehide", () => {
        if (!disposed) void disposeCase("pagehide");
    });
});
