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

// ------------------------------------------------------------------ 动态相机挡位（`?spin=`：静止协议的效度自查）
/**
 * **动态相机挡位**：`?spin=<deg/帧>` 让相机在测量窗口内绕**竖直轴**匀速转动，不再全程锁死同一个机位。
 *
 * 为什么需要它（这是**效度**问题，不是计时精度问题）：静止相机协议会给"排序结果可复用"的实现送上一份
 * 免费优势——两臂的深度排序 worker 都带"视角没变就不重排"的判定（已逐行核对）：
 *   - 本文臂 `src/renderers/webgl/utils/SortWorker.ts:291-298`：新的 viewProj 若**每个元素都能在旧
 *     viewProj 里找到**（等价于矩阵数值完全相同）就不置 `dirty`，`throttledSort()` 于是不重排；
 *   - 基线 `flux-gs-project-gh-pages/render_shared/main.js:558-564`（`runSort`）：新旧视图方向点积
 *     `|dot - 1| < 0.01`（≈ 视角变化 < 8.1°）时直接 `return`，复用上一帧 depthIndex。
 * 也就是说**静止协议下两臂都在跳过每帧排序**。"每帧重排"到底值多少时间，只有相机真动了才测得出来；
 * `spin=0`（缺省）＝原有静止协议，历史数据与论文主表口径都不变。
 *
 * 幅度选择（实测关心两档）：
 *   - **0.1–0.5°/帧**（"用户缓慢拖动"量级）：本文臂是**值级**判定，0.3°/帧即让矩阵数值全部改变 →
 *     每帧都重排；但**基线的 8.1° 阈值不会**（累积漂移每 ~27 帧才越过阈值一次）→ 两臂的重排频率
 *     仍然不对等，不能直接当作"两臂等量工作"的对照组；
 *   - **≥ 9°/帧**（如 10）：越过基线阈值 → 两臂都每帧重排，这才是动态对照组的正确挡位。
 * 若只跑 0.1–0.5°/帧 就断言"动态下也一样"，对基线不成立（它的判定根本没被触发）；两档一起跑才完整。
 *
 * `?spin_mode=swing`（±摆幅往复）**不按 deg/帧 计**：它给的是**摆幅**，峰值角速度 = 摆幅 × 2π / `?spin_period=`
 * （周期，帧；缺省 = 整个测量窗口）。它解决的是上面两个 rate 挡的共同盲点——rate 一路往一个方向转，
 * 转到某些角度时画面内容会变少，于是"fps 不掉"多出一种解释（要画的东西变少了）；swing 让相机**原地**
 * 摆动（位置不动、朝向只在基准 ±摆幅内），整段窗口看着同一片内容，再用 `?sweep=` 逐姿态把这件事实测出来。
 *
 * 旋转轴心（`?pivot=x,y,z`，缺省 = **相机自身位置**）：竖直轴过哪个点，决定"原地转头"还是"绕物体公转"：
 *   - 缺省 `spin_pivot=cam`：相机**原地**绕竖直轴转（视线扫过四周）。这是"用户转动视角"的直接类比，
 *     对 **360 采集场景**（mip360 的 garden/bicycle/…，相机本来就在点云内部）内容量不变；
 *   - `?pivot=x,y,z`：绕该点**公转**、视线始终朝向它。**物体型场景**（相机在物体外，如 truck）必须
 *     用它，否则原地转头会把物体转出画面，测到的"变快"其实是**负载变小**。每轮把模型包围盒中心写进
 *     `scene_center=`（世界坐标），要公转就直接把它抄进 `?pivot=`。
 * 两臂必须用**同一个 pivot** 才可比（否则测的是两条不同的相机轨迹）：`spin_err=` 是各自的
 * "实际视图矩阵 vs 共享实现目标视图矩阵"最大偏差，用来证明这一点。
 *
 * ⚠️ 2026-09-17 修正（**内容量对齐**）：`covered=` 原先在"测帧窗口结束后"读像素，而动态轮此时相机
 * 已经转到别处 → 同一场景不同挡位读出 99.8%/47.0%/38.1%/100.0% 这种忽高忽低的数（那是**探针时机**
 * 的问题，不是渲染内容问题；`rate` 30°/帧 转满 9000°≡0° 才回到 100%）。现已改为探针先还原**基准位姿**
 * → `covered=` 在所有轮次里都表示"基准机位的画面覆盖率"。内容量随轨迹怎么变，交给 `?sweep=` 逐姿态回答：
 *   - `sweep_cov=`  逐姿态**真实渲染**覆盖率 %（readPixels，与 `covered=` 同一个量法）；
 *   - `sweep_seen=` 逐姿态**裁剪盒内**高斯点比例 %（两臂共用 `clipInsideRatio`，各自用**自己渲染器的
 *     viewProj** + 自己的点集）；
 *   - `sweep_drawn=` 逐姿态**提交绘制的实例数**（本文臂 = 排序索引长度、基线 = `vertexCount`；
 *     两臂都是"整份点集每帧都提交"，所以它应当恒定 → `sweep_drawn_const=1` 就是"要画的高斯点数
 *     不随视角变"的直接证据）；
 *   - `sweep_yaw=` / `sweep_pos=` / `sweep_frm=`：逐姿态的轨迹（角度 / 相机世界位置 / 帧号）。
 * 加上 `spin_mode=swing`（±摆幅正弦往复）这一档，才能把"fps 不掉"的两种解释分开：
 *   （A）排序省了时间 vs（B）转到空白区、要画的东西变少了 —— (B) 会让 `sweep_cov`/`sweep_seen`
 *   同步塌下去，而 (A) 不会让它们变。
 *
 * 结果字段（结果头与逐轮行同名同格式，由 `spinRoundTags`/`sweepRoundTags` 统一生成）：
 * `spin=`（rate = deg/帧；swing = 摆幅）、`spin_mode=`、`spin_period=`、`spin_peak=`（峰值 deg/帧）、
 * `spin_pivot=`（轴心或 `cam`）、`spin_err=`（该臂实际视图矩阵与共享实现算出的目标视图矩阵的**最大元素
 * 偏差**，用来证明"两臂转的是同一条轨迹"）、`sort_results=`（测帧窗口内**真正完成**的排序次数 ——
 * 静止协议下两臂都只排 1 次，这是"静止协议让两臂都省掉了每帧排序"的直接证据）、`sweep_*=`（见上）。
 * `spin_err=` 的实测量级（2026-09-17，RTX 4060 Laptop）：本文臂 5e-6（0.3°/帧）、1.6e-4（10°/帧）——
 * 随转角近似线性，等效角度偏差 ≤0.02°（本文臂走"位姿 → 渲染器 `CameraData.update`"这条路，与共享实现
 * 的纯矩阵写法有精度级差异）；基线臂直接注入视图矩阵，受 `__FLUXGS_BENCH_END__.view` 的 1e-3 舍入限制，
 * 实测 0.0e+0。**判定阈值取 1e-3**：超过它才说明两臂走的不是同一条轨迹，该轮不能跨臂相除。
 */
