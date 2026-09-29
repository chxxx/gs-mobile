import type { Scene } from "../core/Scene";
import { FadeInPass } from "./webgl/passes/FadeInPass";
import { Camera } from "../cameras/Camera";
import { Color32 } from "../math/Color32";
import { ShaderProgram } from "./webgl/programs/ShaderProgram";
import { RenderProgram } from "./webgl/programs/RenderProgram";
import { ShaderPass } from "./webgl/passes/ShaderPass";
import { OffscreenRenderTarget } from "./webgl/utils/OffscreenBenchTarget";

export class WebGLRenderer {
    private _canvas: HTMLCanvasElement;
    private _gl: WebGL2RenderingContext;
    private _backgroundColor: Color32 = new Color32();
    private _renderProgram: RenderProgram;
    private _pixelRatio: number = window.devicePixelRatio || 1;
    private _autoResize = true;
    /**
     * 离屏基准协议用的渲染目标（缺省 null = 历史行为：直接渲染到 canvas 的默认 framebuffer）。
     * 只有显式调用 `createOffscreenTarget()`（第 7 章离屏基准测试）才会非 null，
     * 其余所有路径（demo / bench-view / 在屏协议）行为逐字不变。
     */
    private _offscreenTarget: OffscreenRenderTarget | null = null;

    addProgram: (program: ShaderProgram) => void;
    removeProgram: (program: ShaderProgram) => void;
    resize: () => void;
    setSize: (width: number, height: number) => void;
    setPixelRatio: (pixelRatio: number) => void;
    disableAutoResize: () => void;
    enableAutoResize: () => void;
    render: (scene: Scene, camera: Camera) => void;
    dispose: () => void;

    /** 创建离屏渲染目标（FBO + 颜色 renderbuffer，尺寸 = 基准分辨率）。返回是否创建成功。 */
    createOffscreenTarget: (width: number, height: number) => boolean;
    /** 释放离屏渲染目标；释放后渲染路径立即回到 canvas 默认 framebuffer。 */
    disposeOffscreenTarget: () => void;
    /** 在"离屏目标已绑定"的状态下执行 `fn`（像素探针用：`readPixels` 读当前绑定的 framebuffer）。 */
    withOffscreenTargetBound: <T>(fn: () => T) => T;

