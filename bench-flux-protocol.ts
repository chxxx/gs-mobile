/**
 * bench-flux-protocol.ts — Flux-GS 参考协议（FPS 计时协议 + 画布策略）的**唯一实现**。
 *
 * 为什么单独一个文件：
 *   1. 它是"父子两页 + 单元测试"共用的纯逻辑：**不 import `./src`（不碰渲染器/WASM）、不碰 GL、不写 DOM**，
 *      因此 node 下的 vitest 可以直接驱动它（见 bench-flux-protocol.test.ts）。
 *   2. 参考实现（`flux-gs-project-gh-pages/render_shared/main.js:2303-2339` 与 `2351-2367`）
 *      属于第三方代码，本仓库不能改它、也不该维护两份近似实现：于是把那条循环抽成
 *      `runFluxLoop()`，本方法渲染器只往里注入 `render / schedule / now`。
 *   3. 口径常量（driver / frames / warmup / 分辨率模式 / 焦距）只有这里一处定义，
 *      结果头、子页面、单元测试读同一份，避免"父页显示的口径"和"子页实际跑的口径"分叉。
 *
 * 详细逐行对照见 `FLUX_FPS_PROTOCOL.md`（A.2 伪代码 / C.1~C.4 规范）。
 */

/** 测帧驱动：`timer` = Flux 的 `setTimeout(0)` 链（参考协议）；`raf` = 每个 requestAnimationFrame 渲染一帧。 */
export type ThroughputDriver = "raf" | "timer";
/** 分辨率协议：`flux-native` = 复刻 Flux 原生画布策略；`flux-fixed` = 两边强制相同 drawing buffer。 */
export type ResolutionMode = "flux-native" | "flux-fixed";
/** driver 的来源：协议自带 / 用户显式覆盖 / 默认值。 */
export type DriverSource = "flux-protocol" | "explicit-override" | "default";

// ------------------------------------------------------------------ 参考实现身份（写进结果头）
/** 官方仓库（本仓库内嵌副本的出处；**不代表论文口径**）。 */
export const FLUX_SOURCE_REPO = "xiaobiaodu/flux-gs-project";
/** 官方 gh-pages 的 commit：本地内嵌副本即基于它（见 FLUX_VENDOR_DIFF.md §0/§3）。 */
export const FLUX_SOURCE_COMMIT = "d062af33bab6e74ed45f9c4b6e8ec6b3d6cff752";
/**
 * 本协议**到底复刻的是什么**（禁止简写成"Flux-GS 论文协议/原 benchmark 协议"）：
 * 复刻对象 = 本地内嵌副本新增的 `runFluxBenchmark()` 钩子（`render_shared/main.js:2351-2367`
 * ＋ `frame()` 尾部 `2303-2339`）的调度与计时行为。论文是否采用同一口径**未经验证**。
 */
export const FLUX_PROTOCOL_SOURCE = "vendored-copy runFluxBenchmark() hook (verified against source lines)";
/** 参考实现的展示名（最终页面必须显示）。 */
export const FLUX_PROTOCOL_LABEL = "vendored-copy runFluxBenchmark() setTimeout(0) throughput";
/** 论文口径是否被验证（当前：没有任何论文/官方代码证据 ⇒ false，见 FLUX_FPS_PROTOCOL.md §A.5）。 */
export const FLUX_PAPER_PROTOCOL_VERIFIED = false;
/**
 * 指标命名（FLUX_FPS_PROTOCOL.md §A.6）：整段测量里**没有任何 GPU 同步**
 * （无 `gl.finish()` / `fenceSync` / `clientWaitSync` / `readPixels`），
 * 因此它只能叫"未同步的 WebGL 帧提交吞吐"，不得叫 GPU FPS 或呈现 FPS。
 */
