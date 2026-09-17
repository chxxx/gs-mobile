/**
 * bench-shared.ts — bench.html（父页面：队列/UI/结果）与 bench-case.html（子页面：单场景 × 单轮测量）
 * 共用的纯逻辑与父子通信协议。
 *
 * 设计约束（重要，改动前请先读）：
 *   1. 本文件**不导入 src/ 下的任何渲染代码**。父页面在 mode=bench 下绝不创建 WebGL 上下文，
 *      它的模块图里也不能出现 renderer / loader / wasm —— 否则会把渲染器与 wasm 一起拉进父页面。
 *   2. 只放"两页都要用、且与 GL 无关"的东西：URL 参数、场景清单、profile 分组、结果类型、
 *      状态存储键、父子消息协议、口径常量。
 *   3. 计时口径相关的取值（proto/cam/warmup/frames/res、统一像素协议、测帧驱动与计时地板）
 *      全部放在这里，父子两页读同一份实现，避免"父页显示的口径"和"子页实际跑的口径"分叉。
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

/**
 * 结果自动回传（外部测试者用，2026-09-17 追加）：URL 带 `report=<url>` 时，跑完把结果文本 POST 过去。
 *
 * 两臂（bench.ts / bench-flux.ts）共用本函数，保证"回传口径"逐字一致：
 * - 请求体就是 `buildResultText()` 的原文（`text/plain`，简单请求，跨源也不触发预检）；
 * - `keepalive: true`：测试者看到"正在提交"就把页面关掉也能送达；
 * - `token`（页面 URL 的 `rtok=` 参数）：转发成请求 URL 的 `token=`，由接收端校验；不写死在代码里，
 *   换口令只需换分发链接。空字符串时不附加该参数（本地/无闸门调试用）。
 * - 返回是否成功：调用方据此决定显示"结果已自动提交，可以关闭此页面"还是"请手动复制发送"（保留退路）。
 * 接收端是本仓库 vite dev server 的 `/__ch7/report` 中间件（见 vite.config.js）；外网测试者经
 * cloudflared 临时隧道进来时与页面同源，所以 URL 用相对路径 `/__ch7/report?name=xxx` 最省事。
 */
export async function submitReport(reportUrl: string, text: string, token = ""): Promise<boolean> {
    try {
        const url =
            token === ""
                ? reportUrl
                : reportUrl + (reportUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: text,
            keepalive: true,
        });
        return res.ok;
    } catch {
        return false;
    }
}

// ------------------------------------------------------------------ 测帧口径开关（与 Flux-GS 臂对齐）
/** 参考协议（Flux-GS 原协议）：`?proto=flux` → 焦距取它的 COLMAP 焦距、计帧前不预热。 */
export const PROTO_FLUX = param("proto", "") === "flux";
/**
 * 三方同视角（**默认开启**）：不写 `cam` 参数就用 Flux-GS 原代码里的相机
 * （`bench-flux-camera.json` 的 default_view，见 bench-measure 的 applyFluxCamera），
 * 于是本文臂 / reduced-3DGS 臂与 Flux-GS 臂（其 `pose_src=flux`）看到同一机位；
 * `?cam=auto` 显式退回「包围盒自动取景」（各场景机位互不相同，只用于观察/历史对照）。
 *
 * 2026-09-17 改：默认值原本是 `auto` —— 冒烟链接漏带 `cam=flux` 时两臂视角不同
 * （实测 db 场景 `covered` 78.4% vs 100%，playroom 甚至报「相机看不到模型」），
 * 因此把「对齐」设为默认：不对齐必须显式请求 `cam=auto`，报告头 `cam=` 与逐轮 `pose_src=`
 * 都按同一个判定打印，避免再出现「参数漏带却无人察觉」。
 */
