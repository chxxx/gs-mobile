/**
 * bench-flux.ts — 第7章对比方法（Flux-GS）离屏测帧页。
 *
 * 为什么是 iframe 桥接：Flux-GS 只有其自带 WebGL 渲染器
 * （flux-gs-project-gh-pages/render_<scene>/index.html），本仓库的 PLY/QPLY 加载器无法加载它的
 * 压缩格式，因此本页在同源 iframe 里驱动 Flux-GS 渲染器，而不是重写它的解码器。
 *
 * 与 bench.html 对齐的测量口径（论文 7.2.2）：
 *   1. **统一像素协议（主表口径，缺省）**：iframe 链接默认带 `benchres=`（缺省 = `res`，即 1600×1063），
 *      把它的离屏画布与投影视口一起钉死为同一组像素 —— 这是**跨方法 FPS 比较唯一允许**的数据来源
 *      （本文臂/reduced-3DGS 臂用 `res=WxH`，本臂用 `benchres=WxH`，三臂同像素）。
 *      `force=WxH` 仍可显式指定；`force=native` 才退回它的**原生自适应分辨率**（点数 > 500000 → 1× CSS，
 *      否则 CSS × devicePixelRatio）——该档各臂分辨率不对等，**不可比 FPS**，只用于说明它在真机上的像素占用。
 *      两种模式都在结果头/逐轮行写 `res_mode=forced|native`，报表脚本据此过滤；
 *   2. 帧率：**两臂共用的** `bench-shared.driveThroughputFrames()` 逐帧调用 iframe 内的
 *      `__FLUXGS_BENCH_FRAME__()`（渲染一帧后立刻 `gl.finish()`），`setTimeout(0)` 链驱动；
 *      300 帧、**无预热**（与其原实现一致，`warmup=` 可覆盖）；计时区间 = 首个计帧绘制完成 → 末帧绘制完成；
 *   3. 首帧：只计"模型文件获取完成之后"的解码、纹理上传与首个真实绘制帧，不含网络下载段；
 *   4. 冷启动：每轮新建 iframe、追加 ts= 令牌重取模型；整页冷启动刷新由 sessionStorage 续跑。
 *      轮间收尾 = 等 iframe 的 about:blank **真的 load** → 摘节点 → 2 帧；整页冷启动与本文臂①
 *      一样**经零上下文的中转页** bench-hop.html（默认停 1500ms）再进新页，把"旧上下文销毁"
 *      与"新上下文创建"确定性地分开（`?hop=0` 关掉中转页、`?hopms=N` 改停留时长）。
 *   5. 机位：测帧会话启动即冻结（`carousel=false`），并在结果里输出 pose= 指纹供核对。
 *      注：forced 档在 iframe **load 时**就冻结；native 档只能等首个真实帧之后（BEGIN）冻结。
 *   6. 设备名：GPU 名由 iframe 内的 Flux 页面**用自己的上下文**上报（__FLUXGS_STATS__.glRenderer），
 *      本页不建任何探测上下文——手机端"建了不用 / 丢了不还"的上下文会耗尽上下文名额。
 *
 * URL：bench-flux.html?profile=full|mip360|tnt|db|quick&rounds=3&cold=1&u=xxx&frames=300&warmup=0
 *      bench-flux.html?...&force=native          （原生自适应分辨率，仅作补充、不可跨方法比 FPS）
 *      bench-flux.html?...&force=800x600         （显式统一像素，覆盖缺省的 res）
 *
 * 外部测试者（自动回传，2026-09-17 追加）：与 bench.html 同构 ——
 *   `&report=<url>&rtok=<口令>` → 测完自动把 [RESULT] 文本 POST 到 `<url>?token=<口令>`，
 *   测试者只需"打开链接 → 等 → 关页面"；接收端 = vite dev server 的 /__ch7/report 中间件
 *   （见 vite.config.js），落盘到 thesis_project/data/ch7_measurements/raw/。
 */
import { guessChip as guessChipFrom } from "./bench-chip";
import {
    benchResOverride,
    camSpinDegPerFrame,
    clipInsideRatio,
    driveThroughputFrames,
    hopUrlFor,
    maxMatrixDiff,
    mulMat4,
    orbitViewMatrix,
    percentile,
    resolutionMode,
    resolveSpinSpec,
    // [DIAG-EXPERIMENT-1] 分段计时的汇总与结果字段：**两臂共用**同一份实现（本文臂 3 段 / 本臂 5 段）
    applySegTimingFields,
    segTimingRoundTags,
    summarizeSegTiming,
    throughputPercentileRoundTags,
    // 包围盒（世界坐标）+ 逐轮标签：与本文臂同一实现/同一字段名，"0.039 单位占场景尺度多少"两臂可直接对照
    formatTriple,
    positionsBounds,
    sceneBoundsRoundTags,
    spinPeakDegPerFrame,
    spinPivotParam,
    spinRoundTags,
    spinSampleFrames,
    spinYawDegAt,
    submitReport,
    summarizeSweep,
    sweepRoundTags,
    sweepSampleCount,
    throughputFields,
    viewCameraPosition,
} from "./bench-shared";
import type {
    DriveThroughputStats,
    ResMode,
    SegTimingFields,
    SpinSpec,
    SweepResult,
    SweepSample,
} from "./bench-shared";

// ------------------------------------------------------------------ DOM
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const stage = $<HTMLElement>("stage");
const frameHost = $<HTMLElement>("frame-host");
const statusBig = $<HTMLElement>("status-big");
const stDevice = $<HTMLElement>("st-device");
const stRes = $<HTMLElement>("st-res");
const stScene = $<HTMLElement>("st-scene");
const stProgress = $<HTMLElement>("st-progress");
const benchControls = $<HTMLElement>("bench-controls");
const progressRow = $<HTMLElement>("bench-progress");
const progressFill = $<HTMLElement>("bar-fill");
const resultCard = $<HTMLElement>("result-card");
const rcText = $<HTMLTextAreaElement>("rc-text");
const rcSummary = $<HTMLElement>("rc-summary");
/** 结果卡底部那行提示（`report=` 模式下换成"结果会自动回传，无需任何操作"） */
const rcNote = $<HTMLElement>("rc-note");
const btnStart = $<HTMLButtonElement>("btn-start");
const btnCopy = $<HTMLButtonElement>("btn-copy");
const btnDone = $<HTMLButtonElement>("btn-done");
const btnExport = $<HTMLButtonElement>("btn-export");
const selProfile = $<HTMLSelectElement>("sel-profile");
const inpRounds = $<HTMLInputElement>("inp-rounds");
const inpFrames = $<HTMLInputElement>("inp-frames");
const selCold = $<HTMLSelectElement>("sel-cold");

// ------------------------------------------------------------------ types
interface FluxSceneMeta {
    id: string;
    name: string;
    dataset: string;
    page: string;
    model: string;
    storageMB?: number;
}
/** 由 render_shared/main.js 的 benchmark 钩子写入（iframe 内时间轴，单位 ms）。 */
interface FluxStats {
    enabled: boolean;
    t0: number;
    fetchStartAt: number;
    fetchEndAt: number;
    decodeDoneAt: number;
    texUploadDoneAt: number;
    firstFrameAt: number;
    resW: number;
    resH: number;
    /** GPU renderer 名（由 render_shared/main.js 的埋点用自己的上下文写入，供本页显示设备）。 */
    glRenderer?: string;
}
/** `__FLUXGS_BENCH_FRAME__()` 的返回：t = 该帧结束时刻（iframe 内时间轴），syncMs = 该帧 gl.finish() 耗时。 */
interface FluxBenchFrame {
    t: number;
    syncMs: number;
}
/**
 * [DIAG-EXPERIMENT-1] `__FLUXGS_BENCH_END__().drawTimings` 的单项：iframe 内 `frame()` 被拆成的
 * 5 个**互不重叠**分段（单位 ms，同一 `performance.now()` 时间轴）：
 *   - `prep` = `frame()` 入口 → draw 前那个 `gl.getError()` 之前（含 uniformMatrix4fv / clear / 两次 bindTexture）
 *   - `err1` = draw 前的 `gl.getError()`
 *   - `draw` = `gl.drawArraysInstanced`
 *   - `err2` = draw 后的 `gl.getError()`
 *   - `post` = 第二次 `gl.getError()` 之后 → `frame()` 返回前（fps 文本、lastFrame 等）
 * `prep+err1+draw+err2+post + sync_ms ≈ frame_ms`（差在父页面那一层跨 realm 调用）。
 */
