/**
 * bench.ts — 3DGS 网页性能测试页（独立于 index.html demo）。
 *
 * 模式：
 *   mode=bench  自动测试。**父页面只做测试队列/UI/状态/结果，绝不创建 WebGL 上下文**：
 *               每一个「场景 × 轮次」都由一个全新 iframe（bench-case.html）独立完成测量，
 *               测完 → 子页面释放自己的 GL/Worker/场景 → 父页面销毁该 iframe → 等待回收间隔 → 下一轮新建 iframe。
 *   mode=view   展示浏览。只有这个模式会创建 renderer（bench-view.ts 由 main() 动态 import），
 *               可自由旋转缩放、FPS/信息叠加，供截图与录屏。
 *
 * 为什么 bench 模式必须做 iframe 隔离：手机端在同一个 document 里连续复用 WebGL 上下文/显存/WASM 堆时，
 * 第二轮或切换场景会撞上 `CONTEXT_LOST_WEBGL: loseContext: context lost`；而 bench-flux.html 采用
 * "父页面调度 + 每轮新建 iframe + 用完销毁"的方式连续跑就不会崩。本页改成与它同构的生命周期。
 *
 * URL：bench.html?mode=bench&profile=quick|full|mip360|tnt|db&rounds=3&cold=1&u=xxx&res=1600x1063
 *      bench.html?mode=view&scene=garden&fpsoverlay=1
 *
 * 外部测试者（自动回传，2026-09-17 追加）：
 *   `&report=<url>&rtok=<口令>` → 测完自动把 [RESULT] 文本 POST 到 `<url>?token=<口令>`，
 *   测试者只需"打开链接 → 等 → 关页面"；`rtok` 由分发链接带入，不写死在代码里（换口令只换链接）。
 *   接收端 = vite dev server 的 /__ch7/report 中间件（见 vite.config.js），落盘到
 *   thesis_project/data/ch7_measurements/raw/。口令不符时提交失败，页面会退回"手动复制"按钮。
 *
 * 诊断/调试参数（都不进任何性能指标）：
 *   ?diag=1          每轮结果里附加 job=/retry=/ctxlost=/iframe_ms=/dispose_ms=/trace=
 *   ?jobtimeout=ms   单轮上限，默认 300000
 *   ?recyclems=ms    轮间回收等待，默认 1000（两帧 RAF 之外再等这段）
 *   ?docjobs=N       一个顶层文档内最多跑几个 job，默认 4（`?perpage=1`=每轮重启、`?perpage=0`=不重启）；
 *                    手机端一个文档累积到 8~9 个 WebGL context 就会拿不到新上下文（getContext=null），
 *                    整页重启是唯一稳定的回收方式；重启在测量之后，不计入任何指标
 *   ?hop=0           关掉"整页重启必经的零上下文中转页"（默认**开启**，见 bench-shared.hopUrlFor）。
 *                    中转页 bench-hop.html 不建任何上下文/Worker：先把本页文档整个换掉，在那里停
 *                    hopms 毫秒（此期间渲染进程里零上下文），再进新页 —— 这一条是"手机端第 2~3 轮
 *                    建不出上下文"的历史修复，A/B 对照时才关掉
 *   ?hopms=N         中转页停留时长，默认 1500（上限 5000；`0` 等价于关闭）
 *   ?losectx=1       轮末额外主动 loseContext（**默认关闭**，见 bench-measure.dispose 注释）
 *   ?ctxretry=1      调试：同一文档内对建上下文做 0/400/900ms 三次重试（默认只试一次，失败交给整页重启）
 *   ?ctxlosttest=1   调试：每轮 attempt=0 时在子页面里故意丢失一次上下文，验证"失败 → 销毁旧 iframe → 重试"
 *   ?perpage=1       崩溃兜底：每轮把结果写入 sessionStorage 后 location.replace() 整页重启，
 *                    每个顶层文档只测一个 job（正常口径下用不到）
 *
 * 日志：父页面每条生命周期日志都带 jobId（`[bench][job=…][phase]`），子页面日志由父页面转发
 *      （`[case→parent][job=…][…]`）。因此控制台里出现 CONTEXT_LOST_WEBGL 时，直接看同一时刻的
 *      job 号就知道它属于"旧轮的清理"还是"本轮的真实崩溃"。
 */
import {
    ARCHIVE_KEY,
    BENCH_FADE_LABEL,
    CAM_FLUX,
    CASE_DISPOSE_TIMEOUT_MS,
    CASE_DOC_RETRY_DELAY_MS,
    CASE_READY_TIMEOUT_MS,
    CASE_RETRY_LIMIT,
    HOP_PAGE,
    PAGE_RETRY_PARAM,
    PROTO_FLUX,
    STATE_KEY,
    benchFrameCount,
    buildCasePageUrl,
    defaultUserLabel,
    deviceInfo,
    effectiveFocalPx,
    expandProfile,
    fmt,
    hopDelayMs,
    hopUrlFor,
    jobsPerDocument,
    jobTimeoutMs,
    loadManifest,
    median,
    param,
    postTo,
    restartPageUrl,
    recycleDelayMs,
    resolution,
    sceneById,
    shortDeviceLabel,
    sleep,
    spinRoundTags,
    submitReport,
    sweepRoundTags,
    throughputDriver,
    throughputFields,
    warmupFrames,
    // 结果字段法表 + 唯一的清洗/逐字段合并实现（见 bench-shared 顶部说明：这四处不再手工同步）
    copyRoundResultFields,
    sanitizeRoundResult,
    sceneBoundsRoundTags,
    sortLagRoundTags,
} from "./bench-shared";
import type { BenchState, CasePhase, CaseToParentMessage, RoundResult, SceneMeta } from "./bench-shared";
// 仅类型导入：view 模式的实现（含渲染器代码）由 main() 动态 import，bench 模式下不会被加载
import type { BenchView } from "./bench-view";

// ------------------------------------------------------------------ DOM
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("view");
const stDevice = $<HTMLElement>("st-device");
const stRes = $<HTMLElement>("st-res");
const stScene = $<HTMLElement>("st-scene");
const stProgress = $<HTMLElement>("st-progress");
const stPhase = $<HTMLElement>("st-phase");
const benchControls = $<HTMLElement>("bench-controls");
const viewControls = $<HTMLElement>("view-controls");
const progressRow = $<HTMLElement>("bench-progress");
const progressFill = $<HTMLElement>("bar-fill");
const fpsOverlay = $<HTMLElement>("fps-overlay");
const infoOverlay = $<HTMLElement>("info-overlay");
const statusBig = $<HTMLElement>("status-big");
const welcome = $<HTMLElement>("welcome");
const resultCard = $<HTMLElement>("result-card");
const rcText = $<HTMLTextAreaElement>("rc-text");
const rcSummary = $<HTMLElement>("rc-summary");
/** 结果卡底部那行提示（`report=` 模式下换成"结果会自动回传，无需任何操作"） */
const rcNote = $<HTMLElement>("rc-note");
const btnStart = $<HTMLButtonElement>("btn-start");
const btnStop = $<HTMLButtonElement>("btn-stop");
const btnStop2 = $<HTMLButtonElement>("btn-stop-2");
const btnCopy = $<HTMLButtonElement>("btn-copy");
const btnDone = $<HTMLButtonElement>("btn-done");
const btnExport = $<HTMLButtonElement>("btn-export");
const btnLoadView = $<HTMLButtonElement>("btn-load-view");
const btnResetView = $<HTMLButtonElement>("btn-reset-view");
const selProfile = $<HTMLSelectElement>("sel-profile");
const inpRounds = $<HTMLInputElement>("inp-rounds");
const selCold = $<HTMLSelectElement>("sel-cold");
const selViewScene = $<HTMLSelectElement>("sel-view-scene");
const ckOverlay = $<HTMLInputElement>("ck-overlay");
const ckInfo = $<HTMLInputElement>("ck-info");
/** 测试 iframe 的宿主（每次只放一个 iframe，且它同时就是"当前唯一的 WebGL 持有者"） */
const caseHost = $<HTMLElement>("case-host");
/** `?diag=1` 时的屏上自诊断行（几何 + 阶段 + 子页面最后一条日志） */
const diagLine = $<HTMLElement>("diag-line");
const DIAG = param("diag") === "1";

