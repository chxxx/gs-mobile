/**
 * bench-view.ts — `mode=view` 展示浏览模式（加载指定场景、自由旋转缩放、FPS/信息叠加，供截图与录屏）。
 *
 * 为什么单独一个文件：本文件（经由 bench-measure → src/index）会把渲染器与 wasm 模块带进模块图。
 * 父页面 bench.ts 只在 `mode=view` 时**动态 import** 它，于是 `mode=bench` 的模块图里没有任何渲染代码 ——
 * "自动测试父页面零 WebGL 上下文"这句话就能直接从代码结构上看出来，而不是靠运行时小心翼翼。
 */
import { BenchCase } from "./bench-measure";
import * as SPLAT from "./src/index";
import { deviceInfo, shortDeviceLabel, param, submitReport, CAM_FLUX } from "./bench-shared";
import type { SceneMeta } from "./bench-shared";

export interface ViewDom {
    canvas: HTMLCanvasElement;
    stScene: HTMLElement;
    fpsOverlay: HTMLElement;
    infoOverlay: HTMLElement;
    welcome: HTMLElement;
    statusBig: HTMLElement;
    /** [2026-10-07] 加载遮罩（真机上下载+解码十几秒，全黑会让测试者以为卡死） */
    loading: HTMLElement;
    loadingText: HTMLElement;
}

export interface ViewStartOptions {
    /** `?fpsoverlay=1`：超大号 FPS 数字（录屏用） */
    big: boolean;
    overlay: boolean;
    info: boolean;
}

/** 展示模式的会话：一个 renderer / scene / camera / controls + 一个 RAF 循环。 */
export class BenchView {
    private _dom: ViewDom;
    private _list: SceneMeta[];
    private _ctx: BenchCase;
    private _loopStarted = false;
    private _rafId = 0;
    private _lastFrameAt = 0;
    private _emaMs = 0;
    private _currentScene: SceneMeta | null = null;
    private _glName = "";
    /** 实际生效的 dpr（夹取后；见 `_applyPixelRatio`） */
    private _dprApplied = 1;
    /** 现场错误收集（`?diag=1` 回传 + 屏幕上大字提示共用；最多留 40 条） */
    private _errors: string[] = [];
    private _lastErrorShown = "";
    private _diagPosted = false;
    /** 当前已加载的 Splat（`resetCamera` 重新取景/重新套机位时要用） */
    private _splat: SPLAT.Splat | null = null;
    /** 模型世界包围盒中心＝拖动时的公转轴心（`null` = 取不到） */
    private _pivot: [number, number, number] | null = null;
    /** 用户是否已经开始交互（首次拖动/滚轮后才把机位交给 OrbitControls） */
    private _orbitEnabled = false;
    /** 当前场景包围盒最大跨度（`_fitClipPlanes` 顺手记下：交互范围要按它约束，否则钻进点云里"乱跑"） */
    private _span = 0;
    /** 加载遮罩的计时器（每 0.5 s 刷一次"已等待 N 秒"） */
    private _loadingTimer = 0;
    /** 是否已经画出首帧（首帧出来后收起加载遮罩） */
    private _firstFrameShown = false;
    /** `?viewres=WxH` 固定渲染分辨率（后备缓冲锁定为 W×H；与采数/Flux 页对齐用） */
    private _fixedRes: [number, number] | null = null;
    /** 视线轴符号（±1）：锚定到"指向模型"那一侧，使缩放方向始终一致 */
    private _axisSign = 1;
    /** 采数口径的基准焦距（`applyFluxCamera` 后取一次；`?fovfit=1` 用它换算屏幕焦距） */
    private _baseFx = 0;
    /** 视线轴符号是否已经**用有效投影**测准（加载时投影可能还没就绪 ⇒ 首帧后补测） */
    private _axisFixed = false;
    /** 沿视线轴的累计位移（受夹取；`重置视角` 归零），用于"一定能拉回论文机位" */
    private _dollyOffset = 0;
    /** 场景包围盒（世界系，`_fitClipPlanes` 顺手记下；判定视线轴符号/自测投影面积用） */
    private _bbox: [[number, number, number], [number, number, number]] | null = null;

    constructor(dom: ViewDom, list: SceneMeta[]) {
        this._dom = dom;
        this._list = list;
        this._ctx = new BenchCase(dom.canvas);
    }

