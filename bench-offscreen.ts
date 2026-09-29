/**
 * bench-offscreen.ts — **离屏论文协议**的测帧内核（复刻 Flux-GS, Du et al. 2026, §5.1）。
 *
 * 论文原文口径（四要素）→ 本文件的实现位置：
 *   1. "frames are rendered to an offscreen frame buffer"
 *      → 渲染目标由调用方绑定：本文臂走 `WebGLRenderer.createOffscreenTarget()`（FBO + 颜色
 *        renderbuffer，见 `src/renderers/webgl/utils/OffscreenBenchTarget.ts`）；Flux 臂走
 *        **同一个类**套在它的 gl 上（`__FLUXGS_BENCH_GL__()`）。本文件不碰 GL，两臂不可能分叉。
 *   2. "breaks the screen display 120 FPS limit and UI overhead"
 *      → 驱动用 `driver = "msgchannel"`（`bench-shared.throughputTick()`）：既不挂 rAF（vsync），
 *        也不吃 `setTimeout(0)` 的 4ms 级钳制。
 *   3. "after a short warm-up period to mitigate thermal and initialization effects"
 *      → `warmupFrames`（缺省 90，见 `OFFSCREEN_DEFAULTS`）：预热帧照常渲染，**不进任何统计**。
 *   4. "the average FPS is computed over multiple consecutive runs"
 *      → `numRuns`（缺省 5）个连续 run，每个 run 独立计时并各自算 FPS；最终报**均值 ± 标准差**
 *        （另附 min/max/中位数与逐 run 列表），而不是单轮单值。
 *
 * 与在屏协议的关系：**并列存在，互不改变**。在屏协议（`bench-measure.runThroughputFrames` +
 * `bench-shared.driveThroughputFrames`）一行未动；本文件只在 `benchmode=offscreen-paper-match` 时被调用。
 *
 * 依赖约束：本文件**不 import `src/` 下的任何渲染代码**（只 import bench-shared 的纯逻辑），
 * 因此父页面（bench.ts）可以安全地引用它的字段名/标签函数而不必建 WebGL 上下文。
 */
import { meanStd, median, throughputTick } from "./bench-shared";
import type { DriveThroughputStats, MeanStd, ThroughputDriver } from "./bench-shared";

/**
 * GPU 进度检查的回报（由调用方用 `NonBlockingFrameGate` 提供）。
 * **累计语义**：`fenceWaitMs` / `fencesMax` / `forcedDrains` 是该门自创建以来的累计值/峰值，
 * 因此第 N 个 run 上的读数 ≥ 第 N-1 个 run 上的读数；协议按"每个 run 结束时读到的最新值"记录，
 * 全过程中的最大值即最后那个 run 的值。`fencesLimit` 是配置常量。
 */
export interface OffscreenGateSample {
    /** 累计花在 GPU 进度检查（零超时轮询 + 超限阻塞等待）上的毫秒 */
    fenceWaitMs: number;
    /** 观察到的最大在途栅栏数（≤ limit 即"没有无限积压"） */
    fencesMax: number;
    /** 栅栏积压上限（配置值） */
    fencesLimit: number;
    /** 因超出上限而阻塞等待最老栅栏的累计次数 */
    forcedDrains: number;
    /**
     * "刚插进去的栅栏第一次轮询就已 signaled"的累计次数。**≈ 总帧数**说明栅栏根本没生效
     * （命令没投给 GPU：漏了 `gl.flush()`）——此时读数只反映提交耗时，必须判该轮无效。
     */
    firstPollSignaled: number;
}

/** 单个 run 的测帧统计（每个 run 独立计时，互不重叠）。 */
export interface OffscreenRunSample {
    /** run 序号（0 起） */
    run: number;
    /** 该 run 计的帧数 */
    frames: number;
    /** 该 run 的计时区间墙钟毫秒（首帧绘制完成 → 末帧绘制完成） */
    elapsedMs: number;
    /** 该 run 的平均 FPS = frames / (elapsedMs/1000)（**墙钟口径**；见 `fpsSource` 的说明） */
    fps: number;
    /** 该 run 帧内阻塞耗时中位数（渲染提交 + 进度检查；诊断用，**不是**单帧渲染能力） */
    frameMsMedian: number;
    /** 该 run 帧内阻塞耗时均值（暴露长尾抖动） */
    frameMsMean: number;
    /** 记到该 run 结束时的累计进度检查耗时（ms） */
    fenceWaitMs: number;
    /** 记到该 run 结束时的在途栅栏峰值 */
    fencesMax: number;
    /** 栅栏积压上限（配置值） */
    fencesLimit: number;
    /** 记到该 run 结束时的超限阻塞次数 */
    forcedDrains: number;
    /** 该 run 内 GPU 计时样本的中位数（ms；无样本 = undefined） */
    gpuMsMedian?: number;
    /** 该 run 内有效 GPU 计时样本数 */
    gpuSamples: number;
    /** 该 run 的 **GPU 受限帧率** = 1000 / gpuMsMedian（无样本 = undefined） */
    gpuFps?: number;
}

