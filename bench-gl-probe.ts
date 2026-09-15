/**
 * bench-gl-probe.ts — 三方法共用的**外部观察者**（条件 4：draw 用作用域归因，不用简单相减）。
 *
 * 只对**已有对象**做实例级/原型级包装，不创建 WebGL 上下文、不创建 Worker、不碰 `./src`：
 *   - GL：draw*（drawArraysInstanced / drawElementsInstanced / drawArrays / drawElements）、
 *         bufferData / bufferSubData、finish
 *   - Worker：出站 postMessage = 排序请求；入站（带 depthIndex）= 排序完成
 *   - 全局：requestAnimationFrame（调度与回调）、setTimeout（调度）
 *
 * 计数分两类：
 *   - 窗口计数：只在 `openWindow()` 与 `closeWindow()` 之间累加（正式测量窗口）
 *   - 全局计数：用于 `pendingSorts()`（在飞排序数 = 出站 − 入站），窗口边界读取
 */
import type { BenchProbe, WindowCounters } from "./bench-controller";

export interface ProbeCounters extends WindowCounters {
    /** `gl.finish()` 调用次数（每轮应恰好 2 次：preFinish + postFinish） */
    finishCalls: number;
    /** 窗口内 `gl.bufferData` / `bufferSubData` 的总字节数 */
    bufferUploadBytes: number;
    /** 窗口内**新申请**的 rAF 次数（区分"回调触发"与"主动自挂"） */
    rafSchedules: number;
    /** 窗口内非 depthIndex 的 worker 入站消息 */
    workerInboundOther: number;
    /** `beginControlledFrame`/`endControlledFrame` 括号不匹配次数（应为 0） */
    scopeMismatches: number;
    /** 窗口内每个受控帧的 serial（用于核对 drawCallsPerFrame 与帧号对应） */
    drawSerials: number[];
}

export function emptyProbeCounters(): ProbeCounters {
    return {
        sortRequests: 0,
        sortCompleted: 0,
        indexBufferUploads: 0,
        drawCalls: 0,
        drawInstances: 0,
        drawCallsPerFrame: [],
        unexpectedDrawCalls: 0,
        unexpectedFrameCallbacks: 0,
        rafCalls: 0,
        timerSchedules: 0,
        finishCalls: 0,
        bufferUploadBytes: 0,
        rafSchedules: 0,
        workerInboundOther: 0,
        scopeMismatches: 0,
        drawSerials: [],
    };
}

export interface ProbeTargets {
    /** 已存在的 WebGL2 上下文（ours/reduced-3dgs 复用；Flux 用它的 gl） */
    gl?: object | null;
    /** `requestAnimationFrame` 的来源（浏览器为 window） */
    rafOwner?: object | null;
    /** `setTimeout` 的来源（浏览器为 window） */
    timerOwner?: object | null;
    /** Worker 原型（浏览器为 `Worker.prototype`），用于拦截 postMessage / onmessage */
    workerProto?: object | null;
    /** 探针安装所在的 realm（必须与 renderer/worker 同一 realm，否则完全无效） */
    realm?: "case-iframe" | "parent" | "unknown";
    /** 取时刻的函数（用于判定"探针是否早于 worker 创建"） */
    nowMs?: () => number;
    /** worker 创建时刻（可选；绑定时用它判定安装先后） */
    workerCreatedAtMs?: number;
}

/**
 * 探针权威等级（阶段 7A 结论）：
 * 排序有效性的**权威来源是 renderer bridge 的 `getSortAudit()`**；
 * 外部 Worker/GL wrap 只能作交叉验证，其计数**不得**单独作为排序有效性的唯一依据。
 */
export interface ProbeAuthority {
    sortAuditAuthority: "renderer-bridge";
    probeRealmMatched: boolean;
    probeBoundToSortWorkerInstance: boolean;
    probeInstalledBeforeWorkerCreation: boolean;
    probeReattachedExistingHandler: boolean;
    sortWorkerRequestsObserved: number;
    sortWorkerCompletionsObserved: number;
    boundWorkerCount: number;
    note: string;
}

