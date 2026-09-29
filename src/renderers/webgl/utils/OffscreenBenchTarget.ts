/**
 * OffscreenBenchTarget.ts — **离屏基准测试**用的渲染目标与 GPU 栅栏门（仅测量路径使用）。
 *
 * 为什么放在 src/ 下而不是 bench-*.ts 里：同一份实现要被**两支臂**共用 ——
 *   1. 本文臂（`WebGLRenderer.createOffscreenTarget()`），gl 对象来自本仓库渲染器；
 *   2. Flux-GS 臂（`bench-flux.ts`），gl 对象来自 iframe 内 vendored 参考实现暴露的
 *      `__FLUXGS_BENCH_GL__()`。
 * 两臂套的是**同一个类**，因此"离屏渲染目标"与"非阻塞进度检查"在结构上不可能分叉——
 * 这是"离屏协议可跨方法比较"的前提。
 *
 * 复刻的论文口径（Flux-GS, Du et al. 2026, §5.1）：
 *   - `OffscreenRenderTarget`：`gl.createFramebuffer()` + 颜色 `gl.createRenderbuffer()`
 *     （`RGBA8`），尺寸 = 基准分辨率。渲染命令全部落在这个 FBO 上，**不呈现到屏幕**，
 *     因此不受屏幕 vsync / 浏览器合成器节流；
 *   - `NonBlockingFrameGate`：每帧只插一个 `fenceSync`，并用 `clientWaitSync(..., 0ns)`
 *     **非阻塞**轮询回收已完成的栅栏；只有在"在途栅栏数"超过上限（缺省 3）时才阻塞等待
 *     最老的那一个。它替代 `gl.finish()` 的每帧硬等，同时保证 GPU 命令队列不会无限积压。
 *
 * 未使用本模块时（`WebGLRenderer` 没有创建离屏目标），渲染器行为与历史版本**逐字相同**：
 * 所有函数都只在被显式调用时才产生 GL 调用。
 */

/** 只用到的那部分 WebGL2 API（结构化类型：真实 `WebGL2RenderingContext` 可直接传入，测试可传假对象）。 */
export interface GlFramebufferApi {
    createFramebuffer(): WebGLFramebuffer | null;
    bindFramebuffer(target: number, framebuffer: WebGLFramebuffer | null): void;
    createRenderbuffer(): WebGLRenderbuffer | null;
    bindRenderbuffer(target: number, renderbuffer: WebGLRenderbuffer | null): void;
    renderbufferStorage(target: number, internalformat: number, width: number, height: number): void;
    framebufferRenderbuffer(
        target: number,
        attachment: number,
        renderbuffertarget: number,
        renderbuffer: WebGLRenderbuffer | null,
    ): void;
    checkFramebufferStatus(target: number): number;
    deleteFramebuffer(framebuffer: WebGLFramebuffer | null): void;
    deleteRenderbuffer(renderbuffer: WebGLRenderbuffer | null): void;
    readonly FRAMEBUFFER: number;
    readonly RENDERBUFFER: number;
    readonly COLOR_ATTACHMENT0: number;
    readonly RGBA8: number;
    readonly FRAMEBUFFER_COMPLETE: number;
}

/** 只用到的那部分 GPU 同步 API（同样是结构化类型）。 */
export interface GlFenceApi {
    fenceSync(condition: number, flags: number): WebGLSync | null;
    clientWaitSync(sync: WebGLSync, flags: number, timeout: number): number;
    deleteSync(sync: WebGLSync | null): void;
    /**
     * `gl.flush()`：**必须有**。Chrome 把 WebGL 调用攒在渲染进程的 command buffer 里，
     * 只有 flush（或缓冲区写满 / 任务结束）才真正投给 GPU 进程；对一个"还没投出去"的栅栏调用
     * `clientWaitSync` 会立刻返回 `ALREADY_SIGNALED`（2026-09-26 实跑现场抓到的现象：
     * `offscreen_fences=0/3`、`fps=58333`——进度检查退化成"什么都不查"，命令队列无上限积压）。
     * `flush` 只是把命令交给 GPU 进程，**不等 GPU 执行完、也不等 vsync/合成器**，
     * 因此离屏协议"不受屏幕刷新率限制"的性质不受影响。
     */
    flush(): void;
    /**
     * `gl.finish()`：**唯一可靠的阻塞式 GPU 同步**（见 `NonBlockingFrameGate` 顶部关于
     * "为什么还要留一条 finish 通道"的现场实测记录）。
     */
    finish(): void;
    /**
     * `gl.readPixels()`：本环境里**真正会阻塞**的那一个操作（现场实测见
     * `NonBlockingFrameGate` 顶部：`gl.finish()` 返回 0.00ms、而 readPixels 会真实等待）。
     * 同步策略里只用 1×1 的读回（`readPixels(0,0,1,1,...)`）——它强制命令流排空，
     * 但数据传输量可忽略；两臂用的是同一次 1×1 读回，成本一致。
     */
    readPixels(
        x: number,
        y: number,
        width: number,
        height: number,
        format: number,
        type: number,
        pixels: Uint8Array,
    ): void;
    readonly RGBA: number;
    readonly UNSIGNED_BYTE: number;
    readonly SYNC_GPU_COMMANDS_COMPLETE: number;
    readonly ALREADY_SIGNALED: number;
    readonly CONDITION_SATISFIED: number;
}

/** 离屏渲染目标的实测状态（写进结果，用于证明"这一轮确实渲染到 FBO 而不是 canvas"）。 */
export interface OffscreenRenderTargetInfo {
    width: number;
    height: number;
    /** `checkFramebufferStatus()` 是否 `FRAMEBUFFER_COMPLETE` */
    complete: boolean;
    /** 创建/检查失败时的原因（成功时为空串） */
    reason: string;
}

