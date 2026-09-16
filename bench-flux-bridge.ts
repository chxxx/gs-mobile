/**
 * 生产侧 Flux bridge（父侧 orchestration）。
 * 唯一状态机：flux-bench-state.ts（本文件不做状态迁移判定，只把 vendor 事实翻译为状态机调用）。
 * 事实命名空间（iframe → 父）：{ __fxbench:true, fact, session, sortSerial, viewProj, reason? }。
 * depthIndex 字节不进入事实对象、不离开 iframe。
 * 无 `?bridge=1` 时不得实例化本类（由调用方门控；本文件不注册任何全局副作用）。
 *
 * [H22-C 诊断] 8B 路径下“父 → iframe 的驱动/同步”**全部**走薄原语的直接（跨 realm 同步）调用
 * （`frameOnce` / `frameStatic` / `finishGpu` …）：vendor 侧**没有** `window.addEventListener("message")`
 * ⇒ 本类 `tx.post({ prim: * })` 的承载在 8B 路径上**没有任何消费者**（保留为既有 API，不参与判定）。
 * 旧 `finishGpu()` 正是踩在这个坑上：它 post 了一条无人处理的 `prim:"finish-gpu"`，
 * 使“同步 GPU 排空”失效（见 bench-flux-adapter.ts 的 H22-B）。
 */
import { FluxBenchState, sameView, toTerminalReason } from "./flux-bench-state";

/** 固定事实集合（命名冻结）。 */
export const FLUX_FACTS = [
    "sort-requested",
    "worker-completed",
    "result-received",
    "index-uploaded",
    "index-activated",
    "draw-completed",
    "draw-failed",
    "sort-rejected",
    "sort-failed",
    "barrier-ack",
    "context-lost",
] as const;
export type FluxFact = (typeof FLUX_FACTS)[number];

export interface FluxFactMessage {
    __fxbench: true;
    fact: FluxFact;
    session: string;
    sortSerial?: number | null;
    viewProj?: number[];
    reason?: string;
}

/**
 * [H22-A] `prims.frameStatic()` 的**同步返回值**：本帧真实 draw 的归属（vendor 在同一任务内返回）。
 *
 * 布尔返回（旧 vendor）仍被接受，但**无法归属 serial** ⇒ 按 fail-closed 处理（不记账、日志留痕
 * `reason=sync-no-attribution`），绝不猜测。
 */
export interface FluxStaticDrawResult {
    drawn: boolean;
    serial?: number | null;
    /** 本帧真实绘制使用的视图（vendor 的 actual view；与登记视图只保证"同一相机 + 浮点噪声"） */
    viewMatrix?: number[] | null;
}

/** 两个视图的逐项最大绝对差（**诊断**用；不参与任何通过/失败判定）。 */
function maxAbsDiff(a: readonly number[], b: readonly number[]): number {
    let max = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > max) max = d;
    }
    return max;
}

/** 父 → iframe 薄原语 / iframe → 父 事实订阅。 */
export interface FluxBridgeTransport {
    post(msg: Record<string, unknown>): void;
    subscribe(handler: (msg: FluxFactMessage) => void): () => void;
}

export type FluxEventVerdict =
    | "ok"
    | "accepted"
    | "failed"
    | "ignored-session"
    | "ignored-disposed"
    | "ignored-stale"
    | "ignored-duplicate"
    | "ignored-view-mismatch"
    | "protocol-failure"
    | "protocol-failure:dot-equivalent"
    /** [H20] 父侧同步上传门拒绝（父侧是被判方不可见的被调方 ⇒ 拒绝原因必须写进日志自证） */
    | "authorize-rejected";

export interface FluxBridgeEvent {
    seq: number;
    fact: FluxFact | "fact-rejected";
    serial: number | null;
    viewProj: number[] | null;
    verdict: FluxEventVerdict;
    /** [H20] verdict 的原因（仅授权门拒绝等需要自证的路径非 null；其余为 null 以保持既有日志形状）。 */
    reason: string | null;
}

export interface FluxBridgeOptions {
    transport: FluxBridgeTransport;
    sessionId: string;
    width: number;
    height: number;
}