export const FLUX_METRIC = "unsynchronized-webgl-frame-submission-throughput";
/** 本指标是否等待 GPU 完成：false（测量窗口内不做任何同步）。 */
export const FLUX_GPU_SYNCED = false;
/** 本指标是否为"呈现帧率"（presented FPS）：false（与合成器/刷新率无关，只统计提交）。 */
export const FLUX_PRESENTED_FPS = false;
/** `setTimeout(0)` 的计时器下限（HTML 规范：嵌套 >5 层后钳到 ≥4ms）。仅用于 timerClampObserved 的条件判定。 */
export const TIMER_CLAMP_MS = 4;
/** `timerClampObserved` 的判定阈值：样本 ≥30 且 ≥50% 的相邻帧间隔落在 [3.5, 4.6]ms。 */
export const TIMER_CLAMP_GAP_MIN_MS = 3.5;
export const TIMER_CLAMP_GAP_MAX_MS = 4.6;
export const TIMER_CLAMP_MIN_SAMPLES = 30;
export const TIMER_CLAMP_FRACTION = 0.5;
/** Flux 的 COLMAP 焦距（`bench-flux-camera.json` 的 `focal_px`，官方源码里 13 个场景共用）。 */
export const FLUX_FOCAL_PX = 1159.5880733038064;
export const FLUX_DEFAULT_FRAMES = 300;
export const FLUX_DEFAULT_WARMUP = 0;
/** 官方 `main.js:1546` 的 rowLength：`3*4 + 3*4 + 4 + 4`。 */
export const FLUX_ROW_LENGTH = 32;
/** 官方 `main.js:1551` 的不降采样阈值（以"字节 / rowLength"计）。 */
export const FLUX_NATIVE_NO_DOWNSCALE_ROWS = 500000;
/**
 * 相对官方渲染代码的改动拆分（FLUX_VENDOR_DIFF.md §4 的 11 个 hunk 逐条归类）。
 * 注意：**不能再压成一个 `rendering_modifications=none`** —— 那会把
 * 计时循环 / benchres 分辨率 / 相机 三处改动一起掩盖掉（见 §A.7）。
 */
export const FLUX_MODIFICATIONS_ALWAYS: { algorithmModified: boolean; benchmarkLoopModified: boolean } = {
    algorithmModified: false, // 11 hunks 中 0 处触及 shader/排序/剔除/解码/draw（gl.drawArraysInstanced 参数未变）
    benchmarkLoopModified: true, // hunk 10：新增计帧/调度分支并删除官方无条件的 requestAnimationFrame(frame)
};

export interface Size {
    w: number;
    h: number;
}

/** 只依赖 `get()` 的查询串读取接口（浏览器传 URLSearchParams，测试传包装对象）。 */
export interface RawQuery {
    get(name: string): string | null;
}

/** 相机模式：本方法臂的机位来源（决定 cameraModified 是否成立）。 */
export type CameraMode = "auto" | "flux-default" | "flux-hardcoded";

/** 相对官方渲染代码的改动拆分（四个独立布尔，禁止压缩成单一 "none" 标签）。 */
export interface FluxModificationBreakdown {
    /** shader / 排序 / 剔除 / VQ 解码 / draw 调用是否被改（当前：false） */
    algorithmModified: boolean;
    /** 计时循环是否被改（新增计帧/调度分支、删除官方无条件 rAF；当前：true） */
    benchmarkLoopModified: boolean;
    /** 会话内是否改了画布/投影分辨率（`?force=`/`?res=` ⇒ true；纯 flux-native ⇒ false） */
    resolutionModified: boolean;
    /** 会话内是否改了相机（`?cam=flux` / `?fluxcam=N` 或外部注入 viewMatrix ⇒ true） */
    cameraModified: boolean;
    notes: string[];
}

/** 改动拆分（由会话参数决定 resolutionModified / cameraModified）。 */
export function fluxModificationBreakdownFor(
    resolutionMode: ResolutionMode,
    cameraMode: CameraMode,
): FluxModificationBreakdown {
    const notes: string[] = [];
    if (FLUX_MODIFICATIONS_ALWAYS.benchmarkLoopModified) {
        notes.push("benchmarkLoop: main.js:2303-2339 新增计帧分支并删除官方无条件 requestAnimationFrame(frame)");
    }
    if (resolutionMode === "flux-fixed") {
        notes.push("resolution: ?force=/?res= 会话走 benchres 路径（main.js:1671-1676/1690-1694）");
    }
    if (cameraMode !== "auto") {
        notes.push("camera: 机位来自 Flux 相机资产/硬编码镜头（cam=flux|fluxcam=N），并冻结 carousel");
    }
    return {
        algorithmModified: FLUX_MODIFICATIONS_ALWAYS.algorithmModified,
        benchmarkLoopModified: FLUX_MODIFICATIONS_ALWAYS.benchmarkLoopModified,
        resolutionModified: resolutionMode === "flux-fixed",
        cameraModified: cameraMode !== "auto",
        notes,
    };
}