interface FluxDrawTiming {
    prep: number;
    err1: number;
    draw: number;
    err2: number;
    post: number;
}
/** `__FLUXGS_BENCH_SWEEP__(view16)` 的返回：在**指定姿态**渲染一帧后的内容量读数（不进任何计时区间）。
 *  `proj` = 渲染器自己的投影矩阵（列主序 16 项）：驱动页用 `mulMat4(proj, view)` 复现它的 viewProj，
 *  再调**两臂共享的** `clipInsideRatio` 算"裁剪盒内点数"，与本文臂的同一个量法。 */
interface FluxBenchSweep {
    coveredPct: number;
    /** 该姿态实际提交绘制的实例数（= 渲染器的 `vertexCount`；不随视角变） */
    drawn: number;
    proj: number[] | null;
    /** 该姿态渲染器实际使用的视图矩阵（对账用；未取到为 null） */
    view: number[] | null;
}

/** `__FLUXGS_BENCH_END__()` 的返回：测帧会话累计量（由驱动页负责结算，渲染器侧不做计时）。 */
interface FluxBenchEnd {
    frames: number;
    syncSamples: number[];
    /** [DIAG-EXPERIMENT-1] 逐帧分段样本（与 `syncSamples` 同序同长度；旧版钩子无此字段） */
    drawTimings?: FluxDrawTiming[];
    coveredPct: number;
    canvasW: number;
    canvasH: number;
    dpr: number;
    downsample: number;
    points: number;
    /** BEGIN 之后**真正完成**的排序次数（效度自查）：静止机位下基线 worker 的早退会让它停在 1 */
    sorts?: number;
    view: number[];
}
/** `__FLUXGS_BENCH_PROBE__()` 的只读快照（分辨率核对用，不做任何渲染）。 */
interface FluxBenchProbe {
    canvasW: number;
    canvasH: number;
    dpr: number;
    downsample: number;
    points: number;
    carousel: boolean;
    manual: boolean;
    benchRes: { w: number; h: number } | null;
    fetchEndAt: number;
    firstFrameAt: number;
    /** 当前视图矩阵（世界→视图，列主序 16 项）——`?spin=` 用它取基准位姿；旧版钩子无此字段 */
    view?: number[] | null;
}
interface RoundResult extends SegTimingFields {
    scene: string;
    dataset: string;
    round: number;
    ts: string;
    ok: boolean;
    err?: string;
    fps?: number;
    /** 该轮实际计入的帧数（= frames 参数，回传自渲染器钩子） */
    frames?: number;
    /** 该轮的计时区间毫秒数（回传自共享驱动；fps = frames / (elapsedMs/1000)） */
    elapsedMs?: number;
    /** 均帧间隔（含 GPU 同步）：elapsedMs / (frames - 1) */
    cpuMs?: number;
    /** 逐帧 gl.finish() 耗时的中位数（诊断：帧率差异是否由 GPU 负载解释） */
    syncMs?: number;
    /** 计入 syncMs 的样本数（= 本轮实际帧数） */
    syncFrames?: number;
    /** 帧内阻塞耗时中位数/均值（诊断/自检用；不可用于算倍数，语义边界见 bench-shared.DriveThroughputStats.frameMs） */
    frameMs?: number;
    frameMeanMs?: number;
    /**
     * [DIAG-EXPERIMENT-1] iframe 内 `frame()` 的分段 p50/p90 —— 扁平字段由 `SegTimingFields` 提供
     * （`segN`/`segPrepP50`…`segSumOfP50s`），逐轮行经 `segTimingRoundTags()` 输出 `seg_*_p50_ms=`。
     */
    /** [DIAG-EXPERIMENT-1] `gl.finish()` 逐帧耗时的 p50/p90（与 `syncMs` 同一批样本） */
    syncP50?: number;
    syncP90?: number;
    /** [DIAG-EXPERIMENT-1] 帧内阻塞耗时（`frame_ms`）的 p50/p90（与 `frameMs` 同一批样本） */
    frameP50?: number;
    frameP90?: number;
    /** 实测计时地板（空驱动校准，驱动所在文档测得） */
    timerFloorMs?: number;
    timerFloorRounds?: number;
    timerFloorSrc?: string;
    /** true = 本轮帧率已被驱动地板卡住，不能当渲染极限读 */
    fpsCapped?: boolean;
    /** 帧驱动口径（本臂恒为 timer） */
    driver?: string;
    /** 本轮像素口径：forced = 统一像素协议（主表）；native = 其自适应分辨率（仅补充） */
    resMode?: ResMode;
    /** 本轮画布实测的 dpr / downsample（核对分辨率档是否与预期一致） */
    dpr?: number;
    downsample?: number;
    firstFrameMs?: number;
    fetchMs?: number;
    decodeMs?: number;
    texMs?: number;
    bytes?: number;
    resW?: number;
    resH?: number;
    storageMB?: number;
    /** 画面覆盖率（可比性核对：与本文方法同场景的 covered% 对照） */
    coveredPct?: number;
    /** 机位指纹（视图矩阵前 6 项；每轮应完全一致，否则说明机位未固定） */
    poseKey?: string;
    /** `pose=ours` 时机位是否成功注入（false 表示仍用 Flux-GS 自己的机位） */
    poseInjected?: boolean;
    /** 动态相机（`?spin=`）实际注入的转动速度（deg/帧；0/缺省 = 静止协议） */
    spinDeg?: number;
    /** 轨迹模式（`rate` = 匀速转 | `swing` = ±摆幅内往复摆动）与峰值角速度（deg/帧）：
     *  `spin=` 的语义由 `spin_mode=` 决定（与本文臂同名字段，格式逐字一致）。 */
    spinMode?: string;
    spinPeriod?: number;
    spinPeakDeg?: number;
    /** 内容量扫描（`?sweep=<k>`，与本文臂同名字段）：逐姿态实测的覆盖率 / 裁剪盒内高斯比例 / 提交实例数。
     *  用来证明"两臂在整条轨迹上看着同量级的内容"——否则 fps 不掉可以解释成"要画的东西变少了"。 */
    sweepK?: number;
    sweepCoveredMean?: number;
    sweepCoveredMin?: number;
    sweepCoveredMax?: number;
    sweepSeenMean?: number;
    sweepSeenMin?: number;
    sweepSeenMax?: number;
    sweepDrawnMin?: number;
    sweepDrawnMax?: number;
    sweepFrames?: string;
    sweepYaws?: string;
    sweepPoses?: string;
    sweepCoveredList?: string;
    sweepSeenList?: string;
    sweepDrawnList?: string;
    /** 点集包围盒（**世界坐标**，与本文臂同名字段同格式）与对角线长度：基线侧的点集是
     *  `__FLUXGS_DUMP_XYZ__` 回报的**解码后世界坐标**（739431 点）。用途见本文臂同名注释。 */
    sceneMin?: string;
    sceneMax?: string;
    sceneDiag?: number;
    /** 本测帧窗口内基线 worker **真正完成**的排序次数（效度自查；静止下应 ≈1，动态下按帧数增长） */
    sortResults?: number;
    /** 旋转轴心（`x,y,z`）或来源标记 `cam`（绕相机自身位置原地转，载荷会变，慎用） */
    spinPivot?: string;
    /** 轴心来源：param（URL `?pivot=`）| cam（相机位置回退） */
    spinPivotSrc?: string;
    /** 末帧视图 vs 共享实现目标视图的最大元素偏差（受 END 的 1e-3 舍入限制，≤2e-3 即"同一条轨迹"） */
    spinErr?: number;
    /** 动态相机的异常/说明（如"未取到初始视图，已退回静止协议"） */
    spinNote?: string;
    /** dump=1 时导出的世界坐标点数 */
    dumped?: number;
    /** 本轮渲染器解码出的真实点数（`__FLUXGS_BENCH_END__.points`）：核对点数档与负载量级 */
    points?: number;
}
interface BenchState {
    v: number;
    busy: boolean;
    u: string;
    sceneIds: string[];
    rounds: number;
    cold: boolean;
    resW: number;
    resH: number;
    benchFrames: number;
    warmupFrames: number;
    idx: number;
    roundDone: number;
    results: RoundResult[];
    started: number;
}

const STATE_KEY = "gsm-fluxbench-v1";
const ARCHIVE_KEY = "gsm-fluxbench-archive-v1";