type Waiter = { resolve: () => void; reject: (reason: string) => void };

/** 条件等待者（B2 三个等待接口共用）：自带 timer，必须在 resolve/reject 时清理。 */
interface ConditionWaiter {
    test: () => boolean;
    resolve: () => void;
    reject: (reason: string) => void;
    timer: ReturnType<typeof setTimeout>;
    /**
     * [H19] 关联 serial（null = 与 serial 无关）。
     * 终态事实（rejected/failed/protocol-failure）必须**立即**中止相关条件等待，
     * 而不是让调用方空耗 30s 超时（否则"精确协议失败"退化为"超时"）。
     */
    serial: number | null;
}

export class FluxBenchBridge {
    readonly session: string;
    private readonly tx: FluxBridgeTransport;
    private readonly state: FluxBenchState;
    private readonly forced = new Set<number>();
    /**
     * [H21] 当前（严格单飞 ⇒ **至多一个**）登记请求的**规范视图**：serial → view16 副本。
     *
     * 为什么不能像 H20 之前那样用 `state.hasAccepted()`（即 `acceptedResults`）当门的依据：
     * iframe 在**同一任务**里先 `postMessage` 送出 `result-received`、**再同栈**调用本门
     * （`window.__fxbenchAuthorize`），而父侧处理该 postMessage 属于**下一个任务** ⇒ 门执行时
     * `acceptedResults` 必然还没有该 serial 的条目 ⇒ 门**永远**拒绝（实测 reason 正是 `view-mismatch`）。
     * 因此同步门的依据只能是"登记即可同步得知"的本表；"结果是否被合法接收"改由 `index-uploaded`
     * 的处理点（那时 `result-received` 早已被同一 postMessage 队列**先**处理）**后验**校验并 fail-closed。
     */
    private readonly requestedViews = new Map<number, number[]>();
    /** 事实快照：fact#serial → payload 签名（用于区分"幂等重复"与"协议冲突"） */
    private readonly snapshots = new Map<string, string>();
    /** 同 serial 真实成功 draw 的帧数（多帧审计；[H22-A] 见 `syncConfirmable` 的每帧配对规则） */
    private readonly drawCounts = new Map<number, number>();
    /** [H22-A] 已由**同步归属**计数的帧数，等待与随后的 `draw-completed` 事实逐帧配对（避免双计） */
    private readonly syncConfirmable = new Map<number, number>();
    private readonly log: FluxBridgeEvent[] = [];
    private readonly waiters = new Map<number, Waiter>();
    /** B2 条件等待者（applied / quiescence / drawn） */
    private readonly conditionWaiters = new Set<ConditionWaiter>();
    /** dispose / context-lost 后置位，授权门永久拒绝 */
    private disposed = false;
    private readonly unsub: () => void;
    private nextSerial = 1;
    private mode: "static" | "pipelined" = "static";

    constructor(opts: FluxBridgeOptions) {
        this.session = opts.sessionId;
        this.tx = opts.transport;
        this.state = new FluxBenchState({ bridgeEnabled: true });
        this.unsub = this.tx.subscribe((m) => this.onFact(m)); // 唯一订阅点
        this.tx.post({
            __fxbench: true,
            prim: "init",
            session: this.session,
            width: opts.width,
            height: opts.height,
        });
    }

    /** 发起一次排序请求（统一入口）。force=true 时 dot-equivalent 视为协议失败。 */
    requestSortOnce(viewProj: readonly number[], opts?: { force?: boolean }): number {
        const serial = this.nextSerial++;
        const force = opts?.force === true;
        if (force) this.forced.add(serial);
        const begin = this.state.beginSortRequest(serial);
        if (!begin.ok) {
            this.push("fact-rejected", serial, null, "ignored-disposed");
            throw new Error(`flux-bridge: sort request rejected (${begin.reason})`);
        }
        this.state.trackPromise(`sort:${serial}`);
        // [H21] 登记即写入同步门的唯一依据（严格单飞 ⇒ 替换而非追加，无无界增长）
        this.requestedViews.clear();
        this.requestedViews.set(serial, [...viewProj]);
        this.tx.post({
            __fxbench: true,
            prim: "sort",
            session: this.session,
            sortSerial: serial,
            viewProj: [...viewProj],
            force,
        });
        this.push("sort-requested", serial, [...viewProj], "ok");
        return serial;
    }