/** 驱动回调：两支臂各提供自己的实现（本文臂 = `frameRender()`；Flux 臂 = iframe 内的帧钩子）。 */
export interface OffscreenFrameHooks {
    /** 画这一帧**之前**调用（`gputimer` 模式用它开始计时查询；缺省 = 无前置动作） */
    beforeFrame?: (run: number, frame: number) => void;
    /** 提交**恰好一帧**渲染（**不**做逐帧硬同步；同步策略由 `afterFrame` 负责） */
    renderFrame: (run: number, frame: number) => void;
    /** 每帧提交后的收口（非阻塞 GPU 进度检查 / GPU 计时回读）；返回该门的累计诊断值 */
    afterFrame?: () => OffscreenGateSample | void;
    /** 一个 run 结束后的收尾排空（把剩余栅栏/查询等干净，**在计时区间之外**）；缺省 = 不做 */
    endRun?: () => void | Promise<void>;
    /** 已采集到的 GPU 计时样本（毫秒，累计；缺省 = 该环境没有计时查询能力） */
    gpuMsSamples?: () => number[];
    /** GPU 计时查询被丢弃的样本数（`GPU_DISJOINT_EXT` 或读数越界；缺省 = 0） */
    gpuMisses?: () => number;
    /** GPU 计时器的**逐步诊断**一行摘要（缺省 = 无 GPU 计时器；失败时是关键现场） */
    gpuDiag?: () => string;
    /** 返回 true 时中断（本轮被取消/释放） */
    stopped?: () => boolean;
}

/**
 * **自动同步策略的回落链**（2026-09-26 真机实测后新增，纯函数、可单测）。
 *
 * 现场教训（Snapdragon 8 Gen 2 / Adreno 740 / 微信 XWEB，1300 万像素 FBO）：
 * 请求 `sync=gputimer`（缺省）但设备**不提供** `EXT_disjoint_timer_query_webgl2` 时，
 * 原实现直接回落到 `each`（每帧 `gl.finish()` + 1×1 `readPixels`）——那测的是
 * "**每帧全同步延迟**"（实测 70.2ms/帧、整轮 115s、报出 13.8 FPS），
 * 而同一台设备在屏口径有 ~200 FPS。也就是说那条回落产出的数字**与论文口径不可比**。
 *
 * 正确回落是 `fence`：非阻塞 `fenceSync` + `clientWaitSync(0)`，只有在途帧数超过上限（缺省 3）
 * 时才等最老的那一帧。这样 CPU 不被每帧同步卡住，读数反映的是**受 GPU 反压限制的吞吐**
 * （GPU 跟不上 ⇒ 在途帧数顶到上限 ⇒ 不得不等 ⇒ fps 自然降到 GPU 速率）——正是论文协议要的量纲。
 * 若该环境连 `clientWaitSync` 都不提供有效等待（桌面 ANGLE 实测如此），
 * 物理上限守卫（`OFFSCREEN_MAX_PLAUSIBLE_FPS`）会把该轮判为不可信，不会悄悄报错数。
 *
 * 显式 `?sync=each` 仍然保留（A/B 对照用），只是**不再作为自动回落目标**。
 */
export function resolveOffscreenSyncMode(
    wanted: "each" | "fence" | "gputimer" | "batch" | "natural" | "none",
    timerSupported: boolean,
): { mode: "each" | "fence" | "gputimer" | "batch" | "none"; fallback: string } {
    // 零仪器基准（`?sync=none&driver=raf&natsecs=30`）：门**不做任何** GL 侧同步/查询/排空，
    // 帧间隔 = rAF 回调时间戳之差。用途：为"仪器自身开销"提供一个真正干净的基准
    // （此前用 `batch` 的 64.65ms/帧 当基准，那个数本身已混入 run 末排空的开销）。
    if (wanted === "none") {
        return { mode: "none", fallback: "zero_instrument->raf+no_sync_calls(no_finish_no_readpixels_no_drain)" };
    }
    // 自然模式：DONE 逐帧同步（gate 用 `each`：finish + 1×1 readPixels），**不攒帧、不强制 drain**；
    // 区别在驱动（`driver=raf`，vsync 边界）与"按 30 秒墙钟计时"，不在同步操作本身。
    if (wanted === "natural") {
        return { mode: "each", fallback: "natural->raf+perframe_1x1_readpixels(no_batching)" };
    }
    if (wanted === "gputimer" && !timerSupported) {
        return { mode: "batch", fallback: "gputimer_unavailable->batch" };
    }
    return { mode: wanted, fallback: "" };
}