export function camSpinDegPerFrame(): number {
    const v = parseFloat(param("spin", "0"));
    if (!Number.isFinite(v) || v === 0) return 0;
    // ±30°/帧 之外没有意义（一帧半圈以上，轨迹本身不再像"交互"）；超大值一般是参数写错。
    // 注意：这个上限只约束 **rate 档的角速度**；swing 档里 `spin=` 是**摆幅**（不是 deg/帧），
    // 由 spinSwingAmpDeg() 单独取值并夹到 ±180°（见 resolveSpinSpec）。
    return Math.max(-30, Math.min(30, v));
}
/** `?spin=` 的**原始值**（不夹 ±30/帧）：swing 档取它当摆幅（±deg），夹到 ±180°。 */
export function spinSwingAmpDeg(): number {
    const v = Math.abs(parseFloat(param("spin", "0")));
    if (!Number.isFinite(v) || v === 0) return 0;
    return Math.min(180, v);
}
/**
 * 轨迹模式（2026-09-17 追加）：`rate` = 绕竖直轴**匀速**转（历史口径）；`swing` = **正弦往复摆动**。
 *
 * 为什么要加 `swing`（这是**内容量对齐**问题，不是计时问题）：`rate` 档相机一路往一个方向转下去，
 * 转到某个角度时看到的画面内容可能变少（甚至转向空白），此时 fps 不掉就可能是"要画的东西变少了"
 * 而不是"排序省了时间"——两种解释只靠 fps 分不出来。`swing` 让相机在**基准机位附近 ±摆幅**内往复
 * （位置不动、姿态只摆 ±A°），于是整段窗口始终看着与静止轮**同一片**内容，且 0° 那一帧就是基准机位。
 * 逐姿态的实测覆盖率与"裁剪盒内高斯数"写进 `sweep_cov=` / `sweep_seen=`（见 clipInsideRatio），
 * 用来**直接证明**两臂在这条轨迹上做的是等量的工作。
 */
export type SpinMode = "rate" | "swing";
/** `?spin_mode=swing`：往复摆动；缺省/其它值 = `rate`（历史口径，逐字不变）。 */
export function spinModeParam(): SpinMode {
    return param("spin_mode", "").toLowerCase() === "swing" ? "swing" : "rate";
}
/** `?pivot=x,y,z`：旋转轴心（世界坐标，竖直轴过该点）。缺省返回 null，由各臂自行取缺省值。 */
export function spinPivotParam(): [number, number, number] | null {
    const raw = param("pivot", "");
    if (!raw) return null;
    const p = raw.split(",").map((s) => parseFloat(s));
    if (p.length !== 3 || p.some((v) => !Number.isFinite(v))) return null;
    return [p[0], p[1], p[2]];
}
/**
 * 动态相机轨迹的**解析结果**（`?spin=` / `?spin_mode=` / `?spin_period=` 的唯一解读处）：
 * 两臂都只用这个对象驱动相机，轨迹不可能分叉。
 *   - `deg`：`rate` 模式是 deg/帧；`swing` 模式是**摆幅** ±deg（恒取正值）。
 *   - `period`：`swing` 的往返周期（帧）；缺省 = 整个测量窗口（预热 + 计帧）→ 全程一次完整的
 *     "正 → 反 → 正"往复，0°/两个顶点都在窗口内，不会转到陌生视角去。
 *   - `window`：窗口长度（预热 + 计帧），也是 `sweep_*` 采样帧号的上界。
 */
export interface SpinSpec {
    mode: SpinMode;
    deg: number;
    period: number;
    window: number;
}
/** 解析本轮轨迹；`?spin=0`/缺省 → null（静止协议，历史口径逐字不变）。 */
export function resolveSpinSpec(windowFrames: number): SpinSpec | null {
    const window = Math.max(1, Math.round(windowFrames) || 1);
    if (spinModeParam() === "swing") {
        // swing 档：`spin=` 是**摆幅**（±deg，不适用 rate 档的 ±30°/帧 上限），夹到 ±180°
        const amp = spinSwingAmpDeg();
        if (amp === 0) return null;
        const raw = parseFloat(param("spin_period", ""));
        // 周期下限 2 帧：1 帧以下不构成"摆动"，整条轨迹会退化成每帧正负跳变
        const period = Number.isFinite(raw) && raw >= 2 ? Math.min(100000, raw) : window;
        return { mode: "swing", deg: amp, period, window };
    }
    const deg = camSpinDegPerFrame();
    if (deg === 0) return null;
    return { mode: "rate", deg, period: 0, window };
}
/**
 * **第 `index` 帧的 yaw 角（deg）**：两臂唯一的轨迹定义（本文臂据此算位姿，基线臂据此算注入的视图矩阵）。
 *
 *   rate ：`deg · index`                  —— 匀速转（历史口径）
 *   swing：`deg · sin(2π·index/period)`   —— 绕 0° 往复摆动；`index = 0` 时 yaw = 0（基准机位）
 *
 * 帧号从**预热第一帧**起连续计数（`index = 0` = 基准位姿那一帧），与 `driveThroughputFrames` 的
 * warmup/计帧划分一致：预热与计帧因此落在同一条轨迹上，起表点处不会跳一下。
 */