    /** 建渲染器 + controls + RAF 循环（只有进入 view 模式才会被调用一次）。 */
    start(options: ViewStartOptions): void {
        // [2026-10-07 修复真机"还是黑的"] 默认**不挂 FadeInPass**，与真机已跑通真实采数的 bench 测量路径
        //   （bench-case.ts 的 `createRenderer(false)`）完全一致；需要淡入观感时用 `?fade=1` 显式打开。
        //   为什么这条是黑屏的头号嫌疑：FadeInPass 的 `depthFade` 从 0 起、每帧 +0.01、满 1 才关闭，
        //   而它的 `render()` 第一行是 `if (!active || renderData?.updating) return;` —— 在大场景手机上
        //   `updating` 长期为真 ⇒ 淡入值**永远停在 0** ⇒ 颜色 α 乘 0 ⇒ **全黑、且一行异常都不报**。
        //   （历史行为是 `createRenderer(true)`，即展默认挂载淡入。）
        this._ctx.createRenderer(param("fade") === "1");
        this._glName = this._ctx.glRendererName();
        const renderer = this._ctx.renderer;
        // [2026-10-07] `?viewres=WxH`：固定渲染分辨率（后备缓冲 = W×H、像素比 1）。
        //   用途：与采数口径（1600×1063）或 Flux 官方页的 `?benchres=1600x1063` **对齐**做并列对比录屏；
        //   不写则按窗口 CSS×dpr 自动（手机默认口径）。
        const vr = /^(\d+)x(\d+)$/.exec(param("viewres"));
        this._fixedRes = vr ? [parseInt(vr[1], 10), parseInt(vr[2], 10)] : null;
        if (vr && renderer) {
            renderer.disableAutoResize();
            renderer.setPixelRatio(1);
            renderer.setSize(this._fixedRes![0], this._fixedRes![1]);
            this._dprApplied = 1;
            this._layoutFixedResCanvas(); // 等比显示（黑边），否则 CSS 会把固定分辨率拉变形
        } else {
            renderer?.enableAutoResize();
            this._applyPixelRatio();
        }
        window.addEventListener("resize", this._onResize);
        window.addEventListener("error", this._onWindowError);
        window.addEventListener("unhandledrejection", this._onUnhandled as EventListener);
        this._dom.canvas.addEventListener("webglcontextlost", this._onCtxLost as EventListener);
        // [2026-10-07] 改用**自研增量式**轨道控制（见 _orbitBy / _dollyByRatio）：
        //   不再让 OrbitControls 接管——它按"绝对角度 + 阻尼"重算姿态，遇到数据集相机（看向场景某处，
        //   而不是包围盒中心）时会改写视线；极端情况下两个候选方向都判定失败 ⇒ 相机被锁死
        //   （真机原话："动都不能动了"）。增量做法只叠加拖动/捏合的**变化量**：
        //   论文机位逐位不变、永不跳变、且能原路返回。
        const cv = this._dom.canvas;
        cv.addEventListener("pointerdown", this._onPointerDown);
        cv.addEventListener("pointermove", this._onPointerMove);
        cv.addEventListener("pointerup", this._onPointerUp);
        cv.addEventListener("pointercancel", this._onPointerUp);
        cv.addEventListener("wheel", this._onWheel, { passive: true });
        this._dom.fpsOverlay.classList.toggle("hidden", !options.overlay);
        this._dom.infoOverlay.classList.toggle("hidden", !options.info);
        this._dom.fpsOverlay.style.fontSize = options.big ? "56px" : "18px";
        this._ctx.camera.position = new SPLAT.Vector3(0, 0, -5);
        this._ctx.camera.update();
        this._ctx.ensureControls();
        // [2026-10-07] 从"进页面"就先给个等待提示（模块加载 + 渲染器创建也要几秒，全黑像卡死）
        this._setLoadingWithTimer("正在初始化渲染器…");
        // [2026-10-07 修复 view 模式黑屏] **不在加载完成前启动 RAF 循环**：
        //   `?shcache=frag&lr=1&notx=1&nocolortx=1` 这些臂开关由**渲染程序自己**直接读页面 URL 决定
        //   （见 RenderProgram 顶部的 SHPASS/SHCACHE/NOTX/NOCTX 常量），而低秩载荷（lrRank）与
        //   逐点变换表（transformsHeight）是在 PLY **流式解码过程中**逐步挂到 Splat 上的。
        //   若此时已有 RAF 在 `frameRender()`，第一帧就会在"数据没齐"的状态下建 RenderData：
        //     · `?lr=1` ⇒ `sphericalHarmonics.lowRank` 缺失 ⇒ 每帧抛错，
        //     · `?notx=1` ⇒ 运行期自证 `transformsHeight === 1` 判成 0 ⇒ 永久打上 `notx-rejected`。
        //   两者都会让画面**持续全黑**（异常在 RAF 回调里抛出 ⇒ 之后的帧也画不出来）。
        //   bench 测量路径（bench-case.ts → measureOneRound）本来就是"先 loadSplat、等首帧排序完成"再渲染，
        //   这里改成同样顺序：循环首启移到 load() 成功之后（`_startLoop()` 幂等）。
    }

    /** 加载场景（可反复调用：切换场景时先 reset 再加载）。 */
    async load(id: string): Promise<void> {
        const meta = this._list.find((s) => s.id === id);
        if (!meta) {
            this._flash(`未知场景：${id}`);
            return;
        }
        this._currentScene = meta;
        this._dom.stScene.textContent = `${meta.name}（加载中…）`;
        // [2026-10-07] 加载期间**先停帧**：同一机制下（见 start() 注释）边流式解码边渲染会让
        //   `lr`/`notx` 的运行期自证踩在"数据没齐"的状态上，切换场景时会复现首个场景的黑屏。
        this._stopLoop();
        this._orbitEnabled = false; // 换场景后同样先给论文机位（用户再拖才解锁）
        this._firstFrameShown = false;
        this._setLoadingWithTimer(`正在加载 ${meta.name} …`);
        try {
            this._ctx.resetScene();
            const splat = await this._ctx.loadSplat(meta.file);
            // [2026-10-07] **机位与采数口径对齐**：默认 `cam=flux`（与 bench 测量路径同一份
            //   `bench-flux-camera.json` 的 `default_view`，即 Flux-GS 原相机）——
            //   以前展示模式从没走过这条路，一直用包围盒自动取景，所以角度与论文数字/Flux 官方页面不一致。
            //   `?cam=auto` 显式退回包围盒取景；资产取不到时也自动退回。
            let fluxOk = false;
            if (CAM_FLUX) {
                await this._ctx.loadFluxCamera();
                fluxOk = this._ctx.applyFluxCamera();
            }
            if (!fluxOk) this._ctx.frameScene(splat);
            this._fitClipPlanes(splat); // [2026-10-07] 见下方注释：不撑开 far 就是全黑
            this._ctx.camera.update();
            this._baseFx = this._ctx.camera.data.fx; // 采数口径焦距（flux 资产 = 1159.588）
            this._applyFovFit(); // `?fovfit=1`：按画布高换算焦距 ⇒ 填满屏幕且构图与论文一致
            // [2026-10-07] 初始机位**锁死**为论文机位，不交给 OrbitControls：
            //   控制器内部用欧拉角（YXZ）往返重算相机姿态，会丢掉四元数里的滚转分量 ⇒
            //   机位指纹从采数口径的 `0.467561,0.035955,…` 漂成 `0.773544,…`，看着就是"角度不对"。
            //   用户一旦在画布上拖动/滚轮，才解锁并**从原机位**接着转（见 _unlockCamera）。
            this._splat = splat;
            this._pivot = this._ctx.modelCenter(splat);
            this._fitZoomBounds(); // [2026-10-07] 缩放范围绑到本场景（否则钻进点云里像乱跑/回不去）
            this._ctx.cameraLocked = true;
            this._dom.stScene.textContent = meta.name;
            this._dom.welcome.classList.add("hidden");
            // [2026-10-07] 数据齐了再起渲染循环（首帧自证 lr/notx 才不会误判，见 start() 注释）。
            this._startLoop();
            // [2026-10-07] `?diag=1`：加载完成 6 秒后自检并回传（等首帧/排序稳定），现场无需读小字。
            if (param("diag") === "1") {
                window.setTimeout(() => void this._postDiag(), 6000);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this._dom.stScene.textContent = `${meta.name} 加载失败`;
            this._flash(`加载失败：${msg}`);
            this._hideLoading();
            this._startLoop(); // 失败也要把循环恢复（否则页面永久停在黑屏且无提示）
        }
    }

    /**
     * [2026-10-07 修复 view 模式"全黑"的真正原因] `frameScene()` 把相机放在包围盒外 `span*1.6` 处，
     *   而 `CameraData` 的缺省裁剪面是 `near=0.1 / far=100`：大场景（garden span≈155 ⇒ 相机距中心≈248）
     *   **整个模型落在远平面之外** ⇒ 画面永远全黑、且一行异常都不报
     *   （自证现场：`cam=pos(18.72,3.42,274.65)`、`frame_ok=false covered=0 inside=0/2000`）。
     *   bench 测量路径默认 `cam=flux`（注入数据集原相机，距离天然在 100 内）所以从未暴露。
     *   展示路径必须按"取景距离 + 场景尺度"自己把裁剪面撑开。
     */
    private _fitClipPlanes(splat: SPLAT.Splat): void {
        const p = splat.data.positions;
        const n = splat.data.vertexCount;
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
        const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-4);
        this._span = span; // [2026-10-07] 交互范围/缩放下限要用它（见 _applyOrbitFeel）
        this._bbox = [
            [minX, minY, minZ],
            [maxX, maxY, maxZ],
        ];
        const cam = this._ctx.camera;
        const d = Math.hypot(
            cam.position.x - (minX + maxX) / 2,
            cam.position.y - (minY + maxY) / 2,
            cam.position.z - (minZ + maxZ) / 2,
        );
        cam.data.near = Math.max(0.1, Math.min(d * 0.01, 1));
        cam.data.far = d + span * 2;
    }