interface GlFacade {
    drawArraysInstanced?: (...args: unknown[]) => unknown;
    drawElementsInstanced?: (...args: unknown[]) => unknown;
    drawArrays?: (...args: unknown[]) => unknown;
    drawElements?: (...args: unknown[]) => unknown;
    bufferData?: (...args: unknown[]) => unknown;
    bufferSubData?: (...args: unknown[]) => unknown;
    finish?: () => unknown;
}

const GL_DRAW_METHODS = ["drawArraysInstanced", "drawElementsInstanced", "drawArrays", "drawElements"] as const;
const GL_DRAW_INSTANCE_ARG: Record<string, number> = {
    drawArraysInstanced: 3, // mode, first, count, instanceCount
    drawElementsInstanced: 4, // mode, count, type, offset, instanceCount
    drawArrays: 2, // mode, first, count ⇒ 视为 1 个实例
    drawElements: 3, // mode, count, type, offset ⇒ 视为 1 个实例
};

export class GlProbe implements BenchProbe {
    private counts: ProbeCounters = emptyProbeCounters();
    private open = false;
    private scopeStack: number[] = [];
    private scopeDraws = new Map<number, number>();
    private totalSortRequests = 0;
    private totalSortCompletions = 0;
    private restores: Array<() => void> = [];
    private targets: ProbeTargets = {};
    private attached = false;
    // ---- 权威等级（阶段 7A）
    private authorityRealmMatched = false;
    private authorityBoundToSortWorker = false;
    private authorityInstalledBeforeWorker = false;
    private authorityReattachedHandler = false;
    private boundWorkers = new Set<object>();
    private prototypeWrapInstalled = false;
    private originalWorkerPostMessage: ((...a: unknown[]) => unknown) | null = null;
    private boundWorkerRequests = 0;
    private boundWorkerCompletions = 0;
    private rearmDepth = 0;
    /** 已由本探针包装过的入站 handler（幂等保护：重复赋值不得重复包装 ⇒ 避免重复计数）。 */
    private wrappedInboundHandlers = new WeakSet<object>();

    markInboundHandlerWrapped(handler: object): void {
        this.wrappedInboundHandlers.add(handler);
    }

    isInboundHandlerWrapped(handler: object): boolean {
        return this.wrappedInboundHandlers.has(handler);
    }

    /** 该实例是否已被 `bindSortWorker` 绑定（入站消息按实例归属用）。 */
    isBoundWorker(candidate: object): boolean {
        return this.boundWorkers.has(candidate);
    }

    /** 是否已有绑定实例（绑定后原型级计数收敛为"仅绑定实例"，避免误计其它 worker）。 */
    hasBoundWorkers(): boolean {
        return this.boundWorkers.size > 0;
    }

    /** 是否正在"迟到绑定"时重挂已注册的 onmessage handler（诊断字段）。 */
    get rearmingBoundWorker(): boolean {
        return this.rearmDepth > 0;
    }

    get isAttached(): boolean {
        return this.attached;
    }

    get isWindowOpen(): boolean {
        return this.open;
    }

    // ---------------------------------------------------------- BenchProbe
    openWindow(): void {
        this.counts = emptyProbeCounters();
        this.scopeDraws.clear();
        this.open = true;
    }

    closeWindow(): void {
        this.open = false;
        this.scopeStack = [];
    }

    pendingSorts(): number {
        return Math.max(0, this.totalSortRequests - this.totalSortCompletions);
    }

    beginControlledFrame(frameSerial: number): void {
        this.scopeStack.push(frameSerial);
    }

    endControlledFrame(frameSerial?: number): void {
        const top = this.scopeStack.pop();
        if (top === undefined) {
            this.counts.scopeMismatches++;
            return;
        }
        if (typeof frameSerial === "number" && top !== frameSerial) this.counts.scopeMismatches++;
    }

