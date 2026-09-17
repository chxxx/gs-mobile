/**
 * bench-view.ts — `mode=view` 展示浏览模式（加载指定场景、自由旋转缩放、FPS/信息叠加，供截图与录屏）。
 *
 * 为什么单独一个文件：本文件（经由 bench-measure → src/index）会把渲染器与 wasm 模块带进模块图。
 * 父页面 bench.ts 只在 `mode=view` 时**动态 import** 它，于是 `mode=bench` 的模块图里没有任何渲染代码 ——
 * "自动测试父页面零 WebGL 上下文"这句话就能直接从代码结构上看出来，而不是靠运行时小心翼翼。
 */
import { BenchCase } from "./bench-measure";
import * as SPLAT from "./src/index";
import { deviceInfo, shortDeviceLabel } from "./bench-shared";
import type { SceneMeta } from "./bench-shared";

export interface ViewDom {
    canvas: HTMLCanvasElement;
    stScene: HTMLElement;
    fpsOverlay: HTMLElement;
    infoOverlay: HTMLElement;
    welcome: HTMLElement;
    statusBig: HTMLElement;
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

    constructor(dom: ViewDom, list: SceneMeta[]) {
        this._dom = dom;
        this._list = list;
        this._ctx = new BenchCase(dom.canvas);
    }

    /** 建渲染器 + controls + RAF 循环（只有进入 view 模式才会被调用一次）。 */
    start(options: ViewStartOptions): void {
        // 展示路径：**保留 FadeInPass 淡入**（产品特性/录屏观感）。
        // 只有 bench 测量路径（bench-case.ts）才传 false 追求两臂架构对等。
        this._ctx.createRenderer(true);
        this._glName = this._ctx.glRendererName();
        const renderer = this._ctx.renderer;
        renderer?.enableAutoResize();
        renderer?.setPixelRatio(window.devicePixelRatio || 1);
        renderer?.resize();
        window.addEventListener("resize", this._onResize);
        this._dom.fpsOverlay.classList.toggle("hidden", !options.overlay);
        this._dom.infoOverlay.classList.toggle("hidden", !options.info);
        this._dom.fpsOverlay.style.fontSize = options.big ? "56px" : "18px";
        this._ctx.camera.position = new SPLAT.Vector3(0, 0, -5);
        this._ctx.camera.update();
        this._ctx.ensureControls();
        this._startLoop();
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
        try {
            this._ctx.resetScene();
            const splat = await this._ctx.loadSplat(meta.file);
            this._ctx.frameScene(splat);
            this._ctx.camera.update();
            this._dom.stScene.textContent = meta.name;
            this._dom.welcome.classList.add("hidden");
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this._dom.stScene.textContent = `${meta.name} 加载失败`;
            this._flash(`加载失败：${msg}`);
        }
    }

    /** 重置视角（拖到别处后一键回到初始机位）。 */
    resetCamera(): void {
        try {
            this._ctx.controls?.dispose();
        } catch {
            /* ignore */
        }
        this._ctx.controls = null;
        this._ctx.camera.position = new SPLAT.Vector3(0, 0, -5);
        this._ctx.camera.update();
        this._ctx.ensureControls();
    }

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
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = 0;
        this._loopStarted = false;
        window.removeEventListener("resize", this._onResize);
        this._ctx.dispose();
    }

    private _onResize = (): void => {
        this._ctx.renderer?.resize();
    };

    private _flash(text: string): void {
        this._dom.statusBig.textContent = text;
        this._dom.statusBig.classList.remove("hidden");
    }

    private _startLoop(): void {
        if (this._loopStarted) return;
        this._loopStarted = true;
        const loop = (): void => {
            this._rafId = requestAnimationFrame(loop);
            this._ctx.frameRender();
            const splat = this._ctx.scene.objects.find((o) => o instanceof SPLAT.Splat) as SPLAT.Splat | undefined;
            const name = this._currentScene ? this._currentScene.name : "-";
            this._updateOverlay(name, splat ? splat.data.vertexCount : 0);
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
