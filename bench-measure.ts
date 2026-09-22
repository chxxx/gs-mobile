/**
 * bench-measure.ts — 单轮测量内核（旧 bench.ts 的 `measureRound` 及其依赖，原样搬到这里，口径不变）。
 *
 * 谁在用：
 *   - bench-case.ts（子测试页，静态导入）：一个 iframe 只创建一次本类的实例，测完即释放；
 *   - bench-view.ts（mode=view 展示模式）复用同一份 frameScene / 相机逻辑。
 * 谁**不能**用：
 *   - bench.ts（父调度页）在 mode=bench 下不得导入本文件 —— 该文件 import 了 src/index，
 *     会连带把渲染器/wasm 模块拉进父页面。父页面靠"不导入"来保证 bench 模式下零 WebGL 上下文。
 */
import * as SPLAT from "./src/index";
// [DIAG-EXPERIMENT-1] 本文臂渲染器侧的逐帧分段计时（默认关闭；只在本文件的测帧窗口内成对开关）。
//   与 Flux 臂 `render_shared/main.js` 的 drawTimings 对称：段定义见 RenderProgram.ts 顶部注释。
import {
    clearDiagFrameTimings,
    diagFrameTimings,
    setDiagFrameTimingEnabled,
} from "./src/renderers/webgl/programs/RenderProgram";
// 排序耗时来自渲染器内部的 perf 采样（`sort.worker.ms` / `sort.latency.ms`）：只在排序滞后探针里
// 临时打开（`perf.enableWindowDebug()`），跑完立即关掉，不影响其它任何测量。
import { perf } from "./src/utils/PerfDebug";
import {
    CAM_FLUX,
    PROTO_FLUX,
    applySegTimingFields,
    clipInsideRatio,
    driveThroughputFrames,
    fmt,
    formatTriple,
    maxMatrixDiff,
    median,
    orbitViewMatrix,
    param,
    positionsBounds,
    resolveSpinSpec,
    segTimingRoundTags,
    spinPeakDegPerFrame,
    spinPivotParam,
    spinPose,
    spinSampleFrames,
    spinYawDegAt,
    summarizeSegTiming,
    summarizeSweep,
    sweepSampleCount,
    throughputDriver,
    throughputPercentileRoundTags,
} from "./bench-shared";
import type {
    DriveThroughputStats,
    RoundResult,
    SceneBounds,
    SceneMeta,
    SegTimingStats,
    SpinSpec,
    SweepResult,
    SweepSample,
    ThroughputDriver,
} from "./bench-shared";

/** 动态相机（`?spin=`）在本轮的实际配置：基准位姿 + 旋转参数 + 轨迹对账结果。 */
interface SpinState {
    /** 轨迹的解析结果（模式/摆幅或速度/周期）：两臂唯一的轨迹定义，见 bench-shared.spinYawDegAt */
    spec: SpinSpec;
    /** 每帧绕竖直轴转的角度（deg）；正数 = 俯视顺时针（绕 +Y）。`swing` 模式下它是**摆幅** */
    degPerFrame: number;
    /** 竖直轴经过的世界坐标点 */
    pivot: [number, number, number];
    /** 轴心来源：param（`?pivot=`）| cam（相机自身位置＝原地转头，缺省） */
    pivotSrc: string;
    /** 模型包围盒中心（世界坐标，仅作诊断/复现用：物体型场景想要"绕模型公转"时把 `?pivot=` 设成它） */
    sceneCenter: [number, number, number] | null;
    /** 第 0 帧的相机位置 / 姿态 / 视图矩阵（此后每帧由共享实现算出位姿） */
    p0: [number, number, number];
    q0: [number, number, number, number];
    v0: number[];
    /** 第 1 帧实际视图矩阵 vs `orbitViewMatrix` 目标视图矩阵的最大元素偏差（null = 尚未取到） */
    err: number | null;
    /** 已应用过的帧数（含预热） */
    frames: number;
}

/** Flux-GS 原相机资产（`bench-flux-camera.json`，由 tools/extract_flux_camera.py 抽出）。 */
export interface FluxCameraAsset {
    focal_px: number;
    default_view: { position: number[]; quaternion: number[] };
}

/** 一轮测量需要的、来自父页面 job 的参数。 */
export interface MeasureOptions {
    /** 已带 `ts=` 令牌的模型 URL（cache-busting 与旧口径完全一致） */
    modelUrl: string;
    /** 令牌本身：用于从 Resource Timing 里定位本轮的下载段 */
    token: string;
    resW: number;
    resH: number;
    frames: number;
    warmup: number;
    /** 中止信号：disposeCase() 会 abort 它，取消 fetch/读取与后续解码 */
    signal?: AbortSignal;
    /** 阶段回调（只用于 UI，不参与计时） */
    onPhase?: (phase: "loading" | "sorting" | "measuring") => void;
    /** 时间线打点回调（写日志用，不参与计时） */
    onMark?: (mark: string, detail?: string) => void;
}

/** 测帧驱动方式：取值与默认规则见 `bench-shared.throughputDriver()`（timer = 参考协议；raf = 在屏口径）。 */
export type { ThroughputDriver };

/** 测帧统计：口径字段**直接来自共享驱动**（`bench-shared.driveThroughputFrames`，两臂同一个函数），
 *  外加本臂特有的 `renders`（`frameRender()` 的真实调用次数，用来证明每帧都真的画了）与
 *  `sortResults`（本臂 sort worker **完成排序**的次数，见 `runThroughputFrames` 里的说明）。 */
export type ThroughputStats = DriveThroughputStats & {
    renders: number;
    sortResults?: number;
    /** [DIAG-EXPERIMENT-1] 渲染器侧逐帧分段计时（prep/draw/post）的 p50/p90；见 RenderProgram.ts 顶部 */
    segTiming?: SegTimingStats;
};

function emptyThroughput(driver: ThroughputDriver, note: string): ThroughputStats {
    return {
        driver,
        frames: 0,
        rendered: 0,
        renders: 0,
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
        // [DIAG-EXPERIMENT-1] 与 DriveThroughputStats 同批样本的分位数（空结果一律 0）
        frameMsP50: 0,
        frameMsP90: 0,
        syncMsP50: 0,
        syncMsP90: 0,
        warmupMs: 0,
        timerFloorMs: 0,
        timerFloorRounds: 0,
        timerFloorSrc: "-",
        fpsCapped: false,
        aborted: true,
        note,
    };
}

/** readPixels 得到的一帧像素（RGBA8，行序自下而上，与 GL 一致）。 */
interface RGBAFrame {
    w: number;
    h: number;
    px: Uint8Array;
}

/**
 * 两帧像素差异统计（**同一姿态、只有深度序不同**时用它比较"陈旧序 vs 新鲜序"）：
 *   - `pct8` / `pct32`：通道差 > 8/255 与 > 32/255 的像素占比 %（基数是"两帧里任一被高斯覆盖"的像素，
 *     8/255 是人类在平坦区域能察觉的量级，32/255 是明显不同）；
 *   - `max` / `mean`：通道差的最大值 / 均值（0..255）；
 *   - `box`：差异显著（>32）像素的包围盒（用于把截图裁到"差异发生的地方"，而不是缩略图看不清）。
 */
function diffRGBA(
    a: RGBAFrame,
    b: RGBAFrame,
): {
    pct8: number;
    pct32: number;
    max: number;
    mean: number;
    covered: number;
    box: { x0: number; y0: number; x1: number; y1: number };
} {
    const n = Math.min(a.px.length, b.px.length);
    let covered = 0;
    let hit8 = 0;
    let hit32 = 0;
    let max = 0;
    let sum = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const w = a.w;
    for (let i = 0; i < n; i += 4) {
        if (a.px[i + 3] === 0 && b.px[i + 3] === 0) continue;
        covered++;
        const d = Math.max(
            Math.abs(a.px[i] - b.px[i]),
            Math.abs(a.px[i + 1] - b.px[i + 1]),
            Math.abs(a.px[i + 2] - b.px[i + 2]),
        );
        sum += d;
        if (d > max) max = d;
        if (d > 8) hit8++;
        if (d > 32) {
            hit32++;
            const p = i / 4;
            const x = p % w;
            const y = Math.floor(p / w);
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
        }
    }
    return {
        pct8: covered > 0 ? (hit8 / covered) * 100 : 0,
        pct32: covered > 0 ? (hit32 / covered) * 100 : 0,
        max,
        mean: covered > 0 ? sum / covered : 0,
        covered,
        box: { x0, y0, x1, y1 },
    };
}

/** 差异热图 / 裁剪块的编码尺寸（像素）：够看清细节，又是 JPEG 可压的小块（结果文本要放得下）。 */
const SHOT_BOX = { w: 480, h: 320 };

/**
 * 把一块裁剪区域编码成 JPEG data URL（`data:image/jpeg;base64,…`）。
 * `mode`：
 *   - `raw`：直接给像素（用于"陈旧序/新鲜序"两张对照图）；
 *   - `diff8`：把两帧的通道差放大 8 倍当亮度（`min(255, 8·|Δ|)`，全黑 = 完全一致）→ 差异位置一眼可见。
 * 注意 readPixels 的行序自下而上（GL 约定），这里统一翻转成自下而上的正向图。
 */
function encodeCrop(src: RGBAFrame, box: { x: number; y: number; w: number; h: number }, b: RGBAFrame | null): string {
    const cw = Math.max(1, Math.min(box.w, src.w - box.x));
    const ch = Math.max(1, Math.min(box.h, src.h - box.y));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const g = canvas.getContext("2d");
    if (!g) return "";
    const img = g.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) {
        const sy = src.h - 1 - (box.y + y);
        for (let x = 0; x < cw; x++) {
            const si = (sy * src.w + box.x + x) * 4;
            const di = (y * cw + x) * 4;
            if (b) {
                const d = Math.max(
                    Math.abs(src.px[si] - b.px[si]),
                    Math.abs(src.px[si + 1] - b.px[si + 1]),
                    Math.abs(src.px[si + 2] - b.px[si + 2]),
                );
                const v = Math.min(255, d * 8);
                img.data[di] = v;
                img.data[di + 1] = v;
                img.data[di + 2] = v;
            } else {
                img.data[di] = src.px[si];
                img.data[di + 1] = src.px[si + 1];
                img.data[di + 2] = src.px[si + 2];
            }
            img.data[di + 3] = 255;
        }
    }
    g.putImageData(img, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.92);
}