/**
 * GPU 同步策略：
 *   - `"each"`：每帧 `gl.finish()` + **1×1 `readPixels`**（缺省）——`readPixels` 是本环境里唯一
 *     真正阻塞的操作，两者合起来保证"帧间隔 = 提交 + 真实 GPU 执行 + 一次可忽略的读回"；
 *   - `"fence"`：纯非阻塞栅栏门（`fenceSync` + `flush` + `clientWaitSync` + 积压上限）。
 * 取值来源见 `bench-shared.offscreenSyncMode()`（URL `?sync=each|fence`）。
 */
export type OffscreenSyncMode = "each" | "fence" | "gputimer" | "batch" | "none";

/** 同步探针需要的"离屏目标绑定"能力（两臂各自实现：本文臂走渲染器 API，基线臂自己 bind/unbind）。 */
export interface OffscreenSyncProbe {
    /** 在"离屏目标已绑定"的前提下执行 `fn`（1×1 `readPixels` 必须读在离屏目标上） */
    withTargetBound: <T>(fn: () => T) => T;
}

/** GPU 计时查询用到的那部分 WebGL2 API（结构化类型）。 */
export interface GlTimerQueryApi {
    getExtension(name: string): unknown;
    createQuery(): WebGLQuery | null;
    deleteQuery(query: WebGLQuery | null): void;
    beginQuery(target: number, query: WebGLQuery): void;
    endQuery(target: number): void;
    getQueryParameter(query: WebGLQuery, pname: number): unknown;
    getParameter(pname: number): unknown;
    readonly QUERY_RESULT_AVAILABLE: number;
    readonly QUERY_RESULT: number;
}

/**
 * GPU 计时器（`EXT_disjoint_timer_query_webgl2`）：**本环境唯一能可信测到"GPU 真实执行时间"的仪器**。
 *
 * 为什么必须有它（2026-09-26 现场实测，见 `NonBlockingFrameGate` 顶部对照表）：
 * 在这个环境里 `gl.finish()` 立即返回、`clientWaitSync` 超时不阻塞、1×1 `readPixels` 也不阻塞，
 * 于是任何"按帧间隔算 FPS"的读法都只会得到**提交速率**（实测 37k–67k FPS，物理上不可能）。
 * 计时查询走的是另一条路：它在 GPU 上打点、几帧后再取回**真实毫秒数**，不依赖任何阻塞语义。
 *
 * 口径：每帧 `begin()`（画之前）→ `end()`（画之后），结果在若干帧后才可取；每帧调一次 `collect()`
 * 回收已完成的样本。`GPU_DISJOINT_EXT` 为真时（GPU 时钟抖动/上下文切换）该样本作废——这是扩展
 * 规范要求的，丢弃样本数记在 `misses` 里可核对。
 */
export class OffscreenGpuTimer {
    private _gl: GlTimerQueryApi;
    private _ext: { TIME_ELAPSED_EXT: number } | null = null;
    private _timeElapsed: number;
    private _disjointParam: number;
    private _active: WebGLQuery | null = null;
    private _pending: WebGLQuery[] = [];
    private _samples: number[] = [];
    private _misses = 0;

    // ---- 逐步诊断计数器（2026-09-26 加入：此前 begin/end/collect 的异常被静默 catch，
    //      导致 `gpu_samples=0/0` 无法区分是"扩展没拿到"、"调用时序错"还是"驱动不支持"）。
    //      命名规则：<阶段><动作>Calls/Errors，全部可单独读，**不合并**成一个笼统的失败数。
    private _diag = {
        extFetched: 0, // 构造时成功拿到扩展对象
        extNull: 0, // 构造时没拿到扩展对象（或 ext 上没有 TIME_ELAPSED_EXT）
        extName: "", // 实际拿到的扩展名（在真机上是要害信息：许多 Android 两者都拿不到）
        extTried: 0, // 尝试过的扩展名个数（2 = webgl2 版 + 旧版都试过）
        ctxLost: 0, // isContextLost() 为真的次数（每次 begin/end 各探一次）
        createCalls: 0,
        createNull: 0, // createQuery() 返回 null
        createErrors: 0, // createQuery() 抛异常
        beginCalls: 0,
        beginErrors: 0, // beginQuery() 抛异常
        endCalls: 0,
        endErrors: 0, // endQuery() 抛异常
        activeOverwrite: 0, // begin 时上一帧还没 end（同一 query 被覆盖 = 最典型的坏用法）
        orphanEnd: 0, // end 时没有 active（begin 没成功）
        probeCalls: 0, // getQueryParameter(QUERY_RESULT_AVAILABLE) 次数
        probeTrue: 0, // 其中报"已完成"的次数
        probeErrors: 0, // 探测本身抛异常
        resultErrors: 0, // 读 QUERY_RESULT 抛异常
        disjointDrops: 0, // GPU_DISJOINT_EXT 为真 → 样本作废
        rangeDrops: 0, // 读数越界（负 / NaN / ≥1000ms）→ 样本作废
        lastError: "", // 最近一次异常的 name + message（能区分是哪一步）
    };

    private _note(stage: string, err: unknown): void {
        const e = err as { name?: string; message?: string };
        const text = `${stage}:${e && e.name ? e.name : "Error"}:${e && e.message ? e.message : String(err)}`;
        if (this._diag.lastError !== text) this._diag.lastError = text;
    }

    private _contextLost(): boolean {
        try {
            const lost = (this._gl as unknown as { isContextLost?: () => boolean }).isContextLost;
            return typeof lost === "function" ? lost.call(this._gl) === true : false;
        } catch {
            return false;
        }
    }