export function spinYawDegAt(spec: SpinSpec, index: number): number {
    if (spec.mode === "rate") return spec.deg * index;
    return spec.deg * Math.sin((2 * Math.PI * index) / spec.period);
}
/** 该轨迹的**峰值角速度**（deg/帧）：`swing` 下 = 摆幅 × 2π / 周期（用来自查两臂是否都越过重排阈值）。 */
export function spinPeakDegPerFrame(spec: SpinSpec): number {
    return spec.mode === "rate" ? Math.abs(spec.deg) : Math.abs(spec.deg) * ((2 * Math.PI) / spec.period);
}
/** 内容量扫描的姿态采样帧号：在 `[0, window-1]` 上均匀取 `k` 个（`k = 1` → 只取基准帧 0）。 */
export function spinSampleFrames(spec: SpinSpec, k: number): number[] {
    const n = Math.max(1, Math.min(1000, Math.round(k) || 1));
    const last = Math.max(0, spec.window - 1);
    if (n === 1) return [0];
    if (n >= spec.window) {
        // 逐帧（`?sweep>=window`）：直接给出窗口内**每一帧**的帧号，不漏任何一帧
        const all: number[] = [];
        for (let i = 0; i <= last; i++) all.push(i);
        return all;
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(Math.round((last * i) / (n - 1)));
    return Array.from(new Set(out));
}
/**
 * 内容量扫描的姿态数 `?sweep=<k>`（0 = 关闭）。缺省：动态相机轮 = 9 个姿态；静止轮 = 0
 * （静止轮缺省不额外渲染/读像素，**历史口径逐字不变**；显式 `?sweep=1` 可让静止轮也扫一次基准位姿）。
 *
 * 上限 1000：`?sweep=300`（= 逐帧）是合法的——用来拿**每一帧**的内容量曲线（300 个姿态的渲染 + 读像素
 * 都在测帧窗口之外，代价为秒级），逐姿态看"有没有哪一帧画面变空"，而不是只看 9 个采样点。
 */
export function sweepSampleCount(spinActive: boolean): number {
    const raw = param("sweep", spinActive ? "9" : "0");
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return spinActive ? 9 : 0;
    return Math.max(0, Math.min(1000, n));
}
/**
 * **内容量探测（两臂同一个函数）**：把点集经 `viewProj` 投到裁剪空间，统计落在与顶点着色器
 * **同一套**裁剪盒（`|x| < 1.2·w, |y| < 1.2·w, -w < z < w`）内的采样点数与比例。
 *
 * 语义 = "这一帧看着多少内容"，与分辨率、GPU、时序都无关。两臂各自用**自己渲染器的 viewProj**
 * （本文臂 `camera.data.viewProj`；基线 `__FLUXGS_BENCH_SWEEP__` 回报的 `proj` × 注入的 view）
 * 和自己的点集调用它，于是"两臂在同一个姿态上是不是看着同一片内容"可以逐姿态直接核对：
 *   - 某臂若转到画面变空，它的 `sweep_seen` / `sweep_cov` 会同步塌下去（此时该轮 fps 不能用来
 *     证明"排序高效"——要画的内容本身就少了）；
 *   - 两臂的 `sweep_seen` 曲线同量级 → "两臂做的是等量工作"这句话成立。
 * `maxSamples` 只限制采样密度（缺省 4000 点），比例与点数都按采样估计。
 */
export function clipInsideRatio(
    positions: ArrayLike<number> | null | undefined,
    count: number,
    viewProj: ArrayLike<number> | null | undefined,
    maxSamples = 4000,
): { sampled: number; inside: number; insidePct: number } {
    if (!positions || !viewProj || viewProj.length !== 16 || count <= 0) {
        return { sampled: 0, inside: 0, insidePct: 0 };
    }
    const stride = Math.max(1, Math.floor(count / Math.max(1, maxSamples)));
    let sampled = 0;
    let inside = 0;
    for (let i = 0; i < count; i += stride) {
        const x = positions[3 * i];
        const y = positions[3 * i + 1];
        const z = positions[3 * i + 2];
        // 与 SortWorker.cullFrustum / 顶点着色器同构：clip = viewProj · (x, y, z, 1)
        const cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
        const cx = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
        const cy = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
        const cz = viewProj[2] * x + viewProj[6] * y + viewProj[10] * z + viewProj[14];
        const clip = 1.2 * cw;
        sampled++;
        if (!(cz < -cw || cz > cw || cx < -clip || cx > clip || cy < -clip || cy > clip)) inside++;
    }
    return { sampled, inside, insidePct: sampled > 0 ? (inside / sampled) * 100 : 0 };
}
/**
 * 点集**包围盒**（世界坐标）与对角线长度：把"两臂基准机位相差 X 单位"这类偏差换算成
 * **相对场景尺度的比例**（`offset / diag`），而不是只能定性说"真实几何、不是 bug"。
 *
 * 口径：`positions` 必须是该臂**实际提交渲染**的世界坐标点集
 *   - 本文臂：`splat.data.positions` 是**局部坐标**，调用方需先乘对象世界矩阵（见
 *     `bench-measure.sceneBounds()`，与 `modelCenter()` 同一层变换）；
 *   - 基线臂：Flux-GS 视图里的点集本身就是世界坐标（`__FLUXGS_DUMP_XYZ__`）。
 * 两臂各算自己的点集：**两臂加载的并不是同一份资产**（① 的低秩 QPLY 610000 点 / diag 225.7248；
 * ③ 的 Flux 自带压缩模型 739431 点 / diag 196.9606，2026-09-21 实测，相差 14.6%），因此这两个对角线
 * 只按**量级**互相核对，不能当作"同一份点集"的证据；真正逐位核对得的是 ① 与离线解密 PLY 的一致。
 */
export interface SceneBounds {
    min: [number, number, number];
    max: [number, number, number];
    /** 包围盒对角线长度（世界单位） */
    diag: number;
    /** 实际统计到的点数 */
    count: number;
}
export function positionsBounds(positions: ArrayLike<number> | null | undefined, count: number): SceneBounds | null {
    if (!positions || count <= 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
        const x = positions[3 * i];
        const y = positions[3 * i + 1];
        const z = positions[3 * i + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    return {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
        diag: Math.sqrt(dx * dx + dy * dy + dz * dz),
        count,
    };
}
/** 坐标系三元组的打印格式（`x,y,z`；两臂共用，逐轮字段可直接字符串比对） */
export function formatTriple(v: ArrayLike<number>, digits = 4): string {
    return [v[0], v[1], v[2]].map((x) => Number(x).toFixed(digits)).join(",");
}
/**
 * 逐轮行的**包围盒标签**（两臂共用唯一实现）：`scene_min=` / `scene_max=` / `scene_diag=`（世界单位）。
 * 没有数据（缺省）时返回空数组 → 历史行格式不变。
 */
export function sceneBoundsRoundTags(r: { sceneMin?: string; sceneMax?: string; sceneDiag?: number }): string[] {
    if (!r.sceneMin || !r.sceneMax || typeof r.sceneDiag !== "number") return [];
    return [`scene_min=${r.sceneMin}`, `scene_max=${r.sceneMax}`, `scene_diag=${fmt(r.sceneDiag, 4)}`];
}

/** 内容量扫描的一个姿态（两臂同名字段，逐姿态对齐核对）。 */
export interface SweepSample {
    /** 帧号（0 = 基准位姿那一帧；含预热帧的连续编号） */
    frame: number;
    /** 该帧的 yaw 角（deg；0 = 基准机位朝向） */
    yaw: number;
    /** 该帧的相机世界位置（`cam` 轴心时恒等于起始位置——原地摆头） */
    pos: [number, number, number];
    /** 真实渲染覆盖率 %（readPixels 稀疏采样，与 `covered=` 同一个量法） */
    coveredPct: number;
    /** 裁剪盒内的高斯点比例 %（`clipInsideRatio`，该臂自己的 viewProj + 该臂自己的点集） */
    seenPct: number;
    /** 裁剪盒内的高斯点数（采样估计值） */
    seenCount: number;
    /** 该姿态实际提交绘制的实例数（本文臂 = 排序索引长度；基线 = `vertexCount`）：证明"画的点数不随视角变" */
    drawn: number;
}
/** 一轮的完整内容量扫描结果（写进逐轮行 `sweep_*` 字段）。 */
export interface SweepResult {
    samples: SweepSample[];
}
/** 内容量扫描的汇总（两臂同一个函数 → 字段格式不可能分叉）。 */
export interface SweepSummary {
    k: number;
    covMean: number;
    covMin: number;
    covMax: number;
    seenMean: number;
    seenMin: number;
    seenMax: number;
    drawnMin: number;
    drawnMax: number;
    frames: string;
    yaws: string;
    poses: string;
    covList: string;
    seenList: string;
    drawnList: string;
}
/** 把扫描结果压成可打印的摘要（`k = 0` 时各字段为 0/空串，调用方据此决定打不打印）。 */
export function summarizeSweep(sweep: SweepResult): SweepSummary {
    const s = sweep.samples;
    const cov = s.map((x) => x.coveredPct);
    const seen = s.map((x) => x.seenPct);
    const drawn = s.map((x) => x.drawn);
    const avg = (a: number[]) => (a.length > 0 ? a.reduce((p, c) => p + c, 0) / a.length : 0);
    const list = (a: number[], digits: number) => a.map((v) => v.toFixed(digits)).join(",");
    return {
        k: s.length,
        covMean: avg(cov),
        covMin: cov.length > 0 ? Math.min(...cov) : 0,
        covMax: cov.length > 0 ? Math.max(...cov) : 0,
        seenMean: avg(seen),
        seenMin: seen.length > 0 ? Math.min(...seen) : 0,
        seenMax: seen.length > 0 ? Math.max(...seen) : 0,
        drawnMin: drawn.length > 0 ? Math.min(...drawn) : 0,
        drawnMax: drawn.length > 0 ? Math.max(...drawn) : 0,
        frames: s.map((x) => String(x.frame)).join(","),
        yaws: list(
            s.map((x) => x.yaw),
            2,
        ),
        poses: s.map((x) => x.pos.map((v) => v.toFixed(3)).join(",")).join("|"),
        covList: list(cov, 1),
        seenList: list(seen, 1),
        drawnList: drawn.map((v) => String(Math.round(v))).join(","),
    };
}
/**
 * 逐轮行的**动态相机标签**（两臂**唯一**实现：本文臂与基线臂都调它，打印格式不可能分叉）。
 * `spin=` 的语义由 `spin_mode=` 决定：`rate` = deg/帧；`swing` = 摆幅（±deg），其峰值角速度见 `spin_peak=`。
 */
export function spinRoundTags(r: {
    spinDeg?: number;
    spinMode?: string;
    spinPeriod?: number;
    spinPeakDeg?: number;
    spinPivot?: string;
    spinErr?: number;
}): string[] {
    return [
        `spin=${fmt(r.spinDeg ?? 0, 3)}`,
        `spin_mode=${r.spinMode ?? "rate"}`,
        `spin_period=${r.spinPeriod === undefined ? "-" : String(r.spinPeriod)}`,
        `spin_peak=${r.spinPeakDeg === undefined ? "-" : fmt(r.spinPeakDeg, 3)}`,
        `spin_pivot=${r.spinPivot ?? "-"}`,
        `spin_err=${typeof r.spinErr === "number" ? r.spinErr.toExponential(1) : "-"}`,
    ];
}
/**
 * 逐轮行的**内容量扫描标签**（两臂共用唯一实现）：没有扫描数据（`sweepK` 缺省/0）时返回空数组，
 * 因此静止轮的历史行格式不变。字段含义见 `SweepSample` / `contentSweep()`（本文臂）与
 * `runFluxContentSweep()`（基线臂）——两臂由同一套函数产出，逐姿态数值可直接对齐比较。
 */
export function sweepRoundTags(r: {
    sweepK?: number;
    sweepFrames?: string;
    sweepYaws?: string;
    sweepPoses?: string;
    sweepCoveredList?: string;
    sweepSeenList?: string;
    sweepDrawnList?: string;
    sweepCoveredMean?: number;
    sweepCoveredMin?: number;
    sweepCoveredMax?: number;
    sweepSeenMean?: number;
    sweepSeenMin?: number;
    sweepSeenMax?: number;
    sweepDrawnMin?: number;
    sweepDrawnMax?: number;
}): string[] {
    if (!r.sweepK || r.sweepK <= 0) return [];
    return [
        `sweep_k=${r.sweepK}`,
        `sweep_frm=${r.sweepFrames ?? ""}`,
        `sweep_yaw=${r.sweepYaws ?? ""}`,
        `sweep_pos=${r.sweepPoses ?? ""}`,
        `sweep_cov=${r.sweepCoveredList ?? ""}`,
        `sweep_seen=${r.sweepSeenList ?? ""}`,
        `sweep_drawn=${r.sweepDrawnList ?? ""}`,
        `sweep_cov_mean=${fmt(r.sweepCoveredMean, 1)}`,
        `sweep_cov_min=${fmt(r.sweepCoveredMin, 1)}`,
        `sweep_cov_max=${fmt(r.sweepCoveredMax, 1)}`,
        `sweep_seen_mean=${fmt(r.sweepSeenMean, 1)}`,
        `sweep_seen_min=${fmt(r.sweepSeenMin, 1)}`,
        `sweep_seen_max=${fmt(r.sweepSeenMax, 1)}`,
        `sweep_drawn_min=${fmt(r.sweepDrawnMin, 0)}`,
        `sweep_drawn_max=${fmt(r.sweepDrawnMax, 0)}`,
        // 1 = 各姿态提交的实例数完全相同（= "要画的高斯点数不随视角变"）
        `sweep_drawn_const=${r.sweepDrawnMin !== undefined && r.sweepDrawnMin === r.sweepDrawnMax ? 1 : 0}`,
    ];
}
/**
 * 逐轮行的**排序滞后核对标签**（本文臂专用探针 `?sortlag=1`；基线臂没有这个探针时返回空数组）。
 *
 * 读法（决定 §7.9 那句"权衡"怎么写）：
 *   - `sortlag_cadence_med/max`：排序**完成**节奏（帧）——"平均每几帧才更新一次深度序"；
 *   - `sortlag_lag_med/max` + `sortlag_hot=帧@滞后帧/滞后角`：逐帧"正在用的深度序落后于当前视角"
 *     多少（本文臂按"完成一次排序"推断；滞后角 = 该帧视角与深度序对应视角之差，deg）；
 *   - `sortlag_ref=pct8:x%/max:y`：**相邻两帧都用新鲜序**时的画面差异 = "正常帧间变化"的基准线。
 *     判断伪影可见性的正确参照物就是这个数：陈旧序造成的差异若远小于它，视觉上不可能看出来；
 *   - `sortlag_diff=pct8:L1/L2/L4/L8%`：把头一帧的深度序**人为滞后 L 帧**后与新鲜序的画面差异
 *     （同一姿态、同一内容，唯一变量是深度序）→ 给出"滞后多少帧才会看出来"的敏感度曲线；
 *   - `sortlag_diff_max=` 同上但取最大通道差（0..255）。
 * 逐帧滞后列表 `sortlag_lag_list=` 与截图（`?sortlag=shot`）见 bench-measure.sortLagProbe。
 */
export function sortLagRoundTags(r: {
    sortLagOn?: boolean;
    sortLagFrames?: number;
    sortLagCadenceMed?: number;
    sortLagCadenceMax?: number;
    sortLagLagMed?: number;
    sortLagLagMax?: number;
    sortLagHotFrame?: number;
    sortLagHotLag?: number;
    sortLagHotDeg?: number;
    sortLagPipeFrames?: number;
    sortLagWorkerMs?: number;
    sortLagLatencyMs?: number;
    sortLagRealLag?: number;
    sortLagLagList?: string;
    sortLagRefPct8?: number;
    sortLagRefMax?: number;
    sortLagDiff8x1?: number;
    sortLagDiff8x2?: number;
    sortLagDiff8x4?: number;
    sortLagDiff8x8?: number;
    sortLagDiff8Real?: number;
    sortLagDiffMax1?: number;
    sortLagDiffMax2?: number;
    sortLagDiffMax4?: number;
    sortLagDiffMax8?: number;
    sortLagDiffMaxReal?: number;
    sortLagShotA1?: string;
    sortLagShotB1?: string;
    sortLagShotD1?: string;
    sortLagShotAR?: string;
    sortLagShotBR?: string;
    sortLagShotDR?: string;
    sortLagNote?: string;
}): string[] {
    if (!r.sortLagOn) return [];
    const n = (v: number | undefined, digits = 2): string => fmt(v, digits);
    const tags = [
        `sortlag_frames=${r.sortLagFrames ?? "-"}`,
        `sortlag_cadence_med=${n(r.sortLagCadenceMed)}`,
        `sortlag_cadence_max=${r.sortLagCadenceMax ?? "-"}`,
        `sortlag_lag_med=${n(r.sortLagLagMed)}`,
        `sortlag_lag_max=${r.sortLagLagMax ?? "-"}`,
        `sortlag_hot=${r.sortLagHotFrame ?? "-"}@${r.sortLagHotLag ?? "-"}f/${n(r.sortLagHotDeg)}deg`,
        // worker 单次排序耗时（折算成帧）与"真实滞后档"：滞后 = 完成节奏 + 排序耗时本身
        `sortlag_pipe=${r.sortLagPipeFrames === undefined ? "-" : n(r.sortLagPipeFrames)}f`,
        `sortlag_worker=${fmt(r.sortLagWorkerMs, 2)}ms`,
        `sortlag_latency=${fmt(r.sortLagLatencyMs, 2)}ms`,
        `sortlag_real=${r.sortLagRealLag ?? "-"}f`,
        // 参考线：**相邻两帧都用新鲜序**时的差异 = 正常帧间变化有多大（判断伪影可见性的分母）
        `sortlag_ref=pct8:${fmt(r.sortLagRefPct8, 3)}%/max:${fmt(r.sortLagRefMax, 0)}`,
        // 敏感度曲线（滞后 1/2/4/8 帧）与真实档
        `sortlag_diff=pct8:${fmt(r.sortLagDiff8x1, 3)}/${fmt(r.sortLagDiff8x2, 3)}/${fmt(r.sortLagDiff8x4, 3)}/${fmt(r.sortLagDiff8x8, 3)}%`,
        `sortlag_diff_real=pct8:${fmt(r.sortLagDiff8Real, 3)}%`,
        `sortlag_diff_max=${fmt(r.sortLagDiffMax1, 0)}/${fmt(r.sortLagDiffMax2, 0)}/${fmt(r.sortLagDiffMax4, 0)}/${fmt(r.sortLagDiffMax8, 0)}`,
        `sortlag_diff_max_real=${fmt(r.sortLagDiffMaxReal, 0)}`,
    ];
    if (r.sortLagLagList) tags.push(`sortlag_lag_list=${r.sortLagLagList}`);
    // 截图（base64）只在探针带了 `?sortlag=shot` 时存在：字符串很长，会明显撑大结果文本，
    // 因此不进"数值一栏"，而是单独的 `sortlag_shot_*=` 字段（由 out/spin_shot.py 解成 JPEG）。
    if (r.sortLagShotA1) tags.push(`sortlag_shot_a1=${r.sortLagShotA1}`);
    if (r.sortLagShotB1) tags.push(`sortlag_shot_b1=${r.sortLagShotB1}`);
    if (r.sortLagShotD1) tags.push(`sortlag_shot_d1=${r.sortLagShotD1}`);
    if (r.sortLagShotAR) tags.push(`sortlag_shot_ar=${r.sortLagShotAR}`);
    if (r.sortLagShotBR) tags.push(`sortlag_shot_br=${r.sortLagShotBR}`);
    if (r.sortLagShotDR) tags.push(`sortlag_shot_dr=${r.sortLagShotDR}`);
    if (r.sortLagNote) tags.push(`sortlag_note=${r.sortLagNote.replace(/\s+/g, "_")}`);
    return tags;
}

/**
 * 绕世界 Y 轴（竖直轴）过 `pivot` 旋转 `deg` 度的世界变换 B（列主序 4×4，与视图矩阵同布局）：
 * `B = T(pivot) · R_y(deg) · T(-pivot)`。**只转点、不改缩放**，所以它是刚体变换，`B⁻¹ = B(-deg)`。
 */
export function spinYawMatrix(deg: number, pivot: [number, number, number]): number[] {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const [px, py, pz] = pivot;
    // 列主序：第 i 列 = [i*4 .. i*4+3]；线性部分 R_y 的三列为 (c,0,-s) / (0,1,0) / (s,0,c)
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, px - c * px - s * pz, py - py, pz + s * px - c * pz, 1];
}
/** 列主序 4×4 相乘（`mulMat4(a, b)` 语义 = 先作用 b、再作用 a），与 gsplat.js 视图矩阵同布局。 */
export function mulMat4(a: number[], b: number[]): number[] {
    const out = new Array<number>(16).fill(0);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
            out[col * 4 + row] = sum;
        }
    }
    return out;
}
/**
 * 基准视图矩阵 `view16`（世界→视图，列主序）对应的相机绕竖直轴转过 `deg` 后的**新视图矩阵**。
 *
 * 相机世界变换 W 被 B 变换成 B·W，于是视图矩阵 V = W⁻¹ 变成 V·B⁻¹（`B⁻¹ = B(-deg)`）。
 * 两条臂都用这一个函数定义"第 N 帧应该看到的视图"：基线臂把它注入渲染器，本文臂用它把
 * "位置+四元数"算出的实际视图矩阵**逐元素对账**（见 `spin_err`）。
 */
