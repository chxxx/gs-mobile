/**
 * flux-bench-state.ts — 阶段 6 主线程半的**可执行状态机**（纯 TS：无 DOM / 无 GL / 无 Worker）。
 *
 * 五阶段**互相独立**：workerCompleted → resultReceived → uploaded → active → lastDraw
 *   · uploaded 只在**真实 GPU index 上传**后置位；
 *   · active 只在索引成为 **draw 使用状态**后置位；
 *   · lastDraw **只在真实 draw 成功后**记录（失败不更新）；
 *   · barrier ack **不得**解释为 uploaded/active；
 *   · 乱序或 view 不匹配的结果**不得覆盖 active**；
 *   · dispose 之后迟到的结果**一律忽略**；
 *   · 只保存**原始 viewProj 快照**（不实现跨臂 hash）。
 */
export type FluxDrawOutcome = "ok" | "failed";
export type FluxTerminalReason = "completed" | "failure" | "rejection" | "context-lost" | "dispose";
export type FluxResultVerdict = "accepted" | "ignored-stale" | "ignored-view-mismatch" | "ignored-disposed";

export interface FluxSortAudit {
    workerCompletedSerial: number;
    resultReceivedSerial: number;
    uploadedSerial: number;
    activeSerial: number;
    lastDrawSerial: number;
    /** 最近一次 active 索引对应的**原始 viewProj 快照**（不做任何 hash） */
    activeViewProj: number[] | null;
    rejected: Array<{ serial: number; reason: string }>;
    failures: Array<{ serial: number; reason: string }>;
    drawFailures: number;
    /** barrier ack 计数（**不得**影响 uploaded/active） */
    barrierAcks: number;
    disposed: boolean;
    disposeReason: FluxTerminalReason | null;
}

export interface StaticFrameSideEffects {
    cameraIntegrated: boolean;
    sortRequested: boolean;
    domWritten: boolean;
    rafScheduled: boolean;
    timerScheduled: boolean;
}

/** 逐项比较 viewProj 快照（16 元素；长度不同即不匹配）。 */
const sameView = (a: readonly number[], b: readonly number[]): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
};

const EMPTY_AUDIT = (): FluxSortAudit => ({
    workerCompletedSerial: 0,
    resultReceivedSerial: 0,
    uploadedSerial: 0,
    activeSerial: 0,
    lastDrawSerial: 0,
    activeViewProj: null,
    rejected: [],
    failures: [],
    drawFailures: 0,
    barrierAcks: 0,
    disposed: false,
    disposeReason: null,
});

export class FluxBenchState {
    private readonly bridgeEnabled: boolean;
    private audit: FluxSortAudit = EMPTY_AUDIT();
    private inFlight: number | null = null;
    private rafHandleCount = 0;
    private timerHandleCount = 0;
    private pending = new Set<string>();
    private settled = new Set<string>();
    /** 已**合法接收**的结果（serial → 当时的 viewProj 快照） */
    private acceptedResults = new Map<number, number[]>();
    /** 已**真实上传**的结果（serial → viewProj 快照） */
    private uploadedResults = new Map<number, number[]>();
    /** 已**激活**的结果（serial → viewProj 快照；重复激活拒绝） */
    private activeResults = new Map<number, number[]>();
    /** draw 前的 active serial/view 快照（draw 成功后据此提交 lastDraw） */
    private drawSnapshot: { serial: number; viewProj: number[] } | null = null;

    constructor(opts?: { bridgeEnabled?: boolean }) {
        this.bridgeEnabled = opts?.bridgeEnabled ?? false;
    }

    get isBridgeEnabled(): boolean {
        return this.bridgeEnabled;
    }

    get inFlightSerial(): number | null {
        return this.inFlight;
    }

    getSnapshot(): FluxSortAudit {
        return { ...this.audit, activeViewProj: this.audit.activeViewProj ? [...this.audit.activeViewProj] : null };
    }