    /**
     * [2026-10-07] 手感/范围：把 OrbitControls 的半径范围绑到"论文机位 → 模型中心"距离 **与场景尺度**。
     *   库默认是 `minZoom=0.1 / maxZoom=30`，而 garden 的论文机位距离≈38.8 ⇒
     *     · 一解锁，`update()` 会把半径夹到 30 ⇒ 画面"跳近"；
     *     · 之后**再怎么双指捏合也回不到论文机位**（真机实测："想双指缩小又回不去"）。
     *   第二轮真机实测（bicycle）：只按"到中心距离"定缩放下限会**钻进点云内部** ⇒ 画面"乱跑"，
     *   所以下限还要受场景尺度约束（≥ 跨度×3%，且 ≥ 机位距离×2%）；
     *   同时**默认关掉双指平移**（`panSpeed=0`）：平移会把公转轴心拉走，松手后转动就像"乱飞"，
     *   而演示只需要"转 + 缩放"。需要平移时加 `?pan=1`。
     */
    private _applyOrbitFeel(): void {
        const c = this._ctx.ensureControls();
        const p = this._pivot;
        const cam = this._ctx.camera;
        const d0 = p ? Math.hypot(cam.position.x - p[0], cam.position.y - p[1], cam.position.z - p[2]) : 0;
        if (d0 > 0) {
            const byScene = this._span > 0 ? this._span * 0.03 : 0;
            c.minZoom = Math.max(0.05, byScene, d0 * 0.02); // 贴近看细节，但不钻进点云里
            c.maxZoom = d0 * 4; // 一定拉得回论文机位（留 4× 余量）
        }
        c.orbitSpeed = 0.6; // 库默认 1：手机上转太快
        c.zoomSpeed = 0.35; // 库默认 1：捏合缩放太快
        c.panSpeed = param("pan") === "1" ? 0.5 : 0; // 默认关双指平移（见上）
        c.dampening = 0.1; // 库默认 0.12：略缓一点，减少"跟着手指抖"
    }

    /** 重置视角（拖到别处后一键回到初始机位＝论文/Flux 机位）。 */
    resetCamera(): void {
        this._orbitEnabled = false;
        try {
            this._ctx.controls?.dispose();
        } catch {
            /* ignore */
        }
        this._ctx.controls = null;
        // [2026-10-07] 回到"采数口径的机位"：优先重新套 Flux 原相机；取不到才退回包围盒取景。
        const fluxOk = this._ctx.applyFluxCamera();
        if (!fluxOk && this._splat) this._ctx.frameScene(this._splat);
        if (this._splat) this._fitClipPlanes(this._splat);
        this._ctx.cameraLocked = true; // 仍是"未交互"状态
        this._ctx.camera.update();
        this._ctx.ensureControls();
        this._fitZoomBounds(); // 控制器是自研的增量式实现 ⇒ 重新套一遍缩放范围/俯仰基准
    }

    // ---------------------------------------------------------------- 自研轨道控制（view 专用）
    /** 按下的指针（支持多指捏合） */
    private _pointers = new Map<number, { x: number; y: number }>();
    /** 捏合基准距离（px） */
    private _pinchDist = 0;
    /** 累计俯仰（rad），用于 ±80° 夹取，防止翻过头 */
    private _pitch = 0;
    /** 论文机位到模型中心的距离与缩放上下限（`_fitZoomBounds` 里算） */
    private _d0 = 0;
    private _minD = 0.1;
    private _maxD = 100;