export function fluxModificationBreakdown(spec: FluxProtocolSpec): FluxModificationBreakdown {
    return fluxModificationBreakdownFor(spec.resolutionMode, spec.cameraMode);
}
export interface FluxProtocolSpec {
    /** 用户传入的 proto 原值 */
    proto: string;
    protocol: "flux" | "custom";
    driver: ThroughputDriver;
    driverSource: DriverSource;
    frames: number;
    warmup: number;
    cameraFrozen: boolean;
    adaptiveResolution: boolean;
    resolutionMode: ResolutionMode;
    /** flux-fixed 的强制尺寸（来自 force=WxH 或显式 res=WxH） */
    forcedRes: Size | null;
    /** 相机像素焦距：flux 协议默认取 Flux 的 COLMAP 焦距 */
    focalPx: number;
    /** 协议允许的显式覆盖（frames/warmup/force/res/fx） */
    overrides: string[];
    /** 与参考协议冲突的参数（目前只有 driver≠timer） */
    conflicts: string[];
    /** 是否严格按参考协议执行（无冲突） */
    protocolMatched: boolean;
    /** 是否可把本轮 FPS 归类为 Flux-compatible（必须 driver=timer 且无冲突） */
    fluxCompatible: boolean;
    label: string;
    /** 复刻对象的说明（禁止简写成"论文协议"；论文口径 paperProtocolVerified=false） */
    protocolSource: string;
    /** 机位来源（决定 cameraModified 是否成立） */
    cameraMode: CameraMode;
    /** 指标名：未同步的 WebGL 帧提交吞吐（§A.6），不得称 GPU FPS / 呈现 FPS */
    metric: string;
    /** 测量窗口内是否等待 GPU 完成（恒为 false） */
    gpuSynced: boolean;
    /** 是否为呈现帧率（恒为 false） */
    presentedFps: boolean;
    /** 论文口径是否被验证（当前恒为 false；见 FLUX_FPS_PROTOCOL.md §A.5） */
    paperProtocolVerified: boolean;
    sourceRepo: string;
    sourceCommit: string;
    /** 相对官方渲染代码的改动拆分（四个独立布尔 + 备注），不再用单一 none */
    modifications: FluxModificationBreakdown;
}

function intParam(raw: string | null | undefined): number | null {
    if (raw === null || raw === undefined || raw === "") return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
}