// ------------------------------------------------------------------ 父页面状态
/** 场景清单（父页面读清单只为了生成队列，不加载任何模型） */
let manifest: SceneMeta[] = [];
/** 子页面在 bench-case-ready 里上报的 GL renderer 名（父页面自己绝不建探测上下文） */
let glRendererReported = "";
/** 最近一轮子页面实际上报的像素焦距（结果头 fx= 用它，取不到才回退参数推导值） */
let focalPxReported = 0;
/** 当前活动 iframe 与其 jobId：任意时刻最多一个；jobId 用于丢弃上一轮的迟到消息 */
let activeIframe: HTMLIFrameElement | null = null;
let activeJobId = "";
let destroyInFlight: Promise<number> | null = null;
/** 子页面自己释放完毕（失败/上下文丢失路径）的 jobId：此时销毁阶段无需再等一遍 ack。 */
let selfDisposedJobId = "";
/** 让"当前正在等待结果的 job"立刻结束（停止测试用），避免白等到超时。 */
let abortPendingJob: ((code: string, message: string) => void) | null = null;
/** 当前运行的测试状态（子页面上报 GPU 名后回填 st.u 用） */
let currentState: BenchState | null = null;
/** 屏上自诊断行的状态：阶段文本 + 子页面最后一条日志 */
let lastPhaseText = "-";
let lastCaseLog = "";
let diagTimer = 0;
/** 本次收尾是否属于"设备上下文耗尽"（用于在结果卡上给出重启续跑提示） */
let ctxExhausted = false;
/** 当前顶层文档里已经跑完几个 job（刷新后归零；用于"每 N 轮整页重启"） */
let jobsInDoc = 0;
/** 本轮 job 是否已经用掉"整页重启重试一次"的额度（由 URL 上的 _docretry=1 传递，跨刷新有效） */
let docRetryUsed = param(PAGE_RETRY_PARAM) === "1";

/** 该轮失败是否属于"设备给不出 WebGL2 上下文"（getContext 返回 null）。 */
function isCtxUnavailable(r: RoundResult): boolean {
    return /WEBGL2_UNAVAILABLE/.test(r.err ?? "") || /返回 null/.test(r.err ?? "");
}