export function orbitViewMatrix(view16: number[], deg: number, pivot: [number, number, number]): number[] {
    return mulMat4([...view16], spinYawMatrix(-deg, pivot));
}
/**
 * 从视图矩阵（世界→视图，列主序）反解**相机世界位置**：`V = [Rᵀ | t]`（`R` = 相机→世界的旋转），
 * 于是 `t = -Rᵀ·p` ⇒ `p = -R·t`。而 `V` 的旋转块存的正是 `Rᵀ`，`R` 的第 i 行 = `Rᵀ` 的第 i **列**，
 * 在列主序里就是 `V[i]`, `V[4+i]`, `V[8+i]` 这一**组列元素**——等价于"把 `V` 的旋转块按**行**取，
 * 再与 `t` 点乘取负"（`V` 的列主序行 i = `V[i]`,`V[4+i]`,`V[8+i]` 恰好是 `Rᵀ` 的第 i 行）。
 *
 * 用于基线臂在没给 `?pivot=` 时取"绕相机自身位置原地转"的轴心，与本文臂的 `cam` 回退同一含义；
 * 也用于内容量扫描报出**逐姿态相机世界位置**（`sweep_pos=`）。单测 `bench-shared.spin.test.ts` 用
 * "含旋转的世界矩阵取逆 → 反解"两个用例把这个行/列约定钉住（2026-09-17：曾误判此处有 bug 并"修"错一版，
 * 正是单测把误判拦下来的——留此注记以免后人再动它）。
 */