    snapshotWindow(): WindowCounters {
        return {
            sortRequests: this.counts.sortRequests,
            sortCompleted: this.counts.sortCompleted,
            indexBufferUploads: this.counts.indexBufferUploads,
            drawCalls: this.counts.drawCalls,
            drawInstances: this.counts.drawInstances,
            drawCallsPerFrame: [...this.counts.drawCallsPerFrame],
            unexpectedDrawCalls: this.counts.unexpectedDrawCalls,
            unexpectedFrameCallbacks: this.counts.unexpectedFrameCallbacks,
            rafCalls: this.counts.rafCalls,
            timerSchedules: this.counts.timerSchedules,
        };
    }

    /** 完整快照（含 finish/字节/rAF 调度等诊断字段） */
    snapshotWindowFull(): ProbeCounters {
        return {
            ...this.counts,
            drawCallsPerFrame: [...this.counts.drawCallsPerFrame],
            drawSerials: [...this.counts.drawSerials],
        };
    }

    currentFrameSerial(): number | null {
        return this.scopeStack.length > 0 ? this.scopeStack[this.scopeStack.length - 1] : null;
    }

    /** 某 serial 在窗口内的 draw 次数（作用域归因，不做减法） */
    drawCallsOfFrame(frameSerial: number): number {
        return this.scopeDraws.get(frameSerial) ?? 0;
    }

    // ---------------------------------------------------------- 事件钩子
    onDraw(instanceCount = 1): void {
        if (!this.open) return;
        this.counts.drawCalls++;
        this.counts.drawInstances += instanceCount;
        const scope = this.currentFrameSerial();
        if (scope === null) {
            // 不属于任何受控帧的 draw ⇒ 只能计为 unexpected（条件 4）
            this.counts.unexpectedDrawCalls++;
        } else {
            const i = scope - 1;
            this.counts.drawCallsPerFrame[i] = (this.counts.drawCallsPerFrame[i] ?? 0) + 1;
            this.scopeDraws.set(scope, (this.scopeDraws.get(scope) ?? 0) + 1);
            if (!this.counts.drawSerials.includes(scope)) this.counts.drawSerials.push(scope);
        }
    }

    onBufferUpload(bytes = 0): void {
        if (!this.open) return;
        this.counts.indexBufferUploads++;
        if (Number.isFinite(bytes) && bytes > 0) this.counts.bufferUploadBytes += bytes;
    }

    onFinish(): void {
        if (!this.open) return;
        this.counts.finishCalls++;
    }

    onRafSchedule(): void {
        if (!this.open) return;
        this.counts.rafSchedules++;
    }

    /** rAF 回调**触发**：controller 从不使用 rAF ⇒ 窗口内触发即为 unexpected。 */
    onRafFire(): void {
        if (!this.open) return;
        this.counts.rafCalls++;
        this.counts.unexpectedFrameCallbacks++;
    }

    onTimerSchedule(): void {
        if (!this.open) return;
        this.counts.timerSchedules++;
    }

    // ---------------------------------------------------------- 手动上报（adapter 用）
    noteSortRequest(fromBoundInstance = false): void {
        this.totalSortRequests++;
        if (this.open) this.counts.sortRequests++;
        if (fromBoundInstance) this.boundWorkerRequests++;
    }

    noteSortCompleted(fromBoundInstance = false): void {
        this.totalSortCompletions++;
        if (this.open) this.counts.sortCompleted++;
        if (fromBoundInstance) this.boundWorkerCompletions++;
    }

    /** 入站 worker 消息：带 `depthIndex` 视为一次排序完成；`fromBoundInstance` 由调用方按实例归属判定。 */
    noteWorkerInbound(payload: unknown, fromBoundInstance = false): void {
        const hasDepthIndex =
            typeof payload === "object" && payload !== null && "depthIndex" in (payload as Record<string, unknown>);
        if (hasDepthIndex) {
            this.noteSortCompleted(fromBoundInstance);
        } else if (this.open) {
            this.counts.workerInboundOther++;
        }
    }