/**
 * 一个测量会话持有的全部对象：canvas / renderer / scene / camera / controls。
 * 生命周期由调用方控制：`createRenderer()` → `measureOneRound()` → `dispose()`。
 * `dispose()` 幂等；一旦 `dispose()` 被调用（或 `stopped` 置位），后续渲染/写场景的动作全部空转。
 */
export class BenchCase {
    readonly canvas: HTMLCanvasElement;
    readonly scene: SPLAT.Scene;
    readonly camera: SPLAT.Camera;
    renderer: SPLAT.WebGLRenderer | null = null;
    controls: SPLAT.OrbitControls | null = null;
    /** `cam=flux`：机位由显式注入指定，frameRender 不再让 OrbitControls 覆写相机 */
    cameraLocked = false;
    /** 置位后不再渲染、不再写 scene（清理/取消后防止迟到的异步续体污染场景） */
    stopped = false;
    /** 是否已经对上下文调用过 `WEBGL_lose_context.loseContext()`（幂等 + 供子页面日志说明） */
    loseContextCalled = false;
    /** `frameRender()` 的累计调用次数（诊断：用来证明"测帧区间里确实发生了 N 次 render"） */
    renderCalls = 0;

    private _fluxCamera: FluxCameraAsset | null = null;
    /** 动态相机（`?spin=`）本轮配置；null = 静止协议（历史口径，机位全程不变） */
    private _spin: SpinState | null = null;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.scene = new SPLAT.Scene();
        this.camera = new SPLAT.Camera();
    }

    /**
     * 创建渲染器（WebGL2 上下文）。失败会抛错，由调用方决定是否换 canvas 重试。
     *
     * `fadeIn` 由调用方**显式**声明（不给默认值），这是跨臂公平性的一部分：
     *   - `false` —— bench 测量路径（`bench-case.ts`）：显式传**空数组**，于是**不挂 FadeInPass**。
     *     渲染器默认行为是"不传 pass 就自动挂 FadeInPass"（每帧 `depthFade += 0.01`，约 100 帧才完全不透明），
     *     那会让测帧窗口前 ~100 帧的填充负载与常帧**不同构**；基线 Flux-GS 没有这种档位，
     *     所以两臂必须架构对等——不能依赖"设备恰好贴着计时地板"这个前提（已在桌面 A/B 验证过，
     *     但换一台不贴地板的手机就可能重新变成真实优势）。结果头写 `fade=none` 记录该配置。
     *   - `true` —— 展示路径（`bench.html?mode=view` 的 BenchView）：保留淡入观感，产品特性不受影响。
     */
    createRenderer(fadeIn: boolean): SPLAT.WebGLRenderer {
        this.renderer = new SPLAT.WebGLRenderer(this.canvas, fadeIn ? null : []);
        return this.renderer;
    }

    ensureControls(): SPLAT.OrbitControls {
        if (!this.controls) this.controls = new SPLAT.OrbitControls(this.camera, this.canvas);
        return this.controls;
    }

    /** 载入模型（PLY/QPLY/low-rank QPLY 由 PLYLoader 自行判定），Splat 会被加进本会话的 scene。
     *  传入 `signal` 可在 dispose 时取消下载/读取（PLYLoader 会在中止后抛 AbortError）。 */
    loadSplat(url: string, signal?: AbortSignal): Promise<SPLAT.Splat> {
        return SPLAT.PLYLoader.LoadAsync(url, this.scene, undefined, "", false, signal);
    }

    /** 测帧分辨率：关掉自动 resize + 像素比 1 + 固定 W×H（与旧口径一致）。 */
    setBenchmarkResolution(w: number, h: number): void {
        const renderer = this.renderer;
        if (!renderer) return;
        renderer.disableAutoResize();
        renderer.setPixelRatio(1);
        renderer.setSize(w, h);
    }

    frameRender(): void {
        if (this.stopped) return;
        if (this.controls && !this.cameraLocked) this.controls.update();
        this.renderCalls++;
        this.renderer?.render(this.scene, this.camera);
    }

    /**
     * 模型包围盒中心（**世界坐标**）＝动态相机的缺省轴心：绕经过它的竖直轴转弯时，视线始终朝向模型中心，
     * 因此画面里的内容量基本不变（原地转头会把模型转出去，那测出来的"变快"是负载变小，不是性能好）。
     *
     * ⚠️ `splat.data.positions` 是**局部坐标**：shader 里合成的是 `viewProj * transform * position`
     * （`Object3D.transform`，见 `Matrix4.Compose`），所以必须再把局部包围盒中心乘上对象的世界矩阵。
     * 曾经的教训（2026-09-17 首次跑 spin 就撞上）：漏乘这一层时 garden 的轴心从世界原点附近
     * 跑到 `(18.7, 3.4, 26.9)`，相机绕着 39 单位外的点公转 90° 后画面覆盖从 99.8% 掉到 68.6% ——
     * 负载变了，这一轮就不能用。逐轮结果里的 `covered=` 正是用来暴露这种失败的自查字段。
     */
    modelCenter(splat: SPLAT.Splat): [number, number, number] | null {
        try {
            const p = splat.data.positions;
            const n = splat.data.vertexCount;
            if (!p || n <= 0) return null;
            let minX = Infinity;
            let minY = Infinity;
            let minZ = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            let maxZ = -Infinity;
            for (let i = 0; i < n; i++) {
                const x = p[i * 3];
                const y = p[i * 3 + 1];
                const z = p[i * 3 + 2];
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (z < minZ) minZ = z;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
                if (z > maxZ) maxZ = z;
            }
            if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
            const local: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
            const m = splat.transform?.buffer;
            if (!m || m.length !== 16) return local; // 没有变换信息时退回局部中心（通常是恒等变换）
            // 列主序：out = M · local（平移在 m[12..14]）
            return [
                m[0] * local[0] + m[4] * local[1] + m[8] * local[2] + m[12],
                m[1] * local[0] + m[5] * local[1] + m[9] * local[2] + m[13],
                m[2] * local[0] + m[6] * local[1] + m[10] * local[2] + m[14],
            ];
        } catch {
            return null;
        }
    }

    /**
     * 设置动态相机（`?spin=`）：记下基准位姿与轴心，之后每帧由 `applySpinFrame()` 驱动。
     * **必须在相机就位之后、测帧之前调用**（见 `measureOneRound` 里紧跟 `pose=` 取指纹之后那一处）。
     * `spin=0`（缺省）时本函数什么都不做 —— 静止协议与历史数据逐字不变。
     *
     * 轨迹模式（`?spin_mode=`，见 bench-shared.spinYawDegAt）：
     *   - `rate`（缺省）：绕竖直轴**匀速**转 `spin` deg/帧（历史口径）；
     *   - `swing`：在基准朝向 ±`spin`（摆幅）内按正弦**往复摆动**，周期 `spin_period` 帧（缺省 = 整个窗口）。
     *     **内容量对齐用**：相机位置不动、朝向只在基准机位附近 ±A° 内摆动 → 整段窗口始终看着与静止轮
     *     同一片内容，从构造上排除"转到空白区、要画的东西变少"这一解释（逐姿态的实测内容量见
     *     `contentSweep()` 输出的 `sweep_cov=` / `sweep_seen=`）。
     *
     * 轴心（竖直轴过哪个点）：
     *   - 缺省 = **相机自身位置**（`spin_pivot=cam`）：相机原地转头，视线扫过四周——这就是"用户转动视角"
     *     的直接类比，对 **360 采集场景**（mip360 的 garden/bicycle/…：相机本来就在点云内部）内容量不变；
     *   - `?pivot=x,y,z` = 绕该点**公转**（相机位置与朝向一起绕轴刚性旋转）：物体型场景要配 `swing` 小摆幅
     *     使用，否则会把物体转出画面、测出来的是"负载变小"。模型包围盒中心每轮都会写进 `scene_center=`
     *     （世界坐标）；两臂必须传**同一个** pivot。
     * 内容量是否真的没变，由逐轮 `sweep_*`（逐姿态实测覆盖率/裁剪盒内高斯数）回答，不再靠 `covered=` 猜。
     */
    setupSpin(splat: SPLAT.Splat | null, windowFrames: number): void {
        this._spin = null;
        const spec = resolveSpinSpec(windowFrames);
        if (!spec) return;
        const p = this.camera.position;
        const r = this.camera.rotation;
        const p0: [number, number, number] = [p.x, p.y, p.z];
        const pivotParam = spinPivotParam();
        this._spin = {
            spec,
            degPerFrame: spec.deg,
            pivot: pivotParam ?? p0,
            pivotSrc: pivotParam ? "param" : "cam",
            sceneCenter: splat ? this.modelCenter(splat) : null,
            p0,
            q0: [r.x, r.y, r.z, r.w],
            v0: Array.from(this.camera.data.viewMatrix.buffer),
            err: null,
            frames: 0,
        };
    }

    /**
     * 把相机放到"第 `index` 帧"应有的位姿（含预热帧计数）：yaw 角由**两臂共享**的
     * `bench-shared.spinYawDegAt(spec, index)` 给出（`rate` = 匀速累加；`swing` = ±摆幅正弦往复），
     * 位姿由同样共享的 `spinPose()` 给出；第 1 帧再用 `orbitViewMatrix()`（基线臂实际注入的那条式子）
     * 对账一次，写进 `spin_err=`。
     */
    private applySpinFrame(index: number): void {
        const s = this._spin;
        if (!s) return;
        const deg = spinYawDegAt(s.spec, index);
        const pose = spinPose(s.p0, s.q0, deg, s.pivot);
        this.camera.position = new SPLAT.Vector3(pose.position[0], pose.position[1], pose.position[2]);
        this.camera.rotation = new SPLAT.Quaternion(
            pose.quaternion[0],
            pose.quaternion[1],
            pose.quaternion[2],
            pose.quaternion[3],
        );
        // 渲染器内部（RenderProgram._render）也会 update 相机；这里先 update 一次是为了**取到实际视图矩阵**
        // 做对账，不在测量预算之外做任何改动（update 只是矩阵重建，幂等）。
        this.camera.update();
        s.frames = index + 1;
        if (index === 1) {
            // 只对账一次：既避免每帧分配数组扰动测帧窗口，又刚好覆盖"已经开始转动"的第一帧
            s.err = maxMatrixDiff(this.camera.data.viewMatrix.buffer, orbitViewMatrix(s.v0, deg, s.pivot));
        }
    }

    /** 把相机放回**基准位姿**（第 0 帧的位姿；`spin=0` 时是 no-op）：给测帧后的探针用。
     *  为什么需要它：测帧窗口结束时相机已经转到别处，若不还原，`covered=` 量的是"转完后的那个朝向"
     *  （同一场景不同挡位读数忽高忽低），与静止轮/另一臂**不同义**——2026-09-17 的 `covered` 异常即此因。
     *  还原到基准位姿后，`covered=` 在所有轮次里都表示"基准机位的画面覆盖率"，可与静止轮直接对照。 */
    private restoreBasePose(): void {
        const s = this._spin;
        if (!s) return;
        this.camera.position = new SPLAT.Vector3(s.p0[0], s.p0[1], s.p0[2]);
        this.camera.rotation = new SPLAT.Quaternion(s.q0[0], s.q0[1], s.q0[2], s.q0[3]);
        this.camera.update();
    }

    /** 读一帧像素统计覆盖率（%）：`renderFrame()` + `gl.finish()` + 全幅 readPixels + stride=8 稀疏采样
     *  （`alpha > 0` 即视为被高斯覆盖）。`covered=` 与 `sweep_cov=` 共用这一个量法，口径不可能分叉。 */
    private readCoveragePct(): number {
        const renderer = this.renderer;
        if (!renderer) return 0;
        const gl = renderer.gl as WebGL2RenderingContext;
        const w = renderer.canvas.width || 1;
        const h = renderer.canvas.height || 1;
        this.frameRender();
        try {
            gl.finish(); // 等 GPU 真正画完再读（在计时区间之外）
        } catch {
            /* ignore */
        }
        let covered = 0;
        let samples = 0;
        try {
            const buf = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            const stride = 8;
            for (let y = 0; y < h; y += stride) {
                for (let x = 0; x < w; x += stride) {
                    if (buf[(y * w + x) * 4 + 3] > 0) covered++;
                    samples++;
                }
            }
        } catch {
            /* readPixels 不可用时忽略 */
        }
        return samples > 0 ? (covered / samples) * 100 : 0;
    }

    /** 本轮该臂"提交绘制的实例数"（= 排序索引长度）与该臂点云总点数：
     *  本文臂 `RenderProgram` 每帧 `drawArraysInstanced(..., depthIndex.length)`，**剔除默认关闭**
     *  （`?cull=1` 才开）→ 这个数**不随视角变**；它的用处正是把"要画的点数是否变少"这件事摆到台面上。 */
    private drawnInstances(): number {
        const cull = this.renderer?.renderProgram?.cullStats;
        if (!cull || cull.total <= 0) return 0;
        return cull.keptRatio < 1 ? Math.round(cull.total * cull.keptRatio) : cull.total;
    }

    /**
     * **内容量扫描**（`?sweep=<k>`，动态轮缺省 9 个姿态；静止轮缺省关闭）：沿**本轮同一条轨迹**取 k 个姿态，
     * 逐个姿态记录（写进逐轮 `sweep_*` 字段，两臂同名字段同格式）：
     *   - `sweep_cov`：真实渲染覆盖率 %（readPixels，与 `covered=` 同一个量法）；
     *   - `sweep_seen`：裁剪盒内的高斯点比例 %（`clipInsideRatio`，用**本臂渲染器自己的 viewProj**）；
     *   - `sweep_drawn`：该姿态提交绘制的实例数（不随视角变 = "要画的东西没变少"的直接证据）；
     *   - `sweep_yaw` / `sweep_pos` / `sweep_frm`：逐姿态的轨迹（角度、相机世界位置、帧号）。
     *
     * 这段在**测帧窗口之后**执行，不进任何计时区间；跑完把相机还原到基准位姿，不影响后续读法。
     */
    contentSweep(): SweepResult | null {
        const s = this._spin;
        if (!s) return null;
        const k = sweepSampleCount(true);
        if (k <= 0) return null;
        const samples: SweepSample[] = [];
        for (const frame of spinSampleFrames(s.spec, k)) {
            this.applySpinFrame(frame);
            const coveredPct = this.readCoveragePct();
            const vp = this.camera.data.viewProj.buffer as unknown as ArrayLike<number>;
            let sampled = 0;
            let inside = 0;
            let total = 0;
            for (const object of this.scene.objects) {
                if (!(object instanceof SPLAT.Splat)) continue;
                const p = object.data.positions;
                const n = object.data.vertexCount;
                total += n;
                if (!p || n === 0) continue;
                const r = clipInsideRatio(p, n, vp, 4000);
                sampled += r.sampled;
                inside += r.inside;
            }
            const pos = this.camera.position;
            samples.push({
                frame,
                yaw: Math.round(spinYawDegAt(s.spec, frame) * 100) / 100,
                pos: [pos.x, pos.y, pos.z],
                coveredPct,
                seenPct: sampled > 0 ? (inside / sampled) * 100 : 0,
                seenCount: inside,
                drawn: this.drawnInstances() || total,
            });
        }
        this.restoreBasePose();
        return { samples };
    }

    /**
     * 点集**包围盒**（世界坐标）与对角线长度（写进 `scene_min=` / `scene_max=` / `scene_diag=`）。
     * 与 `modelCenter()` 同一层变换：`splat.data.positions` 是**局部坐标**，必须乘对象世界矩阵；
     * 这里把局部包围盒的 8 个角都变换后再取包围盒（对 AABB 做仿射变换的紧上界）。
     *
     * 为什么要有这个数：两臂的基准机位不完全重合（实测相差 0.039 世界单位），要判断这个偏差
     * 是不是可以忽略，必须拿**场景尺度**当分母（`0.039 / scene_diag`），不能只说"真实几何"。
     */
    sceneBounds(splat: SPLAT.Splat): SceneBounds | null {
        try {
            const p = splat.data.positions;
            const n = splat.data.vertexCount;
            if (!p || n <= 0) return null;
            const local = positionsBounds(p, n);
            if (!local) return null;
            const m = splat.transform?.buffer;
            if (!m || m.length !== 16) return local;
            const flat = new Float32Array(24);
            let k = 0;
            for (const x of [local.min[0], local.max[0]]) {
                for (const y of [local.min[1], local.max[1]]) {
                    for (const z of [local.min[2], local.max[2]]) {
                        flat[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
                        flat[k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
                        flat[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
                        k++;
                    }
                }
            }
            return positionsBounds(flat, 8) ?? local;
        } catch {
            return null;
        }
    }

    /** 本臂 sort worker **已完成排序**的次数（每排完一次回一次消息 → `cullStats.samples`）。 */
    private sortSamples(): number {
        return this.renderer?.renderProgram?.cullStats.samples ?? -1;
    }

    /**
     * 等 worker 把**当前姿态**排完（`samples` 增加即视为完成），返回等待耗时 ms（超时返回 null）。
     * 每次循环都 `frameRender()`：RenderProgram 每帧都会把当前 `viewProj` 发给 worker，
     * 而 worker 只在"收到的 viewProj 与上一次不同"时才置 dirty 重排 —— 所以必须持续喂新姿态。
     *
     * ⚠️ 因此**光调用它是不够的**：若当前姿态恰好与上一次投喂的姿态相同，worker 永远不会重排，
     * 这里会一路等到超时（首版探针就栽在这里：`sortlag_*` 字段全空、时间线上留下 6.2s 空档）。
     * 需要"把当前姿态的深度序刷新到最新"时，请用下面的 `refreshSortOrderAt()`。
     */
    private async waitForSortTick(timeoutMs = 5000): Promise<number | null> {
        const before = this.sortSamples();
        if (before < 0) return null;
        const t0 = performance.now();
        while (performance.now() - t0 < timeoutMs) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            this.frameRender();
            if (this.sortSamples() > before) return performance.now() - t0;
        }
        return null;
    }

    /**
     * 把深度序**确定性地刷新到 `frame` 姿态**：先跳到同一条轨迹上的一个相邻帧（保证 viewProj 变化 →
     * worker 置 dirty 重排），等它排完，再跳回 `frame` 并等它排完。返回第二次等待的耗时（≈ 单次排序耗时）。
     *
     * `avoid` = 上一次投喂过的帧号（相邻帧不能选它，否则又不变化）；`maxFrame` = 允许的帧号上限。
     * 之所以用"同一条轨迹的相邻帧"而不是随便造一个姿态：相邻帧一定产生不同的 viewProj，且不会把
     * 深度序污染成"不属于本轨迹"的东西（第二步会把它纠正回 `frame`）。
     */
    private async refreshSortOrderAt(frame: number, avoid: number, maxFrame: number): Promise<number | null> {
        const neighbour = [frame - 1, frame + 1].find((f) => f >= 0 && f <= maxFrame && f !== frame && f !== avoid);
        if (neighbour !== undefined && neighbour !== frame) {
            this.applySpinFrame(neighbour);
            if ((await this.waitForSortTick()) === null) return null;
        }
        this.applySpinFrame(frame);
        return await this.waitForSortTick();
    }

    /**
     * 渲染一帧并读回全幅像素（`gl.finish()` + `readPixels`，全同步、**不 await**）。
     *
     * 关键性质（A/B 对比的确定性来源）：整个过程在**同一个任务**里完成 → SortWorker 的
     * `onmessage`（排序结果回传）是宏任务，不可能插进来 → 这一帧用的就是**进来之前就已经在
     * 缓冲里的那份深度序**。因此"陈旧序渲染"是可以精确复现的，不靠运气抓时序。
     */
    private captureRGBA(): RGBAFrame | null {
        const renderer = this.renderer;
        if (!renderer) return null;
        const gl = renderer.gl as WebGL2RenderingContext;
        const w = renderer.canvas.width || 1;
        const h = renderer.canvas.height || 1;
        this.frameRender();
        try {
            gl.finish(); // 等 GPU 真正画完（同步返回）
        } catch {
            /* 上下文丢失时忽略 */
        }
        try {
            const px = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            return { w, h, px };
        } catch {
            return null;
        }
    }

    /**
     * **排序滞后核对**（`?sortlag=1`，只跑动态轮；`?sortlag=shot` 时把对照截图一并编码进结果）。
     *
     * 要回答的问题（§7.9 那句"权衡"必须有实测支撑）：动态视角下若深度序更新频率低于逐帧，
     * 画面会不会出现结构性（非随机）的前后关系错误？Gaussian Splatting 的半透明混合依赖深度序
     * （本渲染器 `gl.disable(DEPTH_TEST)` + `blendFuncSeparate(ONE_MINUS_DST_ALPHA, ONE, …)`
     * 即"前到后顺序合成"），顺序写错 → 合成结果必然变化，量级必须实测。
     *
     * 做法（全部在测帧窗口**之外**，不进任何性能指标）：
     *   1) 沿本轮同一条轨迹连续渲染 frames 帧，逐帧记 (帧号, yaw, 已完成排序次数)；
     *   2) 由"排序完成"的帧号序列算出：完成节奏（每几帧更新一次深度序）、逐帧滞后帧数、
     *      单次排序耗时（折算成帧）→ 得到**真实滞后档 R** = 最差帧滞后 + 排序耗时；
     *   3) 在最差帧 f* 上做**确定性 A/B**（同一姿态、同一内容，唯一变量是深度序）：
     *        A（陈旧序）：先把相机放到 f*−L、等 worker 排完（缓冲里即该姿态的深度序），
     *                     再把相机跳到 f* 并在**同一个任务**里渲染+readPixels（排序回传进不来）；
     *        B（新鲜序）：保持 f*，等 worker 排完 f* 的深度序，再渲染+readPixels；
     *      敏感度：L = 1/2/4/8 各测一次（"滞后多少帧才会看出来"）+ 真实档 R；
     *   4) 参考线：相邻两帧（都新鲜序）的差异 = 正常帧间变化有多大（伪影可见性的分母）；
     *   5) `sortlag=shot`：把 L=1 与 L=R 两档的 A/B/差异热图裁成 480×320 JPEG 带回来人工核对。
     */
    async sortLagProbe(splat: SPLAT.Splat, frames: number): Promise<Partial<RoundResult> | null> {
        const s = this._spin;
        const renderer = this.renderer;
        if (!s || !renderer) return null;
        const withShots = param("sortlag", "") === "shot";
        const n = Math.max(2, frames);
        // ---- 1) 用**与测帧窗口同一个驱动**沿同一条轨迹再跑一遍，逐帧记录"已完成排序次数" ----
        // ⚠️ 两个坑都必须在代码里写明：
        //   (a) 必须**逐帧让出事件循环**：SortWorker 的排序回传是**宏任务**，同步 for 循环里 300 帧一次都
        //       收不到（首版探针就是这样：`sorts=0/300`、`frame_ms` 只有 0.09ms → 整段数据无效）；
        //   (b) 必须用**同一个驱动函数**（`bench-shared.driveThroughputFrames`，timer 链 + 逐帧 gl.finish），
        //       否则帧间隔与测帧窗口不同 → 排序完成节奏也不可比。
        // 打开 `perf`（缺省不采样）以便直接读**worker 自报的排序耗时** `sort.worker.ms`：
        // "单次排序要几帧"这个关键量就不再靠墙钟估计，而是 worker 自己的 measurements。
        perf.enableWindowDebug();
        perf.reset();
        const trace: Array<{ frame: number; yaw: number; sorts: number }> = [];
        let spinIndex = 0;
        const glProbe = this.renderer ? (this.renderer.gl as WebGL2RenderingContext) : null;
        const drive = await driveThroughputFrames({
            frames: n,
            warmup: 0,
            driver: throughputDriver(),
            renderFrame: (): number => {
                const frame = spinIndex++;
                this.applySpinFrame(frame);
                this.frameRender();
                trace.push({ frame, yaw: spinYawDegAt(s.spec, frame), sorts: this.sortSamples() });
                if (!glProbe) return 0;
                const tSync = performance.now();
                try {
                    glProbe.finish();
                } catch {
                    return 0;
                }
                return performance.now() - tSync;
            },
            stopped: () => this.stopped,
        });
        const perfRows = perf.summarize(true);
        (window as unknown as { __PERF_DEBUG__?: boolean }).__PERF_DEBUG__ = false;
        if (this.stopped || drive.rendered < n) return null;
        const frameMs = drive.cpuMs; // 与测帧窗口同口径（mean frame interval incl. sync）
        const workerRow = perfRows.find((row) => row.phase === "sort.worker.ms");
        const latencyRow = perfRows.find((row) => row.phase === "sort.latency.ms");
        const workerMs = workerRow && workerRow.count > 0 ? workerRow.avgMs : NaN;
        const latencyMs = latencyRow && latencyRow.count > 0 ? latencyRow.avgMs : NaN;
        const done: number[] = [];
        let prev = trace[0].sorts;
        for (const t of trace) {
            if (t.sorts > prev) done.push(t.frame);
            if (t.sorts !== prev) prev = t.sorts;
        }
        // 逐帧"深度序滞后帧数"：该帧最后一次**完成**排序距今多少帧（此前回退到窗口开始，即基准姿态那一份）
        const lag = trace.map((t) => {
            let last = -1;
            for (const f of done) {
                if (f <= t.frame) last = f;
                else break;
            }
            return last < 0 ? 0 : t.frame - last;
        });
        const deg = trace.map((t, i) => Math.abs(t.yaw - trace[Math.max(0, t.frame - lag[i])].yaw));
        const cadences: number[] = [];
        for (let i = 1; i < done.length; i++) cadences.push(done[i] - done[i - 1]);
        let hot = 0;
        for (let i = 1; i < trace.length; i++) {
            if (deg[i] > deg[hot] || (deg[i] === deg[hot] && lag[i] > lag[hot])) hot = i;
        }
        // ---- 2) worker 单次排序耗时（折算成帧）：换一个姿态，量"喂进去到排完"的墙钟 ----
        // `posted` = 上一次投喂给 worker 的帧号：worker 只在 viewProj 变化时重排，刷新时必须避开它。
        const maxFrame = n - 1;
        let posted = trace[trace.length - 1].frame;
        const refresh = async (frame: number): Promise<number | null> => {
            const ms = await this.refreshSortOrderAt(frame, posted, maxFrame);
            posted = frame; // 该函数结束时投喂/停留的姿态一定是 frame
            return ms;
        };
        const pipeProbeMs = (await refresh(Math.max(0, trace[hot].frame - 1))) ?? NaN;
        // 单次排序占几帧：优先用 **worker 自报**的排序耗时（`sort.worker.ms`，见本次新增的 perf 采样），
        // 退化时才用"投喂→回传"的墙钟等待（后者含 setTimeout(0) 的 ~1–4ms 量化误差）。
        const pipeMs = Number.isFinite(workerMs) ? workerMs : pipeProbeMs;
        const pipeFrames = Number.isFinite(pipeMs) && frameMs > 0 ? pipeMs / frameMs : 0;
        const realLag = Math.max(1, Math.round(lag[hot] + pipeFrames));
        // 到此"滞后"这一半已经量完（完成节奏 / 逐帧滞后 / 单次排序耗时 / 真实档 R）。把它先装起来：
        // A/B 那一半万一失败，仍然要把这一半报出去，并在 `sortlag_note=` 里写明失败原因 ——
        // 探针失败**绝不能**又变成一次"字段静默消失"（首版就是返回 null → 整轮 `sortlag_*` 全空）。
        const lagFields: Partial<RoundResult> = {
            sortLagOn: true,
            sortLagFrames: n,
            sortLagCadenceMed: median(cadences) ?? 0,
            sortLagCadenceMax: cadences.length > 0 ? Math.max(...cadences) : 0,
            sortLagLagMed: median(lag) ?? 0,
            sortLagLagMax: Math.max(...lag),
            sortLagHotFrame: trace[hot].frame,
            sortLagHotLag: lag[hot],
            sortLagHotDeg: deg[hot],
            sortLagLagList: lag.join(","),
            // worker 自报的单次排序耗时（ms；`sort.worker.ms`）与"投喂→回传"延迟（ms；`sort.latency.ms`）
            sortLagWorkerMs: Number.isFinite(workerMs) ? Math.round(workerMs * 100) / 100 : undefined,
            sortLagLatencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs * 100) / 100 : undefined,
        };
        const bail = (reason: string): Partial<RoundResult> => {
            lagFields.sortLagNote = `probe_failed_${reason}__lag-only`;
            this.restoreBasePose();
            return lagFields;
        };
        // ---- 3) 最差帧上的确定性 A/B（L=1/2/4/8 敏感度档 + 真实档 R）----
        const levels = Array.from(new Set([1, 2, 4, 8, realLag]))
            .filter((v) => v >= 1 && v <= 60)
            .sort((a, b) => a - b);
        const stats = new Map<number, { pct8: number; pct32: number; max: number; mean: number }>();
        const keepFrames = new Map<number, { a: RGBAFrame; b: RGBAFrame }>();
        let realBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        let freshHot: RGBAFrame | null = null;
        for (const L of levels) {
            const from = Math.max(0, trace[hot].frame - L);
            // A（陈旧序）：先把深度序确定性地刷成 `from` 姿态的
            if ((await refresh(from)) === null) return bail("refresh_from");
            // 再把相机跳到 f* 并**在同一个任务里**渲染 + readPixels（worker 回传是宏任务，插不进来）
            this.applySpinFrame(trace[hot].frame);
            posted = trace[hot].frame;
            const stale = this.captureRGBA();
            if (!stale) return bail("capture_stale");
            // B（新鲜序）：等 worker 把 f* 姿态自己的深度序排完
            if ((await refresh(trace[hot].frame)) === null) return bail("refresh_fresh");
            const fresh = this.captureRGBA();
            if (!fresh) return bail("capture_fresh");
            const d = diffRGBA(stale, fresh);
            stats.set(L, { pct8: d.pct8, pct32: d.pct32, max: d.max, mean: d.mean });
            if (L === realLag) realBox = d.box;
            if (withShots && (L === 1 || L === realLag)) keepFrames.set(L, { a: stale, b: fresh });
            freshHot = fresh;
            if (this.stopped) return bail("stopped");
        }
        // ---- 4) 参考线：相邻两帧都用**新鲜序**（正常帧间变化有多大）----
        let refPct8 = NaN;
        let refMax = NaN;
        if (freshHot) {
            if ((await refresh(trace[hot].frame + 1)) !== null) {
                const next = this.captureRGBA();
                if (next) {
                    const d = diffRGBA(freshHot, next);
                    refPct8 = d.pct8;
                    refMax = d.max;
                }
            }
        }
        // ---- 5) 截图：裁到"差异真正发生的地方"（没差异时取画面中心）----
        const firstShot = keepFrames.values().next().value as { a: RGBAFrame; b: RGBAFrame } | undefined;
        let box = { x: 0, y: 0, w: 0, h: 0 };
        if (firstShot) {
            const src = firstShot.a;
            box.w = Math.min(SHOT_BOX.w, src.w);
            box.h = Math.min(SHOT_BOX.h, src.h);
            const hasDiff = Number.isFinite(realBox.x0) && Number.isFinite(realBox.x1);
            const cx = hasDiff ? (realBox.x0 + realBox.x1) / 2 : src.w / 2;
            const cy = hasDiff ? (realBox.y0 + realBox.y1) / 2 : src.h / 2;
            box.x = Math.max(0, Math.min(src.w - box.w, Math.round(cx - box.w / 2)));
            box.y = Math.max(0, Math.min(src.h - box.h, Math.round(cy - box.h / 2)));
        }
        const out: Partial<RoundResult> = {
            ...lagFields,
            sortLagPipeFrames: Math.round(pipeFrames * 100) / 100,
            sortLagRealLag: realLag,
            sortLagRefPct8: refPct8,
            sortLagRefMax: refMax,
            sortLagDiff8x1: stats.get(1)?.pct8,
            sortLagDiff8x2: stats.get(2)?.pct8,
            sortLagDiff8x4: stats.get(4)?.pct8,
            sortLagDiff8x8: stats.get(8)?.pct8,
            sortLagDiff8Real: stats.get(realLag)?.pct8,
            sortLagDiffMax1: stats.get(1)?.max,
            sortLagDiffMax2: stats.get(2)?.max,
            sortLagDiffMax4: stats.get(4)?.max,
            sortLagDiffMax8: stats.get(8)?.max,
            sortLagDiffMaxReal: stats.get(realLag)?.max,
            sortLagNote:
                `frames=${n} frame_ms=${frameMs.toFixed(2)} trace_fps=${fmt(1 / Math.max(1e-6, frameMs / 1000), 1)} ` +
                `hot=frame${trace[hot].frame} lag=${lag[hot]}f pipe=${pipeFrames.toFixed(1)}f real=${realLag}f ` +
                `sorts=${done.length}/${n} worker_ms=${fmt(workerMs, 2)} latency_ms=${fmt(latencyMs, 2)} ` +
                `ref=adjacent_fresh_pair`,
        };
        for (const [L, fr] of keepFrames) {
            const a = encodeCrop(fr.a, box, null);
            const b = encodeCrop(fr.b, box, null);
            const d = encodeCrop(fr.a, box, fr.b);
            if (L === 1) {
                out.sortLagShotA1 = a;
                out.sortLagShotB1 = b;
                out.sortLagShotD1 = d;
            } else {
                out.sortLagShotAR = a;
                out.sortLagShotBR = b;
                out.sortLagShotDR = d;
            }
        }
        this.restoreBasePose();
        return out;
    }
    /** 本轮动态相机的实际应用参数（写进逐轮结果；`spinDeg=0` = 静止协议）。 */
    spinInfo(): {
        spinDeg: number;
        spinMode?: string;
        spinPeriod?: number;
        spinPeakDeg?: number;
        spinPivot?: string;
        spinPivotSrc?: string;
        spinErr?: number;
        spinFrames?: number;
        sceneCenter?: string;
    } {
        const s = this._spin;
        if (!s) return { spinDeg: 0 };
        return {
            spinDeg: s.degPerFrame,
            // 轨迹模式（`rate` | `swing`）与峰值角速度：`spin=` 的语义由它们决定（swing 下是摆幅）
            spinMode: s.spec.mode,
            spinPeriod: s.spec.mode === "swing" ? s.spec.period : undefined,
            spinPeakDeg: spinPeakDegPerFrame(s.spec),
            // `cam` 时 pivot 就是相机位置本身，跨臂不可比，直接写来源标记（而不是伪装成一个坐标）
            spinPivot: s.pivotSrc === "cam" ? "cam" : s.pivot.map((v) => Math.round(v * 1000) / 1000).join(","),
            spinPivotSrc: s.pivotSrc,
            spinErr: s.err === null ? undefined : s.err,
            spinFrames: s.frames,
            // 模型包围盒中心（世界坐标）：物体型场景想改成"绕模型公转"时，把它抄进 `?pivot=` 即可复现
            sceneCenter: s.sceneCenter ? s.sceneCenter.map((v) => Math.round(v * 1000) / 1000).join(",") : undefined,
        };
    }

    /** 画布/后缓冲的实际尺寸（用于证明"测的就是 1600×1063"）。 */
    canvasStats(): { cssW: number; cssH: number; bufW: number; bufH: number; glW: number; glH: number } {
        const gl = this.renderer?.gl as WebGL2RenderingContext | undefined;
        return {
            cssW: this.canvas.clientWidth,
            cssH: this.canvas.clientHeight,
            bufW: this.canvas.width,
            bufH: this.canvas.height,
            glW: gl?.drawingBufferWidth ?? -1,
            glH: gl?.drawingBufferHeight ?? -1,
        };
    }

    /** 诊断摘要：canvas / drawingBuffer / css 尺寸一行输出（item 6）。 */
    canvasStatsLine(): string {
        const s = this.canvasStats();
        return (
            `canvas=${s.bufW}x${s.bufH} drawingBuffer=${s.glW}x${s.glH} ` +
            `css=${s.cssW}x${s.cssH} (canvas 后备缓冲必须等于 res；css 只是显示尺寸)`
        );
    }

    /**
     * 帧率测量。**驱动与计时都用两臂共享的 `bench-shared.driveThroughputFrames()`**
     * （Flux-GS 臂调用同一个函数，只是把"渲染一帧"换成 iframe 里的 `__FLUXGS_BENCH_FRAME__`）。
     *   - `timer`（协议值，`proto=flux` 时默认）：每帧一条 `setTimeout(0)`，一个 tick 渲染并计一帧；
     *   - `raf`：每帧一个 `requestAnimationFrame`（在屏口径，会被刷新率封顶，与基线不可比）。
     * 本方法只负责"一帧"的定义：`frameRender()` 渲染提交之后立刻 `gl.finish()`，返回其耗时（ms）。
     * 两臂都在每帧后同步一次 GPU，所以帧间隔包含真实 GPU 执行时间（见 driveThroughputFrames 注释）。
     *
     * 计时口径（2026-09-16 与基线逐字对齐）：
     *   `fps = frames / (首帧绘制完成 → 末帧绘制完成的墙钟秒数)`，
     *   起表点在**第 1 个测帧画完之后**——与其原 `runFluxBenchmark` 里 `benchmarkStartTime` 的取点一致。
     *   `cpuMs` 现为"**含 GPU 同步**的均帧间隔"（= elapsedMs / (rendered-1)），结果头用
     *   `cpu_def=mean_frame_interval_incl_gpu_sync` 固定标注该语义。
     */
    async runThroughputFrames(frames: number, warmup = 10): Promise<ThroughputStats> {
        const driver: ThroughputDriver = throughputDriver();
        const gl = this.renderer ? (this.renderer.gl as WebGL2RenderingContext) : null;
        const rendersBefore = this.renderCalls;
        /**
         * 本臂 sort worker **完成排序**的次数（`cullStats.samples` 就是"每完成一次真实排序回一次消息"的计数）：
         * 静止相机下 `viewProj` 逐值不变 → worker 的 `.includes()` 判定不置 `dirty` → **整轮只排一次**；
         * 相机一动就每帧都排。两臂都报这个字段（基线由 render_shared/main.js 的 worker 计数），
         * "测量窗口里两臂是否做了等量工作"才有直接证据，而不是靠推测。
         */
        const sortsBefore = this.renderer?.renderProgram?.cullStats?.samples ?? -1;
        /** 一帧 = 渲染提交 + `gl.finish()`（Flux-GS 臂在 __FLUXGS_BENCH_FRAME__ 里同样每帧同步一次）。 */
        // 动态相机（`?spin=`）：帧号从**预热第一帧**起连续计数（index=0 = 基准位姿那一帧），
        // 使预热与计帧落在同一条匀速转动的轨迹上，起表点处不会跳一下。
        let spinIndex = 0;
        const renderFrame = (_index: number): number => {
            this.applySpinFrame(spinIndex++);
            this.frameRender();
            if (!gl) return 0;
            const t0 = performance.now();
            try {
                gl.finish();
            } catch {
                return 0;
            }
            return performance.now() - t0;
        };
        if (this.stopped) return emptyThroughput(driver, "测帧开始前已被取消");
        // [DIAG-EXPERIMENT-1] 打开渲染器侧逐帧分段采集（打开即清空历史样本：门禁/预热之前的帧不混入）
        setDiagFrameTimingEnabled(true);
        let s: DriveThroughputStats;
        try {
            s = await driveThroughputFrames({
                frames,
                warmup,
                driver,
                renderFrame,
                stopped: () => this.stopped,
            });
        } finally {
            setDiagFrameTimingEnabled(false);
        }
        // [DIAG-EXPERIMENT-1] 只取**计帧窗口**的样本：`driveThroughputFrames` 先跑 warmup 帧再跑计帧，
        //   所以末尾 `rendered` 个样本 = 计帧窗口的帧，与共享驱动的 frameDurations/syncs 是同一批帧。
        //   `rendered === 0`（被取消）时不取（`slice(-0)` 会返回整个数组，必须显式挡住）。
        const counted = Math.max(0, s.rendered);
        const segRows = counted > 0 ? diagFrameTimings().slice(-counted) : [];
        const segTiming = summarizeSegTiming(segRows);
        clearDiagFrameTimings();
        return {
            ...s,
            renders: this.renderCalls - rendersBefore,
            sortResults: this.sortResultsSince(sortsBefore),
            segTiming,
        };
    }

    /**
     * 首帧有效性验证（`?validateframe=1`，**默认开启**；`?validateframe=0` 关闭）：
     * 等 GPU 真正执行完（`gl.finish()`，等价于 fenceSync+clientWaitSync 的完成等待），
     * 再用稀疏采样 readPixels 确认画面**非空**。
     * 这段验证发生在测帧**之前**，不计入 FPS 区间。
     */
    validateFrame(): { ok: boolean; coveredPct: number; reason: string } {
        const renderer = this.renderer;
        if (!renderer) return { ok: false, coveredPct: 0, reason: "renderer 不存在" };
        const gl = renderer.gl as WebGL2RenderingContext;
        const w = renderer.canvas.width || 1;
        const h = renderer.canvas.height || 1;
        this.frameRender();
        try {
            gl.finish(); // 等 GPU 把这一帧执行完（不在计时区间内）
        } catch {
            /* ignore */
        }
        try {
            const buf = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            let covered = 0;
            let samples = 0;
            const stride = 16;
            for (let y = 0; y < h; y += stride) {
                for (let x = 0; x < w; x += stride) {
                    const idx = (y * w + x) * 4;
                    if (buf[idx + 3] > 0) covered++;
                    samples++;
                }
            }
            const coveredPct = samples > 0 ? (covered / samples) * 100 : 0;
            const cull = renderer.renderProgram?.cullStats;
            if (coveredPct <= 0) {
                return {
                    ok: false,
                    coveredPct,
                    reason: `首帧为空（readPixels 非空采样=0，cullTotal=${cull?.total ?? -1}，kept=${cull?.keptRatio ?? -1}）`,
                };
            }
            return { ok: true, coveredPct, reason: "" };
        } catch (err) {
            return {
                ok: false,
                coveredPct: 0,
                reason: `readPixels 失败：${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    /**
     * 读一帧像素，统计画面中被高斯覆盖的像素比例；同时读取视锥剔除后的保留比例，用于诊断测帧画面是否"空转"。
     *
     * **2026-09-17 修正（口径对称性）**：动态轮先 `restoreBasePose()` 再读。此前探针直接在"测帧窗口结束后"
     * 的朝向读像素，而动态轮的窗口结束时相机已经转到别处 → 同一场景不同挡位读出 99.8%/47.0%/38.1%/100.0%
     * 这种忽高忽低的数（`rate` 30°/帧 转满 9000°≡0° 才回到 100%）。那是**探针时机**的问题，不是渲染内容问题；
     * 还原到基准位姿后，本字段在所有轮次里都表示"基准机位的画面覆盖率"，与静止轮、与另一臂同义可比。
     * 画面内容随轨迹如何变化，由 `contentSweep()` 的逐姿态 `sweep_cov=` / `sweep_seen=` 负责回答。
     */
    probeFrameCoverage(): { coveredPct: number; keptPct: number } {
        const renderer = this.renderer;
        if (!renderer) return { coveredPct: 0, keptPct: 0 };
        this.restoreBasePose();
        const coveredPct = this.readCoveragePct();
        const cull = renderer.renderProgram?.cullStats;
        const keptPct = cull && cull.total > 0 ? cull.keptRatio * 100 : 0;
        return { coveredPct, keptPct };
    }

    /**
     * 渲染器的深度排序在 Web Worker 中异步完成，首帧可能深度索引尚未回传（实际绘制 0 实例）。
     * 测帧前必须让出事件队列，等待 worker 至少完成一次排序并产生真实绘制。
     */
    async waitForSortedFrame(timeoutMs = 12000): Promise<boolean> {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
            this.frameRender();
            const cull = this.renderer?.renderProgram?.cullStats;
            if (cull && cull.total > 0 && cull.keptRatio > 0) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 120));
        }
        return false;
    }

    /** 把相机放到能完整框住场景包围盒的固定机位，避免"默认视角大半被剔除"导致测帧失真。 */
    frameScene(splat: SPLAT.Splat): void {
        const data = splat.data;
        const p = data.positions;
        const n = data.vertexCount;
        if (!p || n === 0) return;
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;
        for (let i = 0; i < n; i++) {
            const x = p[3 * i];
            const y = p[3 * i + 1];
            const z = p[3 * i + 2];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const cz = (minZ + maxZ) / 2;
        const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-4);
        const dist = span * 1.6;
        this.camera.position = new SPLAT.Vector3(cx, cy, cz + dist);
        this.camera.update();
        const c = this.ensureControls();
        c.setCameraTarget(new SPLAT.Vector3(cx, cy, cz));
    }

    /** 焦距（像素）：默认 1132（gsplat.js 自带）。`?proto=flux` 时取 Flux-GS 的 COLMAP 焦距，
     *  从而两个渲染器在同一画布下得到完全相同的视场角；`?fx=N` 可显式覆盖。 */
    applyFocalFromParam(): void {
        const fx = parseFloat(param("fx", PROTO_FLUX ? "1159.588" : "0"));
        if (Number.isFinite(fx) && fx > 0) {
            this.camera.data.fx = fx;
            this.camera.data.fy = fx;
        }
    }

    /**
     * `?cam=flux`：用 Flux-GS 原代码里的相机（`bench-flux-camera.json`）。
     * 它的 (position, quaternion) 与 gsplat.js 的 CameraData.update 同构，设进去即可复现同一视图矩阵，
     * 于是本方法 / reduced-3DGS 两臂与 Flux-GS 臂看到的是同一个角度、同一个视场。
     * 注：Flux 源码里的 defaultViewMatrix 只写了 2 位小数、并非严格正交，走"位置+四元数"路径与它原矩阵
     * 最多差 0.32°（1600px 画布下画面边缘约 4.4px）；对测帧结论无影响，肉眼看不出差别。
     */
    async loadFluxCamera(): Promise<void> {
        try {
            const res = await fetch("./bench-flux-camera.json");
            if (!res.ok) return;
            this._fluxCamera = (await res.json()) as FluxCameraAsset;
        } catch {
            /* 取不到就回退到包围盒自动取景 */
        }
    }

    /** 应用 Flux-GS 原相机（位置 + 姿态 + 焦距）。返回 false 表示资产缺失，调用方回退包围盒取景。 */
    applyFluxCamera(): boolean {
        const asset = this._fluxCamera;
        if (!asset || !asset.default_view) return false;
        const [px, py, pz] = asset.default_view.position;
        const [x, y, z, w] = asset.default_view.quaternion;
        this.camera.data.fx = asset.focal_px;
        this.camera.data.fy = asset.focal_px;
        this.camera.position = new SPLAT.Vector3(px, py, pz);
        this.camera.rotation = new SPLAT.Quaternion(x, y, z, w);
        this.camera.update();
        this.cameraLocked = true;
        return true;
    }

    /**
     * 机位指纹：**视图矩阵（列主序）前 6 位**，与 Flux-GS 臂报告里的 `pose=` 同名同格式
     * （那边取渲染器 `end.view.slice(0, 6)`），因此逐轮结果可跨臂直接核对「是否同一个机位」。
     * 口径依据：`src/cameras/Camera.fluxParity.test.ts` 已把「位置+四元数复现的视图矩阵」与
     * Flux-GS 原矩阵的偏差钉在 0.32°（元素级差异 ≤ ~0.006），所以跨臂比对用数值容差而非字符串相等。
     */
    viewFingerprint(): string {
        return this.camera.data.viewMatrix.buffer
            .slice(0, 6)
            .map((v) => Number(v.toFixed(6)))
            .join(",");
    }

    glRendererName(): string {
        try {
            const gl = this.renderer?.gl as WebGL2RenderingContext | undefined;
            if (!gl) return "";
            const dbg = gl.getExtension("WEBGL_debug_renderer_info");
            const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
            return String(name || "");
        } catch {
            return "";
        }
    }

    /** 排序/剔除统计（诊断：total>0 说明排序 worker 已经回过消息，画面才有真实实例）。 */
    renderProgramCullTotal(): number {
        return this.renderer?.renderProgram?.cullStats?.total ?? -1;
    }

    /** 测帧窗口内 sort worker **完成排序**的次数（`before` = 窗口开始前的计数；任一取不到时返回 undefined）。 */
    sortResultsSince(before: number): number | undefined {
        const now = this.renderer?.renderProgram?.cullStats?.samples ?? -1;
        if (before < 0 || now < 0) return undefined;
        return Math.max(0, now - before);
    }

    /**
     * CPU 侧可见性探针（**与 GPU、时序、淡入无关**）：
     * 用渲染器正在用的 `viewProj` 对模型顶点做与顶点着色器**同一套**裁剪盒测试
     * （`|x| < 1.2w, |y| < 1.2w, -w < z < w`，w 为裁剪空间 w），统计落在盒内的采样点比例。
     *
     * 用途：把"首帧为空"的两种原因分开——
     *   insidePct ≈ 0  → 相机确实看不到这个模型（机位/坐标系问题）；
     *   insidePct 很高而画面仍空 → 不是机位问题，是"还没画完/管线异常"（应继续等帧）。
     */
    visibilityProbe(): { sampled: number; inside: number; insidePct: number } {
        const renderer = this.renderer;
        if (!renderer) return { sampled: 0, inside: 0, insidePct: 0 };
        const vp = this.camera.data.viewProj.buffer as unknown as ArrayLike<number>;
        let sampled = 0;
        let inside = 0;
        for (const object of this.scene.objects) {
            if (!(object instanceof SPLAT.Splat)) continue;
            const p = object.data.positions;
            const n = object.data.vertexCount;
            if (!p || n === 0) continue;
            // 与 bench-shared.clipInsideRatio **同一个函数**（同一套裁剪盒、同一个采样密度）：
            // 逐姿态扫描（contentSweep）与本探针因此可比，两臂也可比。
            const r = clipInsideRatio(p, n, vp, 2000);
            sampled += r.sampled;
            inside += r.inside;
        }
        return { sampled, inside, insidePct: sampled > 0 ? (inside / sampled) * 100 : 0 };
    }

    /**
     * 首帧有效性验证（多帧版，`?validateframe=1` 默认开启）：
     * 单帧 readPixels 可能只是"还没画完"（排序回传后的第一帧仍可能用旧索引/淡入未完成），
     * 所以这里**最多连渲染 N 帧**（每帧之间等 120ms），任一次非空即通过。
     * 全程在测帧之前，不计入 FPS。
     */
    async validateFrameRobust(maxFrames = 10): Promise<{
        ok: boolean;
        coveredPct: number;
        framesUsed: number;
        insidePct: number;
        reason: string;
    }> {
        const vis = this.visibilityProbe();
        let last = { coveredPct: 0, reason: "未执行" };
        for (let i = 1; i <= maxFrames; i++) {
            const v = this.validateFrame();
            last = { coveredPct: v.coveredPct, reason: v.reason };
            if (v.ok) {
                return { ok: true, coveredPct: v.coveredPct, framesUsed: i, insidePct: vis.insidePct, reason: "" };
            }
            if (i < maxFrames) await new Promise((resolve) => setTimeout(resolve, 120));
        }
        const cameraSees = vis.insidePct > 0;
        return {
            ok: false,
            coveredPct: last.coveredPct,
            framesUsed: maxFrames,
            insidePct: vis.insidePct,
            reason:
                (cameraSees
                    ? `连渲染 ${maxFrames} 帧后仍未出现任何非空像素（CPU 投影采样 inside=${vis.insidePct.toFixed(1)}%，` +
                      `说明相机能看到模型，属"渲染没画出来"而非机位问题；注意 FadeInPass 每帧只 +1% 不透明度，` +
                      `正常轮次通常在第 1~5 帧就能看到微光）`
                    : `相机看不到模型（CPU 投影采样全部落在裁剪盒外 inside=0/${vis.sampled}，与 GPU/时序无关）`) +
                `：${last.reason}`,
        };
    }

    /** 从 scene 里移除所有对象（旧口径的 scene.reset()）。 */
    resetScene(): void {
        try {
            this.scene.reset();
        } catch {
            /* ignore */
        }
        this.clearSpin();
    }
    /** 清掉动态相机配置（每轮开头 `resetScene()` 与 `dispose()` 都会走到；幂等）。 */
    clearSpin(): void {
        this._spin = null;
    }

    /**
     * 幂等释放：终止 Worker、删 GL 纹理/缓冲，清掉大对象引用，缩小 canvas，最后主动丢失上下文。
     *
     * 顺序很关键：
     *   1) `renderer.dispose()` —— 它要靠"仍然挂在 scene 上的 Splat"来解绑监听、删纹理；
     *   2) `loseContextOnce()` —— 让 GPU 进程立刻开始回收这一个上下文的全部显存，
     *      而不是等 iframe 文档被 GC 时才回收（后者在手机上是几轮之后才发生，正是第二轮/第三轮
     *      在 Adreno 上撞到 context lost 的直接来源）；
     *   3) `scene.reset()`、缩小 canvas、断开引用 —— 这些都不需要 GL，放在丢失之后更安全。
     * 本方法不依赖 GC，也不使用浏览器专有 GC API。
     */
    dispose(): number {
        const t0 = performance.now();
        this.stopped = true;
        try {
            this.controls?.dispose();
        } catch {
            /* ignore */
        }
        this.controls = null;
        try {
            this.renderer?.dispose();
        } catch {
            /* ignore */
        }
        if (this.renderer?.gl) {
            // 把删除命令推给驱动并等它执行完：dispose 发生在测量之后，这里的等待不影响任何指标，
            // 但能让 GPU 侧更早看到 free（而不是排在一个还没提交的队列里）。
            try {
                const gl = this.renderer.gl as WebGL2RenderingContext;
                gl.bindVertexArray?.(null);
                gl.flush();
                gl.finish(); // 只在这里（计时结束之后）用一次，代价是几十毫秒的同步等待
            } catch {
                /* ignore */
            }
        }
        if (param("losectx", "0") === "1") {
            this.loseContextOnce();
        }
        this.releaseSplatData(); // 先断开数据引用，再把它从 scene 上摘掉
        this.resetScene();
        // 缩小 canvas：让驱动尽早回收这块 framebuffer 对应的显存（本 iframe 随后整体销毁）
        try {
            this.canvas.width = 1;
            this.canvas.height = 1;
        } catch {
            /* ignore */
        }
        this._fluxCamera = null;
        this.renderer = null;
        return performance.now() - t0;
    }

    /**
     * 主动丢失 WebGL 上下文。**默认关闭**（`?losectx=1` 才启用），原因有两条实测依据：
     *   1) 仓库里 Flux-GS 臂的现场记录（bench-flux.ts）明确写过：手机端"强制丢弃 + 放弃恢复"会让
     *      上下文名额/显存**迟迟不归还**，连续冷启动到第 2~3 轮反而更容易建不出上下文；
     *   2) 本方法每轮结束都会把整个 iframe 卸载（`about:blank`）+ 摘除节点 + 断开全部引用，
     *      让浏览器走它自己的文档销毁路径回收上下文/显存/Worker —— 那条路径在手机上更可靠。
     * 打开它只用于 A/B 对照（例如怀疑"显存没及时归还"时）。
     * 一旦调用，这个 renderer/canvas/context 就绝不能再被使用（本页随后只做收尾与上报）。
     */
    loseContextOnce(): boolean {
        if (this.loseContextCalled) return false;
        this.loseContextCalled = true;
        try {
            const gl = this.renderer?.gl as WebGL2RenderingContext | undefined;
            const ext = gl?.getExtension("WEBGL_lose_context") as { loseContext: () => void } | null | undefined;
            if (!ext) return false;
            console.log(
                "[bench-measure] 主动调用 WEBGL_lose_context.loseContext()（这是清理动作，" +
                    "随后控制台出现的 CONTEXT_LOST_WEBGL 属预期，不代表崩溃）",
            );
            ext.loseContext();
            return true;
        } catch {
            return false;
        }
    }

    /** 断开 Splat/SplatData 持有的大数组引用（SplatData 是 TypedArray 的宿主，退出作用域前显式摘掉）。 */
    private releaseSplatData(): void {
        try {
            for (const object of this.scene.objects) {
                if (object instanceof SPLAT.Splat) {
                    object.data.detached = true; // 让渲染路径与此数据解耦，随后整轮数据由 GC 回收
                }
            }
        } catch {
            /* ignore */
        }
    }
}

/**
 * 单轮测量（旧 bench.ts `measureRound` 的逐行等价实现，计时起点/终点与结果字段完全一致）。
 *
 * 计时锚点（不可改）：
 *   tStart          本轮开始（reset scene / 设分辨率之前）
 *   responseEnd     模型文件的下载结束时刻（Resource Timing，与 performance.now() 同一条时间轴）
 *   tLoaded         解码完成、Splat 已进 scene
 *   tFirstFrame     深度排序回传后的第一个"真实绘制帧"
 *   → fetch_ms = 下载段；parse_ms = responseEnd→tLoaded；first_frame_ms = responseEnd→tFirstFrame
 *   → fps = 在 tFirstFrame 之后、预热 warmup 帧之后，连续 frames 帧的墙钟均值
 */
export async function measureOneRound(
    ctx: BenchCase,
    meta: SceneMeta,
    roundNo: number,
    opts: MeasureOptions,
): Promise<RoundResult> {
    const base: RoundResult = { scene: meta.id, round: roundNo, ts: new Date().toISOString(), ok: false };
    base.dataset = meta.dataset;
    /** 时间线：每个 mark 记相对本轮开始的毫秒数（诊断用，不参与任何指标） */
    const timeline: Array<[string, number]> = [];
    const tRound0 = performance.now();
    const mark = (name: string, detail?: string): void => {
        const ms = performance.now() - tRound0;
        timeline.push([name, ms]);
        opts.onMark?.(name, detail);
        console.log(
            `[case-timeline][job=${opts.token}][${meta.id} r${roundNo}] ${name} +${ms.toFixed(0)}ms${detail ? " " + detail : ""}`,
        );
    };

    const tStart = performance.now();
    ctx.resetScene();
    ctx.setBenchmarkResolution(opts.resW, opts.resH);
    {
        // item 6：确认测的确实是 res 尺寸（canvas 后备缓冲 + gl.drawingBuffer）
        const cs = ctx.canvasStats();
        const sizeOk = cs.bufW === opts.resW && cs.bufH === opts.resH && cs.glW === opts.resW && cs.glH === opts.resH;
        mark("scale-set", `${ctx.canvasStatsLine()}${sizeOk ? "" : " ⚠ 后备缓冲与 res 不一致！"}`);
    }
    opts.onPhase?.("loading");
    try {
        const splat = await ctx.loadSplat(opts.modelUrl, opts.signal);
        // 竞态保护：本轮已被取消/已释放时，把刚落地的数据丢掉，绝不写进 scene 参与后续渲染
        if (ctx.stopped || opts.signal?.aborted) {
            ctx.resetScene();
            base.err = "已取消（dispose 早于加载完成）";
            return base;
        }
        const tLoaded = performance.now();
        mark("decode-done", `splats=${splat.data?.vertexCount ?? "?"}`);
        // cam=flux：用 Flux-GS 原相机（位置 + 姿态 + 焦距）复现同一视角；资产缺失时才退回包围盒取景
        if (!(CAM_FLUX && ctx.applyFluxCamera())) {
            ctx.frameScene(splat);
        }
        ctx.camera.update();
        // 机位指纹（写进逐轮结果）：与 Flux-GS 臂的 `pose=` 同格式，跨轮/跨臂可直接核对。
        // 注意在**相机就位之后**取值：frameScene 也会 update 相机，取早了记的是默认机位。
        base.poseKey = ctx.viewFingerprint();
        base.poseSrc = ctx.cameraLocked ? "flux" : "auto";
        mark("camera-ready", `camLocked=${ctx.cameraLocked} pose=${base.poseKey}`);
        // ---- 动态相机（`?spin=`，效度自查；`spin=0` 时下面全是 no-op）----
        // 必须在机位就位之后、测帧之前：`pose=` 记的仍是第 0 帧机位，此后每帧由共享实现转动。
        // 窗口长度（预热 + 计帧）传进去：`swing` 档的摆动周期缺省 = 整个窗口，内容量扫描的采样帧号也用它。
        ctx.setupSpin(splat, opts.frames + (opts.warmup ?? 0));
        const spin = ctx.spinInfo();
        base.spinDeg = spin.spinDeg;
        base.spinMode = spin.spinMode;
        base.spinPeriod = spin.spinPeriod;
        base.spinPeakDeg = spin.spinPeakDeg;
        base.spinPivot = spin.spinPivot;
        base.spinPivotSrc = spin.spinPivotSrc;
        base.sceneCenter = spin.sceneCenter;
        if (spin.spinDeg !== 0) {
            mark(
                "spin-setup",
                `spin=${spin.spinDeg}${spin.spinMode === "swing" ? "deg(amp)" : "deg/frame"} ` +
                    `mode=${spin.spinMode} period=${spin.spinPeriod ?? "-"} peak=${fmt(spin.spinPeakDeg, 2)}deg/frame ` +
                    `pivot=${spin.spinPivot ?? "-"} src=${spin.spinPivotSrc ?? "-"}`,
            );
        }
        opts.onPhase?.("sorting");
        // 让出事件循环等待深度排序回传——此时才产生真实的首帧绘制
        const sorted = await ctx.waitForSortedFrame();
        const tFirstFrame = performance.now();
        mark("sort-frames-done", `sorted=${sorted} cullStats.total=${ctx.renderProgramCullTotal()}`);
        if (ctx.stopped) {
            ctx.resetScene();
            base.err = "已取消（dispose 早于首帧）";
            return base;
        }

        const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        let fetchMs: number | undefined;
        let bytes: number | undefined;
        let foundEntry: PerformanceResourceTiming | undefined;
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (opts.token && e.name.includes(`ts=${opts.token}`)) {
                foundEntry = e;
                fetchMs = e.duration;
                bytes = e.transferSize > 0 ? e.transferSize : undefined;
                break;
            }
        }
        // 论文口径：首帧时间从"文件获取完成"之后算起
        // responseEnd 与 performance.now() 同时间轴，不能再加 performance.timeOrigin
        const fetchEndWall = foundEntry ? foundEntry.responseEnd : tStart;
        mark("fetch-timing", `fetch_ms=${(fetchMs ?? tLoaded - tStart).toFixed(0)} bytes=${bytes ?? "-"}`);
        base.fetchMs = fetchMs ?? tLoaded - tStart;
        base.parseMs = tLoaded - fetchEndWall;
        base.firstFrameMs = tFirstFrame - fetchEndWall;
        base.drawOk = sorted;
        base.points = splat.data ? splat.data.vertexCount : undefined;
        base.bytes = bytes;
        base.fx = ctx.camera.data.fx;
        base.resW = opts.resW;
        base.resH = opts.resH;
        base.gl = ctx.glRendererName();

        // ---- 门禁 1：深度排序必须回过消息，否则"首帧"其实是空帧 → 本轮判失败，不进入测帧 ----
        if (!sorted) {
            base.err = `首帧未验证成功：深度排序未回传（cullStats.total=${ctx.renderProgramCullTotal()}）`;
            mark("FAIL-no-sort");
            base.timeline = formatTimeline(timeline);
            return base;
        }

        // ---- 门禁 2：**渲染存活探针**（`?validateframe=1` 默认开启；**不是质量门槛**）----
        // 这里只回答一个问题：管线到底有没有画出过东西（连续 N 帧像素全空 = 没画）。
        // 2026-09-17 起 bench 模式**不挂 FadeInPass**（`fade=none`，见 createRenderer 注释），
        // 所以首帧探针看到的覆盖率为**真实**覆盖率：若 `ff_covered` 仍然很低，那是真没画（红旗），
        // 不能再归因于"淡入还没到 1.0"。（展示路径仍有淡入，它的低覆盖是观感设计，与本探针无关。）
        // 画面覆盖率以测帧之后的 probeFrameCoverage 为准（与原协议一致）。
        const doValidate = param("validateframe", "1") !== "0";
        let firstFrameCovered = -1;
        if (doValidate) {
            const v = await ctx.validateFrameRobust(20);
            mark(
                "validate-frame",
                `alive=${v.ok ? 1 : 0} firstCovered=${v.coveredPct.toFixed(1)}% afterFrames=${v.framesUsed} ` +
                    `inside=${v.insidePct.toFixed(1)}% ${v.reason}`,
            );
            base.visibilityInsidePct = v.insidePct;
            base.validateFramesUsed = v.framesUsed;
            if (!v.ok) {
                base.err = `渲染存活探针失败：${v.reason}`;
                base.timeline = formatTimeline(timeline);
                return base;
            }
            firstFrameCovered = v.coveredPct;
        }
        // 没有开启像素验证时也记录"相机是否看得到模型"，供后续核对
        if (base.visibilityInsidePct === undefined) {
            base.visibilityInsidePct = ctx.visibilityProbe().insidePct;
        }

        opts.onPhase?.("measuring");
        mark("throughput-start", `frames=${opts.frames} warmup=${opts.warmup} driver=${param("driver", "raf")}`);
        const perf = await ctx.runThroughputFrames(opts.frames, opts.warmup);
        // ---- 门禁 3：测帧必须是完整跑完的，且每帧都真的 render 过 ----
        if (perf.aborted || perf.rendered < opts.frames) {
            base.err = `测帧未完成（rendered=${perf.rendered}/${opts.frames} ${perf.note}）`;
            mark("FAIL-throughput-aborted");
            base.timeline = formatTimeline(timeline);
            return base;
        }
        mark(
            "throughput-end",
            `rendered=${perf.rendered} renders=${perf.renders} elapsed=${perf.elapsedMs.toFixed(0)}ms fps=${perf.fps.toFixed(1)} ` +
                `sync(med)=${perf.syncMs.toFixed(2)}ms floor=${perf.timerFloorMs.toFixed(2)}ms capped=${perf.fpsCapped ? 1 : 0} ` +
                `frame(med/mean)=${perf.frameMs.toFixed(2)}/${perf.frameMeanMs.toFixed(2)}ms ` +
                `gap(med/min/max)=${perf.gapMedMs.toFixed(2)}/${perf.gapMinMs.toFixed(2)}/${perf.gapMaxMs.toFixed(2)}ms`,
        );

        const probe = ctx.probeFrameCoverage();
        base.coveredPct = probe.coveredPct;
        base.keptPct = probe.keptPct;
        base.fps = perf.fps;
        base.cpuMs = perf.cpuMs;
        base.driver = perf.driver;
        base.frames = perf.rendered;
        base.elapsedMs = perf.elapsedMs;
        base.renders = perf.renders;
        // 排序次数（效度自查）：静止协议下本文臂整轮只排一次；相机一动就每帧都排。
        // 与基线臂逐轮行的 `sort_results=` 同名同义（那边由 render_shared/main.js 的 worker 计数）。
        base.sortResults = perf.sortResults;
        base.gapMedMs = perf.gapMedMs;
        base.gapMinMs = perf.gapMinMs;
        base.gapMaxMs = perf.gapMaxMs;
        base.warmupMs = perf.warmupMs;
        // 本次新增的诊断口径（与 Flux-GS 臂结果头同名字段）：GPU 同步耗时 / 计时地板 / 是否被地板卡住
        base.syncMs = perf.syncMs;
        base.syncFrames = perf.syncFrames;
        // 帧内阻塞耗时（诊断/自检用）：它只说明"帧内实际被阻塞"的量级，**不是**单帧渲染能力，
        // 不得用来算两臂倍数——被地板封顶时两边读数都落在 performance.now() 的量化下限上。
        base.frameMs = perf.frameMs;
        base.frameMeanMs = perf.frameMeanMs;
        // [DIAG-EXPERIMENT-1] 分段计时 + 共享驱动两个核心量的分位数（与 Flux 臂同名同源：
        //   汇总都在 bench-shared.summarizeSegTiming()，摊平/打印在 applySegTimingFields()/segTimingRoundTags()）。
        applySegTimingFields(base, perf.segTiming);
        base.frameP50 = perf.frameMsP50;
        base.frameP90 = perf.frameMsP90;
        base.syncP50 = perf.syncMsP50;
        base.syncP90 = perf.syncMsP90;
        base.timerFloorMs = perf.timerFloorMs;
        base.timerFloorRounds = perf.timerFloorRounds;
        base.timerFloorSrc = perf.timerFloorSrc;
        base.fpsCapped = perf.fpsCapped;
        // 本文臂恒为统一像素协议（bench-case 把后备缓冲钉死为 res）
        base.resMode = "forced";
        base.firstFrameCoveredPct = firstFrameCovered >= 0 ? firstFrameCovered : undefined;
        // 动态相机的轨迹对账（`spin=0` 时 undefined）：实际视图矩阵 vs 共享实现目标视图矩阵的最大偏差。
        // 大偏差（> 1e-3）＝本轮的相机轨迹与基线臂注入的不是同一条，跨臂相除不成立，结果里必须看得见。
        base.spinErr = ctx.spinInfo().spinErr;
        base.timeline = formatTimeline(timeline);
        // ---- 内容量扫描（`?sweep=<k>`，动态轮缺省 9 个姿态）：测帧窗口**之后**逐姿态实测内容量 ----
        // 回答的问题："这几个挡位的 fps 能不能用来比较两臂？"——只有两臂在整条轨迹上看着同量级的内容，
        // 帧率差异才归因于实现而不是"要画的东西多寡"。见 bench-shared.clipInsideRatio 与 contentSweep()。
        const sweep = ctx.contentSweep();
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
            mark(
                "content-sweep",
                `k=${sum.k} frames=${sum.frames} yaws=${sum.yaws} cov(mean/min/max)=` +
                    `${sum.covMean.toFixed(1)}/${sum.covMin.toFixed(1)}/${sum.covMax.toFixed(1)}% ` +
                    `seen=${sum.seenMean.toFixed(1)}/${sum.seenMin.toFixed(1)}/${sum.seenMax.toFixed(1)}% ` +
                    `drawn=${sum.drawnMin}${sum.drawnMin === sum.drawnMax ? " (与视角无关)" : `~${sum.drawnMax}`}`,
            );
        }
        // ---- 点集包围盒（世界坐标）+ 对角线：把"两臂基准机位相差多少单位"换成**相对场景尺度的比例** ----
        // 这是"0.039 单位到底算不算可忽略"的唯一判据（`offset / scene_diag`），两臂各算自己的点集。
        const bounds = ctx.sceneBounds(splat);
        if (bounds) {
            base.sceneMin = formatTriple(bounds.min);
            base.sceneMax = formatTriple(bounds.max);
            base.sceneDiag = bounds.diag;
            mark(
                "scene-bounds",
                `min=${base.sceneMin} max=${base.sceneMax} diag=${bounds.diag.toFixed(4)} 世界单位（${bounds.count} 点）`,
            );
        }
        // ---- 排序滞后核对（`?sortlag=1`；`?sortlag=shot` 额外带回对照截图）----
        // 回答"动态视角下省掉的那些排序有没有让画面出错"：见 sortLagProbe 与 sortLagRoundTags 的说明。
        if (param("sortlag", "") !== "") {
            const lagInfo = await ctx.sortLagProbe(splat, opts.frames);
            if (lagInfo) {
                Object.assign(base, lagInfo);
                mark(
                    "sortlag-probe",
                    `sorts=${lagInfo.sortLagLagList ? lagInfo.sortLagLagList.split(",").length : "?"}帧 lag(med/max)=` +
                        `${fmt(lagInfo.sortLagLagMed, 2)}/${lagInfo.sortLagLagMax}帧 hot=frame${lagInfo.sortLagHotFrame}` +
                        `(${fmt(lagInfo.sortLagHotDeg, 2)}deg) real=${lagInfo.sortLagRealLag}帧 ` +
                        `diff(pct8,真实档)=${fmt(lagInfo.sortLagDiff8Real, 3)}% ref=${fmt(lagInfo.sortLagRefPct8, 3)}%`,
                );
            }
        }

        // ---- 人工确认用：测完之后先保持画面 holdms 毫秒再上报（默认 0，不进任何指标）----
        const holdMs = Math.max(0, parseInt(param("holdms", "0"), 10) || 0);
        if (holdMs > 0) {
            mark("hold-start", `holdms=${holdMs}（仅用于人工确认，不进指标）`);
            ctx.frameRender();
            await new Promise((resolve) => setTimeout(resolve, holdMs));
            mark("hold-end");
        }

        base.ok = true;
        mark("result-ready");
        base.timeline = formatTimeline(timeline);
        return base;
    } catch (err) {
        base.err = err instanceof Error ? err.message : String(err);
        base.timeline = formatTimeline(timeline);
        return base;
    }
}

/** 时间线 → 一行诊断字符串（空格换下划线，便于 key=value 解析）。 */
function formatTimeline(timeline: Array<[string, number]>): string {
    return timeline
        .map(([k, ms]) => `${k}:${Math.round(ms)}`)
        .join("/")
        .replace(/\s+/g, "_");
}