    constructor(optionalCanvas: HTMLCanvasElement | null = null, optionalRenderPasses: ShaderPass[] | null = null) {
        const canvas: HTMLCanvasElement = optionalCanvas || document.createElement("canvas");
        if (!optionalCanvas) {
            canvas.style.display = "block";
            canvas.style.boxSizing = "border-box";
            canvas.style.width = "100%";
            canvas.style.height = "100%";
            canvas.style.margin = "0";
            canvas.style.padding = "0";
            document.body.appendChild(canvas);
        }
        canvas.style.background = this._backgroundColor.toHexString();
        this._canvas = canvas;

        // 取不到上下文时若继续，会在 gl.createProgram() 处抛
        // "Cannot read properties of null (reading 'createProgram')"，对手机端（内核不支持 WebGL2
        // 或硬件加速被关闭）极难排查；这里直接给出可操作的错误信息。
        // [POWERPREF 2026-09-29] `?powerpref=` 覆盖上下文性能等级声明：
        //   取值 `high-performance` / `low-power` / `default`；**缺省或不认识的值 ⇒ 不传该字段**
        //   （与历史逐字相同，老数据不受影响）。用途：验证"两臂请求的性能等级是否不同"这条假设。
        const powerPref = (() => {
            try {
                if (typeof location === "undefined") return "";
                const v = new URLSearchParams(location.search).get("powerpref") || "";
                return v === "high-performance" || v === "low-power" || v === "default" ? v : "";
            } catch {
                return "";
            }
        })();
        const contextAttrs: WebGLContextAttributes = { antialias: false };
        if (powerPref) {
            contextAttrs.powerPreference = powerPref as WebGLPowerPreference;
        }
        const gl = canvas.getContext("webgl2", contextAttrs) as WebGL2RenderingContext | null;
        if (!gl) {
            throw new Error(
                "WebGL2 不可用：canvas.getContext('webgl2') 返回 null。" +
                    "请在浏览器设置中开启硬件加速，或改用支持 WebGL2 的浏览器/内核（Chrome、Edge、微信 XWEB）。",
            );
        }
        this._gl = gl;

        const renderPasses = optionalRenderPasses || [];
        if (!optionalRenderPasses) {
            renderPasses.push(new FadeInPass());
        }

        this._renderProgram = new RenderProgram(this, renderPasses);
        const programs = [this._renderProgram] as ShaderProgram[];

        this.resize = () => {
            if (!this._autoResize) return;
            const width = Math.floor(canvas.clientWidth * this._pixelRatio);
            const height = Math.floor(canvas.clientHeight * this._pixelRatio);
            if (canvas.width !== width || canvas.height !== height) {
                this.setSize(width, height);
            }
        };

        this.disableAutoResize = () => {
            this._autoResize = false;
        };

        this.enableAutoResize = () => {
            this._autoResize = true;
            this.resize();
        };

        this.setPixelRatio = (pixelRatio: number) => {
            this._pixelRatio = pixelRatio;
            this.resize();
        };

        this.setSize = (width: number, height: number) => {
            canvas.width = width;
            canvas.height = height;
            this._gl.viewport(0, 0, canvas.width, canvas.height);
            for (const program of programs) {
                program.resize();
            }
        };

        this.render = (scene: Scene, camera: Camera) => {
            // 离屏基准协议（Flux-GS §5.1）：把这一帧的渲染命令全部落到自建 FBO 上，不呈现到屏幕。
            // 未创建离屏目标时 `_offscreenTarget === null`，这段完全不执行 → 行为与历史版本逐字相同。
            const offscreen = this._offscreenTarget;
            if (offscreen && offscreen.ready) {
                offscreen.bind();
                for (const program of programs) {
                    program.render(scene, camera);
                }
                offscreen.unbind();
                return;
            }
            for (const program of programs) {
                program.render(scene, camera);
            }
        };

        this.dispose = () => {
            this.disposeOffscreenTarget();
            for (const program of programs) {
                program.dispose();
            }
        };

        this.createOffscreenTarget = (width: number, height: number) => {
            this.disposeOffscreenTarget();
            const target = new OffscreenRenderTarget(this._gl, width, height);
            if (!target.ready) {
                if (target.reason) console.error(`[WebGLRenderer] 离屏渲染目标不可用：${target.reason}`);
                target.dispose();
                return false;
            }
            this._offscreenTarget = target;
            return true;
        };

        this.disposeOffscreenTarget = () => {
            if (!this._offscreenTarget) return;
            // 释放前先解绑，避免把"已删除的 FBO"留在绑定槽里（后续绘制会打到无效目标）
            this._offscreenTarget.unbind();
            this._offscreenTarget.dispose();
            this._offscreenTarget = null;
        };

        this.withOffscreenTargetBound = <T>(fn: () => T): T => {
            const offscreen = this._offscreenTarget;
            if (!offscreen || !offscreen.ready) return fn();
            return offscreen.withBound(fn);
        };

        this.addProgram = (program: ShaderProgram) => {
            programs.push(program);
        };

        this.removeProgram = (program: ShaderProgram) => {
            const index = programs.indexOf(program);
            if (index < 0) {
                throw new Error("Program not found");
            }
            programs.splice(index, 1);
        };

        this.resize();
    }

    get canvas() {
        return this._canvas;
    }

    get gl() {
        return this._gl;
    }

    get renderProgram() {
        return this._renderProgram;
    }

    get backgroundColor() {
        return this._backgroundColor;
    }

    set backgroundColor(value: Color32) {
        this._backgroundColor = value;
        this._canvas.style.background = value.toHexString();
    }

    /** 当前离屏渲染目标（未启用时 null）；供基准测试读取尺寸/完整性/指纹。 */
    get offscreenTarget(): OffscreenRenderTarget | null {
        return this._offscreenTarget;
    }

    /** 是否正在渲染到离屏 FBO（false = 历史行为：canvas 默认 framebuffer）。 */
    get hasOffscreenTarget(): boolean {
        const target = this._offscreenTarget;
        return target !== null && target.ready;
    }
}