/** 解析 `WxH`（`?force=` / `?res=` / `?benchres=` 共用同一格式）。 */
export function parseSize(raw: string | null | undefined): Size | null {
    if (!raw) return null;
    const m = /^(\d+)x(\d+)$/.exec(String(raw).trim());
    if (!m) return null;
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * 由查询串推出协议描述。规则（FLUX_FPS_PROTOCOL.md §C.1）：
 *   - `proto=flux` ⇒ driver=timer、warmup=0、frames=300、cameraFrozen=true、
 *     adaptiveResolution=false、默认 flux-native（给了 force/res 则 flux-fixed）。
 *   - 显式 `warmup=` / `frames=` / `force=` / `res=` / `fx=` 允许覆盖，记入 `overrides`。
 *   - 显式 `driver=<非 timer>` 与参考协议冲突：**按用户要求执行**，但 `protocolMatched=false`
 *     且 `fluxCompatible=false`（该轮禁止被归类为 Flux-compatible FPS）。
 *   - 未传 `proto=flux` 时保持旧口径：driver 默认 raf、warmup 默认 10、分辨率用 res（默认 1600x1063）。
 */
export function fluxProtocolSpec(query: RawQuery): FluxProtocolSpec {
    const proto = (query.get("proto") ?? "").trim();
    const isFlux = proto === "flux";
    const overrides: string[] = [];
    const conflicts: string[] = [];

    const driverRaw = query.get("driver");
    let driver: ThroughputDriver;
    let driverSource: DriverSource;
    if (driverRaw !== null && driverRaw !== "") {
        const want: ThroughputDriver = driverRaw === "timer" ? "timer" : "raf";
        driver = want;
        driverSource = "explicit-override";
        if (isFlux && want !== "timer") conflicts.push(`driver=${driverRaw}`);
    } else if (isFlux) {
        driver = "timer";
        driverSource = "flux-protocol";
    } else {
        driver = "raf";
        driverSource = "default";
    }

    const framesRaw = intParam(query.get("frames"));
    const frames = framesRaw !== null && framesRaw > 0 ? framesRaw : FLUX_DEFAULT_FRAMES;

    const warmupRaw = intParam(query.get("warmup"));
    const warmup = warmupRaw !== null && warmupRaw >= 0 ? warmupRaw : isFlux ? FLUX_DEFAULT_WARMUP : 10;

    const forceRaw = query.get("force");
    const resRaw = query.get("res");
    const forced = parseSize(forceRaw) ?? (isFlux ? parseSize(resRaw) : null);
    const resolutionMode: ResolutionMode = isFlux ? (forced ? "flux-fixed" : "flux-native") : "flux-fixed";

    const fxRaw = query.get("fx");
    const fxParsed = fxRaw === null || fxRaw === "" ? null : parseFloat(fxRaw);
    const focalPx = fxParsed !== null && Number.isFinite(fxParsed) ? fxParsed : isFlux ? FLUX_FOCAL_PX : 0;

    if (isFlux) {
        if (framesRaw !== null) overrides.push(`frames=${frames}`);
        if (warmupRaw !== null) overrides.push(`warmup=${warmup}`);
        if (forced && forceRaw) overrides.push(`force=${forced.w}x${forced.h}`);
        else if (forced) overrides.push(`res=${forced.w}x${forced.h}`);
        if (fxParsed !== null && Number.isFinite(fxParsed)) overrides.push(`fx=${focalPx}`);
    }

    const protocolMatched = isFlux && conflicts.length === 0;
    // 机位来源：?fluxcam=N（用官方硬编码镜头）> ?cam=flux（用官方 default_view）> auto（包围盒取景）
    const fluxCamRaw = query.get("fluxcam");
    const cameraMode: CameraMode =
        fluxCamRaw !== null && /^\d+$/.test(fluxCamRaw)
            ? "flux-hardcoded"
            : query.get("cam") === "flux"
              ? "flux-default"
              : "auto";
    return {
        proto,
        protocol: isFlux ? "flux" : "custom",
        driver,
        driverSource,
        frames,
        warmup,
        cameraFrozen: isFlux,
        cameraMode,
        adaptiveResolution: false,
        resolutionMode,
        forcedRes: forced ?? (isFlux ? null : { w: 1600, h: 1063 }),
        focalPx,
        overrides,
        conflicts,
        protocolMatched,
        fluxCompatible: protocolMatched && driver === "timer",
        label: isFlux ? FLUX_PROTOCOL_LABEL : "custom",
        protocolSource: isFlux ? FLUX_PROTOCOL_SOURCE : "custom",
        metric: FLUX_METRIC,
        gpuSynced: FLUX_GPU_SYNCED,
        presentedFps: FLUX_PRESENTED_FPS,
        paperProtocolVerified: FLUX_PAPER_PROTOCOL_VERIFIED,
        sourceRepo: FLUX_SOURCE_REPO,
        sourceCommit: FLUX_SOURCE_COMMIT,
        modifications: fluxModificationBreakdownFor(resolutionMode, cameraMode),
    };
}

/** 便捷入口：从 `location.search`（或任意 `?a=b&c=d` 串 / URLSearchParams）构造协议描述。 */
export function fluxProtocolSpecFromSearch(search: string | URLSearchParams): FluxProtocolSpec {
    const params = search instanceof URLSearchParams ? search : new URLSearchParams(search);
    return fluxProtocolSpec({ get: (name) => params.get(name) });
}

/** 冲突提示文本（最终页面顶部的显著警告 + 结果头共用一份措辞）。 */
export function fluxProtocolWarning(spec: FluxProtocolSpec): string {
    if (spec.conflicts.length === 0) return "";
    return (
        `协议冲突：${spec.conflicts.join(", ")} 与内嵌副本 runFluxBenchmark() 钩子的口径（driver=timer）不一致。` +
        "该轮按你显式要求的 driver 执行，但结果已标记 protocolMatched=false，" +
        "禁止与内嵌副本钩子的结果直接比较（不会计入 Flux-compatible FPS）。"
    );
}

// ------------------------------------------------------------------ 参考循环（FPS 协议本体）
/**
 * 参考循环需要注入的四个能力。**只有调度与时间**，不涉及 GL/DOM —— 这正是"共享 harness"的关键：
 * 本方法与测试用同一份实现，参考实现（Flux）由 `runFluxLoopReference()` 逐行同构地对拍。
 */
export interface FluxLoopHooks {
    /** 一次完整 render（本方法 = `renderer.render(scene, camera)`，相机冻结、纹理已上传、排序只发请求） */
    render: () => void;
    /** 排下一帧：参考实现用 `setTimeout(cb, 0)`；rAF 口径下传 `requestAnimationFrame` */
    schedule: (cb: () => void) => void;
    /** 单调时钟（参考实现 = `performance.now()`） */
    now: () => number;
    /** 返回非空字符串表示本轮作废（`hidden` / `context-lost` / `stopped` …），不得写 DOM */
    shouldAbort?: () => string | null;
}

export interface FluxLoopResult {
    /** 实际完成的 render 次数（参考实现里它与请求帧数恒等） */
    frames: number;
    /** 请求的帧数 */
    requested: number;
    /** 计时区间的起止（performance.now 口径） */
    startMs: number;
    endMs: number;
    elapsedMs: number;
    fps: number;
    /** 非空 ⇒ 本轮作废（页面隐藏 / 上下文丢失 / 被取消） */
    abortedReason: string;
    /** 相邻两次 render **开始**时刻的间隔样本（诊断用，不参与任何计时）：数量 = frames-1 */
    gapCount: number;
    gapMinMs: number;
    gapMedMs: number;
    gapP95Ms: number;
    gapMaxMs: number;
    /**
     * 是否**实际观测到** timer 节拍（`setTimeout(0)` 的 ≥4ms 钳制）：
     * 条件判定 = 样本 ≥ {@link TIMER_CLAMP_MIN_SAMPLES} 且 落在
     * [{@link TIMER_CLAMP_GAP_MIN_MS}, {@link TIMER_CLAMP_GAP_MAX_MS}]ms 的占比 ≥ {@link TIMER_CLAMP_FRACTION}。
     * **不是常量**：没有实测到 4ms 聚集就必须是 false，不得把"约 250fps 上限"当既定结论。
     */
    timerClampObserved: boolean;
    /** 循环结束时的 `document.visibilityState`（非浏览器环境为 ""） */
    visibilityState: string;
}

/** 分位数（nearest-rank，p ∈ [0,1]）；空数组返回 0。 */
function percentileOf(gaps: number[], p: number): number {
    if (gaps.length === 0) return 0;
    const sorted = [...gaps].sort((a, b) => a - b);
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
    return sorted[rank - 1];
}

/** 极值（诊断）：空数组返回 0。 */
function extremeOf(gaps: number[], mode: "min" | "max"): number {
    if (gaps.length === 0) return 0;
    return mode === "min" ? Math.min(...gaps) : Math.max(...gaps);
}

/** `timerClampObserved` 的条件判定（阈值常量见文件顶部）。 */
export function timerClampObservedFrom(gaps: number[]): boolean {
    if (gaps.length < TIMER_CLAMP_MIN_SAMPLES) return false;
    const inBand = gaps.filter((g) => g >= TIMER_CLAMP_GAP_MIN_MS && g <= TIMER_CLAMP_GAP_MAX_MS).length;
    return inBand / gaps.length >= TIMER_CLAMP_FRACTION;
}

/** 当前文档可见性（非浏览器环境返回 ""；只读，不写 DOM）。 */
function visibilityStateNow(): string {
    try {
        if (typeof document !== "undefined" && document.visibilityState) return String(document.visibilityState);
    } catch {
        /* ignore */
    }
    return "";
}

/**
 * 参考循环（**唯一实现**）：逐行对应 `render_shared/main.js:2351-2367` + `2303-2339`。
 *
 *   warmup 次：render() → schedule()            // 参考臂 warmup 默认 0
 *   tick(): render()                            // ★ 先 render（main.js:2263）
 *           if (startMs === 0) startMs = now()  // ★ 计时起点＝第 1 帧 render 结束（main.js:2305）
 *           count++
 *           if (count < frames) schedule(tick)  // ★ 先 render 后 setTimeout(0)（main.js:2308）
 *           else { endMs = now(); fps = count/(elapsed/1000) }   // ★ main.js:2310-2311
 *
 * 注意：`frames` 计入分子（含第 1 帧），但时间区间只覆盖第 2…N 帧 —— 与参考实现完全一致。
 */
export function runFluxLoop(frames: number, warmup: number, hooks: FluxLoopHooks): Promise<FluxLoopResult> {
    const total = Math.max(1, Math.floor(frames) || 1);
    const warmCount = Math.max(0, Math.floor(warmup) || 0);
    return new Promise<FluxLoopResult>((resolve) => {
        let count = 0;
        let startMs = 0;
        let lastFrameStart = 0;
        const gaps: number[] = [];
        const finish = (abortedReason: string): void => {
            const endMs = hooks.now();
            const elapsedMs = startMs > 0 ? endMs - startMs : 0;
            resolve({
                frames: count,
                requested: total,
                startMs,
                endMs,
                elapsedMs,
                fps: elapsedMs > 0 ? count / (elapsedMs / 1000) : 0,
                abortedReason,
                gapCount: gaps.length,
                gapMinMs: extremeOf(gaps, "min"),
                gapMedMs: percentileOf(gaps, 0.5),
                gapP95Ms: percentileOf(gaps, 0.95),
                gapMaxMs: extremeOf(gaps, "max"),
                timerClampObserved: timerClampObservedFrom(gaps),
                visibilityState: visibilityStateNow(),
            });
        };
        /** 诊断：记录相邻帧开始时刻的间隔（只读时间，不改变任何调度顺序）。 */
        const noteFrameStart = (): void => {
            const t = hooks.now();
            if (lastFrameStart > 0) gaps.push(t - lastFrameStart);
            lastFrameStart = t;
        };
        const tick = (): void => {
            const abort = hooks.shouldAbort ? hooks.shouldAbort() : null;
            if (abort) {
                finish(abort);
                return;
            }
            noteFrameStart();
            hooks.render(); // ★ 先 render
            if (startMs === 0) startMs = hooks.now(); // ★ 计时起点（第 1 帧 render 之后）
            count++;
            if (count < total) {
                hooks.schedule(tick); // ★ 先 render 后 setTimeout(0)
                return;
            }
            finish("");
        };
        let remaining = warmCount;
        const warmTick = (): void => {
            const abort = hooks.shouldAbort ? hooks.shouldAbort() : null;
            if (abort) {
                finish(abort);
                return;
            }
            hooks.render();
            remaining--;
            if (remaining > 0) hooks.schedule(warmTick);
            else hooks.schedule(tick);
        };
        if (warmCount > 0) hooks.schedule(warmTick);
        else hooks.schedule(tick);
    });
}

/**
 * 参考实现的**对拍用**等价实现（`render_shared/main.js:2303-2339` 逐行同构）。
 * 只被测试使用：用同一个假时钟/假调度器驱动它与 `runFluxLoop`，两者的
 * `render 调用序列 / frames / elapsedMs / fps` 必须完全相等。
 */
export function runFluxLoopReference(frames: number, warmup: number, hooks: FluxLoopHooks): Promise<FluxLoopResult> {
    const target = Math.max(1, Math.floor(frames) || 1);
    return new Promise<FluxLoopResult>((resolve) => {
        let benchmarkFrameCount = 0;
        let benchmarkStartTime = 0;
        let warmRemaining = Math.max(0, Math.floor(warmup) || 0);
        let lastFrameStart = 0;
        const gaps: number[] = [];
        const settle = (abortedReason: string): void => {
            const end = hooks.now();
            const elapsed = benchmarkStartTime === 0 ? 0 : (end - benchmarkStartTime) / 1000;
            resolve({
                frames: benchmarkFrameCount,
                requested: target,
                startMs: benchmarkStartTime,
                endMs: end,
                elapsedMs: elapsed * 1000,
                fps: elapsed > 0 ? benchmarkFrameCount / elapsed : 0,
                abortedReason,
                gapCount: gaps.length,
                gapMinMs: extremeOf(gaps, "min"),
                gapMedMs: percentileOf(gaps, 0.5),
                gapP95Ms: percentileOf(gaps, 0.95),
                gapMaxMs: extremeOf(gaps, "max"),
                timerClampObserved: timerClampObservedFrom(gaps),
                visibilityState: visibilityStateNow(),
            });
        };
        const frame = (): void => {
            const abort = hooks.shouldAbort ? hooks.shouldAbort() : null;
            if (abort) {
                settle(abort);
                return;
            }
            const t = hooks.now(); // 诊断：帧开始间隔（不参与计时）
            if (lastFrameStart > 0) gaps.push(t - lastFrameStart);
            lastFrameStart = t;
            hooks.render(); // main.js:2263 完整帧
            if (warmRemaining > 0) {
                // 参考臂的"预热"= 额外完整跑一轮 runFluxBenchmark（结果丢弃）
                warmRemaining--;
                hooks.schedule(frame);
                return;
            }
            if (benchmarkStartTime === 0) benchmarkStartTime = hooks.now(); // main.js:2305
            benchmarkFrameCount++; // main.js:2306
            if (benchmarkFrameCount < target) {
                hooks.schedule(frame); // main.js:2308
            } else {
                settle(""); // main.js:2309-2311
            }
        };
        hooks.schedule(frame); // main.js:2366
    });
}

// ------------------------------------------------------------------ 画布策略（flux-native / flux-fixed）
/**
 * 复刻官方 `main.js:1551-1552`：
 * `downsample = splatData.length / rowLength > 500000 ? 1 : 1 / devicePixelRatio`
 *
 * 注意官方比的是**下载到的字节数 / 32**，不是"高斯点数"。因此本方法必须用**同一个文件字节数**
 * （Resource Timing 的 `decodedBodySize`，与官方 `splatData.length` 同为解压后 body 长度）才能命中同一分支。
 */
export function fluxNativeDownsample(modelBytes: number, devicePixelRatio: number): number {
    const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
    const rows = modelBytes > 0 ? modelBytes / FLUX_ROW_LENGTH : 0;
    return rows > FLUX_NATIVE_NO_DOWNSCALE_ROWS ? 1 : 1 / dpr;
}

/** 复刻官方 `main.js:1688-1689`：`Math.round(css / downsample)`，css 即渲染页的视口尺寸。 */
export function fluxNativeBufferSize(cssW: number, cssH: number, modelBytes: number, devicePixelRatio: number): Size {
    const downsample = fluxNativeDownsample(modelBytes, devicePixelRatio);
    return {
        w: Math.max(1, Math.round(cssW / downsample)),
        h: Math.max(1, Math.round(cssH / downsample)),
    };
}

/**
 * 两边视场角对齐所需的**渲染用焦距**：
 *   - flux-fixed：官方 `?benchres=WxH` 把 `projW/projH` 也换成 `WxH`（`main.js:1674-1675`），
 *     焦距保持 `1159.588` ⇒ 本方法 `setSize(W,H)` 后也直接用同一焦距；
 *   - flux-native：官方投影用 `innerWidth/innerHeight`（CSS 视口）而画布可能更小
 *     ⇒ 本方法必须按 `bufferW / cssW` 缩放焦距，才能得到与官方**完全相同**的 FOV
 *     （官方投影 `2*fx/innerWidth`，本方法投影 `2*fx'/bufferW`）。
 */
export function replicationFocalPx(spec: FluxProtocolSpec, bufferW: number, cssW: number): number {
    const focal = spec.focalPx > 0 ? spec.focalPx : FLUX_FOCAL_PX;
    if (spec.resolutionMode === "flux-fixed") return focal;
    return cssW > 0 ? (focal * bufferW) / cssW : focal;
}

/** 每轮必须输出的分辨率审计块（字段名与 FLUX_FPS_PROTOCOL.md §C.3.3 一致）。 */
export interface ResolutionAudit {
    canvasWidth: number;
    canvasHeight: number;
    drawingBufferWidth: number;
    drawingBufferHeight: number;
    /** gl.getParameter(gl.VIEWPORT) */
    viewport: [number, number, number, number];
    /** CSS 显示尺寸（**只是显示尺寸，绝不当作渲染分辨率**；取不到时填 0） */
    cssWidth: number;
    cssHeight: number;
    devicePixelRatio: number;
    internalRenderScale: number;
    adaptiveResolution: boolean;
    resolutionMode: ResolutionMode;
}

/** 本方法的内部渲染尺度：没有任何自适应缩放，恒为 1（`?adaptive` 之类开关都不参与测帧）。 */
export const INTERNAL_RENDER_SCALE = 1;

export function resolutionAuditFrom(
    canvas: { width: number; height: number; clientWidth?: number; clientHeight?: number },
    gl: { drawingBufferWidth: number; drawingBufferHeight: number; viewport?: [number, number, number, number] } | null,
    devicePixelRatio: number,
    resolutionMode: ResolutionMode,
): ResolutionAudit {
    const bufW = canvas.width;
    const bufH = canvas.height;
    return {
        canvasWidth: bufW,
        canvasHeight: bufH,
        drawingBufferWidth: gl ? gl.drawingBufferWidth : -1,
        drawingBufferHeight: gl ? gl.drawingBufferHeight : -1,
        viewport: gl?.viewport ?? [0, 0, bufW, bufH],
        cssWidth: canvas.clientWidth ?? 0,
        cssHeight: canvas.clientHeight ?? 0,
        devicePixelRatio,
        internalRenderScale: INTERNAL_RENDER_SCALE,
        adaptiveResolution: false,
        resolutionMode,
    };
}

/** 只有这些字段完全相同，两边的结果才是可比的（CSS 尺寸不参与判定）。 */
export function resolutionAuditKey(a: ResolutionAudit): string {
    return [a.canvasWidth, a.canvasHeight, a.drawingBufferWidth, a.drawingBufferHeight, a.viewport.join(",")].join("x");
}

export function resolutionAuditMatches(a: ResolutionAudit, b: ResolutionAudit): boolean {
    return resolutionAuditKey(a) === resolutionAuditKey(b);
}

/** 一行诊断（结果头/日志用；显式标注"css 只是显示尺寸"）。 */
export function formatResolutionAudit(a: ResolutionAudit): string {
    return (
        `canvas=${a.canvasWidth}x${a.canvasHeight} drawingBuffer=${a.drawingBufferWidth}x${a.drawingBufferHeight} ` +
        `viewport=${a.viewport.join(",")} css=${a.cssWidth}x${a.cssHeight} dpr=${a.devicePixelRatio} ` +
        `internalScale=${a.internalRenderScale} adaptive=${a.adaptiveResolution ? 1 : 0} mode=${a.resolutionMode}`
    );
}

// ------------------------------------------------------------------ 相机对齐
/** view 矩阵取整到 1e-3（与参考实现回报 `view:` 时 `Math.round(v*1000)/1000` 一致）。 */
export function roundView16(view: readonly number[]): number[] {
    return Array.from(view, (v) => Math.round(v * 1000) / 1000);
}

/** FNV-1a 32bit 哈希（对取整后的 16 个数），用于"两边相机矩阵必须逐位一致"的判定。 */
export function viewMatrixHash(view: readonly number[]): number {
    let h = 0x811c9dc5;
    for (const v of roundView16(view)) {
        const text = v.toFixed(3);
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
    }
    return h >>> 0;
}

/** 两边矩阵是否一致（默认 1e-3 容差，与哈希取整精度一致）。 */
export function viewMatrixMatches(a: readonly number[], b: readonly number[], tol = 1e-3): boolean {
    if (a.length !== 16 || b.length !== 16) return false;
    for (let i = 0; i < 16; i++) {
        if (!(Math.abs(a[i] - b[i]) <= tol)) return false;
    }
    return true;
}

// ------------------------------------------------------------------ 投影对齐（只比 FOV 项）
/**
 * **完整投影矩阵在两臂之间不可比**，因为除 FOV 项之外的 z 行来自不同的近远平面：
 *   - 本方法 `src/cameras/CameraData.ts:9-10,27-32`：near = 0.1、far = 100
 *   - 内嵌副本 `render_shared/main.js:161-168`：znear = 0.2、zfar = 200
 *   ⇒ `projection[10] = far/(far-near)` 与 `projection[14] = -(far*near)/(far-near)` 必然不同。
 *
 * 真正决定"画面负载是否相同"的只有两个 FOV 项，且两边公式逐字节相同
 * （`CameraData.ts:28-29` 与 `main.js:164-165` 都是 `2*fx/w`、`-2*fy/h`）：
 *   `fovX = 2*fx/width`，`fovY = 2*fy/height`
 * 因此跨臂投影判据 = 这两个标量（及其哈希），不是 16 个数的整矩阵哈希。
 */
export function projectionFovKey(fx: number, fy: number, width: number, height: number): string {
    const sx = width > 0 ? (2 * fx) / width : 0;
    const sy = height > 0 ? (2 * fy) / height : 0;
    return `${sx.toFixed(6)},${sy.toFixed(6)}`;
}

/** FOV 项的 FNV-1a 32bit 哈希（跨臂投影判据：哈希相同 ⇒ 视场角一致）。 */
export function projectionFovHash(fx: number, fy: number, width: number, height: number): number {
    const key = projectionFovKey(fx, fy, width, height);
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/** FOV key 是否一致（按 1e-6 的相对精度比较两个分量）。 */
export function projectionFovMatches(a: string, b: string, tol = 1e-6): boolean {
    const pa = a.split(",").map((v) => parseFloat(v));
    const pb = b.split(",").map((v) => parseFloat(v));
    if (pa.length !== 2 || pb.length !== 2) return false;
    return pa.every((v, i) => Number.isFinite(v) && Math.abs(v - pb[i]) <= tol);
}