    // ---------------------------------------------------------- 包装 / 还原
    attach(targets: ProbeTargets): void {
        this.detach();
        this.targets = targets;
        this.authorityRealmMatched = targets.realm === "case-iframe";
        if (targets.gl) this.wrapGl(targets.gl as GlFacade);
        if (targets.workerProto) this.wrapWorkerProto(targets.workerProto as Record<string, unknown>);
        if (targets.rafOwner) this.wrapRafOwner(targets.rafOwner as Record<string, unknown>, "requestAnimationFrame");
        if (targets.timerOwner) this.wrapTimerOwner(targets.timerOwner as Record<string, unknown>, "setTimeout");
        this.attached = true;
    }

    /**
     * 把探针**绑定到具体的排序 worker 实例**（权威计数的前提）。
     *
     * 为什么必须按实例绑定：ours/reduced 同时存在 3 个 worker（SortWorker / DataWorker /
     * LowRankQPLYWorker），全局 `Worker.prototype.postMessage` 会把加载与数据构建的消息误计为排序请求。
     *
     * 安装过晚也能补救：若该实例已经注册过 `onmessage`，这里会把原 handler **重新赋值**一次，
     * 让它经过我们的原型 setter ⇒ 之后的入站消息仍可计数（`probeReattachedExistingHandler=true`）。
     */
    bindSortWorker(worker: object, opts?: { createdAtMs?: number }): void {
        const rec = worker as Record<string, unknown>;
        const current = rec.postMessage;
        const base =
            this.prototypeWrapInstalled && this.originalWorkerPostMessage
                ? this.originalWorkerPostMessage
                : (current as (...a: unknown[]) => unknown);
        if (this.boundWorkers.has(worker)) {
            // 已绑定：只更新安装先后信息，不叠加包装
        } else {
            this.override(worker, "postMessage", makeWorkerPostMessageWrapper(this, base));
            this.boundWorkers.add(worker);
        }

        // 迟到的绑定：把已注册的 handler 重新走一遍 setter（原型 accessor 已包装时即被纳入计数）
        const existing = rec.onmessage;
        if (typeof existing === "function") {
            this.rearmDepth++;
            try {
                rec.onmessage = existing;
            } finally {
                this.rearmDepth--;
            }
            this.authorityReattachedHandler = true;
        }

        const attachedAt = this.targets.nowMs ? this.targets.nowMs() : NaN;
        const createdAt = opts?.createdAtMs ?? this.targets.workerCreatedAtMs;
        this.authorityInstalledBeforeWorker =
            typeof createdAt === "number" && Number.isFinite(attachedAt) ? attachedAt <= createdAt : false;
        this.authorityBoundToSortWorker = true;
    }

    /** 权威等级快照（必须写入每个测量结果，供人工核对）。 */
    getAuthority(): ProbeAuthority {
        return {
            sortAuditAuthority: "renderer-bridge",
            probeRealmMatched: this.authorityRealmMatched,
            probeBoundToSortWorkerInstance: this.authorityBoundToSortWorker,
            probeInstalledBeforeWorkerCreation: this.authorityInstalledBeforeWorker,
            probeReattachedExistingHandler: this.authorityReattachedHandler,
            sortWorkerRequestsObserved: this.boundWorkerRequests,
            sortWorkerCompletionsObserved: this.boundWorkerCompletions,
            boundWorkerCount: this.boundWorkers.size,
            note:
                "排序有效性以 renderer bridge 的 getSortAudit() 为权威；" +
                "外部 Worker/GL wrap 仅作交叉验证，不得单独作为唯一依据。",
        };
    }