    // ---------------------------------------------------------------- 排序请求（严格单飞）
    beginSortRequest(serial: number): { ok: boolean; reason?: string } {
        if (!this.bridgeEnabled) return { ok: false, reason: "bridge-disabled" };
        if (this.audit.disposed) return { ok: false, reason: "disposed" };
        if (this.inFlight !== null) {
            this.audit.rejected.push({ serial, reason: `single-flight(inFlight=${this.inFlight})` });
            return { ok: false, reason: "single-flight" };
        }
        this.inFlight = serial;
        return { ok: true };
    }

    /** worker 明确 rejection ⇒ 立即结算（不留待 controller timeout）。 */
    markRejectedByWorker(serial: number, reason: string): void {
        this.audit.rejected.push({ serial, reason });
        if (this.inFlight === serial) this.inFlight = null;
        this.settlePromise(`sort:${serial}`, "rejection");
    }

    /** worker 明确 failure ⇒ 立即结算。 */
    markWorkerFailure(serial: number, reason: string): void {
        this.audit.failures.push({ serial, reason });
        if (this.inFlight === serial) this.inFlight = null;
        this.settlePromise(`sort:${serial}`, "failure");
    }

    /** barrier ack：只记账，**不得**推进 uploaded/active。 */
    markBarrierAck(): void {
        this.audit.barrierAcks++;
    }

    markWorkerCompleted(serial: number): void {
        if (serial > this.audit.workerCompletedSerial) this.audit.workerCompletedSerial = serial;
    }

    /**
     * 主线程收到结果消息。
     * 乱序（serial < active）与 view 不匹配**都不得覆盖 active**；dispose 后一律忽略。
     */
    onResultReceived(msg: { sortSerial: number | null; viewProj?: readonly number[] }): FluxResultVerdict {
        if (this.audit.disposed) return "ignored-disposed";
        const serial = msg.sortSerial;
        if (serial === null || serial === undefined) return "ignored-view-mismatch";
        if (serial < this.audit.activeSerial) return "ignored-stale";
        if (msg.viewProj && this.audit.activeViewProj && serial <= this.audit.resultReceivedSerial) {
            const active = this.audit.activeViewProj;
            const same = msg.viewProj.length === active.length && msg.viewProj.every((v, i) => v === active[i]);
            if (!same) return "ignored-view-mismatch";
        }
        if (serial > this.audit.resultReceivedSerial) this.audit.resultReceivedSerial = serial;
        this.markWorkerCompleted(serial);
        // 记录"已合法接收"的 serial → view 快照（uploaded/active 必须与它逐项匹配）
        if (!this.acceptedResults.has(serial)) {
            this.acceptedResults.set(serial, msg.viewProj ? [...msg.viewProj] : []);
        }
        return "accepted";
    }

    /**
     * **真实 GPU index 上传之后**调用（`uploaded` 的唯一置位点）。
     * 必须对应"已合法接收的**同 serial、同 view**"结果；dispose 之后一律拒绝。
     */
    markUploaded(serial: number, viewProj: readonly number[]): boolean {
        if (this.audit.disposed) return false; // dispose 后迟到结果不得上传
        const accepted = this.acceptedResults.get(serial);
        if (!accepted) return false; // 未合法接收（或乱序/未匹配）不得上传
        if (!sameView(accepted, viewProj)) return false; // 同 serial 但 view 不匹配 ⇒ 拒绝
        if (!this.uploadedResults.has(serial)) this.uploadedResults.set(serial, [...viewProj]);
        if (serial > this.audit.uploadedSerial) this.audit.uploadedSerial = serial;
        return true;
    }