/** 日志里只显示 `bench*.html` 这一段（隐藏局域网主机名与查询串里的随机令牌）。 */
function shortUrl(u: string): string {
    return u.replace(/^.*\/(bench[^/?#]*)/, "$1");
}

/**
 * 保存断点后整页重启（`withDocRetry=true` 表示用掉"整页重试一次"的额度）。
 *
 * **经零上下文的中转页**（`bench-hop.html`）再进新页：本页文档连同它的上下文先被换掉，
 * 在中转页里停 `hopms`（默认 1500ms，此期间渲染进程里零 WebGL 上下文），然后才建新上下文。
 * 这一段（以及中转页停留）都在测量区间之外，不计入任何指标；`?hop=0` 退回"本页直接 replace"口径。
 */
function restartPage(withDocRetry: boolean): void {
    const target = restartPageUrl(withDocRetry);
    const url = hopUrlFor(target);
    logBench(
        "restart",
        url === target
            ? `整页重启（hop=0 直切）→ ${shortUrl(target)}`
            : `整页重启（经中转页 ${HOP_PAGE}，停 ${hopDelayMs()}ms）→ ${shortUrl(target)}`,
    );
    location.replace(url);
}
/** 父页面自己的生命周期日志：每行都带 jobId，便于把"旧轮清理"和"本轮崩溃"分开 */
function logBench(phase: string, message: string): void {
    console.log(`[bench][job=${activeJobId || "-"}][${phase}] ${message}`);
}
/** 把本轮的生命周期打点整理成一行诊断字符串（空格换成下划线，便于按 key=value 解析） */
function formatTrace(trace: Array<[string, number]>): string {
    return trace
        .map(([k, ms]) => `${k}=${Math.round(ms)}`)
        .join("/")
        .replace(/\s+/g, "_");
}

/**
 * 结果字段的清洗与逐字段合并**都在 bench-shared.ts**（唯一实现）：
 *   - 清洗：sanitizeRoundResult()  —— 只保留数字/字符串/布尔，绝不放行 Splat/RenderData/ArrayBuffer；
 *   - 合并：copyRoundResultFields() —— 遍历同一批字段表，把子页面上报的字段并进本轮结果。
 * 本文件里曾经各写一份（白名单一份 + 收尾逐字段拷贝一份），两处手工同步，2026-09-16~17 连续丢了四次
 * 字段（fpsCapped / frameMs / timeline / spinMode / sweep*），每次都是静默丢弃。现在字段只登记在
 * bench-shared 的 ROUND_RESULT_BASE/NUM/STR/BOOL_KEYS 四张表里，漏登记由编译期闸门 MissingResultKeys 拦住。
 */
/** 用户点了"停止测试" */
let stopRequested = false;
/** bench 模式是否正在跑（用于按钮禁用与"不允许两个活动 iframe"的断言） */
let running = false;
/** view 模式实例（只在 mode=view 下存在） */
let view: BenchView | null = null;

// ------------------------------------------------------------------ small utils
function el(id: string): HTMLElement {
    return document.getElementById(id) as HTMLElement;
}
/** 等两个 rAF：让当前这一帧（含 iframe 卸载/节点移除）确定被提交后，再创建下一个 iframe。 */
function twoFrames(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
}
/** 同源判定（与 bench-shared.postTo 的 targetOrigin 规则对应；file:// 下 origin 为 "null"）。 */
function isSameOrigin(origin: string): boolean {
    const mine = location.origin;
    return origin === mine || (mine === "null" && (origin === "null" || origin === ""));
}

// ------------------------------------------------------------------ 设备信息
/** 父页面没有任何 GL 对象：GPU 名一律来自子页面上报，取不到时显示"待读取"，绝不新建探测上下文。 */
function refreshDeviceLabel(): void {
    stDevice.textContent = shortDeviceLabel(glRendererReported);
}

// ------------------------------------------------------------------ session state
function loadState(): BenchState | null {
    try {
        const raw = sessionStorage.getItem(STATE_KEY);
        return raw ? (JSON.parse(raw) as BenchState) : null;
    } catch {
        return null;
    }
}
function saveState(st: BenchState): void {
    try {
        sessionStorage.setItem(STATE_KEY, JSON.stringify(st));
    } catch {
        /* ignore quota errors */
    }
}
function clearState(): void {
    try {
        sessionStorage.removeItem(STATE_KEY);
    } catch {
        /* ignore */
    }
}
function archiveState(st: BenchState): void {
    try {
        const prev = localStorage.getItem(ARCHIVE_KEY);
        const arr = prev ? (JSON.parse(prev) as BenchState[]) : [];
        arr.push(st);
        localStorage.setItem(ARCHIVE_KEY, JSON.stringify(arr));
    } catch {
        /* ignore */
    }
}

// ------------------------------------------------------------------ ui helpers
function updateProgress(done: number, total: number, sceneName: string, roundText: string): void {
    progressRow.classList.remove("hidden");
    welcome.classList.add("hidden");
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    progressFill.style.width = `${pct}%`;
    stProgress.textContent = `${done}/${total} 轮`;
    stScene.textContent = `${sceneName} · ${roundText}`;
}
function flashStatusBig(text: string): void {
    statusBig.textContent = text;
    statusBig.classList.remove("hidden");
}
const PHASE_TEXT: Record<CasePhase, string> = {
    boot: "启动子页面",
    loading: "加载模型",
    sorting: "等待排序/首帧",
    measuring: "FPS 采样",
    done: "本轮完成",
    disposing: "释放 GPU/Worker",
};
/** 阶段显示（纯 UI，不参与计时）。 */
function setPhaseText(phase: CasePhase, detail?: string): void {
    lastPhaseText = detail ? `${PHASE_TEXT[phase]}（${detail}）` : PHASE_TEXT[phase];
    stPhase.textContent = lastPhaseText;
}
/** 屏上自诊断行（只有 ?diag=1 才显示）：把"渲染区多大 / iframe 在哪 / 子页面画布多大 / 页面是否被撑高 /
 *  当前阶段与子页面最后一条日志"直接印出来，便于看不到渲染时一眼判断是布局问题还是子页面问题。 */
function startDiagLine(): void {
    if (!DIAG || diagTimer) return;
    diagLine.classList.remove("hidden");
    const tick = (): void => {
        const area = caseHost.parentElement;
        const frame = caseHost.querySelector("iframe");
        const rect = frame?.getBoundingClientRect();
        let childCanvas = "-";
        try {
            const c = frame?.contentWindow?.document?.querySelector("#case-canvas") as HTMLCanvasElement | null;
            if (c) childCanvas = `${c.width}x${c.height}（css ${c.clientWidth}x${c.clientHeight}）`;
        } catch {
            childCanvas = "(cross-origin)";
        }
        diagLine.textContent =
            `vp=${window.innerWidth}x${window.innerHeight} area=${area ? `${area.clientWidth}x${area.clientHeight}` : "-"} ` +
            `iframe=${rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.x)},${Math.round(rect.y)}` : "-"} ` +
            `childCanvas=${childCanvas} scrollH=${document.documentElement.scrollHeight} ` +
            `recycle=${jobsPerDocument() === 0 ? "不重启" : jobsPerDocument() === 1 ? "每轮整页重启" : `每 ${jobsPerDocument()} 轮整页重启`}\n` +
            `phase=${lastPhaseText} scene=${stScene.textContent} progress=${stProgress.textContent} job=${activeJobId || "-"}\n` +
            `last=${lastCaseLog || "-"}`;
    };
    tick();
    diagTimer = window.setInterval(tick, 500);
}
function setRunning(next: boolean): void {
    running = next;
    btnStart.disabled = next;
    btnStop.classList.toggle("hidden", !next);
    btnStop2.classList.toggle("hidden", !next);
    selProfile.disabled = next;
    inpRounds.disabled = next;
    selCold.disabled = next;
    // 测试期间收起顶栏与设置区，把高度让给渲染区；结束后恢复
    document.body.classList.toggle("running", next);
    if (!next) {
        stPhase.textContent = "-";
        lastPhaseText = "-";
    }
}
function totalRounds(st: BenchState): number {
    return st.sceneIds.length * st.rounds;
}

// ------------------------------------------------------------------ 结果文本（格式与旧版逐行一致，仅新增 frames=/isolation= 两行）
function buildResultText(st: BenchState): string {
    const env = deviceInfo(glRendererReported);
    const fx = focalPxReported > 0 ? focalPxReported : effectiveFocalPx();
    const lines: string[] = [];
    lines.push("[RESULT]");
    lines.push("engine=gsplat");
    lines.push(`u=${st.u}`);
    lines.push(`chip=${env.chip}`);
    lines.push(`vendor=${env.vendor}`);
    lines.push(`mode=bench`);
    lines.push(`isolation=iframe`);
    lines.push(`profile=${st.sceneIds.join(",")}`);
    lines.push(`rounds=${st.rounds}`);
    lines.push(`cold=${st.cold ? 1 : 0}`);
    lines.push(`res=${st.resW}x${st.resH}`);
    lines.push(`frames=${st.benchFrames}`);
    // 帧驱动与 FPS 定义：与 Flux-GS 臂**同名字段**（throughputFields 是两页共用的格式函数），
    // 报表脚本据此核对两臂口径一致；res_mode 用于把非统一像素协议的行挡在主表之外。
    // timer_floor_ms / sync_ms 取自各轮上报（真实值在子页面测得），取不到时写 "-"。
    const okRounds = st.results.filter((r) => r.ok);
    lines.push(
        ...throughputFields({
            driver: throughputDriver(),
            // 本文臂（含 reduced-3DGS 臂）恒为统一像素协议：bench-case 把后备缓冲钉死为 res
            resMode: "forced",
            timerFloorMs: median(okRounds.map((r) => r.timerFloorMs ?? 0).filter((v) => v > 0)),
            timerFloorRounds: okRounds.find((r) => r.timerFloorRounds)?.timerFloorRounds,
            timerFloorSrc: okRounds.find((r) => r.timerFloorSrc)?.timerFloorSrc,
            // sync_ms / sync_frames 取各轮中位数（**含 0**：GPU 很快时就是 0.00ms，过滤掉 0 会显示成 "-"）
            syncMs: median(okRounds.map((r) => r.syncMs).filter((v): v is number => typeof v === "number")),
            syncFrames: median(okRounds.map((r) => r.syncFrames).filter((v): v is number => typeof v === "number")),
            // 帧内阻塞耗时（2026-09-17 追加）：**漏传这两个字段就会显示成 `-`**
            // （与逐轮行同款坑：子页面算了、白名单登记了、拷贝点也拷了，最后在这一处汇总忘传）。
            frameMs: median(okRounds.map((r) => r.frameMs).filter((v): v is number => typeof v === "number")),
            frameMeanMs: median(okRounds.map((r) => r.frameMeanMs).filter((v): v is number => typeof v === "number")),
            fpsCapped: okRounds.some((r) => r.fpsCapped),
            // 动态相机（`?spin=`，效度自查）：与 Flux-GS 臂结果头同名字段，取各轮上报的**实际**应用量
            spinDeg: okRounds.find((r) => r.spinDeg)?.spinDeg,
            // 轨迹模式与峰值角速度（2026-09-17 追加）：`spin=` 的语义由 `spin_mode=` 决定
            // （rate = deg/帧；swing = 摆幅）—— 漏传就会让结果头与逐轮行自相矛盾。
            spinMode: okRounds.find((r) => r.spinMode)?.spinMode,
            spinPeriod: okRounds.find((r) => typeof r.spinPeriod === "number")?.spinPeriod,
            spinPeakDeg: okRounds.find((r) => typeof r.spinPeakDeg === "number")?.spinPeakDeg,
            spinPivot: okRounds.find((r) => r.spinPivot)?.spinPivot,
            spinErr: okRounds.find((r) => typeof r.spinErr === "number")?.spinErr,
            spinNote: okRounds.find((r) => r.spinNote)?.spinNote,
            // 排序次数（效度自查）：取首个有值的轮次
            sortResults: okRounds.find((r) => typeof r.sortResults === "number")?.sortResults,
            // bench 模式**不挂 FadeInPass**（两臂架构对等）；Flux 臂没有这个档位，它那边写 n/a。
            fade: BENCH_FADE_LABEL,
        }),
    );
    // 本文臂载入期口径分解（与逐轮 `parse_ms=` 一一对应；Flux 臂的对应字段是 `decode_ms=`/`tex_ms=`）：
    //   parse_ms = responseEnd → loadSplat() 返回（PLY 读取 + 低秩解码 worker + 合并），**不含首次深度排序**；
    //   首次排序 + 首次真实绘制都落在 first_frame_ms 里（子页面 waitForSortedFrame 门禁保证排序已回传）。
    // 之所以要写明：两臂的"载入期重活"构成不同（本文=解析+排序；基线=解码+纹理上传），
    // 所以 parse_ms 与 decode_ms **不能直接相减比较**，只能比 first_frame_ms，并把 breakdown 写进表注。
    lines.push("parse_def=response_end_to_load_complete_depth_sort_excluded");
    lines.push(`stage=${STAGE_LABEL}`);
    lines.push(`validateframe=${param("validateframe", "1") !== "0" ? 1 : 0}`);
    lines.push(`holdms=${parseInt(param("holdms", "0"), 10) || 0}`);
    lines.push(`proto=${param("proto", "")}`);
    lines.push(`cam=${CAM_FLUX ? "flux" : "auto"}`);
    // 机位来源（与 Flux-GS 臂的 `pose_src=` 同名字段）：ch7_baseline_report.py 用它核对
    // "两臂的机位口径是否同一档"，避免只靠人记得看 cam= 这一个参数
    lines.push(`pose_src=${CAM_FLUX ? "flux" : "auto"}`);
    lines.push(`warmup=${warmupFrames()}`);
    lines.push(`fx=${Math.round(fx * 1000) / 1000}`);
    lines.push(`ts=${new Date().toISOString()}`);
    lines.push(`ua=${env.ua}`);
    lines.push(`gl_renderer=${env.gl_renderer}`);
    lines.push(`screen=${env.screen}`);
    lines.push(`dpr=${env.dpr}`);
    lines.push(`hardwareConcurrency=${env.hardwareConcurrency}`);
    lines.push(`deviceMemory=${env.deviceMemory}`);
    lines.push("--- per-round ---");
    const diag = param("diag") === "1";
    for (const r of st.results) {
        const tags = [
            `scene=${r.scene}`,
            `dataset=${r.dataset ?? ""}`,
            `round=${r.round}`,
            `ok=${r.ok ? 1 : 0}`,
            `drawOk=${r.drawOk === undefined ? "" : r.drawOk ? 1 : 0}`,
            `points=${r.points ?? ""}`,
            `bytes=${r.bytes ?? ""}`,
            `fetch_ms=${fmt(r.fetchMs, 0)}`,
            `parse_ms=${fmt(r.parseMs, 0)}`,
            `first_frame_ms=${fmt(r.firstFrameMs, 0)}`,
            `fps=${fmt(r.fps, 1)}`,
            `cpu_ms=${fmt(r.cpuMs, 2)}`,
            `covered=${fmt(r.coveredPct, 1)}%`,
            `kept=${fmt(r.keptPct, 1)}%`,
        ];
        // 口径字段（**始终打印**，不受 diag 开关影响）：报表脚本要用它们过滤主表
        // （res_mode=forced 才允许跨方法比较）并核对新加的 GPU 同步诊断。
        tags.push(
            `driver=${r.driver ?? ""}`,
            `res_mode=${r.resMode ?? "forced"}`,
            `frames=${r.frames ?? ""}`,
            `elapsed_ms=${fmt(r.elapsedMs, 0)}`,
            `sync_ms=${fmt(r.syncMs, 2)}`,
            `sync_frames=${r.syncFrames ?? ""}`,
            // 帧内阻塞耗时（诊断/自检用）：与 `floor_used_ms` 并排打印，可核对 `cpu_ms ≈ 地板 + frame_ms`；
            // 但贴地板的轮次两边读数都贴在量化下限上，**不得用它算两臂倍数**（倍数取帧间隔之比）。
            `frame_ms=${fmt(r.frameMs, 2)}`,
            `frame_mean_ms=${fmt(r.frameMeanMs, 2)}`,
            // 判定 fps_capped 时**实际引用**的本轮实测地板：表头 timer_floor_ms= 是各轮中位数，
            // 与本字段不是同一个数；有了它，`fps_capped` 就能在结果文本里直接用
            // `1000/fps ≤ floor_used_ms × 1.05` 手算复核，不必再猜。
            `floor_used_ms=${fmt(r.timerFloorMs, 2)}`,
            `fps_capped=${r.fpsCapped ? 1 : 0}`,
        );
        // 机位口径（**始终打印**，不受 diag 开关影响）：`pose=` 与 Flux-GS 臂逐轮行的同名同格式，
        // tools/ch7_baseline_report.py 据此跨臂核对"两臂是否同一个机位"。
        tags.push(`pose=${r.poseKey ?? ""}`, `pose_src=${r.poseSrc ?? ""}`);
        // 动态相机（`?spin=`，效度自查）：`spin=0` = 静止协议（`pose=` 即全程机位）；
        // `spin>0` 时 `pose=` 只代表第 0 帧起始机位，`spin_err=` 是本轮轨迹对账误差（> 1e-3 = 两臂轨迹不一致）。
        // 标签由**两臂共用**的 spinRoundTags() 生成（`spin_mode=` 决定 `spin=` 的语义：rate=deg/帧，swing=摆幅）。
        tags.push(...spinRoundTags(r));
        // 内容量扫描（`?sweep=`，动态轮缺省 9 个姿态）：逐姿态的实测覆盖率 / 裁剪盒内高斯数 / 提交实例数。
        // 它回答"这几个挡位的 fps 能不能拿来比较两臂"——两臂看着同量级的内容，fps 差才归因于实现。
        tags.push(...sweepRoundTags(r));
        // 模型包围盒中心（世界坐标）：只在动态相机轮有意义（`?spin=0` 时为 "-"），
        // 物体型场景要用"绕模型公转"时，把它抄进 `?pivot=` 即可复现同一条轨迹。
        if (r.sceneCenter) tags.push(`scene_center=${r.sceneCenter}`);
        if (r.spinNote) tags.push(`spin_note=${r.spinNote.replace(/\s+/g, "_")}`);
        // 点集包围盒（世界坐标）+ 对角线长度：把"两臂基准机位相差多少单位"换算成**相对场景尺度的比例**
        // （`scene_diag=` 是分母，比例由报表/分析侧算），不再只有一句"真实几何、不是 bug"。
        tags.push(...sceneBoundsRoundTags(r));
        // 排序滞后核对（`?sortlag=1`，本文臂专用探针）：排序完成节奏 + 逐帧滞后 + 陈旧序 vs 新鲜序的
        // 画面差异（及其截图）。它是"动态视角下省掉的那些排序有没有让画面出错"的唯一直接证据。
        tags.push(...sortLagRoundTags(r));
        // 排序次数（效度自查）：静止协议下应 ≈1，动态下应 ≈frames —— 这是"两臂在窗口里是否做了等量工作"的直接证据
        if (r.sortResults !== undefined) tags.push(`sort_results=${r.sortResults}`);
        if (diag) {
            // 诊断字段：只描述"这一轮是怎么被隔离执行的"，不参与任何性能指标
            tags.push(
                `job=${r.jobId ?? ""}`,
                `retry=${r.retryCount ?? 0}`,
                `ctxlost=${r.contextLost ? 1 : 0}`,
                `ctxcreate=${r.ctxCreate ?? 0}`,
                `losectx=${r.loseCtx ? 1 : 0}`,
                `iframe_ms=${fmt(r.iframeCreateMs, 0)}`,
                `dispose_ms=${fmt(r.disposeMs, 0)}`,
            );
            // 测帧有效性的关键诊断（证明"确实渲染了 N 帧、且持续了合理时间"）
            tags.push(
                `renders=${r.renders ?? ""}`,
                `gap_med_ms=${fmt(r.gapMedMs, 2)}`,
                `gap_min_ms=${fmt(r.gapMinMs, 2)}`,
                `gap_max_ms=${fmt(r.gapMaxMs, 2)}`,
                `ff_covered=${fmt(r.firstFrameCoveredPct, 1)}%`,
                `vis_inside=${fmt(r.visibilityInsidePct, 1)}%`,
                `timeline=${r.timeline ?? ""}`,
            );
            if (r.trace) tags.push(`trace=${r.trace}`);
            if (r.prevErr) tags.push(`prev_err=${r.prevErr.replace(/\s+/g, "_")}`);
        }
        if (!r.ok) tags.push(`err=${r.err ?? ""}`);
        lines.push(tags.join(" "));
    }
    lines.push("--- summary (median) ---");
    const byScene = new Map<string, RoundResult[]>();
    for (const r of st.results) {
        if (!r.ok) continue;
        const arr = byScene.get(r.scene) || [];
        arr.push(r);
        byScene.set(r.scene, arr);
    }
    for (const sceneId of st.sceneIds) {
        const arr = byScene.get(sceneId) || [];
        const ok = arr.filter((r) => r.ok && r.drawOk !== false);
        const datasetTag = sceneById(manifest, sceneId)?.dataset ?? "";
        if (ok.length === 0) {
            lines.push(`summary scene=${sceneId} dataset=${datasetTag} ok=0`);
            continue;
        }
        lines.push(
            [
                `summary scene=${sceneId}`,
                `dataset=${datasetTag}`,
                `ok=${ok.length}/${arr.length || st.rounds}`,
                `fps_median=${fmt(median(ok.map((r) => r.fps ?? NaN).filter((v) => Number.isFinite(v))), 1)}`,
                `first_frame_ms_median=${fmt(median(ok.map((r) => r.firstFrameMs ?? NaN).filter((v) => Number.isFinite(v))), 0)}`,
                `parse_ms_median=${fmt(median(ok.map((r) => r.parseMs ?? NaN).filter((v) => Number.isFinite(v))), 0)}`,
                `fetch_ms_median=${fmt(median(ok.map((r) => r.fetchMs ?? NaN).filter((v) => Number.isFinite(v))), 0)}`,
                // 机位指纹（取该场景首个有效轮）：与 flux 臂 summary 行的 `pose=` 同名同格式，
                // 报表里同场景两行并排即可直接比对机位
                `pose=${ok[0]?.poseKey ?? ""}`,
            ].join(" "),
        );
    }
    lines.push("[END]");
    return lines.join("\n");
}

// ------------------------------------------------------------------ iframe 生命周期
/**
 * 台上布局（**1:1 对齐基线**）：
 *   `fit=1`（`proto=flux` 时默认）：iframe 的**布局尺寸 = res 像素**（于是子页面看到的
 *   `innerWidth/Height` 与画布一致，和基线 Flux-GS 臂的 `frameHost` 摆法相同），仅用 CSS
 *   `transform: scale()` 等比缩小显示 —— 缩放只影响观感，不改变被测渲染负载；窗口比例不匹配时留黑边。
 *   `fit=0`（显式关掉，或非 proto=flux）：iframe 铺满整个渲染区（画布被非等比拉伸显示），
 *   只有观感/历史数据对照用，**不要**用于正式跨臂采集。
 * 两种取值都写进结果头 `stage=`，可事后核对。
 */
const FIT_STAGE = param("fit", PROTO_FLUX ? "1" : "0") === "1";
/** 台上布局标签：写进结果头，供 `tools/ch7_baseline_report.py` 核对两臂同构。 */
const STAGE_LABEL = FIT_STAGE ? "fit1" : "fill";

function layoutCaseStage(): void {
    if (!FIT_STAGE) return;
    const area = caseHost.parentElement;
    if (!area) return;
    const w = area.clientWidth;
    const h = area.clientHeight;
    const fw = Number(caseHost.dataset.w || "1600");
    const fh = Number(caseHost.dataset.h || "1063");
    if (w <= 0 || h <= 0 || fw <= 0 || fh <= 0) return; // 布局还没算出来时不要缩成 0
    const s = Math.min(1, w / fw, h / fh);
    const dx = Math.max(0, (w - fw * s) / 2);
    const dy = Math.max(0, (h - fh * s) / 2);
    caseHost.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${s.toFixed(4)})`;
}

function makeJobId(): string {
    return `j${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 销毁当前 iframe（本轮测量**已经结束**，这段耗时绝不写进任何性能指标）：
 *   1) 发 bench-case-dispose / bench-case-abort，让子页面自己释放 GL/Worker/场景；
 *   2) 等它回报 bench-case-disposed（超时则不等）；
 *   3) 把 iframe 导航到 about:blank（先卸载子文档，释放它的上下文/显存/WASM 堆）；
 *   4) 摘掉节点，清空 activeIframe。
 * 幂等且串行：同一时刻只会有一个销毁在飞，不会出现两个活动 iframe。
 */
async function destroyActiveIframe(reason: "dispose" | "abort", detail = ""): Promise<number> {
    if (destroyInFlight) return destroyInFlight;
    const iframe = activeIframe;
    if (!iframe) return 0;
    const jobId = activeJobId;
    destroyInFlight = (async (): Promise<number> => {
        const t0 = performance.now();
        const cw = iframe.contentWindow;
        // 子页面若已在自己的失败路径里释放并回报过，就不必再等一次 ack（避免白等超时）
        let disposedAck = selfDisposedJobId === jobId;
        const onMessage = (event: MessageEvent): void => {
            if (!isSameOrigin(event.origin)) return;
            if (event.source !== cw) return;
            const data = event.data as CaseToParentMessage | undefined;
            if (!data || typeof data !== "object" || data.jobId !== jobId) return;
            if (data.type === "bench-case-disposed") disposedAck = true;
        };
        window.addEventListener("message", onMessage);
        logBench(reason === "abort" ? "abort" : "dispose", `请求子页面释放（reason=${detail || reason}）`);
        postTo(
            cw,
            reason === "abort"
                ? { type: "bench-case-abort", jobId, reason: detail }
                : { type: "bench-case-dispose", jobId },
        );
        const deadline = performance.now() + CASE_DISPOSE_TIMEOUT_MS;
        while (!disposedAck && performance.now() < deadline) {
            await sleep(50);
        }
        window.removeEventListener("message", onMessage);
        logBench(
            "dispose",
            disposedAck
                ? `收到同 jobId 的 disposed 回报（waitMs=${(performance.now() - t0).toFixed(0)}）`
                : `等待 disposed 超时 ${CASE_DISPOSE_TIMEOUT_MS}ms，强制销毁 iframe`,
        );
        // 先把 iframe 导航到 about:blank 并**等它 load**（最多 1s），让旧文档确定完成卸载，
        // 再摘节点 —— 比直接 remove() 更容易让浏览器走完文档销毁路径（旧 context/显存随之回收）。
        await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, 1000);
            iframe.addEventListener(
                "load",
                () => {
                    clearTimeout(timer);
                    resolve();
                },
                { once: true },
            );
            try {
                iframe.src = "about:blank";
            } catch {
                clearTimeout(timer);
                resolve();
            }
        });
        iframe.remove();
        if (activeIframe === iframe) {
            activeIframe = null;
            activeJobId = "";
        }
        return performance.now() - t0;
    })();
    try {
        return await destroyInFlight;
    } finally {
        destroyInFlight = null;
    }
}

interface CaseRun {
    result?: RoundResult;
    errorCode: string;
    errorMessage: string;
    contextLost: boolean;
    glRenderer: string;
    /** 父页面创建 iframe → 子页面 ready 的耗时（诊断） */
    iframeCreateMs: number;
}

/**
 * 在一个**全新的 iframe** 里跑完一个 job，返回测量结果（或失败信息）。
 * 无论成功、失败、超时还是 context lost，退出前都会销毁该 iframe 并等一个固定回收间隔。
 */
async function runCaseJob(meta: SceneMeta, roundNo: number, st: BenchState, attempt: number): Promise<RoundResult> {
    const out: RoundResult = {
        scene: meta.id,
        dataset: meta.dataset,
        round: roundNo,
        ts: new Date().toISOString(),
        ok: false,
        jobId: "",
        retryCount: attempt,
        contextLost: false,
    };

    // 进入本轮前确认没有残留 iframe（任意时刻只允许一个测试 iframe）
    if (activeIframe) {
        logBench("stale", "发现上一轮 iframe 仍在，先销毁它再创建本轮");
        await destroyActiveIframe("abort", "stale");
    }

    const jobId = makeJobId();
    out.jobId = jobId;
    selfDisposedJobId = "";
    const trace: Array<[string, number]> = [];
    const tRound = performance.now();
    const mark = (phase: string): void => {
        trace.push([phase, performance.now() - tRound]);
    };
    const token = `r${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const modelUrl = new URL(meta.file, location.href);
    modelUrl.searchParams.set("ts", token);
    const childUrl = buildCasePageUrl({
        jobId,
        sceneId: meta.id,
        dataset: meta.dataset,
        round: roundNo,
        attempt,
        modelUrl: modelUrl.href,
        token,
        resW: st.resW,
        resH: st.resH,
        frames: st.benchFrames,
    });

    caseHost.dataset.w = String(st.resW);
    caseHost.dataset.h = String(st.resH);
    const iframe = document.createElement("iframe");
    if (FIT_STAGE) {
        // 等比显示模式：按离屏分辨率建节点，再用 transform 缩放（只影响观感）
        iframe.width = String(st.resW);
        iframe.height = String(st.resH);
        iframe.style.width = `${st.resW}px`;
        iframe.style.height = `${st.resH}px`;
    }
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("title", `${meta.id} r${roundNo}`);
    iframe.setAttribute("allow", "fullscreen");
    caseHost.textContent = "";
    caseHost.appendChild(iframe);
    activeIframe = iframe;
    activeJobId = jobId;
    layoutCaseStage();
    const tCreate = performance.now();
    mark("create");
    logBench(
        "create",
        `新建测试 iframe scene=${meta.id} dataset=${meta.dataset} round=${roundNo} attempt=${attempt} res=${st.resW}x${st.resH}`,
    );

    const run = await new Promise<CaseRun>((resolve) => {
        let settled = false;
        let result: RoundResult | undefined;
        let errorCode = "";
        let errorMessage = "";
        let contextLost = false;
        let glRenderer = "";
        let iframeCreateMs = 0;
        let readyTimer = 0;
        let resultTimer = 0;

        const cleanup = (): void => {
            window.removeEventListener("message", onMessage);
            if (readyTimer) clearTimeout(readyTimer);
            if (resultTimer) clearTimeout(resultTimer);
            abortPendingJob = null;
        };
        const settle = (): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ result, errorCode, errorMessage, contextLost, glRenderer, iframeCreateMs });
        };
        // 停止测试时由按钮直接调用：本轮立刻以"已中止"结束，不必等到超时
        abortPendingJob = (code: string, message: string): void => {
            errorCode = code;
            errorMessage = message;
            settle();
        };
        const onMessage = (event: MessageEvent): void => {
            if (!isSameOrigin(event.origin)) return;
            // 必须是当前这个 iframe 发的（event.source 校验），且 jobId 与本轮一致（丢弃上一轮的迟到消息）
            if (event.source !== iframe.contentWindow) return;
            const data = event.data as CaseToParentMessage | undefined;
            if (!data || typeof data !== "object" || data.jobId !== jobId) return;
            switch (data.type) {
                case "bench-case-ready":
                    glRenderer = data.glRenderer || glRenderer;
                    iframeCreateMs = performance.now() - tCreate;
                    mark("ready");
                    logBench(
                        "ready",
                        `子页面就绪（iframeCreateMs=${iframeCreateMs.toFixed(0)}）gl=${glRenderer || "unknown"}`,
                    );
                    if (glRenderer) {
                        glRendererReported = glRenderer;
                        refreshDeviceLabel();
                        // 结果头 u= 的默认值（旧口径是 auto-<gpu>-<num>）：第一轮拿到 GPU 名后回填并落盘
                        if (currentState && !param("u")) {
                            const label = defaultUserLabel(glRenderer);
                            if (currentState.u !== label) {
                                currentState.u = label;
                                saveState(currentState);
                            }
                        }
                    }
                    if (readyTimer) clearTimeout(readyTimer);
                    readyTimer = 0;
                    break;
                case "bench-case-progress":
                    setPhaseText(data.phase, data.detail);
                    break;
                case "bench-case-log":
                    // 子页面日志转发到父页面控制台：一个时间线里同时能看到父/子两侧的打点
                    lastCaseLog = `[${data.phase}] ${data.message}`;
                    console.log(`[case→parent][job=${data.jobId}][${data.phase}] ${data.message}`);
                    break;
                case "bench-case-result":
                    result = data.result;
                    mark("result");
                    logBench(
                        "result",
                        `收到结果 ok=${data.result?.ok ? 1 : 0} fps=${data.result?.fps ?? "-"} err=${data.result?.err ?? ""}`,
                    );
                    settle();
                    break;
                case "bench-case-error":
                    errorCode = data.code;
                    errorMessage = data.message;
                    contextLost = contextLost || data.contextLost;
                    mark("error");
                    logBench(
                        "error",
                        `子页面报错 code=${errorCode} message=${errorMessage} ctxlost=${data.contextLost}`,
                    );
                    settle();
                    break;
                case "bench-case-disposed":
                    // 子页面在自己的失败路径里已经释放过了（context lost / 启动失败）：记下来
                    selfDisposedJobId = jobId;
                    mark("caseDisposed");
                    logBench("dispose", "子页面已回报 disposed（自行释放）");
                    break;
            }
        };

        window.addEventListener("message", onMessage);
        readyTimer = window.setTimeout(() => {
            errorCode = "READY_TIMEOUT";
            errorMessage = `子页面 ${Math.round(CASE_READY_TIMEOUT_MS / 1000)}s 内未就绪（未收到 bench-case-ready）`;
            settle();
        }, CASE_READY_TIMEOUT_MS);
        resultTimer = window.setTimeout(() => {
            errorCode = "RESULT_TIMEOUT";
            errorMessage = `单轮测量超时（${Math.round(jobTimeoutMs() / 1000)}s）`;
            settle();
        }, jobTimeoutMs());
        try {
            iframe.src = childUrl; // 监听挂好再设 src，避免极快加载时丢消息
        } catch (err) {
            errorCode = "IFRAME_ERROR";
            errorMessage = err instanceof Error ? err.message : String(err);
            settle();
        }
    });

    // ---- 以下是"测量之后"的收尾，全部与性能指标无关 ----
    if (run.result) {
        // 只接受基本类型字段：Splat / RenderData / ArrayBuffer / TypedArray 之类对象绝不进入结果数组
        const clean = sanitizeRoundResult(run.result);
        // 逐字段并进本轮结果：**遍历 bench-shared 的共享字段表**（不再逐字段手抄）。
        // 这里正是历史上漏拷四次的位置（fpsCapped / frameMs / timeline / spinMode / sweep* 被静默丢弃，
        // 导致逐轮行恒印默认值）——改成遍历字段表后，结构上不可能再漏。见文件顶部说明。
        copyRoundResultFields(out, clean);
        if (clean.fx && clean.fx > 0) focalPxReported = clean.fx;
    } else {
        out.ok = false;
        out.err = `${run.errorCode}: ${run.errorMessage}`;
    }
    out.contextLost = run.contextLost || out.contextLost === true;
    out.iframeCreateMs = run.iframeCreateMs;

    if (!stopRequested) setPhaseText("disposing");
    out.disposeMs = await destroyActiveIframe(stopRequested ? "abort" : "dispose", "round-done");
    mark("iframeRemoved");
    logBench("dispose", `iframe 已删除（disposeMs=${out.disposeMs.toFixed(0)}）`);
    await twoFrames();
    const recycle = stopRequested ? 0 : recycleDelayMs(st.cold);
    if (recycle > 0) await sleep(recycle);
    mark("recycled");
    out.trace = formatTrace(trace);
    logBench(
        "recycled",
        `轮间回收完成（2×RAF + ${recycle}ms，不计入指标）retry=${attempt} ctxlost=${out.contextLost ? 1 : 0} trace=${out.trace}`,
    );
    return out;
}

// ------------------------------------------------------------------ bench runner（父页面队列）
/** 队列：场景 × 轮次。每轮 = 一个全新 iframe；失败（含 context lost/超时）最多整轮重试一次。 */
async function runBench(st: BenchState): Promise<void> {
    if (running) return; // 不允许两个活动测试
    setRunning(true);
    stopRequested = false;
    currentState = st;
    ctxExhausted = false;
    jobsInDoc = 0;
    if (docRetryUsed) {
        // 本页是"整页重试页"（URL 带 _docretry=1）：先给 GPU 进程 1.5s 把上一个文档的资源放掉。
        // 注意 docRetryUsed 在本页**保持为 true**：这一页里再拿不到上下文就直接断点停手，
        // 保证"整页重启重试"每个 job 只用一次，不会无限重启。
        setPhaseText("boot", "等待 GPU 释放上一个文档");
        logBench("ctx", `本页是整页重试页（_docretry=1）：等待 ${CASE_DOC_RETRY_DELAY_MS}ms 再开跑`);
        await sleep(CASE_DOC_RETRY_DELAY_MS);
    }
    try {
        for (;;) {
            // 归一化：当前场景已完成全部轮次则推进到下一个场景
            while (st.roundDone >= st.rounds && st.idx < st.sceneIds.length) {
                st.idx++;
                st.roundDone = 0;
            }
            if (st.idx >= st.sceneIds.length) {
                finishBench(st);
                return;
            }
            const meta = sceneById(manifest, st.sceneIds[st.idx]);
            if (!meta) {
                st.idx++;
                st.roundDone = 0;
                saveState(st);
                continue;
            }
            const roundNo = st.roundDone + 1;
            updateProgress(st.results.length, totalRounds(st), meta.name, `第 ${roundNo}/${st.rounds} 轮`);
            flashStatusBig(`正在测试 ${meta.name} · 第 ${roundNo}/${st.rounds} 轮，请稍候`);
            setPhaseText("boot");

            let r = await runCaseJob(meta, roundNo, st, 0);
            // 「拿不到 WebGL2 上下文」= 设备/进程级配额问题：同一文档内重试无用（规则：不加 0/400/900ms
            // 快速重试、不换 canvas），正确动作是保存断点 + 整页重启，并让新页面先等一会儿再开跑。
            // 整页重启每个 job 最多用一次（由 URL 上的 _docretry=1 标记，刷新后仍可见）。
            if (!r.ok && !stopRequested && isCtxUnavailable(r)) {
                if (!docRetryUsed) {
                    docRetryUsed = true;
                    logBench("ctx", `本机给不出 WebGL2 上下文（getContext 返回 null）：保存断点后整页重启再试一次`);
                    // 注意：这里**不写结果、不推进 roundDone** —— 重启后重跑的就是同一轮
                    saveState(st);
                    restartPage(true);
                    return;
                }
                logBench("ctx", `整页重启后仍然拿不到 WebGL2 上下文 → 判定本机上下文配额已耗尽，断点停手`);
                ctxExhausted = true;
                finishBench(st, "WebGL 上下文耗尽（整页重启后仍无法创建）", true);
                return;
            }
            if (!r.ok && !stopRequested && CASE_RETRY_LIMIT > 0 && !isCtxUnavailable(r)) {
                // 重试：必须"先完整销毁失败 iframe"，再由 runCaseJob 新建 iframe 重跑整轮；
                // 失败轮次的部分数据不参与拼接，只留下 prevErr 作诊断。
                const prevErr = r.err ?? "unknown";
                const prevJob = r.jobId ?? "";
                logBench("retry", `第 ${roundNo} 轮失败（${prevErr}），销毁旧 iframe 后重试一次`);
                flashStatusBig(
                    `✗ ${meta.name} 第 ${roundNo}/${st.rounds} 轮失败：${prevErr.slice(0, 90)}\n正在整轮重试…`,
                );
                setPhaseText("boot", "重试一次");
                const retry = await runCaseJob(meta, roundNo, st, 1);
                retry.retryCount = 1;
                retry.prevErr = `${prevErr} [job=${prevJob}]`;
                r = retry;
            }
            if (!r.ok && !stopRequested) {
                // 重试也失败：把错误直接显示在渲染区底部，便于不看控制台也能发现问题
                flashStatusBig(
                    `✗ ${meta.name} 第 ${roundNo}/${st.rounds} 轮失败：${(r.err ?? "unknown").slice(0, 120)}`,
                );
                logBench("fail", `第 ${roundNo} 轮最终失败：${r.err ?? "unknown"}`);
            }

            if (stopRequested) {
                finishBench(st, "测试已停止");
                return;
            }
            st.results.push(r);
            st.roundDone = roundNo;
            saveState(st);
            jobsInDoc++;

            const allDoneNow = st.idx === st.sceneIds.length - 1 && roundNo >= st.rounds;
            if (allDoneNow) {
                finishBench(st);
                return;
            }

            // 每完成 N 个 job 整页重启一次（默认 N=4，`?perpage=1` 每轮、`?perpage=0` 关闭）：
            // 手机端一个文档内累积到 8~9 个 context 就会开始拿不到上下文，主动重启最稳。
            // 重启发生在测量之后，且 `_doc` 只加在页面 URL 上（模型 URL 的 ts= 协议不受影响）。
            const perDoc = jobsPerDocument();
            if (perDoc > 0 && jobsInDoc >= perDoc) {
                logBench("perpage", `${jobsInDoc}/${perDoc} 个 job 完成：保存断点并整页重启（不计入指标）`);
                await sleep(recycleDelayMs(st.cold));
                restartPage(false);
                return;
            }
        }
    } finally {
        setRunning(false);
        // 收尾：不留任何残留 iframe（此时一定没有第二个 iframe）
        if (activeIframe) await destroyActiveIframe("abort", "run-finished");
    }
}

/** `report=` 模式（外部测试者）结果卡文案的两个状态标记 */
const REPORT_SUBMITTING = "结果正在自动提交，请勿关闭页面…";
const REPORT_DONE = "✅ 结果已自动提交，可以关闭此页面。";

/**
 * `report=` 模式下把「复制结果 / 导出记录」收起来：外部测试者的流程只有"打开链接 → 等 → 关页面"，
 * 露着手动按钮会让不熟悉流程的人以为还要额外操作。提交失败时再放出来（此时文案明确要求点它），
 * 保证任何情况下都有人工退路。
 */
function setManualExportVisible(visible: boolean): void {
    btnCopy.classList.toggle("hidden", !visible);
    btnExport.classList.toggle("hidden", !visible);
}

function finishBench(st: BenchState, note = "", keepState = false): void {
    try {
        archiveState(st);
    } catch {
        /* ignore */
    }
    if (keepState) {
        // 断点停手（例如设备已给不出 WebGL 上下文）：保留进度，重启浏览器后重开同一链接即可续跑
        st.busy = true;
        saveState(st);
    } else {
        clearState();
    }
    progressRow.classList.add("hidden");
    statusBig.classList.add("hidden");
    caseHost.textContent = "";
    const okCount = st.results.filter((r) => r.ok).length;
    const text = buildResultText(st);
    rcText.value = text;
    const reportUrl = param("report");
    const autoReport = reportUrl !== "";
    const head = note ? `${note}：已完成 ${st.results.length} 轮` : "测试完成";
    if (autoReport) {
        setManualExportVisible(false);
        rcNote.textContent = "结果会自动回传，无需任何操作；看到“已自动提交”即可关闭本页面。";
    }
    rcSummary.textContent = autoReport
        ? `${head}：成功 ${okCount}/${st.results.length} 轮。${REPORT_SUBMITTING}`
        : `${head}：成功 ${okCount}/${st.results.length} 轮。请复制下方文本并发送给测试发起人。`;
    if (ctxExhausted) {
        rcSummary.textContent +=
            "\n本机已无法再创建 WebGL 上下文（canvas.getContext('webgl2') 返回 null）。\n" +
            "👉 进度已保存：请**重启浏览器**（完全关闭再打开）后，重新打开同一条链接，会自动从断点继续。";
    }
    // 失败/空转轮次直接列在结果卡上：截图即可定位，不必翻控制台
    const bad = st.results.filter((r) => !r.ok || r.drawOk === false);
    if (bad.length > 0) {
        rcSummary.textContent +=
            "\n失败/空转轮次（详见文本里的 err=/drawOk=/ctxlost=/ctxcreate=）：\n" +
            bad
                .slice(0, 8)
                .map(
                    (r) =>
                        `· ${r.scene} 第${r.round}轮 job=${r.jobId ?? "-"} ctxlost=${r.contextLost ? 1 : 0} ctxcreate=${r.ctxCreate ?? "-"} ` +
                        `drawOk=${r.drawOk === undefined ? "-" : r.drawOk ? 1 : 0} err=${(r.err ?? "").slice(0, 80)}`,
                )
                .join("\n");
    }
    resultCard.style.display = "flex";
    if (autoReport) {
        // 只替换状态标记 / 追加一行提示，不整段重写 rcSummary：
        // 上面追加的"失败轮次明细""上下文耗尽说明"必须原样保留给测试者看
        void submitReport(reportUrl, text, param("rtok")).then((ok) => {
            if (ok) {
                rcSummary.textContent = rcSummary.textContent.replace(REPORT_SUBMITTING, REPORT_DONE);
                rcNote.textContent = "结果已回传，无需任何操作。";
            } else {
                setManualExportVisible(true);
                rcSummary.textContent += "\n⚠ 自动提交失败：请点「复制结果」并发送给测试发起人。";
                rcNote.textContent = "若“复制”按钮无效，请长按文本框手动全选复制。";
            }
        });
    }
}

async function copyResult(): Promise<void> {
    const text = rcText.value;
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        rcText.focus();
        rcText.select();
        try {
            document.execCommand("copy");
        } catch {
            /* ignore */
        }
    }
    btnCopy.textContent = "已复制 ✓";
    setTimeout(() => {
        btnCopy.textContent = "复制结果";
    }, 2000);
}