export function viewCameraPosition(view16: number[]): [number, number, number] {
    const tx = view16[12];
    const ty = view16[13];
    const tz = view16[14];
    return [
        -(view16[0] * tx + view16[1] * ty + view16[2] * tz),
        -(view16[4] * tx + view16[5] * ty + view16[6] * tz),
        -(view16[8] * tx + view16[9] * ty + view16[10] * tz),
    ];
}
/** 绕世界 Y 轴转 `deg` 度的旋转四元数 (x, y, z, w)（与 gsplat.js `SPLAT.Quaternion` 同序）。 */
export function spinQuatDeg(deg: number): [number, number, number, number] {
    const half = (deg * Math.PI) / 180 / 2;
    return [0, Math.sin(half), 0, Math.cos(half)];
}
/** 四元数 Hamilton 积 `a ⊗ b`（(x,y,z,w) 序；`a ⊗ b` = 先作用 b、再作用 a），单位四元数即刚体旋转。 */
export function mulQuat(
    a: [number, number, number, number],
    b: [number, number, number, number],
): [number, number, number, number] {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}
/**
 * 与 `orbitViewMatrix` **等价的位姿形式**：相机绕竖直轴（过 `pivot`）转 `deg` 度后的
 * `位置 + 四元数`。本文臂的相机是"位置+姿态"模型（`CameraData.update` 由它算视图矩阵），
 * 所以它用本函数驱动、再用 `orbitViewMatrix` 对账；两臂因此共享**同一条**相机轨迹。
 */