    awaitApplied(serial: number): Promise<void> {
        if (this.state.getSnapshot().disposed) return Promise.reject("disposed");
        return new Promise<void>((resolve, reject) => this.waiters.set(serial, { resolve, reject }));
    }

    /** static 帧：不自驱调度，请求 iframe 执行一次唯一 draw 主体。 */
    async staticFrame(viewProj: readonly number[]): Promise<void> {
        this.mode = "static";
        const serial = this.requestSortOnce(viewProj, { force: true });
        this.tx.post({ __fxbench: true, prim: "static-frame", session: this.session, sortSerial: serial });
        return this.awaitApplied(serial);
    }

    /** pipelined 帧：复用同一 draw 主体，仍不自驱调度。 */
    async pipelinedFrame(viewProj: readonly number[]): Promise<void> {
        this.mode = "pipelined";
        const serial = this.requestSortOnce(viewProj);
        this.tx.post({ __fxbench: true, prim: "pipelined-frame", session: this.session, sortSerial: serial });
        return this.awaitApplied(serial);
    }

    async barrier(): Promise<void> {
        const serial = this.state.inFlightSerial ?? this.nextSerial++;
        this.state.trackPromise(`barrier:${serial}`);
        this.tx.post({ __fxbench: true, prim: "barrier", session: this.session, sortSerial: serial });
        return new Promise<void>((resolve, reject) => this.waiters.set(-serial, { resolve, reject }));
    }

    /** 联合 quiescence：worker 四条件（vendor 满足）+ 主线程上传/激活/draw/pending/调度。 */
    jointQuiescent(serial: number): boolean {
        const a = this.state.getSnapshot();
        return (
            a.workerCompletedSerial === serial &&
            a.resultReceivedSerial === serial &&
            a.uploadedSerial === serial &&
            a.activeSerial === serial &&
            a.lastDrawSerial === serial &&
            this.state.inFlightSerial === null &&
            this.state.pendingPromiseCount === 0 &&
            this.state.scheduledKindCounts.total === 0
        );
    }

    getEventLog(): readonly FluxBridgeEvent[] {
        return this.log;
    }

    /** 在飞排序数（0 或 1；供 adapter 的 SortAudit.pendingCount 使用，禁止外部推断） */
    get pendingSorts(): number {
        return this.state.inFlightSerial === null ? 0 : 1;
    }

    /** 该 serial 已真实成功 draw 的帧数（多帧审计；[H22-A] 由**同步归属**路径计数）。 */
    getDrawCount(serial: number): number {
        return this.drawCounts.get(serial) ?? 0;
    }