    constructor(gl: GlTimerQueryApi, disjointParam = 0x8fbb /* GPU_DISJOINT_EXT */) {
        this._gl = gl;
        this._timeElapsed = 0;
        this._disjointParam = disjointParam;
        // 依次尝试两个扩展名（2026-09-26 真机后追加）：
        //   - `EXT_disjoint_timer_query_webgl2` 是 WebGL2 的规范名；
        //   - 旧名 `EXT_disjoint_timer_query` 在部分 Chrome/ANGLE 版本上仍会（对 WebGL2 上下文）暴露；
        // 两个都试、并把"拿到的是哪个 / 都没拿到"写进诊断——真机上这是判断"能不能用 GPU 计时口径"
        // 的唯一现场，不能被一句笼统的 supported=false 吞掉。
        const names = ["EXT_disjoint_timer_query_webgl2", "EXT_disjoint_timer_query"];
        const fails: string[] = [];
        for (const name of names) {
            this._diag.extTried++;
            try {
                const ext = gl.getExtension(name) as { TIME_ELAPSED_EXT?: number } | null;
                if (ext && typeof ext.TIME_ELAPSED_EXT === "number") {
                    this._ext = ext as unknown as { TIME_ELAPSED_EXT: number };
                    this._timeElapsed = ext.TIME_ELAPSED_EXT;
                    this._diag.extFetched = 1;
                    this._diag.extName = name;
                    return;
                }
                fails.push(ext ? `${name}:no-TIME_ELAPSED_EXT` : `${name}:null`);
            } catch (err) {
                const e = err as { name?: string };
                fails.push(`${name}:${e && e.name ? e.name : "throw"}`);
                this._note("getExtension", err);
            }
        }
        this._ext = null;
        this._diag.extNull = 1;
        // 追加而不是覆盖：`_note()` 里可能已经存了 getExtension 抛出的异常名（现场最重要的一条），
        // 这里再补上"试过哪两个名字、各自失败原因"。
        const joined = fails.join(",");
        this._diag.lastError = this._diag.lastError ? `${this._diag.lastError} | ${joined}` : joined;
    }

    /** 逐步诊断的**一行可读摘要**（写进结果字段 `offscreen_gpu_diag=`，失败时是唯一现场）。 */
    diagLine(): string {
        const d = this._diag;
        return (
            `ext=${this._ext ? 1 : 0}(name=${d.extName || "-"},tried=${d.extTried},fetched=${d.extFetched},null=${d.extNull}) ` +
            `create=${d.createCalls}/${d.createNull}/${d.createErrors} ` +
            `begin=${d.beginCalls}/${d.beginErrors} end=${d.endCalls}/${d.endErrors} ` +
            `seq(overwrite=${d.activeOverwrite},orphanEnd=${d.orphanEnd}) ` +
            `probe=${d.probeCalls}/${d.probeTrue}/${d.probeErrors} ` +
            `resultErr=${d.resultErrors} drop(disjoint=${d.disjointDrops},range=${d.rangeDrops}) ` +
            `ctxLost=${d.ctxLost} samples=${this._samples.length} pending=${this._pending.length} ` +
            `err=${d.lastError || "-"}`
        );
    }

    /** 结构化诊断（供测试/程序化断言用）。 */
    diag() {
        return { ...this._diag, samples: this._samples.length, pending: this._pending.length };
    }

    get supported(): boolean {
        return this._ext !== null;
    }

    get samples(): number[] {
        return this._samples;
    }

    get misses(): number {
        return this._misses;
    }

    /** 画这一帧**之前**调用。 */
    begin(): void {
        if (!this._ext) return;
        if (this._contextLost()) this._diag.ctxLost++;
        // 时序自查：上一帧的查询还没 end 就又开始新的 —— disjoint timer query 最常见的坏用法，
        // 在 Chrome 下表现为 `beginQuery` 抛 INVALID_OPERATION（而旧代码把它静默吞掉了）。
        if (this._active) this._diag.activeOverwrite++;
        this._diag.beginCalls++;
        let query: WebGLQuery | null = null;
        this._diag.createCalls++;
        try {
            query = this._gl.createQuery();
        } catch (err) {
            this._diag.createErrors++;
            this._note("createQuery", err);
            return;
        }
        if (!query) {
            this._diag.createNull++;
            return;
        }
        try {
            this._gl.beginQuery(this._timeElapsed, query);
            this._active = query;
        } catch (err) {
            this._diag.beginErrors++;
            this._note("beginQuery", err);
            this._gl.deleteQuery(query);
            this._active = null;
        }
    }

    /** 画完这一帧之后调用（提交查询 + 回收历史结果）。 */
    end(): void {
        if (!this._ext) return;
        if (this._contextLost()) this._diag.ctxLost++;
        if (!this._active) {
            // begin 没成功（扩展缺失/beginQuery 抛异常/查询为 null）——不是"没事"，记下来。
            this._diag.orphanEnd++;
            this.collect();
            return;
        }
        this._diag.endCalls++;
        try {
            this._gl.endQuery(this._timeElapsed);
            this._pending.push(this._active);
        } catch (err) {
            this._diag.endErrors++;
            this._note("endQuery", err);
            this._gl.deleteQuery(this._active);
        }
        this._active = null;
        this.collect();
    }

    /** 回收已完成的查询（非阻塞；每帧调一次即可）。 */
    collect(): void {
        if (!this._ext) return;
        let disjoint = false;
        try {
            // `GPU_DISJOINT_EXT` 规范上是布尔，但实现可能给 1/0 —— 两种都认。
            const v = this._gl.getParameter(this._disjointParam);
            disjoint = v === true || v === 1;
        } catch {
            disjoint = false;
        }
        for (let i = this._pending.length - 1; i >= 0; i--) {
            const query = this._pending[i];
            let available = false;
            this._diag.probeCalls++;
            try {
                // 同样：**不能**只认 `=== true`（Chrome/ANGLE 有的版本返回 1）。只认严格布尔时
                // 样本数会恒为 0，协议就只能退回墙钟口径（2026-09-26 现场踩过一次）。
                const raw = this._gl.getQueryParameter(query, this._gl.QUERY_RESULT_AVAILABLE);
                available = raw === true || raw === 1 || raw === "true";
            } catch (err) {
                this._diag.probeErrors++;
                this._note("getQueryParameter(QUERY_RESULT_AVAILABLE)", err);
                available = true; // 取不到就当作已完成并回收，避免查询泄漏
            }
            if (!available) continue;
            this._diag.probeTrue++;
            try {
                const ns = Number(this._gl.getQueryParameter(query, this._gl.QUERY_RESULT));
                const ms = ns / 1e6;
                // 合理范围过滤：0 ≤ ms < 1000ms（超出说明这一帧读数不可信）
                if (disjoint) {
                    this._diag.disjointDrops++;
                    this._misses++;
                } else if (Number.isFinite(ms) && ms >= 0 && ms < 1000) {
                    this._samples.push(ms);
                } else {
                    this._diag.rangeDrops++;
                    this._misses++;
                }
            } catch (err) {
                this._diag.resultErrors++;
                this._note("getQueryParameter(QUERY_RESULT)", err);
                this._misses++;
            }
            this._gl.deleteQuery(query);
            this._pending.splice(i, 1);
        }
    }