export function spinPose(
    p0: [number, number, number],
    q0: [number, number, number, number],
    deg: number,
    pivot: [number, number, number],
): { position: [number, number, number]; quaternion: [number, number, number, number] } {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const dx = p0[0] - pivot[0];
    const dy = p0[1] - pivot[1];
    const dz = p0[2] - pivot[2];
    return {
        // 位置绕轴公转（R_y(deg)·d + pivot）
        position: [pivot[0] + c * dx + s * dz, pivot[1] + dy, pivot[2] - s * dx + c * dz],
        // 姿态左乘世界系 yaw（先转本体、再叠加世界旋转）
        quaternion: mulQuat(spinQuatDeg(deg), q0),
    };
}
/** 两个"矩阵/数组"逐元素最大绝对差（对账用：长度不等返回 Infinity）。 */
export function maxMatrixDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
    if (a.length !== b.length) return Infinity;
    let max = 0;
    for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > max) max = d;
    }
    return max;
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
    /** 动态相机（`?spin=`）：每帧绕竖直轴转的角度（deg/帧；0/缺省 = 静止协议） */
    spinDeg?: number;
    /** 动态相机的旋转轴心（`x,y,z`）或来源标记（`cam` = 绕相机自身位置原地转） */
    spinPivot?: string;
    /** 该臂实际视图 vs 共享实现目标视图的最大元素偏差（跨臂轨迹一致性自查） */
    spinErr?: number;
    /** 动态相机的异常/说明（如"未取到初始视图，已退回静止"），正常时缺省不打印 */
    spinNote?: string;
    /** 测帧窗口内完成排序的次数（效度自查：静止协议下两臂都只排 1 次；相机一动就每帧都排） */
    sortResults?: number;
    /** 动态相机的轨迹模式（`rate` = 匀速转 | `swing` = ±摆幅内往复摆动）及其峰值角速度（deg/帧）：
     *  `spin=` 的语义由它们决定（`swing` 下 `spin=` 是摆幅而不是 deg/帧）。 */
    spinMode?: string;
    spinPeriod?: number;
    spinPeakDeg?: number;
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
        // 动态相机（2026-09-17 追加，效度自查用；语义与两档取法见 bench-shared 顶部"动态相机挡位"）：
        //   spin=0（缺省）＝原有静止协议：两臂的排序 worker 都会"视角没变就不重排"，
        //   因此静止协议只能给出**下界**方向上的比较，不能代表交互场景。
        //   spin=deg/帧 > 0 时，本行给出该轮**实际应用**的转动速度、轴心与轨迹对账误差。
        // 轨迹模式（2026-09-17 追加）：`rate` 下 `spin=` 是 deg/帧；`swing` 下 `spin=` 是**摆幅**（±deg），
        // `spin_peak=` 是它的峰值角速度（= 摆幅 × 2π / `spin_period`），`spin_period=` 是往返周期（帧）。
        // 为什么要加 swing：`rate` 一路往一个方向转，转到某个角度时画面内容可能变少，"fps 不掉"就有
        // 第二种解释（要画的东西少了）；`swing` 让相机在基准机位附近往复，整段窗口看着同一片内容。
        // 逐姿态的实测内容量写进逐轮行 `sweep_cov=` / `sweep_seen=` / `sweep_drawn=`（见 clipInsideRatio）。
        `spin_def=${v.spinMode === "swing" ? "amplitude_deg_of_sine_swing_about_base_view" : "deg_per_frame_about_vertical_axis_through_pivot"}`,
        `spin=${fmt(v.spinDeg ?? 0, 3)}`,
        `spin_mode=${v.spinMode ?? "rate"}`,
        `spin_period=${v.spinPeriod === undefined ? "-" : String(v.spinPeriod)}`,
        `spin_peak=${v.spinPeakDeg === undefined ? "-" : fmt(v.spinPeakDeg, 3)}`,
        `spin_pivot=${v.spinPivot ?? "-"}`,
        `spin_err=${v.spinErr === undefined ? "-" : v.spinErr.toExponential(1)}`,
        // 测帧窗口内**完成排序**的次数（两臂同名字段）：静止协议下两臂的 sort worker 都"视角没变就不重排"，
        // 于是两边都只排 1 次 —— 这就是"静止协议下两臂都省掉了每帧排序"的直接证据；
        // 开 `?spin=` 后本文臂每帧都排（值级判定），基线要越过它的 8.1° 阈值才排（见 bench-shared 顶部）。
        `sort_results=${v.sortResults ?? "-"}`,
    ].concat(v.spinNote ? [`spin_note=${v.spinNote.replace(/\s+/g, "_")}`] : []);
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
    /** 动态相机（`?spin=`）实际应用的转动速度（deg/帧；0/缺省 = 静止协议，`pose=` 即全程机位）。
     *  >0 时 `pose=` 只代表**起始**机位（第 0 帧），机位随帧号线性转动。 */
    spinDeg?: number;
    /** 动态相机的旋转轴心（`x,y,z`）或来源标记：`cam` = 绕相机自身位置原地转（载荷会变，慎用） */
    spinPivot?: string;
    /** 轴心来源：`param`（URL `?pivot=`）| `cam`（相机位置回退） */
    spinPivotSrc?: string;
    /** 模型包围盒中心（世界坐标，`x,y,z`）：物体型场景要改成"绕模型公转"时，把它抄进 `?pivot=` */
    sceneCenter?: string;
    /** 该臂实际视图矩阵 vs 共享实现（`bench-shared.orbitViewMatrix`）目标视图矩阵的最大元素偏差：
     *  这是"两臂转的是同一条轨迹"的**自查证据**（本文臂 ≤1e-5；基线受 END 的 1e-3 舍入限制 ≤2e-3）。 */
    spinErr?: number;
    /** 动态相机的异常/说明（如"未取到初始视图，已退回静止协议"）；正常时缺省。 */
    spinNote?: string;
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
    /** 本轮测帧窗口内**完成排序**的次数（诊断/效度自查）：静止协议下两臂的 sort worker 都会
     *  "视角没变就不重排"，于是整轮只排 1 次；相机一动就每帧都排。两臂同名字段，可直接对照。 */
    sortResults?: number;
    /** 动态相机的轨迹模式（`rate` = 匀速转 | `swing` = 在 ±摆幅内往复摆动）与峰值角速度（deg/帧）。
     *  `swing` 的意义：让相机在整段窗口内始终看着与静止轮**同一片**内容（见 bench-shared 顶部说明）。 */
    spinMode?: string;
    spinPeriod?: number;
    spinPeakDeg?: number;
    /** 内容量扫描（`?sweep=<k>`）：`sweepK` = 采样姿态数；逐姿态值以逗号分隔，姿态位置以 `|` 分隔。
     *  用途：直接证明"两臂在整条轨迹上做的是等量工作"——若某臂画面变空，`sweepCovered`/`sweepSeen`
     *  会同步塌下去，该轮的 fps 就不能用来证明"排序高效"（要画的内容本身就少了）。 */
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

    /** 点集包围盒（**世界坐标**，`x,y,z`）与该臂**实测的**包围盒对角线长度（世界单位）。
     *  用途：把"两臂基准机位相差 0.039 单位"这类偏差换算成**相对场景尺度的比例**
     *  （`offset / sceneDiag`），而不是只有一句"真实几何、不是 bug"。两臂各自算自己点集的包围盒。 */
    sceneMin?: string;
    sceneMax?: string;
    sceneDiag?: number;

    /** **排序滞后核对**（`?sortlag=1`，本文臂；见 bench-measure.sortLagProbe）：把"动态视角下深度排序
     *  更新频率低于逐帧"这件事量化，并给出**陈旧序 vs 新鲜序**在同一姿态下的画面差异与截图。
     *  为什么要有它：`sort_results=` 只能说明"省了多少次排序"，说不出"省掉的那些排序有没有让画面出错"，
     *  而 Gaussian Splatting 的半透明混合依赖深度序，后者才是这个优势的代价。 */
    sortLagOn?: boolean;
    /** 分析的帧数（= 测帧窗口长度） */
    sortLagFrames?: number;
    /** 排序**完成**节奏：相邻两次完成之间的帧数（中位/最大）——"平均每几帧才更新一次深度序" */
    sortLagCadenceMed?: number;
    sortLagCadenceMax?: number;
    /** 逐帧"深度序滞后帧数"的分布（本文臂；基线臂没有这个探针，字段缺省） */
    sortLagLagMed?: number;
    sortLagLagMax?: number;
    /** 滞后最严重一帧：帧号 / 滞后帧数 / 滞后角（deg，= 该帧视角与"深度序对应的视角"之差） */
    sortLagHotFrame?: number;
    sortLagHotLag?: number;
    sortLagHotDeg?: number;
    /** worker 完成一次排序需要几帧（实测排序耗时 ÷ 帧间隔）——排序耗时本身就是滞后的一部分 */
    sortLagPipeFrames?: number;
    /** worker **自报**的单次排序耗时（ms；渲染器内部 `perf` 采样的 `sort.worker.ms` 均值） */
    sortLagWorkerMs?: number;
    /** "投喂 viewProj → 收到新深度序"的延迟（ms；`sort.latency.ms`）：比 worker 耗时多一层消息往返 */
    sortLagLatencyMs?: number;
    /** **真实滞后档 R** = 最差帧的滞后帧数 + worker 单次排序耗时（折算成帧）：这是"该帧真正拿旧序
     *  在渲染"的帧数估计；截图 `sortLagShot*R` 与 `sortLagDiff8Real` 就取这一档（本轮结论档）。 */
    sortLagRealLag?: number;
    /** 逐帧滞后帧数（逗号分隔，便于报表侧算分布；300 帧 ≈ 1KB 文本） */
    sortLagLagList?: string;
    /** 参考量：相邻两帧**都用新鲜序**时的画面差异（"正常帧间变化"有多大，用于判断伪影是否可见） */
    sortLagRefPct8?: number;
    sortLagRefMax?: number;
    /** 陈旧序 × L 帧 vs 新鲜序的画面差异（同一姿态、同一内容，只有深度序不同）：
     *  `pct8` = 差异 > 8/255 的像素占比 %，`max` = 最大通道差（0..255）。
     *  L = 1/2/4/8 是**敏感度曲线**（滞后多少帧才看出来）；`Real` = 实测真实滞后档（见 sortLagRealLag）。 */
    sortLagDiff8x1?: number;
    sortLagDiff8x2?: number;
    sortLagDiff8x4?: number;
    sortLagDiff8x8?: number;
    sortLagDiff8Real?: number;
    sortLagDiffMax1?: number;
    sortLagDiffMax2?: number;
    sortLagDiffMax4?: number;
    sortLagDiffMax8?: number;
    sortLagDiffMaxReal?: number;
    /** 截图（PNG base64，`data:image/jpeg;base64,…`）：A = 陈旧序、B = 新鲜序、D = 差异热图（×8）。
     *  只留两档：`1` = 滞后 1 帧（下限）与 `R` = 真实滞后档（本轮结论档），供人工核对"是否肉眼可见"。 */
    sortLagShotA1?: string;
    sortLagShotB1?: string;
    sortLagShotD1?: string;
    sortLagShotAR?: string;
    sortLagShotBR?: string;
    sortLagShotDR?: string;
    /** 探针说明（例如"参考帧对在窗口中部、相机角速度峰值 X deg/帧"） */
    sortLagNote?: string;

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