/** 策略标签 + 可选的"为什么回落"后缀（两臂同格式；无回落时与原标签逐字相同）。 */
export function syncPolicyLabelWithNote(
    mode: "each" | "fence" | "gputimer" | "batch" | "none",
    maxFencesInFlight = 3,
    note = "",
): string {
    const base = syncPolicyLabel(mode, maxFencesInFlight);
    return note ? `${base}|fallback=${note}` : base;
}

/** GPU 同步/计时策略的标签（两臂同字面量；写进结果字段，供报告核对）。 */
export function syncPolicyLabel(mode: "each" | "fence" | "gputimer" | "batch" | "none", maxFencesInFlight = 3): string {
    if (mode === "fence") return `fence_sync_clientwait0_cap${maxFencesInFlight}`;
    if (mode === "gputimer") return "gpu_timer_query_ext_disjoint";
    if (mode === "batch") return "batch_submit_drain_at_run_end";
    if (mode === "none") return "zero_instrument_no_sync_calls";
    return "finish_and_readpixels1x1";
}

/**
 * 离屏协议结果 → 在屏协议的 `DriveThroughputStats` 摘要（**两臂共用唯一的转换实现**，
 * 字段语义逐项对齐，绝不静默改名）。为什么需要它：`measureOneRound`（本文臂）与
 * `measureRound`（Flux 臂）的门禁与结果字段写法都是"围绕 DriveThroughputStats 写的"，
 * 把离屏结果按语义映射到同一组字段上，两套数字才真正来自同一段收敛逻辑。
 *
 * | 字段 | 在屏（严格协议） | 离屏（论文协议） | 说明 |
 * |---|---|---|---|
 * | `fps` | 单轮 300 帧的 FPS | **各 run FPS 的均值** | 主指标；标准差另见 `offscreenFpsStd` |
 * | `cpuMs` | elapsed/(rendered-1) | `1000/fps.mean` | 同一含义：**含 GPU 同步**的均帧间隔（离屏下换成非阻塞栅栏） |
 * | `frames`/`rendered` | 单轮帧数 | 每 run 帧数 / 全部 run 的计帧总数 | 离屏的"每 run 帧数"另有 `offscreenFramesPerRun` |
 * | `syncMs`/`syncFrames` | 逐帧 `gl.finish()` 中位数 | **均摊**的进度检查耗时（`fenceWaitMs/总帧数`） | 离屏刻意不做每帧硬同步，故这是"非阻塞检查的代价"而非 `gl.finish()` |
 * | `frameMs`/`frameMeanMs` | 帧内阻塞耗时中位数/均值 | 各 run 中位数的中位数 / 各 run 均值的均值 | 诊断量，**不得**用来算两臂倍数 |
 * | `gapMin/Med/MaxMs` | 逐帧间隔分位数 | **0（未测）** | 离屏协议的 tick 节奏不参与 fps，故不测 |
 * | `timerFloorMs/Rounds/Src` | setTimeout 地板 | **msgchannel 空转地板**（`empty_drive_msgchannel`） | 判据 `fpsCapped` 两者同构：`1/fps ≤ floor × 1.05` |
 * | `fpsCapped` | 贴 setTimeout 地板 | 贴 msgchannel 地板 | 贴地板时读数只能当**下界** |
 * | `*P50`/`*P90` | 有样本 | **0 且不在结果里输出**（调用方用 `if (!offscreen)` 守卫） | 离屏协议不采集逐帧分段 |
 */
export interface OffscreenThroughputBridge extends DriveThroughputStats {
    /** 离屏协议的每一帧都由协议内核提交过一次渲染，故 = 计帧总数 */
    renders: number;
}

export function offscreenAsThroughputStats(off: OffscreenProtocolResult): OffscreenThroughputBridge {
    const totalFrames = off.renderedFrames;
    const frameMeanAcrossRuns =
        off.runs.length > 0 ? off.runs.reduce((a, r) => a + r.frameMsMean, 0) / off.runs.length : 0;
    return {
        driver: off.driver,
        frames: off.framesPerRun,
        rendered: totalFrames,
        renders: totalFrames,
        elapsedMs: off.elapsedMs,
        fps: off.fps.mean,
        cpuMs: off.fps.mean > 0 ? 1000 / off.fps.mean : 0,
        gapMinMs: 0,
        gapMedMs: 0,
        gapMaxMs: 0,
        syncMs: totalFrames > 0 ? off.fenceWaitMs / totalFrames : 0,
        syncFrames: totalFrames,
        frameMs: off.frameMsMedian,
        frameMeanMs: frameMeanAcrossRuns,
        // 分位数离屏协议不采集：写 0；调用方在离屏分支**不会**把它们拷进结果（打印成 `-`）。
        frameMsP50: 0,
        frameMsP90: 0,
        syncMsP50: 0,
        syncMsP90: 0,
        warmupMs: off.warmupMs,
        timerFloorMs: off.driverFloorMs,
        timerFloorRounds: 0,
        timerFloorSrc: `empty_drive_${off.driver}`,
        fpsCapped: off.driverCapped,
        aborted: off.aborted,
        note: off.note,
    };
}