    /**
     * 回收所有"已经可以取回"的样本（每帧 `end()` 里已经调过一次 `collect()`，这里只是再补一次）。
     *
     * 注意（诚实标注）：查询结果要等 GPU 执行完才可取回，所以**最后几帧的样本可能永远拿不到**
     * （本轮结束时它们还在 GPU 队列里）。协议用的是"本轮有效样本的中位数"，因此这点损耗只影响
     * 样本数、不影响量级；`misses` 与样本数都会写进结果供核对。
     */
    drain(): void {
        if (!this._ext) return;
        this.collect();
    }

    /**
     * 等所有待回读的查询都取回（**在计时区间之外**调用）。
     *
     * 为什么必须有这个等待：本环境里 CPU 提交一整轮（几百帧）只要几十毫秒，而 GPU 把这些帧真正
     * 画完要几百毫秒——本轮结束时查询几乎全都还没完成（现场实测：不等就是 0 个样本，只能退回墙钟口径）。
     * 这里用"小步轮询 + 让出事件循环"把查询等回来；它发生在 fps 计时区间**之后**，不影响任何已取的点。
     */
    async waitForPending(timeoutMs = 5000): Promise<void> {
        if (!this._ext) return;
        const deadline = performance.now() + Math.max(0, timeoutMs);
        while (this._pending.length > 0 && performance.now() < deadline) {
            this.collect();
            if (this._pending.length === 0) break;
            await new Promise<void>((resolve) => setTimeout(resolve, 2));
        }
        this.collect();
    }

    reset(): void {
        this._samples = [];
    }
}

/** 只用到的那部分 WebGL2 API（**pure-clear 探针**：clear + 与协议同口径的收口读回）。 */
export interface GlClearProbeApi extends GlFramebufferApi {
    clear(mask: number): void;
    readPixels(
        x: number,
        y: number,
        w: number,
        h: number,
        format: number,
        type: number,
        dst: ArrayBufferView | null,
    ): void;
    finish(): void;
    readonly COLOR_BUFFER_BIT: number;
    readonly RGBA: number;
    readonly UNSIGNED_BYTE: number;
}

/** 单个分辨率下的 pure-clear 探针样本（全部为墙钟 ms）。 */
export interface ClearProbeSample {
    width: number;
    height: number;
    /** 兆像素 */
    mpx: number;
    clears: number;
    /** 每次 `clear(COLOR_BUFFER_BIT)` 的平均墙钟耗时 */
    perClearMs: number;
    /** 末尾 `finish()` + `readPixels(1×1)` 的等待（与正式协议**同一套**收口方式） */
    readbackWaitMs: number;
    /** 归一化成本：每次 clear（含均摊读回）/ 兆像素 —— 跨分辨率直接可比 */
    perMpxPerClearMs: number;
}

/**
 * **pure-clear 探针**：在离屏目标上做 N 次 `clear(COLOR_BUFFER_BIT)`，再用与正式协议**同一套收口**
 * （`finish()` + `readPixels(1×1)`）等 GPU 做完，逐分辨率测耗时。
 *
 * 为什么必须单独测：正式测量里的 `ER/SMP`（排空）**同时**被"绘制 splat 数 / 屏幕足迹 / FBO 面积"
 * 三者影响，无法单独读出面积项；本探针里**没有任何 splat** ⇒ 它的面积依赖只能是纯 FBO 成本
 * （tile 清/存、绑定/校验、读回路径），从而把"面积项"从耦合模型里**独立测出来**。
 */
export function runClearProbe(
    gl: GlClearProbeApi | null,
    resolutions: { width: number; height: number }[],
    clears = 40,
    reps = 1,
): ClearProbeSample[] | null {
    if (!gl) return null;
    const out: ClearProbeSample[] = [];
    const px = new Uint8Array(4);
    for (let r0 = 0; r0 < Math.max(1, Math.floor(reps)); r0++) {
        for (const r of resolutions) {
            const target = new OffscreenRenderTarget(gl, r.width, r.height);
            if (!target.ready) {
                target.dispose();
                continue;
            }
            target.bind();
            try {
                for (let i = 0; i < 4; i++) gl.clear(gl.COLOR_BUFFER_BIT); // 预热：让首次分配/tile 建立落在这里
                const t0 = performance.now();
                for (let i = 0; i < clears; i++) gl.clear(gl.COLOR_BUFFER_BIT);
                const t1 = performance.now();
                gl.finish();
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
                const t2 = performance.now();
                const perClear = (t1 - t0) / clears;
                const readback = t2 - t1;
                const mpx = (r.width * r.height) / 1e6;
                out.push({
                    width: r.width,
                    height: r.height,
                    mpx,
                    clears,
                    perClearMs: perClear,
                    readbackWaitMs: readback,
                    perMpxPerClearMs: mpx > 0 ? (perClear + readback / clears) / mpx : 0,
                });
            } finally {
                target.unbind();
                target.dispose();
            }
        }
    }
    return out;
}