    /**
     * [H22-A] **同步绘制归属**：本类唯一能在**同一任务**内推进 `lastDraw` 的入口。
     *
     * 为什么必须存在：`draw-completed` 事实走 `postMessage`，父侧只能在**下一个任务**读到；
     * 而 controller 的 warmup 归因校验（`getSortAudit().lastDrawSortSerial`）与测量窗口基线
     * 都是**同步**读取 ⇒ 只靠事实时 `lastDrawSerial` 恒为 0、合法轮也被判 `warmup-draw-not-verified`
     * （实测 build 8B-7 smoke）。因此 `prims.frameStatic()` 的**返回值**（同栈、跨 realm）才是
     * draw 归属的权威来源；事实路径退化为**幂等确认**（不再重复计数）。
     *
     * fail-closed：未真实 draw / 无 serial（旧布尔返回）/ serial ≠ 当前 active ⇒ 一律**不记账**，
     * 只在事实日志留下精确原因（`sync-not-drawn` / `sync-no-attribution` / `sync-stale-serial`）。
     */
    noteStaticDrawSync(res: FluxStaticDrawResult | boolean | null | undefined): void {
        if (this.disposed) return;
        const shaped = typeof res === "object" && res !== null ? res : null;
        const drawn = shaped ? shaped.drawn === true : res === true;
        const serial = shaped && typeof shaped.serial === "number" ? shaped.serial : null;
        const view =
            shaped && Array.isArray(shaped.viewMatrix) && shaped.viewMatrix.length === 16
                ? [...shaped.viewMatrix]
                : null;
        if (!drawn) {
            this.push("draw-failed", serial, view, "failed", "sync-not-drawn");
            return;
        }
        if (serial === null) {
            this.push("draw-failed", null, view, "failed", "sync-no-attribution");
            return;
        }
        if (!this.state.markDrawnSync(serial)) {
            this.push("draw-failed", serial, view, "failed", "sync-stale-serial");
            return;
        }
        const registered = this.requestedViews.get(serial);
        const drift = view && registered ? maxAbsDiff(registered, view) : null;
        const firstForSerial = !this.drawCounts.has(serial);
        this.drawCounts.set(serial, (this.drawCounts.get(serial) ?? 0) + 1);
        // [H22-A] 记一个"待确认槽位"，供随后的 `draw-completed` 事实逐帧配对（避免同一帧双计）
        this.syncConfirmable.set(serial, (this.syncConfirmable.get(serial) ?? 0) + 1);
        // 只在每个 serial 的**首次**同步归属留痕：其余帧由 drawCounts/drawCalls 计数，
        // 避免 30 行同构日志把诊断尾部真正有用的早期事实挤出去。
        if (firstForSerial) {
            this.push(
                "draw-completed",
                serial,
                view,
                "ok",
                drift === null ? "sync-return" : `sync-return drift=${drift.toExponential(2)}`,
            );
        }
    }

    /** 事实快照缓存大小（dispose 清理审计用）。 */
    get snapshotCount(): number {
        return this.snapshots.size;
    }

    get sortAudit(): ReturnType<FluxBenchState["getSnapshot"]> {
        return this.state.getSnapshot();
    }

    /** 退出：停发事实、解除订阅、清空等待者与阶段表；最多恢复一个 rAF。 */
    dispose(reason: string): { settledPromises: number; restoredRaf: number } {
        if (this.state.getSnapshot().disposed) return { settledPromises: 0, restoredRaf: 0 };
        this.disposed = true;
        this.unsub();
        for (const [key, w] of [...this.waiters]) {
            w.reject(reason);
            this.state.settlePromise(key < 0 ? `barrier:${-key}` : `sort:${key}`, toTerminalReason(reason));
        }
        this.waiters.clear();
        this.clearConditionWaiters(reason);
        this.forced.clear();
        this.requestedViews.clear();
        this.drawCounts.clear();
        this.syncConfirmable.clear();
        this.snapshots.clear();
        const r = this.state.dispose(toTerminalReason(reason));
        return { settledPromises: r.settledPromises, restoredRaf: this.state.restoreSingleRaf() };
    }

    private push(
        fact: FluxFact | "fact-rejected",
        serial: number | null,
        viewProj: number[] | null,
        verdict: FluxEventVerdict,
        reason: string | null = null,
    ): void {
        this.log.push({ seq: this.log.length + 1, fact, serial, viewProj, verdict, reason });
        // 每条事实入账后评估 B2 条件等待者（applied / quiescence / drawn）
        this.evaluateConditionWaiters();
    }