// ------------------------------------------------------------------ small utils
function param(name: string, dflt = ""): string {
    try {
        const v = new URLSearchParams(location.search).get(name);
        return v === null ? dflt : v;
    } catch {
        return dflt;
    }
}
function fmt(n: number | undefined, digits = 1): string {
    return n === undefined || !Number.isFinite(n) ? "-" : n.toFixed(digits);
}
function median(nums: number[]): number | undefined {
    if (nums.length === 0) return undefined;
    const a = [...nums].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ------------------------------------------------------------------ scene manifest
let manifest: FluxSceneMeta[] = [];
/** 本文臂导出的逐场景视图矩阵（bench-camviews.json）；`pose=ours` 时注入到 Flux-GS 渲染器，
 *  使基线在**完全相同的机位**下测帧。 */
let camViews: Record<string, number[]> = {};

async function loadCamViews(): Promise<void> {
    try {
        const res = await fetch("./bench-camviews.json");
        if (!res.ok) return;
        const json = (await res.json()) as { views?: Record<string, number[]> };
        camViews = json.views ?? {};
    } catch {
        /* 缺失时用 Flux-GS 自己的机位 */
    }
}

/** pose=aligned 用：由 align_flux_positions.py 生成的"本文机位→其坐标系"注入表。 */
async function loadInjectedViews(): Promise<Record<string, number[]>> {
    try {
        const res = await fetch("./bench-camviews-flux.json");
        if (!res.ok) return {};
        const json = (await res.json()) as { views?: Record<string, number[]> };
        return json.views ?? {};
    } catch {
        return {};
    }
}

async function loadManifest(): Promise<void> {
    const res = await fetch("./flux-baseline-scenes.json");
    if (!res.ok) throw new Error(`flux-baseline-scenes.json 加载失败：HTTP ${res.status}`);
    const json = (await res.json()) as { scenes?: FluxSceneMeta[] };
    manifest = Array.isArray(json.scenes) ? json.scenes : [];
}
function sceneById(id: string): FluxSceneMeta | undefined {
    return manifest.find((s) => s.id === id);
}
function expandProfile(profile: string): string[] {
    if (profile === "full") return manifest.map((s) => s.id);
    if (profile === "mip360" || profile === "tnt" || profile === "db") {
        return manifest.filter((s) => s.dataset === profile).map((s) => s.id);
    }
    if (profile === "quick") return ["garden", "truck", "drjohnson"].filter((id) => sceneById(id));
    // 2026-09-17 追加：**直接点名场景**（`profile=garden`，或 `profile=garden,truck`）—— 与本文臂
    // `bench-shared.expandProfile()` 的同名分支逐字同构（两臂必须同写法，否则操作手册 §11.5 的
    // 重负载阶梯里"两臂同一条 URL 只换域名"就不成立）。本函数是独立副本，改动请两边一起改。
    const named = profile
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const resolved = named.filter((id) => !!sceneById(id));
    if (named.length > 0 && resolved.length === named.length) return resolved;
    return [];
}

// ------------------------------------------------------------------ device info
/** WebGL2 能力探测：手机端拿不到上下文时（内核不支持/硬件加速被关闭）给出可操作提示与可回传信息。 */
interface GpuProbe {
    ok: boolean;
    reason: string;
    renderer: string;
}

function probeWebGL2(): GpuProbe {
    try {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl2") as WebGL2RenderingContext | null;
        if (!gl) return { ok: false, reason: "canvas.getContext('webgl2') 返回 null", renderer: "" };
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        // 不要在这里调 WEBGL_lose_context().loseContext()：强制丢弃 + 放弃恢复会让上下文名额/显存
        // 迟迟不归还（手机端连续冷启动到第 2~3 轮就建不出上下文），交给 GC 回收即可。
        return { ok: true, reason: "", renderer: String(name || "") };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err), renderer: "" };
    }
}

/** 当前桥接 iframe；GPU 名从它内部的 __FLUXGS_STATS__.glRenderer 读取。 */
let currentIframe: HTMLIFrameElement | null = null;
/** 首次成功读到的 GPU renderer 名（缓存下来供结果文本与状态栏使用）。 */
let cachedGlRenderer = "";

/** 读取 GPU renderer 名：来源是 iframe 内 Flux 页面**自己的上下文**（main.js 埋点上报）。
 *  本页**绝不新建探测上下文**——外层每建一个"建了不用 / 丢了不还"的上下文就白占一个名额，
 *  手机端连续冷启动时正是这类上下文把名额耗尽（表现为第 2~3 轮建不出上下文）。
 *  首个场景加载前返回空串（状态栏显示"待读取"，不谎报 unknown）。 */
function glRendererName(cw: Window | null = null): string {
    if (cachedGlRenderer) return cachedGlRenderer;
    try {
        const w = (cw ?? currentIframe?.contentWindow) as FluxWindow | null;
        const name = String(w?.__FLUXGS_STATS__?.glRenderer || "");
        if (name) cachedGlRenderer = name;
        return cachedGlRenderer;
    } catch {
        return "";
    }
}

/** 刷新状态栏的设备名；GPU 名还没上报时显示"待读取"，不显示 unknown。 */
function refreshDeviceLabel(cw: Window | null = null): void {
    const name = glRendererName(cw);
    stDevice.textContent = name ? guessChip() : "GPU 名待读取…";
}

/** 首次失败时才做的 WebGL2 可用性自检：探测上下文**只在失败路径**创建，正常跑测帧时一个都不多建。 */
let gpuChecked = false;
function firstFailureGpuCheck(): void {
    if (gpuChecked) return;
    gpuChecked = true;
    const probe = probeWebGL2();
    if (!probe.ok) showFatalGpuError(probe.reason);
}

/** WebGL2 不可用时的收尾：显示自检信息（可长按复制回传），并停止测试流程。 */
function showFatalGpuError(reason: string): void {
    stDevice.textContent = "WebGL2 不可用";
    statusBig.textContent = "WebGL2 不可用";
    statusBig.classList.remove("hidden");
    resultCard.style.display = "flex";
    rcSummary.textContent = "请在浏览器中开启硬件加速，或改用 Chrome/Edge（微信里可点右上角“在浏览器打开”）。";
    rcText.value =
        [
            "== bench-flux 环境自检失败 ==",
            "webgl2=0",
            `reason=${reason}`,
            `ua=${navigator.userAgent}`,
            `screen=${window.screen.width}x${window.screen.height} dpr=${window.devicePixelRatio}`,
        ].join("\n") + "\n";
}
function guessChip(): string {
    // 映射表与 bench.html 共用（bench-chip.ts），保证两臂结果头的 `chip=` 写法一致。
    return guessChipFrom(glRendererName()).chip;
}
function deviceInfo(): Record<string, string | number> {
    const chip = guessChipFrom(glRendererName());
    return {
        ua: navigator.userAgent,
        gl_renderer: glRendererName(),
        vendor: chip.vendor,
        chip: chip.chip,
        screen: `${window.screen.width}x${window.screen.height}`,
        dpr: window.devicePixelRatio || 1,
        hardwareConcurrency: navigator.hardwareConcurrency || 0,
        timestamp: new Date().toISOString(),
    };
}

// ------------------------------------------------------------------ stage sizing
/**
 * iframe 的布局尺寸固定为离屏分辨率（保证渲染器内部 innerWidth/Height 与画布一致），
 * 仅用 CSS transform 缩放显示，因此缩放不改变被测渲染负载。
 */
function layoutStage(): void {
    const w = stage.clientWidth || 1;
    const h = stage.clientHeight || 1;
    const hostW = Number(frameHost.dataset.w || "1600");
    const hostH = Number(frameHost.dataset.h || "1063");
    const s = Math.min(1, w / hostW, h / hostH);
    frameHost.style.transform = `scale(${s.toFixed(4)})`;
}

// ------------------------------------------------------------------ session state
type FluxWindow = Window & {
    __FLUXGS_STATS__?: FluxStats;
    __FLUXGS_SET_CAM__?: (view16: number[]) => boolean;
    __FLUXGS_DUMP_XYZ__?: () => Float32Array | null;
    /** [BENCH INSTRUMENTATION] 渲染器侧 4 个最小测帧入口（见 render_shared/main.js 顶部注释）。 */
    __FLUXGS_BENCH_PROBE__?: () => FluxBenchProbe;
    __FLUXGS_BENCH_BEGIN__?: (opts?: { frames?: number }) => boolean;
    __FLUXGS_BENCH_FRAME__?: () => FluxBenchFrame;
    __FLUXGS_BENCH_END__?: () => FluxBenchEnd;
    /** 内容量扫描：在指定姿态渲染一帧并回报覆盖率/实例数/投影矩阵（测帧窗口之后调用，不进计时） */
    __FLUXGS_BENCH_SWEEP__?: (view16: number[]) => FluxBenchSweep | null;
};