/** `?clearprobe=WxH,WxH,…`：探针分辨率清单（缺省空 = 不跑探针）。 */
export function clearProbeResolutionsFromUrl(search?: string): { width: number; height: number }[] {
    try {
        const s = search ?? (typeof location !== "undefined" ? location.search : "");
        const raw = new URLSearchParams(s).get("clearprobe") || "";
        if (!raw.trim()) return [];
        const parsed = raw.split(",").map((item) => {
            const m = /^(\d+)x(\d+)$/.exec(item.trim());
            return m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : null;
        });
        return parsed.filter((v): v is { width: number; height: number } => v !== null && v.width > 0 && v.height > 0);
    } catch {
        return [];
    }
}

/** `?cleariter=N`：每个分辨率的 clear 次数（缺省 40，上限 400）。 */
export function clearProbeIterationsFromUrl(search?: string): number {
    try {
        const s = search ?? (typeof location !== "undefined" ? location.search : "");
        const n = parseInt(new URLSearchParams(s).get("cleariter") || "40", 10);
        return Number.isFinite(n) && n > 0 ? Math.min(400, n) : 40;
    } catch {
        return 40;
    }
}

/**
 * 在**当前页面**新建一个一次性 WebGL2 上下文跑完探针，然后立刻用 `WEBGL_lose_context` 释放
 * （不让探针上下文常驻影响被测轮次）。两臂共用同一条实现、同一个 `OffscreenRenderTarget` 类，
 * 因此两臂测到的"纯 FBO 成本"来自**完全相同的 FBO 配置**（`RGBA8` renderbuffer、无深度附件）。
 */
export function runClearProbeOnDevice(
    resolutions: { width: number; height: number }[],
    clears: number,
    reps = 1,
): ClearProbeSample[] | null {
    if (resolutions.length === 0 || typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext("webgl2", {
        antialias: false,
        alpha: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: "high-performance",
    }) as unknown as GlClearProbeApi | null;
    if (!gl) return null;
    try {
        return runClearProbe(gl, resolutions, clears, reps);
    } finally {
        try {
            (gl as unknown as WebGL2RenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
        } catch {
            /* 上下文已丢失时忽略 */
        }
    }
}

/** `?clearreps=N`：探针在同一页面内重复几轮（缺省 1，上限 20）。 */
export function clearProbeRepsFromUrl(search?: string): number {
    try {
        const s = search ?? (typeof location !== "undefined" ? location.search : "");
        const n = parseInt(new URLSearchParams(s).get("clearreps") || "1", 10);
        return Number.isFinite(n) && n > 0 ? Math.min(20, n) : 1;
    } catch {
        return 1;
    }
}

/**
 * 结果行里的探针标签：
 *   `CLR<W>x<H>:<每分辨率中位数>,…`（**保持旧格式**，拟合工具 `ch7_clearprobe_fit.py` 直接可用）
 *   + `CLRrep<W>x<H>:<min>-<max>|n=N`（仅当该分辨率有多次重复时才出现 ⇒ 用来判"两臂差异是噪声还是系统性的"）
 *   + `CLRrb<读回等待中位数>,…`；无探针 ⇒ `CLRna`。
 */
export function formatClearProbeTags(samples: ClearProbeSample[] | null): string {
    if (!samples || samples.length === 0) return "CLRna";
    const groups = new Map<string, { perMpx: number[]; rb: number[] }>();
    for (const s of samples) {
        const key = `${s.width}x${s.height}`;
        const g = groups.get(key) ?? { perMpx: [], rb: [] };
        g.perMpx.push(s.perMpxPerClearMs);
        g.rb.push(s.readbackWaitMs);
        groups.set(key, g);
    }
    const med = (xs: number[]) => {
        const a = [...xs].sort((p, q) => p - q);
        const m = Math.floor(a.length / 2);
        return a.length % 2 === 1 ? a[m] : (a[m - 1] + a[m]) / 2;
    };
    const base: string[] = [];
    const spread: string[] = [];
    const rbMed: string[] = [];
    for (const [key, g] of groups) {
        base.push(`${key}:${med(g.perMpx).toFixed(3)}`);
        if (g.perMpx.length > 1) {
            spread.push(`${key}:${Math.min(...g.perMpx).toFixed(3)}-${Math.max(...g.perMpx).toFixed(3)}|n=${g.perMpx.length}`);
        }
        rbMed.push(med(g.rb).toFixed(0));
    }
    return (
        "CLR" +
        base.join(",") +
        (spread.length > 0 ? "CLRrep" + spread.join(",") : "") +
        "CLRrb" +
        rbMed.join(",")
    );
}

/**
 * **带标签**（2026-09-28）：用"每帧排空"这个代理给每条结果打档，事后按带筛数据，避免每次重新争"这组能不能用"。
 * 阈值按臂给定（ours 与 flux 的绝对量级不同，不能共用一个阈值）。
 */
export function bandTag(drainMsPerFrame: number, slowFromMs: number, fastToMs: number): string {
    if (!Number.isFinite(drainMsPerFrame) || drainMsPerFrame <= 0) return "BAND?";
    if (drainMsPerFrame >= slowFromMs) return "BANDslow";
    if (drainMsPerFrame <= fastToMs) return "BANDfast";
    return "BANDmid";
}

/**
 * 离屏渲染目标：FBO + 颜色 renderbuffer。
 *
 * 只建颜色附件、**不建深度附件**：两支臂的基准管线都是 `gl.disable(gl.DEPTH_TEST)` +
 * 混合排序绘制（本文臂见 `RenderProgram._render`，Flux 臂同构），深度缓冲不参与任何行为，
 * 建了只会白占显存、并让"两臂像素占用"这层对比多一个无关变量。
 */
export class OffscreenRenderTarget implements OffscreenRenderTargetInfo {
    private _gl: GlFramebufferApi;
    private _fbo: WebGLFramebuffer | null = null;
    private _color: WebGLRenderbuffer | null = null;
    private _width: number;
    private _height: number;
    private _complete = false;
    private _reason = "";
    private _disposed = false;

    constructor(gl: GlFramebufferApi, width: number, height: number) {
        this._gl = gl;
        this._width = Math.max(1, Math.floor(width));
        this._height = Math.max(1, Math.floor(height));
        try {
            const fbo = gl.createFramebuffer();
            const color = gl.createRenderbuffer();
            if (!fbo || !color) {
                this._reason = "createFramebuffer/createRenderbuffer 返回 null（上下文已丢失？）";
                return;
            }
            gl.bindRenderbuffer(gl.RENDERBUFFER, color);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, this._width, this._height);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
            const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.bindRenderbuffer(gl.RENDERBUFFER, null);
            this._fbo = fbo;
            this._color = color;
            this._complete = status === gl.FRAMEBUFFER_COMPLETE;
            if (!this._complete) {
                this._reason = `checkFramebufferStatus=0x${status.toString(16)}（期望 FRAMEBUFFER_COMPLETE）`;
            }
        } catch (err) {
            this._reason = `离屏渲染目标创建失败：${err instanceof Error ? err.message : String(err)}`;
        }
    }

    get width(): number {
        return this._width;
    }

    get height(): number {
        return this._height;
    }

    get complete(): boolean {
        return this._complete;
    }

    get reason(): string {
        return this._reason;
    }

    /** 结果行里的目标指纹，如 `fbo:1600x1063`（两臂同格式）。 */
    get label(): string {
        return `fbo:${this._width}x${this._height}`;
    }

    get ready(): boolean {
        return !this._disposed && this._complete && this._fbo !== null;
    }

    bind(): void {
        if (!this._fbo) return;
        this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, this._fbo);
    }

    unbind(): void {
        this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, null);
    }

    /**
     * 在"离屏目标已绑定"的状态下执行 `fn`。用于**像素探针**（覆盖率/有效性验证的
     * `readPixels`）：`readPixels` 读的是**当前绑定的 framebuffer**，所以探针必须显式绑定到
     * 离屏目标，否则读到的是 canvas 默认 framebuffer（那是空画面，会让门禁误判"没画出来"）。
     */
    withBound<T>(fn: () => T): T {
        this.bind();
        try {
            return fn();
        } finally {
            this.unbind();
        }
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        if (this._fbo) this._gl.deleteFramebuffer(this._fbo);
        if (this._color) this._gl.deleteRenderbuffer(this._color);
        this._fbo = null;
        this._color = null;
        this._complete = false;
    }
}