    private onFact(m: FluxFactMessage): void {
        if (this.state.getSnapshot().disposed) return; // dispose 后迟到事实不得触发 GL/激活/Promise 成功
        if (!m || m.__fxbench !== true) return;
        if (m.session !== this.session) {
            this.push(m.fact, m.sortSerial ?? null, null, "ignored-session");
            return;
        }
        const serial = typeof m.sortSerial === "number" ? m.sortSerial : null;
        const view = m.viewProj ? [...m.viewProj] : null;
        const key = `${m.fact}#${serial}`;
        const signature = JSON.stringify({ view, reason: m.reason ?? null });
        // draw-completed 允许同一 serial 多帧重复（不按键去重，改为逐帧计数）
        if (m.fact !== "draw-completed") {
            const prev = this.snapshots.get(key);
            if (prev !== undefined) {
                if (prev !== signature) {
                    // 同 fact + 同 serial 但 payload 不同 ⇒ 协议失败（不得伪装成幂等重复）
                    if (serial !== null) this.state.markWorkerFailure(serial, "protocol-failure:payload-mismatch");
                    this.push("sort-failed", serial, view, "protocol-failure");
                    return;
                }
                this.push(m.fact, serial, view, "ignored-duplicate"); // 幂等：不破坏已成功 token
                return;
            }
            this.snapshots.set(key, signature);
        }
        switch (m.fact) {
            case "sort-requested":
                // [H21] iframe 回显（父侧在 requestSortOnce() 已登记同名事实）。
                // 该事实在 FLUX_FACTS 中**已声明**，绝不能落到 default 分支被记为 failed（那会在 diag 里制造假失败信号）。
                this.push(m.fact, serial, view, serial !== null && this.forced.has(serial) ? "ok" : "ignored-stale");
                return;
            case "context-lost":
                this.push(m.fact, serial, view, "failed");
                this.dispose("context-lost"); // 立即终态
                return;
            case "worker-completed":
                if (serial !== null) this.state.markWorkerCompleted(serial);
                this.push(m.fact, serial, view, "ok");
                return;
            case "result-received":
                this.push(
                    m.fact,
                    serial,
                    view,
                    this.state.onResultReceived({ sortSerial: serial, viewProj: view ?? undefined }),
                );
                return;
            case "index-uploaded": {
                const ok = serial !== null && view !== null && this.state.markUploaded(serial, view);
                // [H21] 后验校验失败（结果未被合法接收 / view 不一致）⇒ 精确原因**立即终态**
                // （否则 quiescence 只能干等 30s 超时，把协议失败伪装成"超时"）
                if (!ok && serial !== null) this.abort(serial, "protocol-failure:upload-not-accepted");
                this.push(m.fact, serial, view, ok ? "ok" : "failed");
                return;
            }
            case "index-activated": {
                if (serial !== null && view !== null && this.state.markActive(serial, view)) {
                    // applied 语义在激活点完成：释放单飞等待者与 pending
                    // （否则 sort quiescence 在 draw 前永远不可达）
                    this.settle(serial, serial);
                    this.push(m.fact, serial, view, "ok");
                } else {
                    // [H21] 未上传 / view 不匹配 / 重复激活（幂等重复已在上方按键去重）⇒ 精确原因立即终态
                    if (serial !== null) this.abort(serial, "protocol-failure:activate-rejected");
                    this.push(m.fact, serial, view, "failed");
                }
                return;
            }
            case "draw-completed":
            case "draw-failed":
                this.commitDraw(serial, m.fact === "draw-completed" ? "ok" : "failed");
                return;
            case "barrier-ack":
                this.state.markBarrierAck(); // 只记账，不推进 uploaded/active
                if (serial !== null) this.settle(-serial, serial);
                this.push(m.fact, serial, view, "ok");
                return;
            case "sort-rejected":
                if (serial !== null) {
                    this.state.markRejectedByWorker(serial, m.reason ?? "rejected");
                    this.fail(serial, m.reason ?? "rejected");
                }
                this.push(m.fact, serial, view, "failed");
                return;
            case "sort-failed": {
                const protocol =
                    serial !== null && this.forced.has(serial) && (m.reason ?? "").includes("dot-equivalent");
                const reason = protocol ? "protocol-failure:dot-equivalent" : (m.reason ?? "failed");
                if (serial !== null) {
                    this.state.markWorkerFailure(serial, reason);
                    this.fail(serial, reason);
                }
                this.push(m.fact, serial, view, protocol ? "protocol-failure:dot-equivalent" : "failed");
                return;
            }
            default:
                this.push(m.fact, serial, view, "failed");
        }
    }