/** 轮询等待渲染器暴露注入接口并调用（钩子在 main() 里 fetch 之后才定义，需要等一下）。 */
async function injectView(cw: FluxWindow, view: number[], timeoutMs = 30000): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        const fn = cw.__FLUXGS_SET_CAM__;
        if (typeof fn === "function") {
            try {
                return fn.call(cw, view) !== false;
            } catch {
                return false;
            }
        }
        await sleep(100);
    }
    return false;
}

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
        /* ignore */
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
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    progressFill.style.width = `${pct}%`;
    stProgress.textContent = `${done}/${total} 轮`;
    stScene.textContent = `${sceneName} · ${roundText}`;
}
function flashStatusBig(text: string): void {
    statusBig.textContent = text;
    statusBig.classList.remove("hidden");
}
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_resolve, reject) =>
            setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms),
        ),
    ]);
}

// ------------------------------------------------------------------ iframe bridge
function waitIframeLoad(iframe: HTMLIFrameElement, timeoutMs = 30000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("iframe 加载超时")), timeoutMs);
        iframe.addEventListener(
            "load",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}

/**
 * 把 iframe 导航到 `about:blank` 并**等它 load**（最多 `timeoutMs`，超时也算完成），
 * 再摘节点 —— 比"设了 src 就在同一个任务里 remove()"更容易让浏览器走完**文档销毁**路径
 * （旧文档的 WebGL 上下文/显存/解码 Worker 都随之归还）。
 * 不抛异常：收尾阶段绝不能让调用方再多一条失败路径。
 */
function waitIframeBlank(iframe: HTMLIFrameElement, timeoutMs = 1500): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
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
}

/** 等一帧（收尾用）：让"节点移除 / 文档销毁"这一步确定被提交，再继续下一步。 */
function nextFrame(): Promise<void> {
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** 渲染器内部错误文案暴露在 #message（main() 的 catch 分支写入）。 */
function iframeErrorText(cw: FluxWindow): string {
    try {
        const el = cw.document.getElementById("message");
        return el ? (el.textContent || "").trim() : "";
    } catch {
        return "";
    }
}

/** 轮询等待 benchmark 钩子写入首帧时刻。 */
async function waitFirstFrame(cw: FluxWindow, timeoutMs = 180000): Promise<FluxStats> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        const err = iframeErrorText(cw);
        if (err) throw new Error(`Flux-GS 加载失败：${err}`);
        const stats = cw.__FLUXGS_STATS__;
        if (stats && stats.firstFrameAt > 0) return stats;
        await sleep(200);
    }
    throw new Error("等待 Flux-GS 首帧超时");
}

/** 从 iframe 的 Resource Timing 里取模型文件的下载段（与 bench.html 同口径）。 */
function modelFetchTiming(
    cw: FluxWindow,
    modelName: string,
): { fetchMs?: number; bytes?: number; responseEnd?: number } {
    try {
        const entries = cw.performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (!e.name.includes(modelName) || !e.responseEnd) continue;
            return {
                fetchMs: e.duration,
                bytes: e.transferSize > 0 ? e.transferSize : undefined,
                responseEnd: e.responseEnd,
            };
        }
    } catch {
        /* ignore */
    }
    return {};
}