    /**
     * **索引成为 draw 使用状态之后**调用（`active` 的唯一置位点）。
     * 必须对应"已上传的**同 serial、同 view**"结果（不只是比较水位）；乱序/重复拒绝。
     */
    markActive(serial: number, viewProj: readonly number[]): boolean {
        if (this.audit.disposed) return false;
        const uploaded = this.uploadedResults.get(serial);
        if (!uploaded) return false; // 未上传不得激活
        if (!sameView(uploaded, viewProj)) return false; // view 不匹配不得激活
        if (this.activeResults.has(serial)) return false; // 重复激活拒绝
        this.activeResults.set(serial, [...viewProj]);
        this.audit.activeSerial = serial;
        this.audit.activeViewProj = [...viewProj]; // 只保存原始 viewProj 快照
        return true;
    }

    /** draw **前**调用：冻结本帧将使用的 active serial/view 快照（draw 主体不得在 draw 中重读 active）。 */
    beginDraw(): { serial: number; viewProj: number[] } | null {
        if (this.audit.disposed || this.audit.activeSerial <= 0) {
            this.drawSnapshot = null;
            return null;
        }
        this.drawSnapshot = { serial: this.audit.activeSerial, viewProj: [...(this.audit.activeViewProj ?? [])] };
        return this.drawSnapshot;
    }

    /**
     * **真实 draw 成功返回之后**调用：只用 draw **前**快照判定，失败不更新 lastDraw，
     * 且若快照 serial 与传入 serial 不一致（active 已换代）一律不提交。
     */
    markDrawAttempt(serial: number, outcome: FluxDrawOutcome): void {
        const snap = this.drawSnapshot === null ? this.beginDraw() : this.drawSnapshot;
        if (outcome === "failed") {
            this.audit.drawFailures++;
            return;
        }
        if (this.audit.disposed) return;
        if (snap === null || snap.serial !== serial) return; // 非本帧 draw 前快照 ⇒ 不提交
        if (serial !== this.audit.activeSerial) return; // active 已换代 ⇒ 本帧快照作废
        this.audit.lastDrawSerial = serial;
    }

    /** static frame 的副作用记录（全部必须为 false）。 */
    recordStaticFrame(side: StaticFrameSideEffects): StaticFrameSideEffects {
        return side;
    }

    // ---------------------------------------------------------------- 唯一调度封装
    scheduleFrame(kind: "raf" | "timer"): number {
        if (kind === "raf") this.rafHandleCount++;
        else this.timerHandleCount++;
        return kind === "raf" ? this.rafHandleCount : this.timerHandleCount;
    }

    cancelScheduled(): number {
        const n = this.rafHandleCount + this.timerHandleCount;
        this.rafHandleCount = 0;
        this.timerHandleCount = 0;
        return n;
    }

    /** 退出 slave 时**最多恢复一个 rAF**（仅 bridge 模式由 bridge 恢复）。 */
    restoreSingleRaf(): number {
        this.cancelScheduled();
        if (!this.bridgeEnabled) return 0;
        this.scheduleFrame("raf");
        return this.rafHandleCount;
    }

    get scheduledKindCounts(): { raf: number; timer: number; total: number } {
        return {
            raf: this.rafHandleCount,
            timer: this.timerHandleCount,
            total: this.rafHandleCount + this.timerHandleCount,
        };
    }

    // ---------------------------------------------------------------- Promise 终态
    trackPromise(id: string): void {
        this.pending.add(id);
    }

    settlePromise(id: string, reason: FluxTerminalReason): void {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.settled.add(`${id}:${reason}`);
    }

    settleAll(reason: FluxTerminalReason): number {
        const ids = [...this.pending];
        for (const id of ids) this.settlePromise(id, reason);
        return ids.length;
    }

    get pendingPromiseCount(): number {
        return this.pending.size;
    }

    get settledPromiseCount(): number {
        return this.settled.size;
    }

    // ---------------------------------------------------------------- 终态
    dispose(reason: FluxTerminalReason): { settledPromises: number; cancelledHandles: number } {
        const settledPromises = this.settleAll(reason);
        const cancelledHandles = this.cancelScheduled();
        this.audit.disposed = true;
        this.audit.disposeReason = reason;
        this.inFlight = null;
        return { settledPromises, cancelledHandles };
    }
}