/** 便利构造：创建失败或 FBO 不完整时返回 null（调用方据此退回在屏协议，而不是静默测错）。 */
export function createOffscreenRenderTarget(
    gl: GlFramebufferApi,
    width: number,
    height: number,
): OffscreenRenderTarget | null {
    const target = new OffscreenRenderTarget(gl, width, height);
    return target.ready ? target : null;
}

/**
 * GPU 进度门（默认"每帧 `gl.finish()`"，可选纯栅栏模式）。
 *
 * ## 现场实测（2026-09-26，RTX 4060 Laptop / ANGLE-D3D11 / headless Edge 153）
 *
 * 三种"同步"手段在本环境的真实表现（都是实测，不是推理）：
 *   | 手段 | 实测 | 结论 |
 *   |---|---|---|
 *   | 纯栅栏（不 flush）：`fenceSync`+`clientWaitSync` | 栅栏首次轮询即 signaled，`fences=0/3`、`fps=58333` | 命令还在渲染进程 command buffer 里 → 检查退化成空操作 |
 *   | 纯栅栏（补 flush） | 首轮不再 signaled，但**超时阻塞立即返回**；`fps=67500` | 该环境 `clientWaitSync` 不提供有效等待 |
 *   | 每帧 `gl.finish()` | 同环境在屏协议实测 `sync(med)=0.00ms`、`frame(med)=0.10ms` | 未呈现的画布上 `finish()` 也**不等** |
 *   | 每帧 `readPixels`（1×1） | 本文件缺省 `each` 模式采用；见结果字段 `offscreen_frame_ms` | **唯一真正阻塞**的操作 |
 *
 * 结论（工程事实，不是取舍）：离屏协议必须用 `readPixels` 收口，否则读数只反映**提交速率**
 * （实测 37363–67500 FPS 这种物理上不可能的数）。因此本门提供两种模式：
 *   - `"each"`（**默认**）：每帧 `gl.finish()` + 一次 **1×1 `readPixels`**（读回 4 字节，数据量可忽略）。
 *     它等的是**这一帧的 GPU 执行**，不是屏幕呈现（渲染目标是不呈现的离屏 FBO），
 *     既不挂 vsync 也不受合成器影响；帧间隔因此包含真实 GPU 执行时间，读数可直接解释。
 *     两臂用的是**同一次 1×1 读回**，成本一致，且其代价单独记在 `fenceWaitMs` 里可核对。
 *   - `"fence"`：纯非阻塞栅栏门，保留给"环境确实支持 `clientWaitSync` 阻塞"的场景；
 *     若环境不支持，读数会被物理上限守卫（`OFFSCREEN_MAX_PLAUSIBLE_FPS`）判为不可信并让该轮失败。
 * 两种模式都写进结果字段 `offscreen_sync_policy=`，报告可据此核对。
 */
export class NonBlockingFrameGate {
    private _gl: GlFenceApi;
    private _maxInFlight: number;
    private _mode: OffscreenSyncMode;
    private _probe: OffscreenSyncProbe | null;
    private _gpuTimer: OffscreenGpuTimer | null;
    private _probePixel = new Uint8Array(4);
    private _pending: WebGLSync[] = [];
    private _waitTotalMs = 0;
    // [LAB 2026-09-28] drainAll 内部三段账目（用于判定此前 `fence_wait_ms` 为何与外部实测 RA 差 2.65–3.8×）
    private _finishMs = 0;
    private _readPixelsMs = 0;
    private _fencePollMs = 0;
    private _drainCalls = 0;
    private _bindOverheadMs = 0;
    private _maxInFlightSeen = 0;
    private _forcedDrains = 0;
    private _firstPollSignaled = 0;

