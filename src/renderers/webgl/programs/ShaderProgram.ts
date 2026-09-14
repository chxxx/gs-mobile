import { Camera } from "../../../cameras/Camera";
import { Scene } from "../../../core/Scene";
import { WebGLRenderer } from "../../WebGLRenderer";
import { ShaderPass } from "../passes/ShaderPass";

abstract class ShaderProgram {
    private _renderer: WebGLRenderer;
    private _program: WebGLProgram;
    private _passes: ShaderPass[];
    /** 本程序创建的着色器对象（deleteProgram 之外还要 deleteShader，否则逐轮泄漏） */
    private _shaders: WebGLShader[] = [];
    /** dispose 幂等标志：已释放的程序不再渲染（gl 对象已删除，再 useProgram 会报错） */
    private _disposed = false;

    protected _scene: Scene | null = null;
    protected _camera: Camera | null = null;
    protected _started: boolean = false;
    protected _initialized: boolean = false;

    protected abstract _initialize: () => void;
    protected abstract _resize: () => void;
    protected abstract _render: () => void;
    protected abstract _dispose: () => void;

    initialize: () => void;
    resize: () => void;
    render: (scene: Scene, camera: Camera) => void;
    dispose: () => void;

    constructor(renderer: WebGLRenderer, passes: ShaderPass[]) {
        this._renderer = renderer;
        const gl = renderer.gl;

        this._program = gl.createProgram() as WebGLProgram;
        this._passes = passes || [];

        const vertexShader = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
        gl.shaderSource(vertexShader, this._getVertexSource());
        gl.compileShader(vertexShader);
        if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(vertexShader));
        }

        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
        gl.shaderSource(fragmentShader, this._getFragmentSource());
        gl.compileShader(fragmentShader);
        if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(fragmentShader));
        }

        this._shaders.push(vertexShader, fragmentShader); // 供 dispose 删除，避免泄漏

        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            console.error(gl.getProgramInfoLog(this.program));
        }

        /**
         * 只回收"已初始化的运行时状态"（passes + 纹理/缓冲/Worker），**不动 GL 程序对象本身**。
         * render() 在检测到 scene/camera 变化时会走这里再 initialize()，这条路径不能删程序：
         * 首帧就属于这条路径（_scene 从 null 变成真实 scene），删掉程序会导致
         * "drawArraysInstanced: no valid shader program in use" + 全部贴图/排序数据建不出来。
         */
        const teardownInitialized = (): void => {
            if (!this._initialized) return;

            gl.useProgram(this._program);

            for (const pass of this.passes) {
                pass.dispose();
            }

            this._dispose();

            this._scene = null;
            this._camera = null;
            this._initialized = false;
        };

        this.resize = () => {
            if (this._disposed) return;
            gl.useProgram(this._program);

            this._resize();
        };

        this.initialize = () => {
            console.assert(!this._initialized, "ShaderProgram already initialized");

            gl.useProgram(this._program);

            this._initialize();
            for (const pass of this.passes) {
                pass.initialize(this);
            }

            this._initialized = true;
            this._started = true;
        };

        this.render = (scene: Scene, camera: Camera) => {
            if (this._disposed) return; // 程序已被真正释放（WebGLRenderer.dispose()）：不再渲染

            gl.useProgram(this._program);

            if (this._scene !== scene || this._camera !== camera) {
                teardownInitialized();
                this._scene = scene;
                this._camera = camera;
                this.initialize();
            }

            for (const pass of this.passes) {
                pass.render();
            }

            this._render();
        };

        this.dispose = () => {
            if (this._disposed) return;
            this._disposed = true;

            // 先回收运行时状态（纹理/缓冲/Worker/passes），再删除 GL 程序与着色器对象。
            // GL 程序与着色器由本类创建，必须在 dispose 时显式删除：漏删会让"每轮新建上下文/程序"
            // 的用法（bench-case 的 iframe、频繁重建 renderer 的页面）逐轮泄漏 GL 句柄。
            teardownInitialized();

            gl.useProgram(null);
            gl.deleteProgram(this._program);
            for (const shader of this._shaders) {
                gl.deleteShader(shader);
            }
            this._shaders.length = 0;
        };
    }

    get renderer() {
        return this._renderer;
    }

    get scene() {
        return this._scene;
    }

    get camera() {
        return this._camera;
    }

    get program() {
        return this._program;
    }

    get passes() {
        return this._passes;
    }

    get started() {
        return this._started;
    }

    protected abstract _getVertexSource(): string;
    protected abstract _getFragmentSource(): string;
}

export { ShaderProgram };