    private _onPointerDown = (e: PointerEvent): void => {
        this._orbitEnabled = true;
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this._pointers.size === 2) this._pinchDist = this._pointerDistance();
        try {
            this._dom.canvas.setPointerCapture(e.pointerId);
        } catch {
            /* ignore */
        }
    };

    private _onPointerMove = (e: PointerEvent): void => {
        const prev = this._pointers.get(e.pointerId);
        if (!prev) return;
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this._pointers.size >= 2) {
            const d = this._pointerDistance();
            if (this._pinchDist > 0 && d > 0) this._dollyByRatio(this._pinchDist / d);
            this._pinchDist = d;
            return;
        }
        this._orbitBy(e.clientX - prev.x, e.clientY - prev.y);
    };

    private _onPointerUp = (e: PointerEvent): void => {
        this._pointers.delete(e.pointerId);
        if (this._pointers.size < 2) this._pinchDist = 0;
    };

    private _onWheel = (e: WheelEvent): void => {
        this._orbitEnabled = true;
        this._dollyByRatio(Math.pow(1.0015, e.deltaY));
    };

    private _pointerDistance(): number {
        const p = [...this._pointers.values()];
        if (p.length < 2) return 0;
        return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    }

    /**
     * 拖动 → 绕**世界竖直轴**偏航 + 绕**相机当前右轴**俯仰。纯增量：
     *   只把拖动的变化量叠加到现有姿态上 ⇒ 论文机位在"未拖动"时逐位不变（不会像 OrbitControls
     *   那样按绝对角度重算、把视线掰到包围盒中心）。俯仰累计夹在 ±80°，防止翻过头。
     */
    private _orbitBy(dx: number, dy: number): void {
        const cam = this._ctx.camera;
        const speed = Number(param("orbit")) > 0 ? Number(param("orbit")) : 0.0035;
        // [2026-10-07] **与 Flux 官方页逐条对齐**（其源码 rotate4(a,rad,x,y,z) 是"相机局部系后乘"）：
        //   Flux: inv=rotate4(inv, +dx, 0,1,0)（绕**相机自身竖直轴**）; inv=rotate4(inv, -dy, 1,0,0)（绕**相机自身右轴**）
        //   ⇒ 这里同样：偏航绕相机自身 up、俯仰绕相机自身 right 且取 -dy。
        //   `?orbitinv=1` 可整体反转（万一某台设备手感相反）。
        const inv = param("orbitinv") === "1" ? -1 : 1;
        const maxPitch = (80 * Math.PI) / 180;
        const want = this._pitch - dy * speed * inv;
        const pitch = Math.max(-maxPitch, Math.min(maxPitch, want)) - this._pitch;
        this._pitch += pitch;
        const b = SPLAT.Matrix3.RotationFromQuaternion(cam.rotation).buffer;
        const right = new SPLAT.Vector3(b[0], b[3], b[6]); // 相机右轴（世界）
        const up = new SPLAT.Vector3(b[1], b[4], b[7]); // 相机上轴（世界）
        let q = SPLAT.Quaternion.FromAxisAngle(up, dx * speed * inv).multiply(cam.rotation);
        q = SPLAT.Quaternion.FromAxisAngle(right, pitch).multiply(q);
        cam.rotation = q;
        cam.update();
    }

    /**
     * 捏合 / 滚轮 → 沿**相机视线轴**推拉（纯缩放，无横向漂移；视线方向与滚转都不变）。
     *   方向约定：捏合张开 = 靠近 = 画面变大（`?zoominv=1` 反转）。
     *   位移按"沿视线轴累计位移"夹取：`-0.85×d0`（贴近细节）~ `+3×d0`（拉远），
     *   且始终从当前位置**增量**移动 ⇒ 一定能原路回到论文机位。
     */
    private _dollyByRatio(ratio: number): void {
        const cam = this._ctx.camera;
        if (!(this._d0 > 0) || !(ratio > 0)) return;
        const speed = Number(param("zoom")) > 0 ? Number(param("zoom")) : 1;
        const inv = param("zoominv") === "1" ? -1 : 1;
        const scale = Math.pow(ratio, speed * inv); // <1 = 靠近
        const step = this._d0 * (1 - scale);
        const prev = this._dollyOffset;
        this._dollyOffset = Math.max(-0.85 * this._d0, Math.min(3 * this._d0, prev + step));
        const applied = this._dollyOffset - prev;
        const axis = this._viewAxis();
        cam.position = new SPLAT.Vector3(
            cam.position.x + axis[0] * applied,
            cam.position.y + axis[1] * applied,
            cam.position.z + axis[2] * applied,
        );
        cam.update();
    }

    /** 相机视线轴（世界系，单位向量；符号由 `_fitZoomBounds` 用投影面积实测锚定）。 */
    private _viewAxis(): [number, number, number] {
        const b = this._ctx.camera.data.viewMatrix.buffer as unknown as ArrayLike<number>;
        const len = Math.hypot(b[8], b[9], b[10]) || 1;
        const s = this._axisSign;
        return [(s * b[8]) / len, (s * b[9]) / len, (s * b[10]) / len];
    }

    /**
     * 画面"内容尺度"探针（与朝向约定、GPU、时序都无关）：把**真实点云采样点 + 包围盒角点**
     *   用当前 viewProj 投到 NDC，取**相机前方**（`w>0`）那部分的外接矩形面积。
     *   相机靠近 ⇒ 面积变大。用途：① 判定视线轴符号 ② 自测"捏合张开是否真的放大"。
     *   ⚠️ 不能用全部包围盒角点：大场景（bicycle）很多角点在相机背后，`w<0` 会让 NDC 坐标翻转、
     *   矩形面积失真（第一版就是栽在这上面：判出来的符号是反的）。
     */
    private _projectedArea(): number {
        const vp = this._ctx.camera.data.viewProj.buffer as unknown as ArrayLike<number>;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        let hit = 0;
        const push = (x: number, y: number, z: number): void => {
            const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
            if (!(w > 1e-6)) return; // 只统计相机前方的点
            const nx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w;
            const ny = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w;
            minX = Math.min(minX, nx);
            maxX = Math.max(maxX, nx);
            minY = Math.min(minY, ny);
            maxY = Math.max(maxY, ny);
            hit++;
        };
        const splat = this._splat;
        const p = splat?.data.positions;
        const n = splat?.data.vertexCount ?? 0;
        if (p && n > 0) {
            const step = Math.max(1, Math.floor(n / 256));
            for (let i = 0; i < n; i += step) push(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
        }
        const bb = this._bbox;
        if (bb) {
            for (const x of [bb[0][0], bb[1][0]]) {
                for (const y of [bb[0][1], bb[1][1]]) {
                    for (const z of [bb[0][2], bb[1][2]]) push(x, y, z);
                }
            }
        }
        if (hit < 4 || !Number.isFinite(minX)) return 0;
        return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
    }

    /**
     * 缩放范围 + 视线轴符号锚定。**符号用投影面积实测**（与任何"前向 = ±view 矩阵某行"的约定无关）：
     *   沿 ±轴各挪一小步，取"画面变大（投影面积增大）"的那一侧 ⇒ 之后 pinch 张开一定 = 靠近。
     */
    private _fitZoomBounds(): void {
        const p = this._pivot;
        if (!p) return;
        const cam = this._ctx.camera;
        const d0 = Math.hypot(cam.position.x - p[0], cam.position.y - p[1], cam.position.z - p[2]);
        this._d0 = d0;
        this._minD = Math.max(0.05, this._span * 0.03, d0 * 0.02);
        this._maxD = Math.max(d0 * 4, this._minD * 2);
        this._pitch = 0;
        this._dollyOffset = 0;
        this._axisFixed = false;
        this._fixAxisSign(); // 先试一次（此时 viewProj 可能还是默认口径 ⇒ 失败会留到首帧后重测）
    }

    /**
     * 视线轴符号：沿 ±轴各挪一小步，取"画面变大（投影面积增大）"的那一侧。
     * ⚠️ 必须在**渲染器已经把画布尺寸同步给相机**之后测（否则 viewProj 还是默认 512 口径，
     *   两个候选面积都是 0 ⇒ 判不出方向，缩放就会反）。所以失败时置 `_axisFixed=false`，
     *   由渲染循环在首帧后再调一次。
     */
    private _fixAxisSign(): void {
        if (this._axisFixed) return;
        const cam = this._ctx.camera;
        const p = this._pivot;
        if (!p) return;
        const b = cam.data.viewMatrix.buffer as unknown as ArrayLike<number>;
        const len = Math.hypot(b[8], b[9], b[10]) || 1;
        const unit: [number, number, number] = [b[8] / len, b[9] / len, b[10] / len];
        const home: [number, number, number] = [cam.position.x, cam.position.y, cam.position.z];
        const eps = Math.max(1e-3, this._span * 0.02);
        const areaAt = (s: number): number => {
            cam.position = new SPLAT.Vector3(
                home[0] + s * unit[0] * eps,
                home[1] + s * unit[1] * eps,
                home[2] + s * unit[2] * eps,
            );
            cam.update();
            return this._projectedArea();
        };
        const aPlus = areaAt(1);
        const aMinus = areaAt(-1);
        cam.position = new SPLAT.Vector3(home[0], home[1], home[2]);
        cam.update();
        if (aPlus <= 0 || aMinus <= 0) return; // 判据无效（投影还没就绪）⇒ 留给下一帧
        // 判据：沿 ±轴各挪 eps（= 场景跨度 2%，相对机位距离很小）⇒ 投影面积变大的那一侧就是"朝前"
        //   （eps 必须小：步长太大时相机横向摆动会主导面积变化，判据失效 —— 自测踩过这个坑）。
        this._axisSign = aPlus >= aMinus ? 1 : -1;
        this._axisFixed = true;
    }

    // [2026-10-07] 旧实现 `_unlockCamera`（把机位交给 OrbitControls）**已废弃**：它按"绝对角度 + 阻尼"
    //   重算姿态，遇到数据集相机（看向场景某处，而非包围盒中心）会改写视线；极端情况下两个候选方向
    //   都判定失败、直接把相机锁死（真机："动都不能动了"）。函数体保留仅作历史参考，**不再被调用**：
    //   view 模式一律走自研增量式控制（_orbitBy / _dollyByRatio）。
    private _unlockCamera = (): void => {
        if (this._orbitEnabled) return;
        const cam = this._ctx.camera;
        const c = this._ctx.ensureControls();
        // 注意：`CameraData.update()` 每次都**新建** Matrix4 ⇒ 必须每回重新读 buffer，不能缓存引用
        // （第一版就踩了这个坑：两份快照其实指向同一块旧矩阵 ⇒ 自证恒真 ⇒ 放反了也判"通过"）。
        const snap = (): number[] => Array.from(cam.data.viewMatrix.buffer as unknown as ArrayLike<number>).slice(0, 12);
        const dot = (a: number[], o: number, b: number[], o2: number): number =>
            a[o] * b[o2] + a[o + 1] * b[o2 + 1] + a[o + 2] * b[o2 + 2];
        // 视线是否被破坏：比较 view 矩阵的 x/y 行（若只是把 roll 归零，两行几乎不变；被翻转则会变号）
        const preserved = (m: number[]): boolean => dot(before, 0, m, 0) > 0.9 && dot(before, 4, m, 4) > 0.9;
        const before = snap();
        const v: [number, number, number] = [before[8], before[9], before[10]];
        const p = this._pivot;
        const d = p
            ? Math.hypot(p[0] - cam.position.x, p[1] - cam.position.y, p[2] - cam.position.z)
            : 5;
        const home: [number, number, number] = [cam.position.x, cam.position.y, cam.position.z];
        // [2026-10-07] 两个候选方向（相机前后各放一个轴心）各试一次，用**语义判据**择优：
        //   不能用"view 矩阵行向量点积"——不同实现的欧拉约定不同，会误判（真机表现：两个候选都不通过
        //   ⇒ 走"放弃接管"分支 ⇒ 相机锁死、动都不能动）。改用 CPU 投影探针 `visibilityProbe().insidePct`
        //   （"还看不看得到模型"，与朝向约定无关）：取看得更多的那个。
        //   另外必须**迭代到收敛**再判：控制器有 `dampening`，单次 `update()` 只走 10%。
        const beforeInside = this._ctx.visibilityProbe().insidePct;
        const toward: [number, number, number] = p
            ? [p[0] - home[0], p[1] - home[1], p[2] - home[2]]
            : [0, 0, 0];
        const facing = v[0] * toward[0] + v[1] * toward[1] + v[2] * toward[2] >= 0;
        let bestSign = facing ? 1 : -1;
        let bestInside = -1;
        for (const s of [1, -1]) {
            c.setCameraTarget(new SPLAT.Vector3(home[0] + s * v[0] * d, home[1] + s * v[1] * d, home[2] + s * v[2] * d));
            for (let i = 0; i < 200; i++) c.update();
            cam.update();
            const inside = this._ctx.visibilityProbe().insidePct;
            if (inside > bestInside) {
                bestInside = inside;
                bestSign = s;
            }
        }
        if (bestInside < Math.max(1, beforeInside * 0.5)) {
            // 两个方向都会把模型转出视野 ⇒ 不接管：恢复论文机位并保持锁定（宁可不能拖，也不让画面变怪）
            this._ctx.cameraLocked = true;
            this._ctx.applyFluxCamera();
            this._ctx.camera.update();
            if (this._splat) this._fitClipPlanes(this._splat);
            return;
        }
        c.setCameraTarget(
            new SPLAT.Vector3(home[0] + bestSign * v[0] * d, home[1] + bestSign * v[1] * d, home[2] + bestSign * v[2] * d),
        );
        for (let i = 0; i < 200; i++) c.update();
        cam.update();
        this._orbitEnabled = true;
        this._ctx.cameraLocked = false;
        this._applyOrbitFeel(); // 解锁瞬间把范围/手感对齐（半径不再被夹到 30）
    };

    setOverlayVisible(visible: boolean): void {
        this._dom.fpsOverlay.classList.toggle("hidden", !visible);
    }
    setInfoVisible(visible: boolean): void {
        this._dom.infoOverlay.classList.toggle("hidden", !visible);
    }
    glRendererName(): string {
        return this._glName;
    }
    deviceLabel(): string {
        return shortDeviceLabel(this._glName);
    }

    /** 释放（本页切走/关闭时调用，保持与 bench 模式对称的清理习惯）。 */
    dispose(): void {
        this._stopLoop();
        if (this._loadingTimer) {
            window.clearInterval(this._loadingTimer);
            this._loadingTimer = 0;
        }
        window.removeEventListener("resize", this._onResize);
        window.removeEventListener("error", this._onWindowError);
        window.removeEventListener("unhandledrejection", this._onUnhandled as EventListener);
        this._dom.canvas.removeEventListener("pointerdown", this._onPointerDown);
        this._dom.canvas.removeEventListener("pointermove", this._onPointerMove);
        this._dom.canvas.removeEventListener("pointerup", this._onPointerUp);
        this._dom.canvas.removeEventListener("pointercancel", this._onPointerUp);
        this._dom.canvas.removeEventListener("wheel", this._onWheel);
        this._ctx.dispose();
    }

    private _onResize = (): void => {
        // 旋转 / 改窗口后 CSS 尺寸变了 ⇒ dpr 夹取要重算（否则可能又超上限）；
        // `?viewres=WxH` 固定分辨率时**不跟随窗口**（与采数口径一致），但要重算等比显示框。
        if (this._fixedRes) {
            this._layoutFixedResCanvas();
            this._applyFovFit();
            return;
        }
        this._applyPixelRatio();
        this._applyFovFit();
    };

    /**
     * [2026-10-07] `?fovfit=1`：把**竖直视场**锁定成采数口径（1600×1063 那套，49.4°），
     *   横向按屏幕比例自然裁切 ⇒ **填满屏幕、无黑边、不变形，且构图与论文/Flux 一致**。
     *   做法：焦距是按像素定义的 ⇒ `fx = 基准焦距 × (画布高 / 1063)`（渲染器每帧都会把
     *   `camera.data.height` 跟画布后备缓冲对齐，所以窗口/旋转变化后重算一次即可）。
     */
    private _applyFovFit(): void {
        if (param("fovfit") !== "1" || !(this._baseFx > 0)) return;
        const cam = this._ctx.camera;
        const h = cam.data.height || this._dom.canvas.height || 1063;
        const fx = this._baseFx * (h / 1063);
        cam.data.fx = fx;
        cam.data.fy = fx;
    }

    /**
     * [2026-10-07] `?viewres=WxH` 时把画布**等比裁切填满**屏幕（cover，无黑边、无拉伸）。
     *   渲染缓冲锁定为 W×H（与采数口径、Flux 页 `benchres` 完全一致 ⇒ FPS 像素负载可比），
     *   显示时等比放大到铺满视口、由 `#view-area`（overflow:hidden）裁掉多余部分：
     *     比例 = max(视口宽/W, 视口高/H)（>1 时两边都会超出 ⇒ 一定铺满、一定不变形）
     *   之前用 min(...) 是"等比含入（contain）"⇒ 竖屏上会留大片黑边（用户反馈：要么拉伸、要么黑边）。
     */
    private _layoutFixedResCanvas(): void {
        const fr = this._fixedRes;
        if (!fr) return;
        const cv = this._dom.canvas;
        const area = cv.parentElement;
        const aw = Math.max(1, area?.clientWidth ?? window.innerWidth);
        const ah = Math.max(1, area?.clientHeight ?? window.innerHeight);
        const s = Math.max(aw / fr[0], ah / fr[1]); // cover：铺满 + 等比（不拉伸）
        cv.style.position = "absolute";
        cv.style.left = "50%";
        cv.style.top = "50%";
        cv.style.transform = "translate(-50%, -50%)";
        cv.style.width = `${Math.max(1, Math.round(fr[0] * s))}px`;
        cv.style.height = `${Math.max(1, Math.round(fr[1] * s))}px`;
    }

    /**
     * [2026-10-07] 后备缓冲 = CSS 尺寸 × dpr，但**夹住上限**：手机 dpr 常 3~3.5，
     *   915×412 CSS × 3.15 ≈ 2882×1298（≈3.7 M 像素）会逼近部分移动 GPU 的
     *   MAX_RENDERBUFFER / 显存预算，目标建不出来就是黑屏。
     *   这里同时夹「单边 ≤ GL 上限」与「总像素 ≤ 4.2 M」；要更清晰时用 `?dpr=N` 显式覆盖（仍受同一夹取保护）。
     */
    private _applyPixelRatio(): void {
        const renderer = this._ctx.renderer;
        if (!renderer) return;
        const gl = renderer.gl as WebGL2RenderingContext | undefined;
        const maxDim = Math.min(
            gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 4096,
            gl ? (gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) : 4096,
            4096,
        );
        const cssW = Math.max(1, this._dom.canvas.clientWidth);
        const cssH = Math.max(1, this._dom.canvas.clientHeight);
        const want = Number(param("dpr")) > 0 ? Number(param("dpr")) : window.devicePixelRatio || 1;
        this._dprApplied = Math.max(
            1,
            Math.min(want, maxDim / cssW, maxDim / cssH, Math.sqrt(4.2e6 / (cssW * cssH))),
        );
        renderer.setPixelRatio(this._dprApplied);
        renderer.resize();
    }

    private _onWindowError = (e: ErrorEvent): void => {
        this._pushError(`window.error=${e.message || String(e.error ?? "unknown")}`);
    };

    private _onUnhandled = (e: Event): void => {
        const r = (e as PromiseRejectionEvent).reason as unknown;
        this._pushError(`unhandledrejection=${r instanceof Error ? r.message : String(r)}`);
    };

    private _onCtxLost = (): void => {
        this._pushError("webglcontextlost=上下文丢失（请重新加载本页）");
    };

    /** 记一条现场错误：屏幕上大字提示（只在内容变化时写 DOM，避免每帧刷屏）+ 留给 `?diag=1` 回传。 */
    private _pushError(msg: string): void {
        if (this._errors.length < 40) this._errors.push(msg);
        if (this._lastErrorShown !== msg) {
            this._lastErrorShown = msg;
            this._flash(`渲染失败：${msg}`);
        }
    }

    private _sceneSplats(): number {
        const splat = this._ctx.scene.objects.find((o) => o instanceof SPLAT.Splat) as SPLAT.Splat | undefined;
        return splat ? splat.data.vertexCount : 0;
    }

    /**
     * 「画面到底画出来没有」的判据：**本任务内先渲染一帧、再立刻 readPixels**。
     *   为什么必须自己渲染一帧：`preserveDrawingBuffer=false` 时，浏览器合成后缓冲被清空，
     *   靠在别人的 rAF 里读（或 `drawImage` 到 2D 画布）会拿到全黑，**分不出"真黑"与"读不到"**；
     *   同一个 JS 任务里"提交绘制 → 立刻读回"拿到的才是这一帧的真实像素。
     */
    private _samplePixels(): Promise<{ ok: boolean; mean: number; max: number; w: number; h: number }> {
        try {
            const gl = this._ctx.renderer?.gl as WebGL2RenderingContext | undefined;
            if (!gl) return Promise.resolve({ ok: false, mean: -1, max: -1, w: 0, h: 0 });
            this._ctx.frameRender(); // 同一任务内先画一帧（readPixels 读到的就是它）
            const w = 64;
            const h = 64;
            const x = Math.max(0, Math.floor(gl.drawingBufferWidth / 2 - w / 2));
            const y = Math.max(0, Math.floor(gl.drawingBufferHeight / 2 - h / 2));
            const buf = new Uint8Array(w * h * 4);
            gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            let s = 0;
            let mx = 0;
            for (let i = 0; i < buf.length; i += 4) {
                const v = (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
                s += v;
                if (v > mx) mx = v;
            }
            return Promise.resolve({ ok: true, mean: +(s / (w * h)).toFixed(2), max: mx, w, h });
        } catch {
            return Promise.resolve({ ok: false, mean: -2, max: -2, w: 0, h: 0 });
        }
    }

    /**
     * [2026-10-07] `?diag=1`：把「真机到底怎么了」直接 POST 回 `/__ch7/report`（落盘到 raw/）。
     *   现场（手机）不用读小字也不用连 USB，发起人这边就能拿到证据：尺寸/dpr/GL 上限/点数/中心像素亮度/错误列表。
     *   复用 bench 的回传通道与口令（`rtok=`），请求体仍是 `[RESULT]…[END]` 文本。
     */
    private async _postDiag(): Promise<void> {
        const reportUrl = param("report");
        if (this._diagPosted || param("diag") !== "1" || !reportUrl) return;
        this._diagPosted = true;
        const px = await this._samplePixels();
        const gl = this._ctx.renderer?.gl as WebGL2RenderingContext | undefined;
        const info = deviceInfo(this._glName);
        const lines = [
            "[RESULT]",
            `view_diag=1 scene=${this._currentScene?.name ?? "-"}`,
            `splats=${this._sceneSplats()}`,
            `canvas=${this._dom.canvas.width}x${this._dom.canvas.height} css=${this._dom.canvas.clientWidth}x${this._dom.canvas.clientHeight} dpr=${(window.devicePixelRatio || 1).toFixed(2)} applied_dpr=${this._dprApplied.toFixed(2)}`,
            `viewport=${window.innerWidth}x${window.innerHeight}`,
            `gl_limits=maxTex=${gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : "-"} maxRb=${gl ? (gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) : "-"}`,
            `pixel_mean=${px.mean} pixel_max=${px.max} sampled=${px.w}x${px.h} readok=${px.ok}`,
            `gl_error=${gl ? gl.getError() : "-"} fade=${param("fade") === "1" ? 1 : 0}`,
            `chip=${info.chip}`,
            `gl_renderer=${info.gl_renderer}`,
            `url_search=${location.search.replace(/^\?/, "")}`,
            `cam=pos(${this._ctx.camera.position.x.toFixed(2)},${this._ctx.camera.position.y.toFixed(2)},${this._ctx.camera.position.z.toFixed(2)}) fx=${this._ctx.camera.data.fx} size=${this._ctx.camera.data.width}x${this._ctx.camera.data.height}`,
            `cull=total=${this._ctx.renderer?.renderProgram?.cullStats?.total ?? "-"} kept=${this._ctx.renderer?.renderProgram?.cullStats?.keptRatio ?? "-"} renders=${this._ctx.renderCalls}`,
            `pose=${this._ctx.viewFingerprint()}`,
            `cam_src=${CAM_FLUX ? "flux" : "auto"}`,
            `focal=fx=${this._ctx.camera.data.fx} far=${this._ctx.camera.data.far}`,
            `orbit=minZoom=${(this._ctx.controls?.minZoom ?? 0).toFixed(2)} maxZoom=${(this._ctx.controls?.maxZoom ?? 0).toFixed(2)} orbitSpeed=${this._ctx.controls?.orbitSpeed ?? "-"} zoomSpeed=${this._ctx.controls?.zoomSpeed ?? "-"} panSpeed=${this._ctx.controls?.panSpeed ?? "-"} dampening=${this._ctx.controls?.dampening ?? "-"}`,
            `dist_to_pivot=${this._pivot ? Math.hypot(this._ctx.camera.position.x - this._pivot[0], this._ctx.camera.position.y - this._pivot[1], this._ctx.camera.position.z - this._pivot[2]).toFixed(2) : "-"}`,
            `orbit_enabled=${this._orbitEnabled ? 1 : 0}`,
            ...this._errors.slice(-10).map((e, i) => `err${i + 1}=${e}`),
            "[END]",
        ];
        // 渲染管线自证：validateFrameRobust 会连渲染数帧并 readPixels + CPU 投影采样，
        //   把「相机看不到模型」与「看得到却没画出来」分开（见 bench-measure 的注释）。
        let frameLine = "frame_check=skipped";
        try {
            const v = await this._ctx.validateFrameRobust(6);
            frameLine = `frame_ok=${v.ok} covered=${v.coveredPct} inside=${v.insidePct} frames=${v.framesUsed} reason=${v.reason}`;
        } catch (e) {
            frameLine = `frame_check_error=${e instanceof Error ? e.message : String(e)}`;
        }
        lines.splice(lines.length - 1, 0, frameLine);
        // [2026-10-07] `?selftest=1`：量"解锁瞬间到底动了什么" —— 用于定位"一控制就怪、回不去"。
        if (param("selftest") === "1") {
            const camOf = (): string => {
                const c = this._ctx.camera.position;
                return `${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}`;
            };
            const distOf = (): string => {
                if (!this._pivot) return "-";
                const c = this._ctx.camera.position;
                return Math.hypot(c.x - this._pivot[0], c.y - this._pivot[1], c.z - this._pivot[2]).toFixed(2);
            };
            const poseBefore = this._ctx.viewFingerprint();
            const camBefore = camOf();
            const distBefore = distOf();
            this._fitZoomBounds(); // 自研控制器：此处只需刷新缩放范围（不改动任何姿态）
            await new Promise((r) => setTimeout(r, 1500));
            lines.splice(
                lines.length - 1,
                0,
                `selftest_cam_before=${camBefore} dist_before=${distBefore}`,
                `selftest_pose_before=${poseBefore}`,
                `selftest_cam_after=${camOf()} dist_after=${distOf()}`,
                `selftest_pose_after=${this._ctx.viewFingerprint()}`,
            );
        }
        // [2026-10-07] `?uitest=1`：一次问清"不能动"的原因
        //   ① 画布中心命中的是谁（加载遮罩若没收起会盖住画布吞掉全部触摸）
        //   ② 解锁走到了哪个分支（orbit_enabled=0 ⇒ 走了"放弃接管"）
        //   ③ 合成一次单指拖动，看机位是否真的变化（验证拖动链路本身）
        if (param("uitest") === "1") {
            try {
                const cx = Math.floor(window.innerWidth / 2);
                const cy = Math.floor(window.innerHeight / 2);
                const hit = document.elementFromPoint(cx, cy);
                const cs = window.getComputedStyle(this._dom.loading);
                lines.splice(
                    lines.length - 1,
                    0,
                    `uitest_hit=${hit ? hit.id || hit.tagName : "-"} loading_display=${cs.display} pointer=${cs.pointerEvents}`,
                    `uitest_orbit_enabled=${this._orbitEnabled ? 1 : 0} locked=${this._ctx.cameraLocked ? 1 : 0}`,
                );
                this._fitZoomBounds();
                const poseBefore = this._ctx.viewFingerprint();
                const canvas = this._dom.canvas;
                const fireId = (id: number, type: string, x: number, y: number): void => {
                    canvas.dispatchEvent(
                        new PointerEvent(type, {
                            pointerId: id,
                            pointerType: "touch",
                            isPrimary: id === 1,
                            clientX: x,
                            clientY: y,
                            bubbles: true,
                            cancelable: true,
                        }),
                    );
                };
                fireId(1, "pointerdown", 300, 300);
                for (let i = 1; i <= 8; i++) fireId(1, "pointermove", 300 + i * 15, 300);
                fireId(1, "pointerup", 420, 300);
                await new Promise((r) => setTimeout(r, 600));
                lines.splice(
                    lines.length - 1,
                    0,
                    `uitest_pose_before=${poseBefore}`,
                    `uitest_pose_after=${this._ctx.viewFingerprint()}`,
                );
                // 双指张开（**极小步长** 2px，避免横向摆动污染面积判据）：应"画面变大" ⇒ 面积变大
                const a1 = this._projectedArea();
                fireId(1, "pointerdown", 300, 300);
                fireId(2, "pointerdown", 500, 300);
                fireId(1, "pointermove", 298, 300);
                fireId(2, "pointermove", 502, 300);
                fireId(1, "pointerup", 298, 300);
                fireId(2, "pointerup", 502, 300);
                await new Promise((r) => setTimeout(r, 200));
                const a2 = this._projectedArea();
                // 直径轴符号自证：在当前机位沿 ±视线轴各挪 eps，报告两侧面积（面积大的那侧=朝前）
                lines.splice(
                    lines.length - 1,
                    0,
                    `uitest_pinch_area_before=${a1.toFixed(4)} after=${a2.toFixed(4)} (after 应更大)`,
                );
            } catch (e) {
                lines.splice(lines.length - 1, 0, `uitest_error=${e instanceof Error ? e.message : String(e)}`);
            }
        }
        const ok = await submitReport(reportUrl, lines.join("\n"), param("rtok"));
        this._flash(
            ok
                ? `诊断已回传：pixel_mean=${px.mean} splats=${this._sceneSplats()} canvas=${this._dom.canvas.width}x${this._dom.canvas.height}`
                : `诊断回传失败（pixel_mean=${px.mean}）——请把屏幕文字截图发我`,
        );
    }

    private _flash(text: string): void {
        this._dom.statusBig.textContent = text;
        this._dom.statusBig.classList.remove("hidden");
    }

    /**
     * [2026-10-07] 加载遮罩：真机上"下载 + 低秩解码"要十几秒（经隧道更慢），全黑画面会让测试者以为卡死。
     *   这里显示居中遮罩 + 转圈 + **已等待秒数**（秒数是唯一能让人相信"还活着"的信息）。
     */
    private _setLoadingWithTimer(label: string): void {
        const t0 = performance.now();
        if (this._loadingTimer) window.clearInterval(this._loadingTimer);
        this._dom.loading.classList.remove("hidden");
        const tick = (): void => {
            const s = ((performance.now() - t0) / 1000).toFixed(0);
            this._dom.loadingText.textContent = `${label}\n已等待 ${s} 秒（首次加载较慢，请不要关闭页面）`;
        };
        tick();
        this._loadingTimer = window.setInterval(tick, 500);
    }

    private _hideLoading(): void {
        if (this._loadingTimer) {
            window.clearInterval(this._loadingTimer);
            this._loadingTimer = 0;
        }
        this._dom.loading.classList.add("hidden");
    }

    /** 停渲染循环（幂等）。加载期间与 dispose 都用它：见 load() 的 2026-10-07 注释。 */
    private _stopLoop(): void {
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = 0;
        this._loopStarted = false;
    }

    /** 起渲染循环（幂等）。**只在场景加载完成后调用**，理由见 start() 的 2026-10-07 注释。 */
    private _startLoop(): void {
        if (this._loopStarted) return;
        this._loopStarted = true;
        const loop = (): void => {
            this._rafId = requestAnimationFrame(loop);
            try {
                this._ctx.frameRender();
            } catch (err) {
                // 渲染期异常：屏幕大字留痕（内容不变就不重复写 DOM）+ 收进 `?diag=1` 的回传列表
                this._pushError(`frameRender=${err instanceof Error ? err.message : String(err)}`);
            }
            const name = this._currentScene ? this._currentScene.name : "-";
            this._updateOverlay(name, this._sceneSplats());
            // [2026-10-07] 渲染器是**每帧**才把画布后备缓冲尺寸同步到 `camera.data` 的，
            //   所以 `?fovfit=1` 的焦距换算必须在这里（拿到真实画布高之后）再对齐一次才准。
            //   焦距 setter 幂等：值没变不会重建投影矩阵。
            this._applyFovFit();
            // [2026-10-07] 视线轴符号同样要等"画布尺寸已同步给相机"才能测准 ⇒ 首帧后再补测一次。
            this._fixAxisSign();
            // [2026-10-07] 首帧画出来之后再收起加载遮罩（否则遮罩撤了、画面还是黑的，体验更差）
            if (!this._firstFrameShown) {
                this._firstFrameShown = true;
                this._hideLoading();
            }
        };
        this._rafId = requestAnimationFrame(loop);
    }

    private _updateOverlay(metaName: string, splatCount: number): void {
        const now = performance.now();
        if (this._lastFrameAt > 0) {
            const ms = now - this._lastFrameAt;
            this._emaMs = this._emaMs === 0 ? ms : this._emaMs * 0.9 + ms * 0.1;
        }
        this._lastFrameAt = now;
        const fps = this._emaMs > 0 ? 1000 / this._emaMs : 0;
        this._dom.fpsOverlay.innerHTML = `FPS ${fps.toFixed(0)}`;
        const info = deviceInfo(this._glName);
        const dpr = window.devicePixelRatio || 1;
        this._dom.infoOverlay.textContent =
            `${metaName}\n${info.chip}\nsplats=${splatCount.toLocaleString()}\n` +
            `canvas=${this._dom.canvas.width}x${this._dom.canvas.height} ` +
            `(${this._dom.canvas.clientWidth}x${this._dom.canvas.clientHeight} CSS, dpr=${dpr.toFixed(2)})\n` +
            `gl=${info.gl_renderer}`;
    }
}