/** 离屏协议的完整结果（字段名见 `bench-shared.offscreenRoundTags`，两臂同格式）。 */
export interface OffscreenProtocolResult {
    /** 所有 run 都完整跑完（预热 + N 个 run 都未被中断） */
    completed: boolean;
    /** 被 `stopped()` 中断 */
    aborted: boolean;
    /** 说明（正常为空串） */
    note: string;
    driver: ThroughputDriver;
    framesPerRun: number;
    numRuns: number;
    warmupFrames: number;
    /** 预热阶段墙钟毫秒（**不进任何统计**，只作诊断） */
    warmupMs: number;
    runs: OffscreenRunSample[];
    /** 各 run FPS 的统计量（**主指标**：`fps.mean ± fps.std`） */
    fps: MeanStd;
    /** 各 run 帧内耗时中位数的中位数（诊断） */
    frameMsMedian: number;
    /** 全过程（预热 + 所有 run）墙钟毫秒（诊断） */
    elapsedMs: number;
    requestedFrames: number;
    renderedFrames: number;
    /** 本模式的实测驱动地板（msgchannel 空转校准，ms） */
    driverFloorMs: number;
    /** true = `1000/fps.mean ≤ driverFloorMs × 1.05`（与在屏协议 `fps_capped` 同判据） */
    driverCapped: boolean;
    /** 全程在途栅栏峰值 / 上限（`≤` 即没有无限积压） */
    fencesMax: number;
    fencesLimit: number;
    /** 全程累计 GPU 进度检查耗时（ms） */
    fenceWaitMs: number;
    /** 全程"新栅栏第一次轮询就已 signaled"次数（≈ 总帧数 ⇒ 栅栏没生效，该轮无效） */
    fencesFirstPollSignaled: number;
    /**
     * **FPS 的口径来源**（必须显式写进结果，否则读者无法判断这个数该不该信）：
     *   - `"gpu-timer"`：来自 `EXT_disjoint_timer_query_webgl2` 的 GPU 执行时间（**推荐口径**，
     *     本环境的墙钟口径只能测到提交速率，见 `NonBlockingFrameGate` 顶部实测）；
     *   - `"wall-clock"`：来自帧间隔（在同步真正生效的环境里也是正确口径）。
     */
    fpsSource: "gpu-timer" | "wall-clock";
    /** 各 run 的 GPU 受限帧率的统计量（`fpsSource="gpu-timer"` 时与 `fps` 相同） */
    gpuFps: MeanStd;
    /** 各 run 的 GPU 执行时间中位数（ms） */
    gpuMsMedian?: number;
    /** 全程有效 GPU 计时样本数 / 丢弃数（诊断：样本太少说明查询回读没跟上） */
    gpuSamples: number;
    gpuMisses: number;
    /** GPU 计时器的逐步诊断一行摘要（`ext=` / `create=` / `begin=` / `end=` / `seq=` / `probe=` 各段可单独读） */
    gpuDiag: string;
    /**
     * **读数是否可信**：栅栏进度检查确实生效（`fencesFirstPollSignaled` 明显小于总帧数）
     * 且平均 FPS 在物理可能范围内。false ⇒ 调用方必须判该轮失败，不能把这批数字写进报告。
     */
    plausible: boolean;
    /** `plausible=false` 的原因（正常为空串） */
    implausibleReason: string;
    /** 每多少帧让出一次事件循环（驱动降频；缺省 1） */
    tickEvery: number;
    /** 本轮的让出次数（= 帧数 / tickEvery 上取整） */
    tickCalls: number;
    /** 让出本身的耗时中位数（ms）——手机上是"驱动节奏是否成为瓶颈"的直接证据 */
    tickMsMedian: number;
    /** [LAB] 全部 run 的让出耗时合计（ms）／帧内计算+提交耗时合计（ms）／帧间纯等待合计（ms） */
    tickMsTotal: number;
    frameMsTotal: number;
    gapMsTotal: number;
    /** [LAB] run 末收尾（排空 + 计时查询回读）累计耗时（ms，含预热那次） */
    endRunMsTotal: number;
    /** [自然模式] 逐秒窗口 FPS 统计（`n` = 完整秒数；无自然模式时为 0） */
    natWinN: number;
    natFpsMin: number;
    natFpsMax: number;
    natFpsMean: number;
    natFpsSd: number;
}