/** dump=1：把 iframe 里解码出的世界坐标下载成本地 .bin（Float32 LE，N×3）。 */
function exportXyzDump(cw: FluxWindow, sceneId: string): number {
    const fn = cw.__FLUXGS_DUMP_XYZ__;
    const xyz = typeof fn === "function" ? (fn.call(cw) as Float32Array | null) : null;
    if (!xyz || xyz.length === 0) return 0;
    const blob = new Blob([xyz.buffer as ArrayBuffer], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `xyz-${sceneId}.bin`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return xyz.length / 3;
}

/**
 * 用**两臂共享的** `driveThroughputFrames()` 驱动 iframe 内的渲染器测帧（本页不再自己计时）。
 * 一帧 = iframe 里的 `__FLUXGS_BENCH_FRAME__()`（渲染一帧 + `gl.finish()`），与本文臂逐帧对称；
 * 计时区间/起表点/帧驱动全在共享实现里，两臂口径逐字相同。
 */
/** 动态相机（`?spin=`）在基线臂的注入配置：基准视图矩阵 + 旋转参数。 */
interface SpinInjection {
    /** 轨迹的解析结果（模式/摆幅或速度/周期）：与本文臂**同一个** `resolveSpinSpec()` 产物 */
    spec: SpinSpec;
    /** 每帧绕竖直轴转的角度（deg）；`swing` 模式下它是**摆幅** */
    deg: number;
    /** 竖直轴经过的世界坐标点 */
    pivot: [number, number, number];
    /** 轴心来源：param（`?pivot=`）| cam（由基准视图反解的相机位置＝原地转） */
    pivotSrc: string;
    /** 第 0 帧的视图矩阵（世界→视图，列主序）＝注入基线渲染器的基准位姿 */
    v0: number[];
}

async function driveFluxFrames(
    cw: FluxWindow,
    frames: number,
    warmup: number,
    timeoutMs: number,
    spin: SpinInjection | null = null,
): Promise<{ stats: DriveThroughputStats; end: FluxBenchEnd; spinErr?: number }> {
    const begin = cw.__FLUXGS_BENCH_BEGIN__;
    const step = cw.__FLUXGS_BENCH_FRAME__;
    const end = cw.__FLUXGS_BENCH_END__;
    if (typeof begin !== "function" || typeof step !== "function" || typeof end !== "function") {
        throw new Error(
            "Flux-GS 渲染器未暴露 __FLUXGS_BENCH_* 入口：请确认 render_shared/main.js 的 [BENCH INSTRUMENTATION] 钩子未被覆盖",
        );
    }
    // BEGIN：冻结机位（carousel=false）、停止渲染器自身的 rAF 链、复位累计量 —— 之后每帧都由本页驱动
    begin.call(cw, { frames: frames + warmup });
    const setCam = cw.__FLUXGS_SET_CAM__;
    /** 动态相机：帧号从**预热第一帧**起连续计数，逐帧把"该帧应有的视图矩阵"注入渲染器 */
    let spinIndex = 0;
    const stats = await withTimeout(
        driveThroughputFrames({
            frames,
            warmup,
            driver: "timer", // 协议值：每帧一条 setTimeout(0)，与本文臂同一条链的语义
            renderFrame: () => {
                if (spin && typeof setCam === "function") {
                    // 只注入**视图矩阵**（与本仓库 CameraData.viewMatrix 同布局）：位置与姿态都由它决定，
                    // 渲染器不会用鼠标/键盘改写（SET_CAM 同时关掉 carousel）。
                    // yaw 由**两臂共享**的 spinYawDegAt 给出（rate = 匀速累加；swing = ±摆幅正弦往复）。
                    setCam.call(cw, orbitViewMatrix(spin.v0, spinYawDegAt(spin.spec, spinIndex), spin.pivot));
                }
                spinIndex++;
                const r = step.call(cw);
                return r && Number.isFinite(r.syncMs) ? r.syncMs : 0;
            },
        }),
        timeoutMs,
        `driveThroughputFrames(${frames})`,
    );
    if (!stats || !Number.isFinite(stats.fps) || stats.fps <= 0) {
        throw new Error("Flux-GS 测帧未返回有效帧率");
    }
    const tail = end.call(cw);
    if (stats.rendered !== frames) {
        throw new Error(`测帧未完成（rendered=${stats.rendered}/${frames}）`);
    }
    // 轨迹对账：末帧注入的目标视图（按 END 的 1e-3 精度舍入）vs 渲染器回报的 `end.view`。
    // 若两者不一致，说明注入没被渲染器采用（或被它自己的相机逻辑覆盖），该轮不能参与跨臂比较。
    let spinErr: number | undefined;
    if (spin) {
        const expected = orbitViewMatrix(spin.v0, spinYawDegAt(spin.spec, spinIndex - 1), spin.pivot).map(
            (v) => Math.round(v * 1000) / 1000,
        );
        spinErr = Array.isArray(tail.view) && tail.view.length === 16 ? maxMatrixDiff(expected, tail.view) : undefined;
    }
    return { stats, end: tail, spinErr };
}

/**
 * **内容量扫描（基线臂）**：沿**与本文臂同一条轨迹**取 k 个姿态，逐个姿态渲染一帧并回报内容量读数。
 *
 * 与本文臂的 `BenchContext.contentSweep()` 逐项对应（字段同名同格式）：
 *   - `coveredPct`：iframe 内真实 readPixels 的覆盖率（`__FLUXGS_BENCH_SWEEP__` 里量）；
 *   - `seenPct`：裁剪盒内高斯点比例（用**它自己渲染器的** `proj` × 实际 `view` 复现 viewProj，
 *     再调**两臂共享的** `clipInsideRatio`；点集来自 `__FLUXGS_DUMP_XYZ__` 的解码世界坐标）；
 *   - `drawn`：该姿态提交绘制的实例数（渲染器的 `vertexCount`，不随视角变）。
 * 全部在测帧窗口**之后**执行，不进任何计时区间；异常一律吞掉（扫描失败不影响本轮 fps 结论）。
 */
async function runFluxContentSweep(cw: FluxWindow, spin: SpinInjection): Promise<SweepResult | null> {
    const sweepFn = cw.__FLUXGS_BENCH_SWEEP__;
    const k = sweepSampleCount(true);
    if (k <= 0 || typeof sweepFn !== "function") return null;
    const xyz = cw.__FLUXGS_DUMP_XYZ__?.() ?? null;
    const pointCount = xyz ? Math.floor(xyz.length / 3) : 0;
    const samples: SweepSample[] = [];
    for (const frame of spinSampleFrames(spin.spec, k)) {
        const target = orbitViewMatrix(spin.v0, spinYawDegAt(spin.spec, frame), spin.pivot);
        let r: FluxBenchSweep | null = null;
        try {
            r = sweepFn.call(cw, target);
        } catch {
            r = null;
        }
        if (!r) break;
        const actual = Array.isArray(r.view) && r.view.length === 16 ? r.view : target;
        const vp = Array.isArray(r.proj) && r.proj.length === 16 ? mulMat4(r.proj, actual) : null;
        const seen = clipInsideRatio(xyz, pointCount, vp, 4000);
        samples.push({
            frame,
            yaw: Math.round(spinYawDegAt(spin.spec, frame) * 100) / 100,
            pos: viewCameraPosition(actual.slice()),
            coveredPct: r.coveredPct,
            seenPct: seen.insidePct,
            seenCount: seen.inside,
            drawn: r.drawn,
        });
    }
    // 扫描结束把机位还原到基准位姿（iframe 随后会被销毁；还原只是让最后状态可复现）
    const setCam = cw.__FLUXGS_SET_CAM__;
    if (typeof setCam === "function") {
        try {
            setCam.call(cw, spin.v0);
        } catch {
            /* 忽略 */
        }
    }
    return samples.length > 0 ? { samples } : null;
}

// ------------------------------------------------------------------ measurement
async function measureRound(meta: FluxSceneMeta, round: number, st: BenchState): Promise<RoundResult> {
    const base: RoundResult = {
        scene: meta.id,
        dataset: meta.dataset,
        round,
        ts: new Date().toISOString(),
        ok: false,
        storageMB: meta.storageMB,
    };
    const token = `r${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const modelUrl = new URL(meta.model, location.href);
    modelUrl.searchParams.set("ts", token);
    const pageUrl = new URL(meta.page, location.href);
    pageUrl.searchParams.set("url", modelUrl.href);
    // **统一像素协议（主表口径）**：默认就带 `benchres=`（缺省 = res 1600×1063，`force=WxH` 可覆盖），
    // 使它的画布与投影视口 = 本文臂/基线臂的 res（三臂同像素，才允许跨方法比 FPS）。
    // 只有显式 `force=native` 才不干预它的自适应策略（点数 > 500000 → 1× CSS；否则 CSS × dpr）——
    // 那种模式下各臂分辨率不对等，结果行的 `res_mode=native` 会让报表脚本把它挡在主表之外。
    const forced = benchResOverride();
    const resMode: ResMode = resolutionMode();
    base.resMode = resMode;
    if (forced) {
        pageUrl.searchParams.set("benchres", `${forced.w}x${forced.h}`);
    }
    // ?fluxcam=N：让它的渲染器使用自己源码里的第 N 个真实镜头（与本文臂 cam=fluxcam:N 完全同一机位）
    const fluxCam = param("fluxcam", "");
    if (/^\d+$/.test(fluxCam)) {
        pageUrl.searchParams.set("fluxcam", fluxCam);
    }
    // [DIAG-EXPERIMENT-2] `?noge=1` 必须**显式转发**进 iframe：渲染器读的是**它自己文档**的
    //   `location.search`，父页面的参数不会自动传进去。首次尝试漏了这一步，于是"B 版"与 A 版逐字相同
    //   （实测 B 的 `seg_ge1/seg_ge2` 仍为 0.50/0.70ms）——这种"开关没生效"会伪装成"消融无效果"，
    //   是本轮桌面预筛拦下来的第 1 个坑，特此留痕。
    if (param("noge", "") === "1") {
        pageUrl.searchParams.set("noge", "1");
    }

    frameHost.dataset.w = String(st.resW);
    frameHost.dataset.h = String(st.resH);
    frameHost.textContent = "";
    const iframe = document.createElement("iframe");
    // 台上布局：统一像素协议下 iframe 布局尺寸 = 强制像素（与 bench.html 的 stage=fit1 逐字同构，
    // 且保证渲染器内部 innerWidth/Height 与画布一致）；原生档下退回"iframe 布局 = 本页视口"。
    const hostW = forced ? forced.w : Math.max(320, window.innerWidth);
    const hostH = forced ? forced.h : Math.max(320, window.innerHeight);
    iframe.width = String(hostW);
    iframe.height = String(hostH);
    iframe.style.width = `${hostW}px`;
    iframe.style.height = `${hostH}px`;
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("allow", "fullscreen");
    frameHost.dataset.w = String(hostW);
    frameHost.dataset.h = String(hostH);
    frameHost.appendChild(iframe);
    currentIframe = iframe;
    layoutStage();

    try {
        const loaded = waitIframeLoad(iframe); // 先挂 load 监听再设 src，避免极快加载时丢事件
        iframe.src = pageUrl.href;
        await loaded;
        const cw = iframe.contentWindow as FluxWindow | null;
        if (!cw) throw new Error("无法访问 iframe 内容窗口");
        refreshDeviceLabel(cw); // iframe 内的渲染器已建好上下文就立刻把 GPU 名显示出来

        // pose=aligned：把"本文机位换算到它的坐标系"后的视图矩阵注入它的渲染器
        if (param("pose", "") === "aligned") {
            const views = await loadInjectedViews();
            const view = views[meta.id] ?? null;
            base.poseInjected = view ? await injectView(cw, view, 30000) : false;
        }
        // `pose=ours`：把本文臂导出的同一机位注入基线渲染器（视角对齐的关键一步）
        if (param("pose", "") === "ours") {
            const view = camViews[meta.id] ?? camViews[meta.page] ?? null;
            if (!view) {
                base.poseInjected = false;
            } else {
                base.poseInjected = await injectView(cw, view, 30000);
            }
        }

        const stats = await waitFirstFrame(cw, 180000);

        // dump=1：只导出该场景解码后的世界坐标（.bin），用于跨实现坐标系对齐，不做测帧
        if (param("dump") === "1") {
            const n = exportXyzDump(cw, meta.id);
            base.dumped = n;
            base.ok = n > 0;
            if (n === 0) base.err = "未能取到解码后的世界坐标（__FLUXGS_DUMP_XYZ__ 为空）";
            return base;
        }
        const fetched = modelFetchTiming(cw, meta.model.split("/").pop() || "");
        const fetchEnd = fetched.responseEnd ?? stats.fetchEndAt;
        base.fetchMs = fetched.fetchMs;
        base.bytes = fetched.bytes;
        base.resW = stats.resW || st.resW;
        base.resH = stats.resH || st.resH;
        base.firstFrameMs = stats.firstFrameAt - fetchEnd;
        base.decodeMs = stats.decodeDoneAt > 0 ? stats.decodeDoneAt - fetchEnd : undefined;
        base.texMs =
            stats.texUploadDoneAt > 0 && stats.decodeDoneAt > 0
                ? stats.texUploadDoneAt - stats.decodeDoneAt
                : undefined;

        // ---- 动态相机（`?spin=`，效度自查）：逐帧把"该帧应有的视图矩阵"注入基线渲染器 ----
        // 为什么必须做：基线渲染器的排序 worker 带 `|dot-1| < 0.01`（≈ 视角变化 < 8.1°）就跳过排序的
        // 早退（render_shared/main.js:558-564），静止协议下它**整轮只排一次序**——这个便宜只有在
        // 相机真动起来之后才消失。基准位姿取**注入之后**的真实视图（`PROBE.view`），因此本页注入的
        // spin 轨迹与本文臂 `cam=flux` 看到的起始机位是同一条。
        const spinDeg = camSpinDegPerFrame();
        let spin: SpinInjection | null = null;
        if (spinDeg !== 0) {
            const probe = cw.__FLUXGS_BENCH_PROBE__?.();
            const v0raw = probe && Array.isArray(probe.view) && probe.view.length === 16 ? probe.view : null;
            if (!v0raw) {
                base.spinNote = "未取到初始视图（PROBE.view 缺失）：本轮退回静止协议";
            } else {
                const pivotParam = spinPivotParam();
                // 轨迹由**共享的** resolveSpinSpec 解析（与本文臂同一个函数：模式/摆幅/周期不会分叉）
                const spec = resolveSpinSpec(st.benchFrames + st.warmupFrames);
                if (!spec) {
                    base.spinNote = "轨迹为空（?spin=0）：本轮按静止协议处理";
                } else {
                    spin = {
                        spec,
                        deg: spec.deg,
                        pivot: pivotParam ?? viewCameraPosition(v0raw.slice()),
                        pivotSrc: pivotParam ? "param" : "cam",
                        v0: v0raw.slice(),
                    };
                    base.spinMode = spec.mode;
                    base.spinPeriod = spec.mode === "swing" ? spec.period : undefined;
                    base.spinPeakDeg = spinPeakDegPerFrame(spec);
                }
            }
        }

        // 测帧：共享驱动（两臂同一个函数）逐帧调 iframe 的 __FLUXGS_BENCH_FRAME__（渲染 + gl.finish()）。
        // BEGIN 在首个真实帧**之后**调用：native 档下机位就此冻结；forced 档在 load 时已冻结。
        const {
            stats: bench,
            end,
            spinErr,
        } = await driveFluxFrames(cw, st.benchFrames, st.warmupFrames, 240000 + st.warmupFrames * 2000, spin);
        base.fps = bench.fps;
        base.frames = bench.rendered;
        base.elapsedMs = bench.elapsedMs;
        base.cpuMs = bench.cpuMs;
        base.driver = bench.driver;
        base.syncMs = bench.syncMs;
        base.syncFrames = bench.syncFrames;
        // 帧内阻塞耗时（诊断/自检用；不可用于算倍数）：
        // 本臂的 frame_ms / cpu_ms 里多含一层"父页面 → iframe 内钩子"的跨 realm 直接调用
        // （本文臂是在父页面里直接渲染，没有这一层）。该开销量级远小于 1ms，方向是**对基线略不利**，
        // 属测量框架常量而非渲染器差异：核对两臂时不必修正，但结论里不把它算作方法优势即可。
        base.frameMs = bench.frameMs;
        base.frameMeanMs = bench.frameMeanMs;
        // [DIAG-EXPERIMENT-1] frame_ms / sync_ms 的分位数 + iframe 内 frame() 的 5 段分解：
        //   `seg_sum_p50_ms + sync_p50_ms` 应与 `frame_p50_ms` 同量级；差距大就说明还有未被计时的区间。
        base.frameP50 = bench.frameMsP50;
        base.frameP90 = bench.frameMsP90;
        base.syncP50 = bench.syncMsP50;
        base.syncP90 = bench.syncMsP90;
        // [DIAG-EXPERIMENT-1] 分段计时（iframe 内 frame() 的 5 段）摊平进结果字段
        applySegTimingFields(base, summarizeSegTiming(end.drawTimings));
        base.timerFloorMs = bench.timerFloorMs;
        base.timerFloorRounds = bench.timerFloorRounds;
        base.timerFloorSrc = bench.timerFloorSrc;
        base.fpsCapped = bench.fpsCapped;
        // 画布实测值（统一协议下应恒等于 res；native 档则由其自适应策略决定）
        base.resW = end.canvasW || base.resW;
        base.resH = end.canvasH || base.resH;
        base.dpr = end.dpr;
        base.downsample = end.downsample;
        base.points = end.points;
        base.coveredPct = end.coveredPct;
        // 静态轮：`pose=` = 渲染器回报的视图（= 全程机位）。动态轮（`?spin=`）：必须写**第 0 帧**视图
        // （`spin.v0`），否则与本文臂同名不同义（那边 `pose=` 取的是测帧前的起始机位），跨臂核对会误报。
        base.poseKey = spin
            ? spin.v0.slice(0, 6).join(",")
            : Array.isArray(end.view)
              ? end.view.slice(0, 6).join(",")
              : undefined;
        // ---- 动态相机（`?spin=`）实际应用量：`spinDeg=0` = 静止协议（`pose=` 即全程机位）----
        base.spinDeg = spin ? spin.deg : 0;
        // 排序次数（效度自查）：BEGIN 之后 worker 真正排完的次数，与本文臂 `sort_results=` 同名同义
        base.sortResults = typeof end.sorts === "number" ? end.sorts : undefined;
        if (spin) {
            base.spinPivot =
                spin.pivotSrc === "cam" ? "cam" : spin.pivot.map((v) => Math.round(v * 1000) / 1000).join(",");
            base.spinPivotSrc = spin.pivotSrc;
            base.spinErr = spinErr;
            // ---- 内容量扫描（`?sweep=<k>`）：测帧之后逐姿态实测"看着多少内容" ----
            // 与本文臂同名字段同格式：只有两臂在整条轨迹上看着同量级的内容，帧率差异才归因于实现。
            const sweep = await runFluxContentSweep(cw, spin);
            if (sweep) {
                const sum = summarizeSweep(sweep);
                base.sweepK = sum.k;
                base.sweepCoveredMean = sum.covMean;
                base.sweepCoveredMin = sum.covMin;
                base.sweepCoveredMax = sum.covMax;
                base.sweepSeenMean = sum.seenMean;
                base.sweepSeenMin = sum.seenMin;
                base.sweepSeenMax = sum.seenMax;
                base.sweepDrawnMin = sum.drawnMin;
                base.sweepDrawnMax = sum.drawnMax;
                base.sweepFrames = sum.frames;
                base.sweepYaws = sum.yaws;
                base.sweepPoses = sum.poses;
                base.sweepCoveredList = sum.covList;
                base.sweepSeenList = sum.seenList;
                base.sweepDrawnList = sum.drawnList;
            }
        }
        // ---- 点集包围盒（世界坐标）+ 对角线长度（与本文臂同名字段同格式）----
        // 目的与本文臂一致：把"两臂基准机位相差 0.039 世界单位"换算成**相对场景尺度的比例**。
        // 数据来源 = `__FLUXGS_DUMP_XYZ__`（解码后的世界坐标，与 sweep_seen 用的是同一份点集），
        // 纯 CPU 统计、发生在测帧窗口之后，不参与任何性能指标。
        try {
            const xyz = cw.__FLUXGS_DUMP_XYZ__?.() ?? null;
            const bnd = xyz ? positionsBounds(xyz, Math.floor(xyz.length / 3)) : null;
            if (bnd) {
                base.sceneMin = formatTriple(bnd.min);
                base.sceneMax = formatTriple(bnd.max);
                base.sceneDiag = bnd.diag;
            }
        } catch {
            /* 点集还没解码出来时忽略（包围盒只是自查字段） */
        }
        base.ok = true;
        refreshDeviceLabel(cw); // 首帧已过，GPU 名一定已上报（读的是它在用的上下文，零新建）
        return base;
    } catch (err) {
        base.err = err instanceof Error ? err.message : String(err);
        return base;
    } finally {
        // 先让 iframe 卸载页面以释放它的 WebGL 上下文，再移除节点：
        // 手机端 13 个场景连续新建 iframe 会累积上下文名额/显存，导致后面的场景拿不到上下文。
        // 顺序比"设了 src 立刻 remove()"更强：等 about:blank **真的 load**（≤1500ms）→ 摘节点 →
        // 再让出两帧，确保旧文档走完销毁路径（上下文/显存/解码 Worker 都随之归还），
        // 而不是把"卸载旧文档"和"新建下一个文档"压在同一个任务里。
        await waitIframeBlank(iframe);
        iframe.remove();
        if (currentIframe === iframe) currentIframe = null;
        frameHost.textContent = "";
        await nextFrame();
        await nextFrame();
    }
}

/**
 * [DIAG-EXPERIMENT-1] 分段计时的结果行字段由 **两臂共用** 的 `segTimingRoundTags()`（bench-shared）
 * 统一输出：本文臂 3 段（prep/draw/post，`seg_ge1/ge2` 写 `-`）、Flux 臂 5 段，字段名与格式不可能分叉。
 * 这里只补上共享驱动两个核心量的分位数（`sync_p50/p90_ms`、`frame_p50/p90_ms`）。
 */
function fluxThroughputPercentileTags(r: RoundResult): string[] {
    return throughputPercentileRoundTags(r);
}

function buildResultText(st: BenchState): string {
    const env = deviceInfo();
    const lines: string[] = [];
    lines.push("[RESULT]");
    lines.push("engine=fluxgs");
    lines.push(`u=${st.u}`);
    lines.push(`chip=${env.chip}`);
    lines.push(`vendor=${env.vendor}`);
    lines.push("mode=bench");
    lines.push(`profile=${st.sceneIds.join(",")}`);
    lines.push(`rounds=${st.rounds}`);
    lines.push(`cold=${st.cold ? 1 : 0}`);
    lines.push(`res=${st.resW}x${st.resH}`);
    lines.push(`frames=${st.benchFrames}`);
    lines.push(`warmup=${st.warmupFrames}`);
    // 帧驱动与 FPS 定义：本臂与本文臂走**同一个**共享驱动（bench-shared.driveThroughputFrames，
    // 逐帧调渲染器的 __FLUXGS_BENCH_FRAME__ = 渲染一帧 + gl.finish()），起表点 = 首个计帧绘制完成之后。
    // throughputFields() 输出的字段名/格式与 bench.html 结果头**逐字相同**，脚本可直接对齐。
    const roundStats = st.results.filter((r) => r.ok);
    lines.push(
        ...throughputFields({
            driver: "timer",
            resMode: resolutionMode(),
            timerFloorMs: median(roundStats.map((r) => r.timerFloorMs ?? 0).filter((v) => v > 0)),
            timerFloorRounds: roundStats.find((r) => r.timerFloorRounds)?.timerFloorRounds,
            timerFloorSrc: roundStats.find((r) => r.timerFloorSrc)?.timerFloorSrc,
            // sync_ms / sync_frames 取各轮中位数：**包含 0**（GPU 很快时 sync 就是 0.00ms，
            // 过滤掉 0 会让表头变成 "-" 而逐轮却是 0.00，反而让人以为字段缺失）。
            syncMs: median(roundStats.map((r) => r.syncMs).filter((v): v is number => typeof v === "number")),
            syncFrames: median(roundStats.map((r) => r.syncFrames).filter((v): v is number => typeof v === "number")),
            // 帧内阻塞耗时（诊断/自检用；不可用于算倍数）：与本文臂结果头同名字段，供核对量级与地板关系
            frameMs: median(roundStats.map((r) => r.frameMs).filter((v): v is number => typeof v === "number")),
            frameMeanMs: median(roundStats.map((r) => r.frameMeanMs).filter((v): v is number => typeof v === "number")),
            fpsCapped: roundStats.some((r) => r.fpsCapped),
            // 动态相机（`?spin=`，效度自查）：取各轮上报的实际应用量（缺省 0 = 静止协议）
            spinDeg: roundStats.find((r) => r.spinDeg)?.spinDeg,
            // 轨迹模式与峰值角速度（2026-09-17 追加，与本文臂结果头同名字段）
            spinMode: roundStats.find((r) => r.spinMode)?.spinMode,
            spinPeriod: roundStats.find((r) => typeof r.spinPeriod === "number")?.spinPeriod,
            spinPeakDeg: roundStats.find((r) => typeof r.spinPeakDeg === "number")?.spinPeakDeg,
            spinPivot: roundStats.find((r) => r.spinPivot)?.spinPivot,
            spinErr: roundStats.find((r) => typeof r.spinErr === "number")?.spinErr,
            spinNote: roundStats.find((r) => r.spinNote)?.spinNote,
            // 排序次数（效度自查）：静止下应 ≈1、动态下按帧数增长（两臂同名字段）
            sortResults: roundStats.find((r) => typeof r.sortResults === "number")?.sortResults,
            // 本臂没有 FadeInPass 那类"前 N 帧只画一部分"的档位：写 n/a（把本文臂的 `fade=none` 区分开）
            fade: "n/a",
        }),
    );
    // 本臂载入期口径分解（对应本文臂结果头的 `parse_def=`；**两臂的这两个字段不能直接相减比较**）：
    //   decode_ms = responseEnd → **解码 + 主纹理上传**完成（render_shared/main.js:1854-1855）
    //   tex_ms    = 解码完成 → **SH 纹理上传**完成（main.js:1870）
    // 本文臂不单列纹理上传（首次 render 内的 texImage2D 落在 first_frame_ms 里），
    // 所以"载入期性能"只能在 first_frame_ms 上比，breakdown 只作脚注解释构成差异。
    lines.push(`decode_def=response_end_to_decode_complete_incl_main_texture`);
    lines.push(`tex_def=decode_complete_to_sh_texture_upload_complete`);
    // 台上布局：本臂始终"iframe 布局尺寸 = 目标像素 + CSS transform 等比缩小"（bench-flux.ts:layoutStage）
    // 即 bench.html 的 `stage=fit1`，两臂最后一处口径差异由此可核对。
    lines.push(`stage=fit1`);
    lines.push(`force=${param("force", "") || `res(${st.resW}x${st.resH})`}`);
    lines.push(`pose_src=${param("pose", "flux")}`);
    lines.push(`ts=${new Date().toISOString()}`);
    lines.push(`ua=${env.ua}`);
    lines.push(`gl_renderer=${env.gl_renderer}`);
    lines.push(`screen=${env.screen}`);
    lines.push(`dpr=${env.dpr}`);
    lines.push(`hardwareConcurrency=${env.hardwareConcurrency}`);
    lines.push("--- per-round ---");
    for (const r of st.results) {
        const tags = [
            `scene=${r.scene}`,
            `dataset=${r.dataset}`,
            `round=${r.round}`,
            `ok=${r.ok ? 1 : 0}`,
            // 逐轮也写 res_mode：报表脚本据此把 native 档的行挡在跨方法主表之外
            `res_mode=${r.resMode ?? resolutionMode()}`,
            `res=${r.resW ?? ""}x${r.resH ?? ""}`,
            `dpr=${r.dpr ?? ""}`,
            `points=${r.points ?? ""}`,
            `downsample=${r.downsample === undefined ? "" : r.downsample.toFixed(4)}`,
            `bytes=${r.bytes ?? ""}`,
            `fetch_ms=${fmt(r.fetchMs, 0)}`,
            `first_frame_ms=${fmt(r.firstFrameMs, 0)}`,
            `decode_ms=${fmt(r.decodeMs, 0)}`,
            `tex_ms=${fmt(r.texMs, 0)}`,
            `fps=${fmt(r.fps, 1)}`,
            `frames=${r.frames ?? ""}`,
            `elapsed_ms=${fmt(r.elapsedMs, 0)}`,
            `cpu_ms=${fmt(r.cpuMs, 2)}`,
            `sync_ms=${fmt(r.syncMs, 2)}`,
            `sync_frames=${r.syncFrames ?? ""}`,
            // 帧内阻塞耗时（诊断/自检用）：与 `floor_used_ms` 并排，可核对"帧率被地板焊死，
            // 而帧内实际阻塞是 X ms"（`cpu_ms ≈ 地板 + frame_ms`）；不得用它算两臂倍数。
            `frame_ms=${fmt(r.frameMs, 2)}`,
            `frame_mean_ms=${fmt(r.frameMeanMs, 2)}`,
            // [DIAG-EXPERIMENT-1] 分段计时诊断字段（由**两臂共用**的 segTimingRoundTags() 输出；
            //   读法：`seg_sum_p50_ms + sync_p50_ms` ≈ `frame_p50_ms`；差得远说明还有没计时的区间）。
            ...segTimingRoundTags(r),
            ...fluxThroughputPercentileTags(r),
            `driver=${r.driver ?? "timer"}`,
            // 判定 fps_capped 时**实际引用**的本轮实测地板（表头 timer_floor_ms= 是各轮中位数，
            // 与本字段不是同一个数）：两臂逐轮行同名字段，报表脚本据此重算判据自查。
            `floor_used_ms=${fmt(r.timerFloorMs, 2)}`,
            `fps_capped=${r.fpsCapped ? 1 : 0}`,
            `covered=${fmt(r.coveredPct, 1)}%`,
            `poseInjected=${r.poseInjected === undefined ? "" : r.poseInjected ? 1 : 0}`,
            `pose=${r.poseKey ?? ""}`,
            // 动态相机（`?spin=`，效度自查）：与本文臂同名同格式；`spin=0` = 静止协议，
            // `pose=` 即全程机位；`spin>0` 时 `pose=` 只代表第 0 帧起始机位。
            // 标签由**两臂共用**的 spinRoundTags()/sweepRoundTags() 生成（格式不可能分叉）。
            ...spinRoundTags(r),
            `sort_results=${r.sortResults ?? "-"}`,
            ...sweepRoundTags(r),
            // 包围盒（世界坐标）+ 对角线：与本文臂同名同格式，用于把"机位偏差"换算成相对场景尺度的比例
            ...sceneBoundsRoundTags(r),
            // 排序滞后核对（`sortlag_*`）：**基线臂没有这个探针**（`?sortlag=1` 只在本文臂实现，
            // 见 bench-measure.sortLagProbe），所以这里不打印该组字段 —— 字段的定义与格式仍由
            // 两臂共用的 sortLagRoundTags() 给出，将来基线侧若要补探针，直接调它即可。
            ...(r.spinNote ? [`spin_note=${r.spinNote.replace(/\s+/g, "_")}`] : []),
        ];
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
        if (arr.length === 0) {
            const all = st.results.filter((r) => r.scene === sceneId);
            lines.push(`summary scene=${sceneId} dataset=${all[0]?.dataset ?? ""} ok=0`);
            continue;
        }
        const med = (key: keyof RoundResult): number | undefined =>
            median(arr.map((r) => Number(r[key])).filter((v) => Number.isFinite(v)));
        lines.push(
            [
                `summary scene=${sceneId}`,
                `dataset=${arr[0].dataset}`,
                `storage_mb=${arr[0].storageMB ?? ""}`,
                `ok=${arr.length}/${st.rounds}`,
                `fps_median=${fmt(med("fps"), 1)}`,
                `first_frame_ms_median=${fmt(med("firstFrameMs"), 0)}`,
                `decode_ms_median=${fmt(med("decodeMs"), 0)}`,
                `tex_ms_median=${fmt(med("texMs"), 0)}`,
                `fetch_ms_median=${fmt(med("fetchMs"), 0)}`,
                `covered_median=${fmt(med("coveredPct"), 1)}%`,
                `pose=${arr[0].poseKey ?? ""}`,
                `res=${arr[0].resW ?? ""}x${arr[0].resH ?? ""}`,
            ].join(" "),
        );
    }
    lines.push("[END]");
    return lines.join("\n");
}

// ------------------------------------------------------------------ bench runner
function totalRounds(st: BenchState): number {
    return st.sceneIds.length * st.rounds;
}

async function runBench(st: BenchState): Promise<void> {
    while (st.roundDone >= st.rounds && st.idx < st.sceneIds.length) {
        st.idx++;
        st.roundDone = 0;
    }
    if (st.idx >= st.sceneIds.length) {
        finishBench(st);
        return;
    }
    const meta = sceneById(st.sceneIds[st.idx]);
    if (!meta) {
        st.idx++;
        st.roundDone = 0;
        saveState(st);
        await runBench(st);
        return;
    }
    const roundNo = st.roundDone + 1;
    updateProgress(st.results.length, totalRounds(st), meta.name, `第 ${roundNo}/${st.rounds} 轮`);
    flashStatusBig(`正在测试 ${meta.name} · 第 ${roundNo}/${st.rounds} 轮，请稍候`);
    const r = await measureRound(meta, roundNo, st);
    st.results.push(r);
    if (!r.ok) firstFailureGpuCheck();
    st.roundDone = roundNo;
    saveState(st);

    const allDone = st.idx === st.sceneIds.length - 1 && roundNo >= st.rounds;
    if (allDone) {
        finishBench(st);
        return;
    }
    if (st.cold) {
        // 整页冷启动：重建 iframe/WebGL 上下文/解码 worker，更接近真实首开。
        // **经零上下文的中转页**（bench-hop.html，默认停 hopms=1500ms）再进新页：
        // 本页文档（连同刚才销毁的 iframe 上下文/显存）确定走完销毁路径，新页才开始建上下文，
        // 而不是"本页 sleep 一小段就 location.reload()"（那样新旧上下文的回收/创建会重叠）。
        // 中转页停留与导航都在测量之外，不计入任何指标；`?hop=0` 退回旧口径（等价于 location.reload()）。
        await sleep(200);
        location.replace(hopUrlFor(location.href));
        return;
    }
    await sleep(300);
    await runBench(st);
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

function finishBench(st: BenchState): void {
    try {
        archiveState(st);
    } catch {
        /* ignore */
    }
    clearState();
    progressRow.classList.add("hidden");
    statusBig.classList.add("hidden");
    frameHost.textContent = "";
    const okCount = st.results.filter((r) => r.ok).length;
    const text = buildResultText(st);
    rcText.value = text;
    const reportUrl = param("report");
    const autoReport = reportUrl !== "";
    if (autoReport) {
        setManualExportVisible(false);
        rcNote.textContent = "结果会自动回传，无需任何操作；看到“已自动提交”即可关闭本页面。";
    }
    rcSummary.textContent = autoReport
        ? `测试完成：成功 ${okCount}/${st.results.length} 轮。${REPORT_SUBMITTING}`
        : `测试完成：成功 ${okCount}/${st.results.length} 轮。请复制下方文本并发送给测试发起人。`;
    resultCard.style.display = "flex";
    if (autoReport) {
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
    try {
        await navigator.clipboard.writeText(rcText.value);
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
        a.download = `bench-flux-archive-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch {
        /* ignore */
    }
}

function buildStateFromParams(): BenchState {
    const rounds = Math.max(1, Math.min(9, parseInt(param("rounds", "3"), 10) || 3));
    const cold = param("cold") !== "0";
    const resRaw = param("res", "1600x1063");
    const parts = resRaw.split("x");
    const resW = parseInt(parts[0], 10) || 1600;
    const resH = parseInt(parts[1], 10) || 1063;
    const benchFrames = parseInt(param("frames", "300"), 10) || 300;
    // 参考协议（Flux-GS 原协议）**没有预热帧**；默认 0。旧 1600×1063 对照口径可用 warmup=10。
    const warmupFrames = Math.max(0, parseInt(param("warmup", "0"), 10) || 0);
    const profile = param("profile", selProfile.value);
    return {
        v: 1,
        busy: true,
        u: param("u") || "fluxgs-auto",
        sceneIds: expandProfile(profile),
        rounds,
        cold,
        resW,
        resH,
        benchFrames,
        warmupFrames,
        idx: 0,
        roundDone: 0,
        results: [],
        started: Date.now(),
    };
}

function bindBenchEvents(): void {
    btnStart.addEventListener("click", () => {
        const st = buildStateFromParams();
        if (st.sceneIds.length === 0) {
            flashStatusBig("没有可用的场景（清单为空或 profile 无匹配项）");
            return;
        }
        saveState(st);
        void runBench(st);
    });
    btnCopy.addEventListener("click", () => {
        void copyResult();
    });
    btnDone.addEventListener("click", () => {
        resultCard.style.display = "none";
        frameHost.textContent = "";
        progressRow.classList.add("hidden");
        benchControls.classList.remove("hidden");
        btnExport.disabled = false;
    });
    btnExport.addEventListener("click", exportArchive);
}

function applyParamToControls(): void {
    const profile = param("profile");
    if (profile && ["quick", "full", "mip360", "tnt", "db"].includes(profile)) {
        selProfile.value = profile;
    }
    const rounds = param("rounds");
    if (rounds) inpRounds.value = rounds;
    const frames = param("frames");
    if (frames) inpFrames.value = frames;
    const cold = param("cold");
    if (cold !== "") selCold.value = cold === "0" ? "0" : "1";
}

async function main(): Promise<void> {
    // 注意：这里**不再**在启动时建探测上下文（7b1003a 那个跑通的版本也没有）。
    // 手机端"建了不用 / 丢了不还"的上下文会挤占名额，导致后面几轮建不出上下文；
    // 可用性判断交给渲染器自身报错 + 首次失败时的 firstFailureGpuCheck()。
    stDevice.textContent = "读取场景清单…";
    try {
        await loadManifest();
        await loadCamViews();
    } catch (err) {
        stDevice.textContent = "清单加载失败";
        flashStatusBig(err instanceof Error ? err.message : String(err));
        return;
    }
    applyParamToControls();
    refreshDeviceLabel();
    // 状态栏显示当前像素口径：forced 显示实际像素，native 显示"其自适应"
    const forcedNow = benchResOverride();
    stRes.textContent = forcedNow
        ? `${forcedNow.w}×${forcedNow.h}（统一像素协议）`
        : "native（其自适应，仅补充、不可跨方法比 FPS）";
    bindBenchEvents();
    window.addEventListener("resize", layoutStage);
    layoutStage();

    const st = loadState();
    if (st && st.busy) {
        await runBench(st);
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
    flashStatusBig("选择上方测试范围并点击“开始测试”");
}

window.addEventListener("DOMContentLoaded", () => {
    void main();
});