    constructor(
        gl: GlFenceApi,
        maxInFlight = 3,
        mode: OffscreenSyncMode = "each",
        probe: OffscreenSyncProbe | null = null,
        gpuTimer: OffscreenGpuTimer | null = null,
    ) {
        this._gl = gl;
        this._maxInFlight = Math.max(1, Math.floor(maxInFlight));
        this._mode = mode;
        this._probe = probe;
        this._gpuTimer = gpuTimer;
    }

    get gpuTimer(): OffscreenGpuTimer | null {
        return this._gpuTimer;
    }

    /**
     * 画这一帧**之前**调用：`gputimer` 模式下开始一次 GPU 计时查询。
     * 其它模式（each/fence）不需要前置动作，调用它是无害的（空实现）。
     */
    beginFrame(): void {
        if (this._mode === "gputimer") this._gpuTimer?.begin();
    }

    get mode(): OffscreenSyncMode {
        return this._mode;
    }

    get maxInFlight(): number {
        return this._maxInFlight;
    }

    get inFlight(): number {
        return this._pending.length;
    }

    /** 整轮期间观察到的最大在途栅栏数（写进结果：证明"没有无限积压"）。 */
    get maxInFlightSeen(): number {
        return this._maxInFlightSeen;
    }

    /**
     * "刚插进去的栅栏在**第一次轮询**时就已 signaled"的次数。
     *
     * 为什么单独报它：这是"进度检查其实没生效"的**直接证据**。若它 ≈ 总帧数、且在途峰值恒为 0，
     * 说明命令根本没被投给 GPU（漏了 `gl.flush()`，或实现里把 flush 删了），此时测到的是
     * **纯提交耗时**（实测会出现 `fps=58333` 这种物理上不可能的读数）。
     */
    get firstPollSignaled(): number {
        return this._firstPollSignaled;
    }

    /** 累计花在"零超时轮询 + 超限阻塞等待"上的墙钟毫秒（诊断；不含 `drainAll()`）。 */
    get waitTotalMs(): number {
        return this._waitTotalMs;
    }

    /** 因超出 `maxInFlight` 而阻塞等待最老栅栏的次数。 */
    get forcedDrains(): number {
        return this._forcedDrains;
    }