/* ------------------------------------------------------------------ 结果字段登记表（**唯一声明处**）

   **为什么必须只有一处**：2026-09-16 ~ 09-17 连续踩了四次**同一个坑**——新字段在子页面
   （bench-measure.ts）已经写进结果，父页面（bench.ts）却把它丢掉（静默丢弃，不报错）：
     1) `fpsCapped` 丢 → 逐轮 `fps_capped=0` 恒假（"帧率贴驱动地板"的轮次被误读成渲染差异）；
     2) `validateFramesUsed` / `visibilityInsidePct` / `timeline` 丢 → diag 报告里没有存活探针证据；
     3) `frameMs` / `frameMeanMs` 丢 → `frame_ms=` 恒为空；
     4) `spinMode` / `spinPeriod` / `spinPeakDeg` / `sweep*` 丢 → `spin_mode=` 恒印 `rate`、`sweep_*=`
        一个都不出现（一整批验证白做）。
   根因是"白名单在一处、收尾逐字段拷贝在另一处"，两处靠手工同步。现在改成：
     - 字段**只登记在下面三张表**里；
     - `sanitizeRoundResult()` 与 `copyRoundResultFields()` **都遍历这三张表** → 结构上不存在"漏拷"；
     - "新增字段忘了登记"由下面的**编译期闸门**兜住（`MissingResultKeys` 必须收敛到 `never`）。
   ⚠️ 新增字段的正确做法：加进 `RoundResult` 接口 → 加进对应的一张表 → 需要打印时加进
   `*RoundTags()`（标签是给人看的，名字不同，只能手写，但**漏打印会立刻看出来**，不像漏拷会静默）。
*/
/** 结果对象的**基本**字段（恒存在，不来自子页面的可选上报）。 */
export const ROUND_RESULT_BASE_KEYS = ["scene", "round", "ts", "ok"] as const;
/** 数值字段（清洗时要求 `number` 且有限） */
export const ROUND_RESULT_NUM_KEYS = [
    "coveredPct",
    "keptPct",
    "points",
    "bytes",
    "fetchMs",
    "parseMs",
    "firstFrameMs",
    "fps",
    "cpuMs",
    "fx",
    "resW",
    "resH",
    "retryCount",
    "disposeMs",
    "iframeCreateMs",
    "ctxCreate",
    "frames",
    "elapsedMs",
    "renders",
    "gapMedMs",
    "gapMinMs",
    "gapMaxMs",
    "warmupMs",
    "syncMs",
    "syncFrames",
    "frameMs",
    "frameMeanMs",
    "timerFloorMs",
    "timerFloorRounds",
    "firstFrameCoveredPct",
    "validateFramesUsed",
    "visibilityInsidePct",
    "spinDeg",
    "spinErr",
    "spinPeriod",
    "spinPeakDeg",
    "sortResults",
    "sweepK",
    "sweepCoveredMean",
    "sweepCoveredMin",
    "sweepCoveredMax",
    "sweepSeenMean",
    "sweepSeenMin",
    "sweepSeenMax",
    "sweepDrawnMin",
    "sweepDrawnMax",
    "sceneDiag",
    "sortLagFrames",
    "sortLagCadenceMed",
    "sortLagCadenceMax",
    "sortLagLagMed",
    "sortLagLagMax",
    "sortLagHotFrame",
    "sortLagHotLag",
    "sortLagHotDeg",
    "sortLagPipeFrames",
    "sortLagWorkerMs",
    "sortLagLatencyMs",
    "sortLagRealLag",
    "sortLagRefPct8",
    "sortLagRefMax",
    "sortLagDiff8x1",
    "sortLagDiff8x2",
    "sortLagDiff8x4",
    "sortLagDiff8x8",
    "sortLagDiff8Real",
    "sortLagDiffMax1",
    "sortLagDiffMax2",
    "sortLagDiffMax4",
    "sortLagDiffMax8",
    "sortLagDiffMaxReal",
] as const satisfies readonly (keyof RoundResult)[];
/** 字符串字段（列表类字段也在这里，逐姿态/逐帧数据用逗号分隔） */
export const ROUND_RESULT_STR_KEYS = [
    "dataset",
    "err",
    "gl",
    "jobId",
    "prevErr",
    "trace",
    "driver",
    "timeline",
    "timerFloorSrc",
    "resMode",
    "poseKey",
    "poseSrc",
    "spinPivot",
    "spinPivotSrc",
    "spinNote",
    "sceneCenter",
    "spinMode",
    "sweepFrames",
    "sweepYaws",
    "sweepPoses",
    "sweepCoveredList",
    "sweepSeenList",
    "sweepDrawnList",
    "sceneMin",
    "sceneMax",
    "sortLagLagList",
    "sortLagShotA1",
    "sortLagShotB1",
    "sortLagShotD1",
    "sortLagShotAR",
    "sortLagShotBR",
    "sortLagShotDR",
    "sortLagNote",
] as const satisfies readonly (keyof RoundResult)[];
/** 布尔字段 */
export const ROUND_RESULT_BOOL_KEYS = [
    "drawOk",
    "contextLost",
    "loseCtx",
    "fpsCapped",
    "sortLagOn",
] as const satisfies readonly (keyof RoundResult)[];
/** 三张表的并集（`copyRoundResultFields` 的遍历对象） */
export type RoundResultFieldKey =
    | (typeof ROUND_RESULT_BASE_KEYS)[number]
    | (typeof ROUND_RESULT_NUM_KEYS)[number]
    | (typeof ROUND_RESULT_STR_KEYS)[number]
    | (typeof ROUND_RESULT_BOOL_KEYS)[number];