    detach(): void {
        while (this.restores.length > 0) {
            const restore = this.restores.pop();
            if (restore) restore();
        }
        this.attached = false;
        this.targets = {};
        this.prototypeWrapInstalled = false;
        this.originalWorkerPostMessage = null;
        this.boundWorkers.clear();
        this.authorityBoundToSortWorker = false;
        this.authorityInstalledBeforeWorker = false;
        this.authorityReattachedHandler = false;
        this.authorityRealmMatched = false;
        this.boundWorkerRequests = 0;
        this.boundWorkerCompletions = 0;
    }

    private override(obj: object, key: string, value: unknown): void {
        const rec = obj as Record<string, unknown>;
        const own = Object.getOwnPropertyDescriptor(obj, key);
        Object.defineProperty(obj, key, {
            value,
            writable: true,
            configurable: true,
            enumerable: own?.enumerable ?? false,
        });
        this.restores.push(() => {
            if (own) Object.defineProperty(obj, key, own);
            else delete rec[key];
        });
    }

    // ---------------------------------------------------------- 各种目标的具体包装
    private wrapGl(gl: GlFacade): void {
        for (const name of GL_DRAW_METHODS) {
            const orig = gl[name as keyof GlFacade];
            if (typeof orig !== "function") continue;
            this.override(gl, name, makeGlDrawWrapper(this, gl, orig, GL_DRAW_INSTANCE_ARG[name]));
        }
        for (const name of ["bufferData", "bufferSubData"] as const) {
            const orig = gl[name];
            if (typeof orig !== "function") continue;
            const dataIndex = name === "bufferData" ? 1 : 2;
            this.override(gl, name, makeGlUploadWrapper(this, gl, orig, dataIndex));
        }
        const finish = gl.finish;
        if (typeof finish === "function") this.override(gl, "finish", makeGlFinishWrapper(this, gl, finish));
    }

    private wrapWorkerProto(proto: Record<string, unknown>): void {
        const pm = proto.postMessage;
        if (typeof pm === "function") {
            this.originalWorkerPostMessage = pm as (...a: unknown[]) => unknown;
            this.prototypeWrapInstalled = true;
            this.override(proto, "postMessage", makeWorkerPostMessageWrapper(this, this.originalWorkerPostMessage));
        }
        this.overrideAccessor(proto, "onmessage");
    }

    /** 包装访问器型属性（`Worker.prototype.onmessage`）：拦截 set，回调触发时上报入站消息。 */
    private overrideAccessor(obj: object, key: string): void {
        const desc = Object.getOwnPropertyDescriptor(obj, key);
        if (desc && "value" in desc) return; // 数据属性不是回调注册点
        const hasAccessor = !!(desc && (desc.get || desc.set));
        const backing = new WeakMap<object, unknown>();
        const getter =
            hasAccessor && desc!.get
                ? desc!.get
                : function (this: object): unknown {
                      return backing.get(this);
                  };
        const setter =
            hasAccessor && desc!.set
                ? desc!.set
                : function (this: object, v: unknown): void {
                      void backing.set(this, v);
                  };
        Object.defineProperty(obj, key, {
            configurable: true,
            enumerable: desc?.enumerable ?? false,
            get(this: object): unknown {
                return getter.call(this);
            },
            set: makeWorkerInboundSetter(this, setter),
        });
        this.restores.push(() => {
            if (desc) Object.defineProperty(obj, key, desc);
            else delete (obj as Record<string, unknown>)[key];
        });
    }

    private wrapRafOwner(owner: Record<string, unknown>, key: string): void {
        const orig = owner[key];
        if (typeof orig !== "function") return;
        this.override(owner, key, makeRafWrapper(this, owner, orig as (cb: (t: number) => void) => number));
    }

    private wrapTimerOwner(owner: Record<string, unknown>, key: string): void {
        const orig = owner[key];
        if (typeof orig !== "function") return;
        this.override(owner, key, makeTimerWrapper(this, owner, orig as (...a: unknown[]) => unknown));
    }