    /** 提交一帧之后调用；各模式在这里做自己的收口，返回仍在途的栅栏数。 */
    afterFrame(): number {
        if (this._mode === "gputimer") {
            // 唯一在本环境**可信**的做法：不在 CPU 侧等待，而是用 GPU 计时查询记录
            // "这一帧在 GPU 上真正花了多少毫秒"（扩展不可用时由协议判该轮无效）。
            this._gpuTimer?.end();
            return 0;
        }
        if (this._mode === "batch") {
            // **批末排空模式**（2026-09-26 真机后追加）：逐帧不做任何 CPU 侧同步，
            // 把"等 GPU"整段挪到 run 末的 `drainAll()`（`finish()` + 一次 1×1 `readPixels`）。
            // 协议内核会把该 run 的计时终点取在排空**之后**（`timingEndAfterDrain`），
            // 因此 elapsed 覆盖本轮全部 GPU 执行 —— 这才是论文要的"multiple consecutive runs 的平均 FPS"。
            //
            // 为什么必须再补这一条路（手机实测的两种坏口径）：
            //   - `fence`：该设备 `clientWaitSync` 不提供等待 ⇒ 量到 **2500 FPS**（纯提交速率）；
            //   - `each`：每帧 `finish()+readPixels` ⇒ 量到 **13.8 FPS**（每帧全同步延迟，70ms/帧）。
            // 两者都不是吞吐；`batch` 把同步成本摊到一个 run（300 帧）上，约 0.2ms/帧。
            return 0;
        }
        if (this._mode === "each") {
            // 阻塞点 = `gl.finish()` + 1×1 `readPixels`：
            //   - `finish()` 在本环境不给保证（实测 0.00ms 立即返回），但代价近零、语义正确；
            //   - 1×1 `readPixels` 是**真正会等**的那一步（读回 4 字节，数据量可忽略），
            //     它等的是"这一帧的 GPU 执行"，不是屏幕呈现（目标是不呈现的 FBO）。
            // 两者合起来的耗时记在 waitTotalMs 里，逐轮输出 `offscreen_fence_wait_ms` 供核对。
            const t0 = performance.now();
            try {
                this._gl.finish();
                const read = () =>
                    this._gl.readPixels(0, 0, 1, 1, this._gl.RGBA, this._gl.UNSIGNED_BYTE, this._probePixel);
                if (this._probe) this._probe.withTargetBound(read);
                else read();
            } catch {
                /* 上下文丢失时忽略 */
            }
            this._waitTotalMs += performance.now() - t0;
            return 0;
        }

        // **零仪器基准**（`sync=none`，2026-09-28 追加）：本帧**不做任何** GL 侧同步/查询，也不插栅栏。
        // 用途：给"仪器自身开销"提供一个真正干净的基准 —— 帧间隔就等于 rAF 回调时间戳之差，
        // 没有任何 `finish()`/`readPixels()`/`fenceSync()` 进入被测区间（对照 `each`/`natural`）。
        if (this._mode === "none") return 0;

        let inserted: WebGLSync | null = null;
        try {
            inserted = this._gl.fenceSync(this._gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            if (inserted) this._pending.push(inserted);
        } catch {
            /* 上下文丢失时无法插栅栏：退化为"无进度检查"，但绝不能中断测量 */
        }
        // ★ 必须先把命令真正投给 GPU 进程，栅栏才有意义（见 GlFenceApi.flush 的说明）：
        //   漏掉这一步时，`clientWaitSync` 对"还没投出去"的栅栏恒返回 ALREADY_SIGNALED，
        //   进度检查退化成空操作，命令队列无上限积压（实测会给出 fps=58333 这种不可能的数）。
        try {
            this._gl.flush();
        } catch {
            /* 上下文丢失时忽略 */
        }

        const t0 = performance.now();
        // 非阻塞回收（零超时）：只问状态，不等
        for (let i = this._pending.length - 1; i >= 0; i--) {
            const sync = this._pending[i];
            const done = this._signaled(sync, 0);
            if (done && sync === inserted) this._firstPollSignaled++;
            if (done) {
                this._delete(sync);
                this._pending.splice(i, 1);
            }
        }
        // 队列积压上限：只有超限才阻塞等待最老的一个
        while (this._pending.length > this._maxInFlight) {
            const oldest = this._pending.shift() as WebGLSync;
            this._signaled(oldest, 100_000_000); // 100ms 上限；即使超时也继续（不能因为一次等待失败就中断测量）
            this._delete(oldest);
            this._forcedDrains++;
        }
        this._waitTotalMs += performance.now() - t0;
        if (this._pending.length > this._maxInFlightSeen) this._maxInFlightSeen = this._pending.length;
        return this._pending.length;
    }

    /**
     * 排空所有在途栅栏：**每个 run 结束时**调用一次，让"本轮已提交的 GPU 工作全部落地"，
     * 从而让各 run 相互独立（下一轮的计时不会把上一轮残留的 GPU 工作算进去）。
     * 它发生在计时区间之外（fps 的终点已在调用前取点），因此不影响帧率口径。
     */
    drainAll(): void {
        // **零仪器基准**（`sync=none`）：整段不做任何事 —— 不 `finish()`、不 `readPixels()`、不轮询栅栏，
        // 也不累计等待。这样 run 的 elapsed 就是纯"提交 + 驱动节奏"，可当作零开销基准
        // （与 `batch` 的区别：`batch` 在 run 末做唯一一次阻塞排空，本模式连那一次也不做）。
        if (this._mode === "none") return;
        const t0 = performance.now();
        // `batch` 模式在这里做**唯一的**阻塞排空：`finish()` + 1×1 `readPixels`
        // （与 `each` 每帧做的那一步同源，只是整段摊到一个 run 上）。
        // 它保证"本轮提交的 GPU 工作全部落地"，因此"排空之后再取计时终点"得到的是真实吞吐。
        if (this._mode === "batch") {
            // [LAB] 三段分开计时：finish / readPixels /（bind+unbind 的探针开销单列，避免混进 readPixels）
            try {
                const tF = performance.now();
                this._gl.finish();
                this._finishMs += performance.now() - tF;
                const tP = performance.now();
                let readMs = 0;
                const read = () => {
                    const t0r = performance.now();
                    this._gl.readPixels(0, 0, 1, 1, this._gl.RGBA, this._gl.UNSIGNED_BYTE, this._probePixel);
                    readMs += performance.now() - t0r;
                };
                if (this._probe) this._probe.withTargetBound(read);
                else read();
                const total = performance.now() - tP;
                this._readPixelsMs += readMs;
                this._bindOverheadMs += Math.max(0, total - readMs);
            } catch {
                /* 上下文丢失时忽略 */
            }
        }
        const tW = performance.now();
        while (this._pending.length > 0) {
            const sync = this._pending.shift() as WebGLSync;
            this._signaled(sync, 1_000_000_000); // 1s 上限：正常路径下 GPU 早已完成，立即返回
            this._delete(sync);
        }
        this._fencePollMs += performance.now() - tW;
        this._drainCalls++;
        this._waitTotalMs += performance.now() - t0;
    }

    /**
     * [LAB 2026-09-28] `drainAll()` 的三段分解 + 调用次数。
     *
     * 为什么要拆：真机上程序自记的 `offscreen_fence_wait_ms`（= `_waitTotalMs`）与外部直接测的
     * RA（包住整个 `drainAll()` 的墙钟）相差 **2.65–3.8×**，必须用同一行里的三段账目找出差额落在哪。
     * 三段定义：`finishMs` = `gl.finish()`；`readPixelsMs` = 1×1 `readPixels`（含探针 bind/unbind）；
     * `fencePollMs` = `while(_pending)` 里的 `clientWaitSync` 轮询（batch 模式下通常为 0，因为不插栅栏）。
     * 三者之和 vs `_waitTotalMs`：若显著小于它，说明 `drainAll` 内有未被计时的间隙；
     * 若三者之和 ≈ 外部 RA 而 `_waitTotalMs` 更小，则问题在 `_waitTotalMs` 的累加位置。
     */
    get drainBreakdown(): {
        finishMs: number;
        readPixelsMs: number;
        fencePollMs: number;
        bindOverheadMs: number;
        drainCalls: number;
        waitTotalMs: number;
    } {
        return {
            finishMs: this._finishMs,
            readPixelsMs: this._readPixelsMs,
            fencePollMs: this._fencePollMs,
            bindOverheadMs: this._bindOverheadMs,
            drainCalls: this._drainCalls,
            waitTotalMs: this._waitTotalMs,
        };
    }

    private _signaled(sync: WebGLSync, timeoutNs: number): boolean {
        try {
            const status = this._gl.clientWaitSync(sync, 0, timeoutNs);
            return status === this._gl.ALREADY_SIGNALED || status === this._gl.CONDITION_SATISFIED;
        } catch {
            return true; // 拿不到状态就当作已完成并回收，避免栅栏泄漏
        }
    }

    private _delete(sync: WebGLSync): void {
        try {
            this._gl.deleteSync(sync);
        } catch {
            /* ignore */
        }
    }
}