export const ROUND_RESULT_FIELD_KEYS: readonly RoundResultFieldKey[] = [
    ...ROUND_RESULT_BASE_KEYS,
    ...ROUND_RESULT_NUM_KEYS,
    ...ROUND_RESULT_STR_KEYS,
    ...ROUND_RESULT_BOOL_KEYS,
];
/**
 * **编译期闸门**（不是运行时检查）：`RoundResult` 里若有字段没登记进上面三张表，
 * `MissingResultKeys` 就不再是 `never`，下面那一行的泛型实参违反约束 `T extends never`
 * → `tsc --noEmit` 直接报错，并**在错误信息里列出缺的字段名**。这就是"第五次漏登记"的拦截点。
 */
export type MissingResultKeys = Exclude<keyof RoundResult, RoundResultFieldKey>;
function assertResultKeysRegistered<T extends never>(): void {
    /* 只做类型检查，运行时无动作 */
}
void assertResultKeysRegistered<MissingResultKeys>();

/**
 * 逐字段取值白名单（**唯一实现**）：`raw` 来自子页面（postMessage），只接受基本类型；
 * Splat / RenderData / ArrayBuffer / TypedArray 之类对象绝不进入结果数组。
 * 未登记字段一律丢弃（登记方法见上面的字段表说明）。
 */
export function sanitizeRoundResult(raw: RoundResult): RoundResult {
    const out: RoundResult = {
        scene: typeof raw.scene === "string" ? raw.scene : "",
        round: typeof raw.round === "number" ? raw.round : 0,
        ts: typeof raw.ts === "string" ? raw.ts : new Date().toISOString(),
        ok: raw.ok === true,
    };
    // 写成 `Record<string, unknown>` 只是为了让"联合键求值"通过 TS 的索引写入检查
    // （联合键的直接写入会被推成 never），运行行为与逐字段赋值完全一致。
    const dst = out as unknown as Record<string, unknown>;
    const src = raw as unknown as Record<string, unknown>;
    for (const key of ROUND_RESULT_NUM_KEYS) {
        const value = src[key];
        if (typeof value === "number" && Number.isFinite(value)) dst[key] = value;
    }
    for (const key of ROUND_RESULT_STR_KEYS) {
        const value = src[key];
        if (typeof value === "string") dst[key] = value;
    }
    for (const key of ROUND_RESULT_BOOL_KEYS) {
        const value = src[key];
        if (typeof value === "boolean") dst[key] = value;
    }
    return out;
}

/**
 * 把已清洗的结果**逐字段**合并进目标对象（**唯一实现**：遍历同一批字段表 → 不可能再出现
 * "白名单里有、收尾拷贝漏了" 这类静默丢弃）。`src` 上缺失（undefined）的字段不覆盖
 * `dst` 的既有缺省值（父页面 `runCaseJob` 建 `out` 时给的一些默认值因此得以保留）。
 */
export function copyRoundResultFields(dst: RoundResult, src: RoundResult): void {
    const to = dst as unknown as Record<string, unknown>;
    const from = src as unknown as Record<string, unknown>;
    for (const key of ROUND_RESULT_FIELD_KEYS) {
        const value = from[key];
        if (value !== undefined) to[key] = value;
    }
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