/**
 * FPS 的物理上限守卫（`plausible` 判定用）：1.7Mpx、几十万高斯的渲染，
 * 单帧不可能低于 0.2ms（含提交）。实测这条守卫真的抓到过"栅栏没生效 → 读数 58333 FPS"
 * （2026-09-26 现场），所以它不是形式主义：**宁可少一条数据，也不能留下无法解释的数**。
 */
export const OFFSCREEN_MAX_PLAUSIBLE_FPS = 5000;

/**
 * 空驱动校准（**msgchannel 版**）：跑 `rounds` 轮、每轮 `ticks` 个"什么都不做"的 msgchannel tick，
 * 取该轮间隔中位数，再在若干轮里取众数（并列取最小）作为地板。
 *
 * 为什么需要它：即便 msgchannel 不吃 4ms 钳制，事件循环本身仍有每次 tick 的固定开销。
 * 若帧率已经贴到这个地板（`driverCapped`），读数只能当**下界**读，不能当作"GPU 也就这么快"。
 * 判据与在屏协议同一套（`1000/fps ≤ floor × 1.05`），字段名一致（`offscreen_driver_floor_ms`）。
 */
export async function calibrateOffscreenDriverFloor(
    driver: ThroughputDriver = "msgchannel",
    rounds = 3,
    ticks = 32,
): Promise<{ floorMs: number; rounds: number; src: string }> {
    const roundMedians: number[] = [];
    for (let r = 0; r < rounds; r++) {
        const gaps: number[] = [];
        let last = performance.now();
        for (let i = 0; i < ticks; i++) {
            await throughputTick(driver);
            const now = performance.now();
            gaps.push(now - last);
            last = now;
        }
        roundMedians.push(Math.round((median(gaps) ?? 0) * 100) / 100);
    }
    const counts = new Map<number, number>();
    for (const v of roundMedians) counts.set(v, (counts.get(v) || 0) + 1);
    let floorMs = roundMedians[0] ?? 0;
    let best = -1;
    for (const [v, c] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
        if (c > best) {
            best = c;
            floorMs = v;
        }
    }
    return { floorMs, rounds, src: `empty_drive_${driver}` };
}

/**
 * 跑完整个离屏协议：`warmupFrames` 帧预热（不计入）→ `numRuns` 个连续 run，每 run `framesPerRun` 帧。
 *
 * 计时口径（每 run 独立、与共享驱动 `driveThroughputFrames` **同构**，便于两臂逐 run 对照）：
 *   - 每帧先 `await throughputTick("msgchannel")` 让出一个宏任务，再渲染提交；
 *   - 起表点 = **第 1 个计帧绘制完成之后**，终点 = 末帧绘制完成
 *     → `fps = frames / (终点 - 起点)`。取点方式与在屏协议完全相同，因此两套协议的差别只剩
 *       "渲染目标"与"是否逐帧硬同步"这两项，正是论文协议要区分的两项；
 *   - 每 run 结束调用 `hooks.endRun()` 排空栅栏，**发生在终点取点之后**：不影响帧率口径，
 *     但保证各 run 相互独立（下一 run 不会把上一 run 残留的 GPU 工作算进去）。
 */