    /** draw 前冻结 active 快照；只有真实 draw 成功才推进 lastDraw。 */
    private commitDraw(serial: number | null, outcome: "ok" | "failed"): void {
        const snap = this.state.beginDraw();
        const s = serial ?? (snap ? snap.serial : null);
        if (s === null) return;
        // [H22-A] 同步路径是否已为**本帧**记账（必须在 markDrawAttempt 之前读，否则必为真）
        this.state.markDrawAttempt(s, outcome);
        if (outcome === "ok") {
            // [H22-A] 同一帧会被**两条路径**看到（同步返回值 + 之后的 draw-completed 事实）⇒
            // 用"待确认槽位"做**每帧配对**：有槽位 ⇒ 本次事实只是确认（不计数）；无槽位 ⇒
            // 该帧没有同步归属（纯事实驱动路径）⇒ 由事实计数。两种路径都恰好计 1 次。
            const pendingConfirm = this.syncConfirmable.get(s) ?? 0;
            if (pendingConfirm > 0) this.syncConfirmable.set(s, pendingConfirm - 1);
            else this.drawCounts.set(s, (this.drawCounts.get(s) ?? 0) + 1);
        }
        this.push(
            outcome === "ok" ? "draw-completed" : "draw-failed",
            s,
            snap ? snap.viewProj : null,
            outcome === "ok" ? "ok" : "failed",
        );
        if (outcome === "ok" && this.mode === "static") {
            this.state.scheduleFrame("raf"); // 退出时恢复自驱，最多一个
        }
    }

    private settle(waiterKey: number, serial: number): void {
        // 无论是否有 bridge waiter，都必须先释放状态机 pending（否则 quiescence 永不可达）
        this.state.settlePromise(`sort:${serial}`, "applied");
        const w = this.waiters.get(waiterKey);
        if (!w) return;
        this.waiters.delete(waiterKey);
        w.resolve();
    }

    private fail(serial: number, reason: string): void {
        // [H19] 终态事实必须立即中止**条件等待者**（否则 quiescence 只能干等到 30s 超时，
        // 把"精确协议失败"伪装成"超时"，掩盖真正原因）
        this.rejectConditionWaiters(serial, reason);
        const w = this.waiters.get(serial) ?? this.waiters.get(-serial);
        if (!w) return;
        this.waiters.delete(serial);
        this.waiters.delete(-serial);
        w.reject(reason);
    }

    /**
     * [H21] 精确协议失败 ⇒ 立即终态：状态机记 failure（同时释放单飞槽）并中止相关等待者。
     * 用于**后验**校验点（index-uploaded / index-activated）：事件送达顺序保证 `result-received`
     * 已被同一 postMessage 队列先行处理，因此这两处的拒绝都是真实协议失败，不得退化为超时。
     */
    private abort(serial: number, reason: string): void {
        this.state.markWorkerFailure(serial, reason);
        this.fail(serial, reason);
    }

    /** [H19] 以终态原因立即拒绝所有绑定到该 serial 的条件等待者。 */
    private rejectConditionWaiters(serial: number, reason: string): void {
        if (this.conditionWaiters.size === 0) return;
        for (const entry of [...this.conditionWaiters]) {
            if (entry.serial !== serial) continue;
            this.conditionWaiters.delete(entry);
            entry.reject(reason);
        }
    }

    // ------------------------------------------------ B2：三个独立等待条件（applied / quiescence / drawn）
    /** applied：目标 serial 自身已被合法接收、已真实上传、且为当前 active（**不含** draw）。 */
    waitForSortApplied(serial: number, viewProj?: readonly number[]): Promise<void> {
        return this.awaitCondition(
            () =>
                this.state.hasAccepted(serial, viewProj) &&
                this.state.hasUploaded(serial, viewProj) &&
                this.state.isActive(serial, viewProj),
            `waitForSortApplied(${serial}) aborted`,
            30_000,
            serial,
        );
    }

    /** quiescence：applied ∧ Worker 主线程精确阶段静止（**不要求 lastDraw**，避免 active 后、draw 前死锁）。 */
    waitForSortQuiescence(serial: number, viewProj?: readonly number[]): Promise<void> {
        return this.awaitCondition(
            () => this.state.isSortQuiescent(serial, viewProj),
            `waitForSortQuiescence(${serial}) aborted`,
            30_000,
            serial,
        );
    }