    /** 已包装的目标快照（诊断用） */
    get attachedTargets(): Readonly<ProbeTargets> {
        return this.targets;
    }
}

function byteLengthOf(value: unknown): number {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    return 0;
}

// ------------------------------------------------------------------ wrapper 构造（模块级：probe 只经参数传入，避免 this 别名）
function drawInstanceCount(args: unknown[], argIndex: number): number {
    const raw = args[argIndex];
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function makeGlDrawWrapper(
    probe: GlProbe,
    gl: GlFacade,
    orig: (...a: unknown[]) => unknown,
    argIndex: number,
): (...args: unknown[]) => unknown {
    return (...args: unknown[]): unknown => {
        probe.onDraw(drawInstanceCount(args, argIndex));
        return orig.apply(gl, args);
    };
}

function makeGlUploadWrapper(
    probe: GlProbe,
    gl: GlFacade,
    orig: (...a: unknown[]) => unknown,
    dataIndex: number,
): (...args: unknown[]) => unknown {
    return (...args: unknown[]): unknown => {
        probe.onBufferUpload(byteLengthOf(args[dataIndex]));
        return orig.apply(gl, args);
    };
}

function makeGlFinishWrapper(probe: GlProbe, gl: GlFacade, orig: () => unknown): () => unknown {
    return (): unknown => {
        probe.onFinish();
        return orig.call(gl);
    };
}

function makeWorkerPostMessageWrapper(
    probe: GlProbe,
    orig: (...a: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
    // 必须保留调用时的 this（真实 Worker.prototype.postMessage 以 this=worker 调用，
    // 若固定为原型对象会抛 "Illegal invocation"）
    return function (this: unknown, ...args: unknown[]): unknown {
        // 计数规则：未绑定时按原型级统计（交叉验证模式）；
        // 一旦 `bindSortWorker` 绑定过实例，就**只统计绑定实例**，避免把 DataWorker /
        // LowRankQPLYWorker 等其它 worker 的消息误计为排序请求。
        const isBound = typeof this === "object" && this !== null && probe.isBoundWorker(this);
        if (isBound || !probe.hasBoundWorkers()) {
            probe.noteSortRequest(isBound);
        }
        return orig.apply(this, args);
    };
}

/** setter 必须是普通函数（需要目标实例作 this），probe 只能经参数传入。 */
function makeWorkerInboundSetter(
    probe: GlProbe,
    setter: (this: object, v: unknown) => void,
): (this: object, fn: unknown) => void {
    return function (this: object, fn: unknown): void {
        if (typeof fn !== "function") {
            setter.call(this, fn);
            return;
        }
        // 幂等：已经是我们包装过的 handler（例如迟到绑定时重新赋值）⇒ 原样存入，不重复包装
        if (probe.isInboundHandlerWrapped(fn)) {
            setter.call(this, fn);
            return;
        }
        const handler = fn as (ev: unknown) => unknown;
        const wrapped = function (this: object, ev: unknown): unknown {
            probe.noteWorkerInbound((ev as { data?: unknown } | null)?.data, probe.isBoundWorker(this));
            return handler.call(this, ev);
        };
        probe.markInboundHandlerWrapped(wrapped);
        setter.call(this, wrapped);
    };
}

function makeRafWrapper(
    probe: GlProbe,
    owner: object,
    orig: (cb: (t: number) => void) => number,
): (cb: (t: number) => void) => number {
    return (cb: (t: number) => void): number => {
        probe.onRafSchedule();
        return orig.call(owner, (t: number) => {
            probe.onRafFire();
            cb(t);
        });
    };
}

function makeTimerWrapper(
    probe: GlProbe,
    owner: object,
    orig: (...a: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
    return (...args: unknown[]): unknown => {
        probe.onTimerSchedule();
        return orig.apply(owner, args);
    };
}