function exportArchive(): void {
    try {
        const raw = localStorage.getItem(ARCHIVE_KEY);
        const blob = new Blob([raw || "[]"], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `bench-archive-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch {
        /* ignore */
    }
}

// ------------------------------------------------------------------ view（展示浏览）模式
/** 只有本函数会创建 renderer：bench 模式下连 bench-view.ts 都不会被下载/执行。 */
async function setupViewMode(): Promise<void> {
    benchControls.classList.add("hidden");
    viewControls.classList.remove("hidden");
    progressRow.classList.add("hidden");
    welcome.classList.add("hidden");
    caseHost.classList.add("hidden");
    canvas.classList.remove("hidden");
    progressFill.style.width = "0%";
    stPhase.textContent = "-";
    const mod = await import("./bench-view");
    view = new mod.BenchView({ canvas, stScene, fpsOverlay, infoOverlay, welcome, statusBig }, manifest);
    view.start({ big: param("fpsoverlay") === "1", overlay: ckOverlay.checked, info: ckInfo.checked });
    glRendererReported = view.glRendererName();
    stDevice.textContent = view.deviceLabel();
    const sceneParam = param("scene");
    const initialId =
        sceneParam && sceneById(manifest, sceneParam) ? sceneParam : (manifest.find((s) => s.demo)?.id ?? "");
    if (initialId) {
        selViewScene.value = initialId;
        await view.load(initialId);
    }
}

function setupBenchStage(): void {
    // bench 模式下把父页面自己的画布藏起来，测试画面来自子 iframe
    canvas.classList.add("hidden");
    caseHost.classList.remove("hidden");
    caseHost.classList.toggle("fit", FIT_STAGE);
    layoutCaseStage();
    startDiagLine();
    if (FIT_STAGE) {
        window.addEventListener("resize", layoutCaseStage);
    }
}

function setupViewEvents(): void {
    btnLoadView.addEventListener("click", () => {
        void view?.load(selViewScene.value);
    });
    btnResetView.addEventListener("click", () => view?.resetCamera());
    ckOverlay.addEventListener("change", () => {
        view?.setOverlayVisible(ckOverlay.checked);
        fpsOverlay.classList.toggle("hidden", !ckOverlay.checked);
    });
    ckInfo.addEventListener("change", () => {
        view?.setInfoVisible(ckInfo.checked);
        infoOverlay.classList.toggle("hidden", !ckInfo.checked);
    });
    selViewScene.addEventListener("change", () => {
        void view?.load(selViewScene.value);
    });
}

// ------------------------------------------------------------------ bench 模式 UI 与状态
function buildStateFromParams(): BenchState {
    const rounds = Math.max(1, Math.min(9, parseInt(param("rounds", "3"), 10) || 3));
    const cold = param("cold") !== "0";
    const res = resolution();
    const profile = param("profile", selProfile.value);
    return {
        v: 1,
        busy: true,
        u: defaultUserLabel(glRendererReported),
        sceneIds: expandProfile(manifest, profile),
        rounds,
        cold,
        resW: res.w,
        resH: res.h,
        benchFrames: benchFrameCount(),
        idx: 0,
        roundDone: 0,
        results: [],
        started: Date.now(),
    };
}

function showBenchSettings(): void {
    benchControls.classList.remove("hidden");
    viewControls.classList.add("hidden");
    progressRow.classList.add("hidden");
    welcome.classList.remove("hidden");
    stPhase.textContent = "-";
}

function bindBenchEvents(): void {
    btnStart.addEventListener("click", () => {
        if (running) return;
        const st = buildStateFromParams();
        if (st.sceneIds.length === 0) {
            flashStatusBig("没有可用的场景文件（场景尚未上传或清单为空）");
            return;
        }
        saveState(st);
        void runBench(st);
    });
    const stopRun = (): void => {
        if (!running) return;
        stopRequested = true;
        flashStatusBig("正在停止：销毁当前测试 iframe 并释放资源…");
        setPhaseText("disposing", "用户停止");
        abortPendingJob?.("ABORTED", "用户停止测试");
        void destroyActiveIframe("abort", "user-stop");
    };
    btnStop.addEventListener("click", stopRun);
    btnStop2.addEventListener("click", stopRun);
    btnCopy.addEventListener("click", () => {
        void copyResult();
    });
    btnDone.addEventListener("click", () => {
        resultCard.style.display = "none";
        showBenchSettings();
    });
    btnExport.addEventListener("click", exportArchive);
}

// ------------------------------------------------------------------ mode UI & bootstrap
function setTopLinks(mode: "bench" | "view"): void {
    const lnkBench = el("lnk-bench");
    const lnkView = el("lnk-view");
    lnkBench.classList.toggle("active", mode === "bench");
    lnkView.classList.toggle("active", mode === "view");
    const hint = el("mode-hint");
    hint.textContent =
        mode === "bench"
            ? "自动测试：每轮新建并销毁一个 iframe（测试 iframe 与父页面隔离 WebGL 上下文）"
            : "展示浏览：可拖动视角，供截图/录屏";
}

function populateSceneSelect(): void {
    for (const s of manifest) {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = `${s.name}${s.demo ? "" : "（扩展）"}`;
        selViewScene.appendChild(opt);
    }
}

function applyParamToControls(): void {
    const profile = param("profile");
    if (profile && ["quick", "full", "mip360", "tnt", "db"].includes(profile)) {
        selProfile.value = profile;
    }
    const rounds = param("rounds");
    if (rounds) inpRounds.value = rounds;
    const cold = param("cold");
    if (cold !== "") selCold.value = cold === "0" ? "0" : "1";
}

async function main(): Promise<void> {
    stDevice.textContent = "读取场景清单…";
    try {
        manifest = await loadManifest();
    } catch {
        stDevice.textContent = "清单加载失败";
        welcome.textContent = "bench-scenes.json 未能加载，请检查部署是否完整。";
        return;
    }
    populateSceneSelect();
    applyParamToControls();
    stRes.textContent = param("res", "1600×1063");

    const modeParam = param("mode");
    if (modeParam === "view") {
        setTopLinks("view");
        setupViewEvents();
        await setupViewMode();
        return;
    }

    // ---- bench 模式：父页面这里**没有任何 renderer/scene/camera**，WebGL 全部在子 iframe 里
    setTopLinks("bench");
    setupBenchStage();
    bindBenchEvents();
    refreshDeviceLabel();

    const st = loadState();
    if (st && st.busy) {
        // 页面刷新/重启后的续跑（进度与结果在 sessionStorage 里）
        logBench("resume", `从断点续跑：已完成 ${st.results.length} 轮，sceneIdx=${st.idx} roundDone=${st.roundDone}`);
        void runBench(st);
        return;
    }
    if (param("profile")) {
        const auto = buildStateFromParams();
        if (auto.sceneIds.length > 0) {
            saveState(auto);
            void runBench(auto);
            return;
        }
    }
    showBenchSettings();
}

window.addEventListener("DOMContentLoaded", () => {
    void main();
});

// 页面关闭前顺手把当前 iframe 收掉（它与父页面同生共死，这里只是双保险）
window.addEventListener("pagehide", () => {
    if (activeIframe) {
        try {
            activeIframe.src = "about:blank";
        } catch {
            /* ignore */
        }
    }
    view?.dispose();
});