    /** drawn：该 serial 至少被真实成功 draw 一次（多帧 draw 另行计数审计）。 */
    waitForDrawn(serial: number): Promise<void> {
        return this.awaitCondition(() => this.state.isDrawn(serial), `waitForDrawn(${serial}) aborted`, 30_000, serial);
    }

    /**
     * 同步上传前授权门（fail-closed）：仅在 `gl.bufferData` **之前**同步调用，必须立即返回 boolean。
     * 不接收也不得接触 depthIndex 字节；不推进 uploaded/active；异常一律按 false 处理。
     *
     * [H20] 父侧门是 iframe **看不到内部**的被调方（只拿到布尔），一旦拒绝，若不在父侧留下原因，
     * 上游只能看到无信息的 `parent:reject`。因此每条拒绝路径都在事实日志留下 `authorize-rejected` + 精确原因。
     * 注意：判定用 `sameView` 是**逐位严格比较**（不是 1e-6 近似）⇒ 调用方必须传入**规范视图**
     * （= 登记视图 = 交给 worker 的排序视图 = `result-received` 上报的视图），而不是自己重算的浮点近似值。
     */
    authorizeUpload(input: { session: string; sortSerial: number; viewProj: readonly number[] }): boolean {
        const reject = (reason: string, serial: number | null, view: number[] | null): false => {
            this.push("sort-rejected", serial, view, "authorize-rejected", reason);
            return false;
        };
        try {
            if (!input || typeof input.sortSerial !== "number") return reject("malformed-serial", null, null);
            const serial = input.sortSerial;
            if (!Array.isArray(input.viewProj) || input.viewProj.length !== 16)
                return reject("view-not-16", serial, null);
            const view = [...input.viewProj];
            if (input.session !== this.session) return reject("session-mismatch", serial, view); // 异 session
            if (this.disposed) return reject("disposed", serial, view); // dispose / context-lost 后永久拒绝
            const a = this.state.getSnapshot();
            if (a.disposed || a.disposeReason === "context-lost") return reject("disposed", serial, view);
            if (this.state.inFlightSerial !== serial) return reject("not-in-flight", serial, view); // 请求已被替换/结束
            if (!this.forced.has(serial)) return reject("not-forced", serial, view); // 非当前 bridge 请求
            // [H21] 门的同步可达依据 = **本次登记**（不得要求父侧"已处理过 result-received"：那是下一个任务）
            const registered = this.requestedViews.get(serial);
            if (!registered) return reject("not-registered", serial, view); // 非本次登记请求
            if (!sameView(registered, view)) return reject("view-mismatch", serial, view); // 与登记规范视图不一致
            return true;
        } catch {
            return reject("exception", null, null); // 异常 fail-closed
        }
    }

    /** 统一等待条件（带 timeout 清理：到期清除 waiter，不留悬挂 timer）。 */
    private awaitCondition(
        test: () => boolean,
        abortReason: string,
        timeoutMs = 30_000,
        serial: number | null = null,
    ): Promise<void> {
        if (this.disposed) return Promise.reject(abortReason);
        if (test()) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
            const entry: ConditionWaiter = {
                test,
                serial,
                resolve: () => {
                    clearTimeout(entry.timer);
                    resolve();
                },
                reject: (r: string) => {
                    clearTimeout(entry.timer);
                    reject(r);
                },
                timer: setTimeout(() => {
                    this.conditionWaiters.delete(entry);
                    reject(abortReason);
                }, timeoutMs),
            };
            this.conditionWaiters.add(entry);
        });
    }

    /** 每条事实入账后评估所有条件等待者（由 push() 调用，覆盖全部事实路径）。 */
    private evaluateConditionWaiters(): void {
        if (this.conditionWaiters.size === 0) return;
        for (const entry of [...this.conditionWaiters]) {
            if (this.disposed) {
                this.conditionWaiters.delete(entry);
                entry.reject("disposed");
                continue;
            }
            if (entry.test()) {
                this.conditionWaiters.delete(entry);
                entry.resolve();
            }
        }
    }

    /** dispose 时清空条件等待者。 */
    private clearConditionWaiters(reason: string): void {
        for (const entry of [...this.conditionWaiters]) {
            this.conditionWaiters.delete(entry);
            entry.reject(reason);
        }
    }
}