export async function runOffscreenProtocol(spec: {
    framesPerRun: number;
    numRuns: number;
    warmupFrames: number;
    hooks: OffscreenFrameHooks;
    driver?: ThroughputDriver;
    /** 强制指定 FPS 口径（缺省：有 GPU 计时样本就用 `gpu-timer`，否则 `wall-clock`） */
    fpsSource?: "gpu-timer" | "wall-clock";
    /**
     * `batch` 同步策略：把每个 run 的**计时终点取在排空之后**（默认 false = 取在末帧提交后）。
     * 只有在"逐帧零同步、run 末一次性 `finish()+readPixels`"时才应打开——否则会把 GPU 执行时间
     * 排除在计时之外，量到的只是 CPU 提交速率。
     */
    timingEndAfterDrain?: boolean;
    /**
     * 每多少帧让出一次事件循环（`?tickevery=N`，缺省 1 = 每帧一次）。
     *
     * 2026-09-26 真机实测：手机上 `await throughputTick("msgchannel")` 这个"每帧让出一次宏任务"
     * 本身要 **~43ms**（GPU 队列饱和时，主线程的宏任务被拖到 ~2 个 vsync 之后才被调度），
     * 于是"逐帧 tick"把吞吐卡在 ~23 FPS —— 而同一轮的渲染提交只要 0.2ms、排空等 GPU 只要 22ms/帧。
     * 论文要的是"连续提交帧"，不是"每帧让出一次"，所以让出频率可以降下来：
     * `N=16` 时驱动开销摊到 ~2.7ms/帧，读数才回到 GPU/流水线本身。
     */
    tickEveryFrames?: number;
    /**
     * **按墙钟时间跑**（ms；0/缺省 = 关闭 ⇒ 按 `framesPerRun` 计帧）。
     *
     * 自然模式（`?sync=natural` + `driver=raf`）用它跑满 30 秒：循环在该预算耗尽时 break，
     * 并额外给出**逐秒窗口**的 FPS 统计（`natFpsMin/Max/Mean/Sd`）——这正是"用户实际交互流畅度"的口径，
     * 区别于 batch 模式的"攒帧后一次排空"极限吞吐口径。
     */
    durationMs?: number;
}): Promise<OffscreenProtocolResult> {
    const driver: ThroughputDriver = spec.driver ?? "msgchannel";
    // 让出频率（缺省 1 = 每帧；`?tickevery=N` 可降频，见 spec.tickEveryFrames 的说明）
    const tickEvery = Math.max(1, Math.floor(spec.tickEveryFrames ?? 1));
    let tickCalls = 0;
    const tickDurations: number[] = [];
    // [LAB 2026-09-26] 逐帧时间戳分解（直接测量，不用比值推断）：
    //   tickMs  = 帧内让出（await tick()）耗时合计；
    //   frameMs = 帧内**同JS/WASM计算+GL提交**（beforeFrame→afterFrame）耗时合计；
    //   gapMs   = 上一帧收口结束 → 本帧起点之间的**纯等待**（事件循环调度延迟）合计。
    let tickMsTotal = 0;
    let frameMsTotal = 0;
    let gapMsTotal = 0;
    let endRunMsTotal = 0;
    let lastFrameEnd = 0;
    /** [自然模式] 逐秒窗口的帧数（= 该秒的 FPS），用于"用户体感口径"的最小/最大/均值/标准差 */
    const natWinVals: number[] = [];
    /** run 末收尾（`drainAll()` + GPU 计时查询回读）——它也在计时窗口内（`batch` 取点在排空之后） */
    const endRun = async (): Promise<void> => {
        const t = performance.now();
        await hooks.endRun?.();
        endRunMsTotal += performance.now() - t;
    };
    const tick = async (): Promise<void> => {
        const tTick = performance.now();
        await throughputTick(driver);
        const d = performance.now() - tTick;
        tickDurations.push(d);
        tickMsTotal += d;
        tickCalls++;
    };
    const framesPerRun = Math.max(1, Math.floor(spec.framesPerRun));
    const numRuns = Math.max(1, Math.floor(spec.numRuns));
    const warmupFrames = Math.max(0, Math.floor(spec.warmupFrames));
    const hooks = spec.hooks;
    const runs: OffscreenRunSample[] = [];
    const tAll0 = performance.now();
    const floor = await calibrateOffscreenDriverFloor(driver);

    let aborted = false;
    let note = "";
    /** 最近一次 afterFrame() 的累计回报（每 run 结束时取一次快照） */
    let gate: OffscreenGateSample | undefined;
    /** GPU 计时样本的累计读取游标（每次取本轮新增的那一段） */
    let gpuCursor = 0;

    // ---- 预热：照常渲染 + 照常做收口，只是**不计时** ----
    const tWarmup0 = performance.now();
    for (let i = 0; i < warmupFrames; i++) {
        if (hooks.stopped?.()) {
            aborted = true;
            note = "预热期间被取消";
            break;
        }
        if (i % tickEvery === 0) await tick();
        hooks.beforeFrame?.(-1, i);
        hooks.renderFrame(-1, i);
        gate = hooks.afterFrame?.() ?? gate;
    }
    // 预热结束也排空一次：run 0 的起表点不能带着预热残留的 GPU 工作
    if (!aborted) await endRun();
    const warmupMs = performance.now() - tWarmup0;

    // ---- 多轮连续 run（论文的 "multiple consecutive runs"） ----
    for (let run = 0; run < numRuns && !aborted; run++) {
        const frameDurations: number[] = [];
        let t0 = 0;
        let rendered = 0;
        // [2026-09-28 cfgscan2 ③⑦] 跨 run 边界**不计"帧间等待"**：上一个 run 的收尾排空已经计入
        // 它自己的 `elapsedMs`（汇总为 `ER`），若在这里再算一次 gap，`G` 会被 5×~1300 ms 的排空污染
        // （实测 20帧×5run 下 G=5211 ms 而帧间等待真值只有 ~15 ms）⇒ 分项求和就对不上 elapsed 了。
        // 所以每个 run 的第一帧从"无上一帧"开始（与 run 0 的首帧语义一致）。
        lastFrameEnd = 0;
        const runStart = performance.now();
        const frameStamps: number[] = [];
        const maxFrames = spec.durationMs ? Number.MAX_SAFE_INTEGER : framesPerRun;
        for (let i = 0; i < maxFrames; i++) {
            if (spec.durationMs && performance.now() - runStart >= spec.durationMs) break;
            if (hooks.stopped?.()) {
                aborted = true;
                note = `run ${run + 1} 期间被取消`;
                break;
            }
            if (i % tickEvery === 0) await tick();
            const tFrame0 = performance.now();
            if (lastFrameEnd > 0) gapMsTotal += tFrame0 - lastFrameEnd; // 上一帧收口 → 本帧起点：纯等待
            hooks.beforeFrame?.(run, i);
            hooks.renderFrame(run, i);
            gate = hooks.afterFrame?.() ?? gate;
            const tFrameEnd = performance.now();
            frameMsTotal += tFrameEnd - tFrame0; // JS/WASM 计算 + GL 提交
            lastFrameEnd = tFrameEnd;
            frameDurations.push(tFrameEnd - tFrame0);
            frameStamps.push(tFrameEnd);
            rendered++;
            if (rendered === 1) t0 = performance.now();
        }
        let t1 = performance.now();
        // `batch` 模式：计时终点取在**排空之后**（排空 = `finish()` + 1×1 `readPixels`，会真正等 GPU 画完）。
        // 其它模式仍是"末帧提交即取点"，排空放在取点之后（不污染口径）。
        if (spec.timingEndAfterDrain) {
            await endRun();
            t1 = performance.now();
        }
        const elapsedMs = t0 > 0 ? t1 - t0 : 0;
        // 本轮新增的 GPU 计时样本（`endRun` 之前先取，避免把下一轮的算进来）
        const allGpu = hooks.gpuMsSamples ? hooks.gpuMsSamples() : [];
        const gpuRun = allGpu.slice(gpuCursor);
        gpuCursor = allGpu.length;
        const gpuMed = gpuRun.length > 0 ? median(gpuRun) : undefined;
        runs.push({
            run,
            frames: rendered,
            elapsedMs,
            fps: elapsedMs > 0 ? rendered / (elapsedMs / 1000) : 0,
            frameMsMedian: median(frameDurations) ?? 0,
            frameMsMean:
                frameDurations.length > 0 ? frameDurations.reduce((a, b) => a + b, 0) / frameDurations.length : 0,
            fenceWaitMs: gate ? gate.fenceWaitMs : 0,
            fencesMax: gate ? gate.fencesMax : 0,
            fencesLimit: gate ? gate.fencesLimit : 0,
            forcedDrains: gate ? gate.forcedDrains : 0,
            gpuMsMedian: gpuMed,
            gpuSamples: gpuRun.length,
            gpuFps: gpuMed !== undefined && gpuMed > 0 ? 1000 / gpuMed : undefined,
        });
        // [自然模式] 逐秒窗口 FPS（丢掉不满整秒的末段）：用户体感口径的最小/最大/均值/标准差
        if (spec.durationMs && frameStamps.length > 2) {
            const first = frameStamps[0];
            const last = frameStamps[frameStamps.length - 1];
            const fullSecs = Math.floor((last - first) / 1000);
            for (let s = 0; s < fullSecs; s++) {
                let n = 0;
                for (const ts of frameStamps) {
                    const dt = ts - first;
                    if (dt >= s * 1000 && dt < (s + 1) * 1000) n++;
                }
                natWinVals.push(n);
            }
        }
        // 收尾排空放在终点取点之后：让本轮 GPU 工作全部落地（并等 GPU 计时查询回读），各 run 相互独立
        // （`batch` 模式下排空已在上面、且计时终点在其之后，这里不再重复）
        if (!spec.timingEndAfterDrain) await endRun();
        if (aborted) break;
    }

    const fps = meanStd(runs.map((r) => r.fps));
    const gpuFpsValues = runs.map((r) => r.gpuFps).filter((v): v is number => typeof v === "number");
    const gpuFps = meanStd(gpuFpsValues);
    const gpuMsValues = runs.map((r) => r.gpuMsMedian).filter((v): v is number => typeof v === "number");
    const totalFrames = runs.reduce((a, r) => a + r.frames, 0);
    // ---- FPS 口径：有 GPU 计时样本 ⇒ 用 GPU 口径（本环境唯一可信的口径）----
    const forced = spec.fpsSource;
    const useGpu = forced ? forced === "gpu-timer" : gpuFps.n > 0;
    const fpsOut = useGpu && gpuFps.n > 0 ? gpuFps : fps;
    // ---- 可信性守卫 ----
    const firstPoll = gate ? gate.firstPollSignaled : 0;
    let implausible = "";
    if (useGpu && gpuFps.n === 0) {
        implausible = "指定了 GPU 计时口径，但一轮有效样本都没取到（计时查询不可用或回读没跟上）";
    } else if (!useGpu && fpsOut.mean > OFFSCREEN_MAX_PLAUSIBLE_FPS) {
        implausible =
            `平均 FPS=${fpsOut.mean.toFixed(0)} 超过物理上限 ${OFFSCREEN_MAX_PLAUSIBLE_FPS}` +
            `（墙钟口径在本环境只能测到提交速率；请改用 GPU 计时口径 sync=gputimer）`;
    } else if (!useGpu && totalFrames > 0 && offscreenFramesWithNoFence(totalFrames, firstPoll)) {
        const warn =
            `栅栏进度检查疑似未生效（${totalFrames} 帧中 ${firstPoll} 帧的新栅栏首次轮询即 signaled、` +
            `在途峰值 ${gate ? gate.fencesMax : 0}）：轻量场景可能正常，重负载场景请核对 fps 量级`;
        note = note ? `${note}；${warn}` : warn;
    }
    if (implausible) note = note ? `${note}；${implausible}` : implausible;

    return {
        completed: !aborted && runs.length === numRuns,
        aborted,
        note,
        driver,
        framesPerRun,
        numRuns,
        warmupFrames,
        warmupMs,
        runs,
        // `fps` = 主指标（口径由 `fpsSource` 决定）；墙钟值始终保留在 `runs[].fps` 里可回溯
        fps: fpsOut,
        fpsSource: useGpu ? "gpu-timer" : "wall-clock",
        gpuFps,
        gpuMsMedian: median(gpuMsValues),
        gpuSamples: runs.reduce((a, r) => a + r.gpuSamples, 0),
        gpuMisses: hooks.gpuMisses ? hooks.gpuMisses() : 0,
        gpuDiag: hooks.gpuDiag ? hooks.gpuDiag() : "",
        frameMsMedian: median(runs.map((r) => r.frameMsMedian)) ?? 0,
        elapsedMs: performance.now() - tAll0,
        requestedFrames: framesPerRun * numRuns,
        renderedFrames: totalFrames,
        driverFloorMs: floor.floorMs,
        // 判据与在屏协议的 `fps_capped` 同构：1/fps ≤ 地板 × 1.05
        driverCapped: fpsOut.mean > 0 && floor.floorMs > 0 && 1000 / fpsOut.mean <= floor.floorMs * 1.05,
        fencesMax: gate ? gate.fencesMax : 0,
        fencesLimit: gate ? gate.fencesLimit : 0,
        fenceWaitMs: gate ? gate.fenceWaitMs : 0,
        fencesFirstPollSignaled: firstPoll,
        plausible: implausible === "",
        implausibleReason: implausible,
        tickEvery,
        tickCalls,
        tickMsMedian: median(tickDurations) ?? 0,
        tickMsTotal,
        frameMsTotal,
        gapMsTotal,
        endRunMsTotal,
        // [自然模式] 逐秒窗口 FPS 统计（无窗口时全 0）
        natWinN: natWinVals.length,
        natFpsMin: natWinVals.length ? Math.min(...natWinVals) : 0,
        natFpsMax: natWinVals.length ? Math.max(...natWinVals) : 0,
        natFpsMean: natWinVals.length ? natWinVals.reduce((a, b) => a + b, 0) / natWinVals.length : 0,
        natFpsSd: (() => {
            if (!natWinVals.length) return 0;
            const m = natWinVals.reduce((a, b) => a + b, 0) / natWinVals.length;
            return Math.sqrt(natWinVals.reduce((a, b) => a + (b - m) ** 2, 0) / natWinVals.length);
        })(),
    };
}

/**
 * 辅助判定：栅栏"在途峰值恒为 0"且首轮即 signaled 次数已占多数时，视为命令没有真正投给 GPU。
 * 单独抽出来是为了让判据可读、可测（也便于将来放宽/收紧而不动主循环）。
 */
export function offscreenFramesWithNoFence(totalFrames: number, firstPollSignaled: number): boolean {
    return totalFrames >= 100 && firstPollSignaled >= Math.floor(totalFrames * 0.9);
}