export const CAM_FLUX = param("cam", "flux") !== "auto";
/** 计帧前预热帧数：参考协议（Flux-GS 原协议）为 0，旧 1600×1063 口径为 10；`?warmup=N` 可显式覆盖。 */
export function warmupFrames(): number {
    const n = parseInt(param("warmup", PROTO_FLUX ? "0" : "10"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}
/** 测帧驱动方式：timer = `setTimeout(0)` 链（**参考协议**：与 Flux-GS 自带测帧逐帧同构）；
 *  raf = 每个 requestAnimationFrame 渲染并统计一帧（在屏口径，会被屏幕刷新率封顶）。 */
export type ThroughputDriver = "raf" | "timer";
/**
 * 帧驱动口径（**两臂 FPS 可比性的前提**，2026-09-16 对齐基线）：
 *   1. `?driver=timer|raf` 显式覆盖优先；
 *   2. 否则 `proto=flux`（参考协议）取 `timer`；
 *   3. 其余情况取 `raf`（旧的默认值，只用于在屏口径的观察/历史数据对照）。
 * 注意：rAF 每次只申请一个 vsync 间隔，**会被屏幕刷新率封顶**（60Hz 设备最多报 60），
 * 与基线不可比；正式采集保持 timer。两种取值都会写进结果头 `driver=`，可事后核对。
 *
 * 实现说明（2026-09-16）：`timer` 驱动现在由**两臂共用的** `driveThroughputFrames()` 实现
 * （本文臂与 Flux-GS 臂调用同一个函数：后者逐帧调 iframe 的 `__FLUXGS_BENCH_FRAME__`）。
 * 它与基线原 `window.runFluxBenchmark` 内部的 `setTimeout(0)` 链同构——该入口已从 vendored
 * `render_shared/main.js` 中移除（那本是上游自带的官方测帧入口，两臂各跑一份会分叉）。
 */
export function throughputDriver(): ThroughputDriver {
    const explicit = param("driver", "");
    if (explicit === "raf" || explicit === "timer") return explicit;
    return PROTO_FLUX ? "timer" : "raf";
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

// ------------------------------------------------------------------ 共享测帧驱动（两臂**同一个函数**）
/**
 * 帧驱动 + 计时的**唯一实现**：本文臂（本仓库渲染器）与 Flux-GS 臂（iframe 内渲染器暴露的
 * `__FLUXGS_BENCH_FRAME__`）都调用它，口径不可能分叉（旧版两臂各写一份，容易漂移）。
 *
 * 口径（与其原 `runFluxBenchmark` 内部逐字相同）：
 *   1. `timer` 驱动：每帧一条 `setTimeout(0)`，**一个 tick 渲染并只计一帧**；
 *   2. 起表点 = **第 1 个计帧渲染完成之后**，终点 = 末帧渲染完成
 *      → `fps = frames / (终点 - 起点)`（frames 个帧点之间 frames-1 个间隔的墙钟均值）；
 *   3. `renderFrame(i)` 必须完成"渲染提交 + `gl.finish()`"并返回该次 GPU 同步耗时（ms）：
 *      两臂都在每帧后同步一次，帧间隔由此**包含真实 GPU 执行时间**（否则小场景的 GPU 异步
 *      会让测出的帧率虚高，且两臂不同步时不公平）；
 *   4. `syncMs` = 逐帧 `gl.finish()` 耗时的中位数（诊断：用来核对帧率差异是否由 GPU 负载解释）。
 */
export interface DriveThroughputSpec {
    /** 计帧数（不含 warmup）。 */
    frames: number;
    /** 计帧前的预热帧数（同样逐帧渲染 + gl.finish()，但不进计时区间）。 */
    warmup?: number;
    /** 覆盖驱动方式（缺省取 `throughputDriver()`）。 */
    driver?: ThroughputDriver;
    /** 渲染一帧 + `gl.finish()`，返回 gl.finish() 的耗时 ms（warmup 帧传 -1）。 */
    renderFrame: (index: number) => number;
    /** 返回 true 时中断（本轮被 dispose/取消）。 */
    stopped?: () => boolean;
}
export interface DriveThroughputStats {
    driver: ThroughputDriver;
    frames: number;
    rendered: number;
    elapsedMs: number;
    fps: number;
    /** 均帧间隔（**含 GPU 同步**）：elapsedMs / (rendered - 1)，首帧只作起表点不进分母。 */
    cpuMs: number;
    gapMinMs: number;
    gapMedMs: number;
    gapMaxMs: number;
    /** 逐帧 `gl.finish()` 耗时的中位数（诊断） */
    syncMs: number;
    /** 计入 syncMs 的样本数（= rendered） */
    syncFrames: number;
    /**
     * **帧内阻塞耗时中位数（诊断/自检用，不可用于算两臂倍数）**：`renderFrame()` 调用前后到
     * `gl.finish()` 返回的帧内墙钟（渲染提交 + GPU 同步），**不经过 `nextTick()`**，
     * 因此只量到"帧内实际被阻塞"的那一段，帧内让出/等待的时间不在这个窗口里。
     *
     * 为什么需要它（以及语义边界，2026-09-17 依据 8 组实测修订）：`timer` 驱动的每帧要过一条
     * `setTimeout(0)`，而浏览器对连续嵌套的定时器有 4ms 级钳制（本仓库在两台设备上实测地板
     * 4.3–5.4ms）。测帧窗口因此有两种 regime：
     *   - **未贴地板**：`cpuMs ≈ 地板 + frameMs`（8/8 组成立，最大偏差 7.5%）——即 `frameMs`
     *     比"每帧真实耗时"**低约一个地板值**；
     *   - **贴地板（`fps_capped=1`）**：帧率读数完全由驱动节奏决定，而两臂的 `frameMs` 都只落在
     *     `performance.now()` 的 100µs 量化下限附近（桌面实测 0.09–0.20ms、手机 0.50–0.80ms），
     *     此时相除**没有意义**（旧注释把它称作"地板无关的单帧渲染能力可比量"，已作废）。
     * 结论：跨臂倍数**只能由帧间隔之比给出**（`1000/fps` 之比；被地板封顶的臂只给下界）。
     * 反例（本仓库实测）：桌面上同一场景把像素从 0.42Mpx 加到 3.83Mpx（×9），`1000/fps` 仍是
     * 4.9–5.2ms（与像素无关），只有帧间隔之比能反映负载差异。
     *
     * 两臂对称：本文臂 = `frameRender()` + `gl.finish()`；基线臂 = iframe 里的
     * `__FLUXGS_BENCH_FRAME__()`（本身即"渲染一帧 + `gl.finish()`"）+ **一次跨 realm 的直接调用**。
     * 那层调用是测量框架常量（量级远小于 1ms，方向对基线略不利，不是渲染器差异）：
     * 本文臂在父页面内直接渲染、没有这一层，所以两臂的 `frameMs` 只差这一个常量。
     *
     * **读法（量化下限）**：Chrome 的 `performance.now()` 在非隔离上下文里量化到 100µs，所以
     * 桌面实测读出 `frame_ms=0.10` 时，正确含义是"**≤ 0.15ms 量级**"，不是"恰好 0.10ms"；
     * 它只适合用来核对 `cpu_ms ≈ 地板 + frame_ms`、暴露量级与长尾抖动，不适合在小数值上做加减。
     */
    frameMs: number;
    /** 帧内耗时**均值**（与中位数一起给：长尾轮次下中位数会低估，均值能暴露抖动） */
    frameMeanMs: number;
    warmupMs: number;
    /** 实测的计时地板（见 calibrateTimerFloor） */
    timerFloorMs: number;
    timerFloorRounds: number;
    timerFloorSrc: string;
    /** true = 测到的帧率已被驱动节奏（地板）卡住，不能当作渲染极限 */
    fpsCapped: boolean;
    aborted: boolean;
    note: string;
}

export async function driveThroughputFrames(spec: DriveThroughputSpec): Promise<DriveThroughputStats> {
    const driver: ThroughputDriver = spec.driver ?? throughputDriver();
    const floor = await timerFloor();
    const warmup = Math.max(0, spec.warmup ?? 0);
    const zero: DriveThroughputStats = {
        driver,
        frames: spec.frames,
        rendered: 0,
        elapsedMs: 0,
        fps: 0,
        cpuMs: 0,
        gapMinMs: 0,
        gapMedMs: 0,
        gapMaxMs: 0,
        syncMs: 0,
        syncFrames: 0,
        frameMs: 0,
        frameMeanMs: 0,
        warmupMs: 0,
        timerFloorMs: floor.floorMs,
        timerFloorRounds: floor.rounds,
        timerFloorSrc: floor.src,
        fpsCapped: false,
        aborted: true,
        note: "",
    };
    const nextTick = (): Promise<void> =>
        new Promise<void>((resolve) => {
            if (driver === "raf") requestAnimationFrame(() => resolve());
            else setTimeout(resolve, 0);
        });

    const tWarmup0 = performance.now();
    for (let i = 0; i < warmup; i++) {
        if (spec.stopped?.()) return { ...zero, note: "warmup 期间被取消" };
        spec.renderFrame(-1);
        await nextTick();
    }
    const warmupMs = performance.now() - tWarmup0;

    const gaps: number[] = [];
    const syncs: number[] = [];
    /** 帧内耗时样本（`renderFrame` 调用前 → 返回后）：不含 `nextTick()` 让出，见 DriveThroughputStats.frameMs */
    const frameDurations: number[] = [];
    let last = performance.now();
    let rendered = 0;
    // 起表点 = 第 1 个计帧渲染完成之后（与其原 runFluxBenchmark 里 benchmarkStartTime 的取点同构）
    let t0 = 0;
    let aborted = false;
    while (rendered < spec.frames) {
        if (spec.stopped?.()) {
            aborted = true;
            break;
        }
        await nextTick();
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        const tFrame0 = performance.now();
        syncs.push(spec.renderFrame(rendered)); // 渲染 + gl.finish()：这一帧的 GPU 执行也在此刻完成
        frameDurations.push(performance.now() - tFrame0);
        rendered++;
        if (rendered === 1) t0 = performance.now();
    }
    const t1 = performance.now();
    const elapsedMs = t0 > 0 ? t1 - t0 : 0;
    const fps = elapsedMs > 0 ? spec.frames / (elapsedMs / 1000) : 0;
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const floorMs = floor.floorMs;
    return {
        driver,
        frames: spec.frames,
        rendered,
        elapsedMs,
        fps,
        cpuMs: rendered > 1 ? elapsedMs / (rendered - 1) : 0,
        gapMinMs: sortedGaps[0] ?? 0,
        gapMedMs: median(sortedGaps) ?? 0,
        gapMaxMs: sortedGaps[sortedGaps.length - 1] ?? 0,
        syncMs: median(syncs) ?? 0,
        syncFrames: syncs.length,
        frameMs: median(frameDurations) ?? 0,
        frameMeanMs: frameDurations.length > 0 ? frameDurations.reduce((a, b) => a + b, 0) / frameDurations.length : 0,
        warmupMs,
        timerFloorMs: floorMs,
        timerFloorRounds: floor.rounds,
        timerFloorSrc: floor.src,
        // 帧间隔已贴到地板（允许 5% 余量）→ 这个帧率是驱动节奏的上限，不是渲染极限
        fpsCapped: fps > 0 && floorMs > 0 && 1000 / fps <= floorMs * 1.05,
        aborted,
        note: aborted ? "测帧过程中被取消" : "",
    };
}

/**
 * **统一像素协议 = 主表口径**：三臂（本文方法 / reduced-3DGS 基线 / Flux-GS 基线）全部把离屏画布
 * 钉死在同一组像素上，这是跨方法 FPS/吞吐比较**唯一**允许的数据来源。
 *   - 本文臂与 reduced-3DGS 臂：`?res=WxH`（bench-case 里 `setBenchmarkResolution()` 强制后备缓冲 = res）；
 *   - Flux-GS 臂：`?benchres=WxH`（`bench-flux.ts` 默认就带，即 `force` 的缺省值**就是 `res`**）。
 *
 * **原生协议（`?force=native`）= 仅作补充**：不干预 Flux-GS 的自适应画布策略
 * （点数 > 500000 → 1× CSS；否则 CSS × devicePixelRatio）。该模式下各臂分辨率**不对等**，
 * 因此**不可跨方法比 FPS**，只用于说明"它在真机上跑起来占多少像素"。
 *
 * 两种模式都写进结果头 `res_mode=forced|native`：报表脚本只取 `res_mode=forced` 的行进主表，
 * 从机制上避免两种协议的数据被混进同一张对比表。
 */
export type ResMode = "forced" | "native";
/** 当前链接的口径：`force=native` 才是原生协议，其余（含缺省）一律统一像素协议。 */
export function resolutionMode(): ResMode {
    return param("force", "").trim().toLowerCase() === "native" ? "native" : "forced";
}
/** Flux-GS 臂要附加的 `benchres=WxH`：`force=native` 时返回 null（不干预其自适应策略），
 *  否则 = `force=WxH`（显式）或 `res`（缺省 1600×1063）。 */
export function benchResOverride(): { w: number; h: number } | null {
    if (resolutionMode() === "native") return null;
    const m = /^(\d+)x(\d+)$/.exec(param("force", "").trim());
    if (m) return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
    return resolution();
}

/**
 * 计时地板 `timer_floor_ms`：**实测得出，不写死任何猜测值**。
 *
 * 为什么需要它：定时器驱动下一个 tick 的最短间隔由浏览器对嵌套 `setTimeout(0)` 的钳制决定
 * （Chrome 在连续嵌套 >5 层后按 4ms 处理；不同手机浏览器此值不同），这个下限会直接表现为
 * "小场景也跑不过某个帧率"。若把它当成渲染极限写进结论，就会得出"两条臂一样快"的假象。
 *
 * 做法（"空驱动校准"）：跑 `rounds` 轮，每轮连续 `ticks` 次 `setTimeout(0)` 且**不做任何渲染**，
 * 取该轮间隔的中位数；再在 `rounds` 个中位数里取**众数**（并列取最小）作为地板。
 * 结果写进结果头 `timer_floor_ms=` / `timer_floor_rounds=` / `timer_floor_src=empty_drive`（表头写的是
 * 各轮**中位数**）；逐轮行另外输出判定时**实际引用**的本轮地板 `floor_used_ms=`（两臂同名字段）。
 * 判据 `fps_capped=1` ⇔ `1000/fps ≤ floor_used_ms × 1.05` —— 用逐轮行里的 fps 与 floor_used_ms
 * 就能直接手算复核，不必再拿表头中位数去猜。
 */
export interface TimerFloor {
    floorMs: number;
    rounds: number;
    roundMedians: number[];
    src: string;
}
export async function calibrateTimerFloor(rounds = 5, ticks = 40): Promise<TimerFloor> {
    const roundMedians: number[] = [];
    for (let r = 0; r < rounds; r++) {
        const gaps: number[] = [];
        let last = performance.now();
        for (let i = 0; i < ticks; i++) {
            await sleep(0);
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
    return { floorMs, rounds, roundMedians, src: "empty_drive" };
}
/** 每个文档只校准一次（地板是该文档/该浏览器的属性，不随场景变化）。 */
let timerFloorPromise: Promise<TimerFloor> | null = null;
export function timerFloor(): Promise<TimerFloor> {
    if (!timerFloorPromise) timerFloorPromise = calibrateTimerFloor();
    return timerFloorPromise;
}

/** 测帧口径字段（结果头与逐轮行**两臂逐字同格式**，报表脚本可直接按字段名对齐/过滤）。 */
export interface ThroughputFieldValues {
    driver: string;
    resMode: ResMode;
    timerFloorMs?: number;
    timerFloorRounds?: number;
    timerFloorSrc?: string;
    syncMs?: number;
    syncFrames?: number;
    /** 帧内阻塞耗时中位数/均值（诊断/自检用；不可用于算倍数，语义边界见 DriveThroughputStats.frameMs） */
    frameMs?: number;
    frameMeanMs?: number;
    fpsCapped?: boolean;
    /** 渲染管线配置档（`fade=`）：本文臂 bench 模式恒为 `none`（不挂 FadeInPass），Flux 臂写 `n/a`。 */
    fade?: string;
}
/**
 * bench 模式的渲染管线配置标签（结果头 `fade=`）。
 *
 * 本文臂在 **bench 模式**下不挂 `FadeInPass`（调用点：`bench-case.ts:createCaseWithRenderer` 传 `false`），
 * 原因是跨臂公平：基线 Flux-GS 没有任何"前 N 帧只画一部分"的效果，而本文渲染器在**不传 pass** 时会
 * 自动挂 FadeInPass（`WebGLRenderer` 构造函数），使测帧窗口的前 ~100 帧填充负载与常帧**不同构**。
 * 这个差异在桌面（贴计时地板、非填充受限）测不出来，但不能因此假设它在别的设备上也不存在；
 * 改成两臂架构对等后，"设备恰好贴着地板"不再是公平性的前提条件。
 *
 * 正常演示路径（`demo.ts` / `bench.html?mode=view` / `examples/*`）不受影响，仍保留淡入观感。
 */
export const BENCH_FADE_LABEL = "none";
export function throughputFields(v: ThroughputFieldValues): string[] {
    return [
        `driver=${v.driver}`,
        `fps_def=first_frame_end_to_last_frame_end`,
        // 2026-09-17 追加：把两个"看起来互相矛盾、其实是口径不同"的字段的**起止点**写进结果头。
        //   fetch_ms       = Resource Timing entry 的 `duration`，请求发出 → 响应体接收完，是一段**时长**；
        //   first_frame_ms = `responseEnd`（下载完成）→ 首个**真实绘制**帧，也是一段**时长**，起点在下载结束处。
        // 两者量的是不同区段，**不存在"谁必须大于谁"**：`fetch_ms > first_frame_ms` 的含义只是
        // "下载花了 10.6s，而从下载结束到画出第一帧只花了 3.7s"，不是时序错位、更不是边下载边渲染
        // （测帧启动前必须等完整数据 + 排序回传，见 bench-measure.ts 的门禁 0/1/2）。
        // 要核对**绝对**时刻请用 diag=1 的 `timeline=` 打点（同一条 performance.now 时间轴）。
        `fetch_def=request_start_to_response_end_duration`,
        `first_frame_def=response_end_to_first_real_frame`,
        // 两臂的 first_frame_ms **都**包含"首次深度排序回传 + 首次上传 + 首次真实绘制"（已逐行核对两边代码）：
        //   - 本文臂：子页面 waitForSortedFrame 门禁（必须 cullStats.total>0 且 keptRatio>0 才算首帧，见 bench-measure 门禁 1）；
        //   - 基线：`firstFrameAt` 只在 `vertexCount > 0` 时落点，而 `vertexCount` 只在 worker 的 depthIndex 消息里被赋值
        //     （render_shared/main.js:2340/2357/1879）—— 深度索引没回来时首帧落点根本不会出现。
        // 所以"首次排序"这一项在两臂口径里是对称的，不会出现"一边算了、一边没算"。
        `first_sort_def=included_in_first_frame_gated_by_sort_return`,
        `res_mode=${v.resMode}`,
        `timer_floor_ms=${v.timerFloorMs === undefined ? "-" : fmt(v.timerFloorMs, 2)}`,
        `timer_floor_rounds=${v.timerFloorRounds ?? "-"}`,
        `timer_floor_src=${v.timerFloorSrc ?? "-"}`,
        `sync_ms=${v.syncMs === undefined ? "-" : fmt(v.syncMs, 2)}`,
        `sync_frames=${v.syncFrames ?? "-"}`,
        // 帧内阻塞耗时（2026-09-17 追加）：`timer` 驱动下帧间隔会被嵌套 setTimeout 的 4ms 级钳制
        // "焊死"（`fps_capped=1` 时帧率差根本测不出来），这一项量的是"渲染提交 → gl.finish() 返回"
        // 之间**实际被阻塞**的时长，**不含帧内让出**——因此它比每帧真实耗时低约一个地板：
        // 关系近似 `cpu_ms ≈ 地板 + frame_ms`（对照 floor_used_ms 可核对地板是否真在起作用）。
        // ⚠️ 贴地板的臂两侧读数都在 performance.now() 量化下限上，**不得用这一项算两臂倍数**；
        // 倍数只能取帧间隔之比（`1000/fps`，贴地板的臂只给下界）。
        `frame_def=in_frame_render_submit_plus_gl_finish_excludes_driver_yield`,
        `frame_ms=${v.frameMs === undefined ? "-" : fmt(v.frameMs, 2)}`,
        `frame_mean_ms=${v.frameMeanMs === undefined ? "-" : fmt(v.frameMeanMs, 2)}`,
        `fps_capped=${v.fpsCapped ? 1 : 0}`,
        // cpu_ms 语义已明确为"含 GPU 同步的均帧间隔"，用固定字段名写清，避免两臂解释不一致
        `cpu_def=mean_frame_interval_incl_gpu_sync`,
        // 渲染管线配置档（2026-09-17 追加）：本文臂 bench 模式 `none` = **不挂 FadeInPass**（两臂架构对等），
        // Flux 臂 `n/a` = 它本来就没有这种"前 N 帧只画一部分"的档位。
        // 报表/复核时用它区分"淡入开着的历史数据"（旧文件无该字段）与"两臂对等的当前协议"。
        `fade=${v.fade ?? "n/a"}`,
    ];
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
    // 2026-09-17 追加：允许**直接点名场景**（`profile=garden`，或 `profile=garden,truck`）。
    // 用途：手机端要找"让两臂都不贴计时地板"的重负载档时，逐场景试探（1 场景 ≈ 20s）比整包
    // 9 场景（≈2.5min）快一个数量级；两臂共用本函数，所以点名写法在两臂上含义完全一致。
    // 结果头 `profile=` 打印的本来就是**展开后**的场景 id 列表，两种写法在报告里长得一样。
    const named = profile
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const resolved = named.filter((id) => {
        const meta = sceneById(list, id);
        return !!meta && !meta.baseline;
    });
    if (named.length > 0 && resolved.length === named.length) return resolved;
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
    /** 本轮机位指纹：视图矩阵（列主序）前 6 位，与 Flux-GS 臂报告里的 `pose=` 同名同格式，
     *  供 tools/ch7_baseline_report.py 跨臂核对"两臂是否同一个机位"（数值容差比对）。 */
    poseKey?: string;
    /** 本轮机位来源：`flux` = Flux-GS 原相机（bench-flux-camera.json 的 default_view）；
     *  `auto` = 包围盒自动取景（`?cam=auto`，或 cam=flux 但相机资产缺失时回退）。 */
    poseSrc?: string;
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
    /** 测帧驱动方式（诊断）：`timer` = 共享驱动 driveThroughputFrames 的 setTimeout(0) 链（协议值）；
     *  `raf` = 每帧一个 requestAnimationFrame（在屏口径，会被刷新率封顶）。 */
    driver?: string;
    /** 逐帧 `gl.finish()` 耗时的中位数（诊断：帧率差异是否由 GPU 负载解释） */
    syncMs?: number;
    /** 计入 syncMs 的样本数（= 本轮实际帧数） */
    syncFrames?: number;
    /** 帧内阻塞耗时中位数（诊断/自检用；不可用于算倍数，语义边界见 DriveThroughputStats.frameMs） */
    frameMs?: number;
    /** 帧内耗时均值（与中位数一起看，暴露长尾抖动） */
    frameMeanMs?: number;
    /** 实测计时地板（空驱动校准；与结果头同名同源） */
    timerFloorMs?: number;
    timerFloorRounds?: number;
    timerFloorSrc?: string;
    /** true = 本轮帧率已被驱动地板卡住（`1/fps ≤ timer_floor_ms × 1.05`），不能当渲染极限读 */
    fpsCapped?: boolean;
    /** 本轮的像素口径（`forced` = 统一像素协议；本文臂恒为 forced） */
    resMode?: string;
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
 * 整页重启**必经零上下文的中转页**（`bench-hop.html`，见 `hopUrlFor`）：先把本页文档整个换掉、
 * 在那里停 `hopms`，再进新页建上下文 —— 只在本页 sleep 再 replace 是不够的（等待期间本页仍持有上下文）。
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
/**
 * 轮间中转页：**零 WebGL 上下文、零 Worker** 的空白文档（`bench-hop.html`）。
 *
 * 为什么必须有它：手机端（Adreno）在"上一轮刚销毁的上下文/显存还没被 GPU 进程还回来，
 * 新上下文就来要内存"时，`canvas.getContext('webgl2')` 会直接返回 **null**
 * （不是 `CONTEXT_LOST_WEBGL`，也不是"Too many active WebGL contexts"）——这是设备/显存级拒绝创建。
 * 只在测量页里 `sleep()` 再 `location.replace()` 并不够：等待期间**当前文档仍然持有上下文**，
 * 归还时机完全取决于浏览器对新旧文档的异步回收。
 * 改成"先把整个文档换成中转页（本页文档连同它的上下文一起被销毁）→ 在中转页里停 delay 毫秒
 * （此期间渲染进程里零上下文）→ 再进下一项"，就把"销毁旧上下文"和"创建新上下文"确定性地分开了。
 * （2026-09-13 的那次修复走的就是这条：`renderer.dispose()` → 中转页 → 回测帧页。
 *   见 thesis_project/第七章对比方法实测方案_reduced-3DGS与Flux-GS.md「轮间释放两臂同构」。）
 *
 * `?hop=0` 关掉中转页（退回旧的"本页 sleep 后直接 `location.replace`"口径，仅用于 A/B 对照）；
 * `?hopms=N` 改停留时长（默认 1500，上限 5000，`0` 等价于关闭）。
 */
export const HOP_PAGE = "bench-hop.html";
export function hopDelayMs(): number {
    if (param("hop", "1") === "0") return 0;
    const n = parseInt(param("hopms", "1500"), 10);
    if (!Number.isFinite(n) || n < 0) return 1500;
    return Math.min(n, 5000);
}
/** 把"目标页 URL"包成一次**经中转页**的导航；`hop=0`（或 delay=0）时原样返回目标 URL。 */
export function hopUrlFor(nextUrl: string): string {
    const delay = hopDelayMs();
    if (delay <= 0) return nextUrl;
    const url = new URL(HOP_PAGE, location.href);
    url.searchParams.set("delay", String(delay));
    url.searchParams.set("next", nextUrl);
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
