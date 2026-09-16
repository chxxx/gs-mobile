/**
 * bench-three-way.ts — 三臂静态吞吐入口（唯一页面逻辑；iframe 所有权归 Adapter）。
 *
 * 页面只做：解析参数 → 创建 Adapter → 调 controller → 展示/导出结果。
 * 硬门槛（§12.1）：只有 `staticFrameRenderOnly=true` 且五项排序/上传计数全 0，
 * 该轮才允许标记 `static-render-only-synchronized-throughput-v1` 且 `excludeFromMainTable=false`。
 */
import { PROTOCOL_STATIC_FULL_FRAME, PROTOCOL_STATIC_RENDER_ONLY, runSyncedThroughput } from "./bench-controller";
import type {
    BenchMethod,
    BenchmarkConfig,
    ControllerDeps,
    SyncedRoundResult,
    ThreeWayBenchmarkAdapter,
    VisibilityState,
    YieldMode,
} from "./bench-controller";
import { createOursAdapter, createReduced3dgsAdapter } from "./bench-adapters";
import { FluxGsAdapter, FLUX_ADAPTER_BUILD } from "./bench-flux-adapter";
import type { FluxIframeHandle } from "./bench-flux-adapter";
import type { AnchorSet, WorkloadAudit } from "./bench-audit";
import { BENCH_FAR, BENCH_FOCAL_PX, BENCH_NEAR } from "./bench-constants";
import { describeSlaveUrl, slaveIframeUrl } from "./bench-slave-url";

export const THREE_WAY_METHODS: readonly BenchMethod[] = ["ours", "flux-gs", "reduced-3dgs"];
/** 明确不接受的别名（禁止静默映射，例如 `methods=flux`）。 */
export const REJECTED_METHOD_ALIASES: Record<string, string> = {
    flux: "flux-gs",
    reduced: "reduced-3dgs",
    r3dgs: "reduced-3dgs",
    reduced3dgs: "reduced-3dgs",
};
export const PARAM_LIMITS = { frames: 1000, warmup: 600, rounds: 24, dimension: 8192 } as const;

export interface ThreeWayRunConfig {
    methods: BenchMethod[];
    protocol: "gpu-sync";
    yieldMode: YieldMode;
    width: number;
    height: number;
    frames: number;
    warmup: number;
    rounds: number;
    label: string;
    only: string | null;
}

export type ParseResult = { ok: true; config: ThreeWayRunConfig } | { ok: false; error: string };

const intParam = (raw: string | null, name: string, min: number, max: number, dflt: number): number | string => {
    if (raw === null || raw === "") return dflt;
    if (!/^\d+$/.test(raw)) return `${name} 必须是非负整数（收到 "${raw}"）`;
    const v = Number(raw);
    if (v < min || v > max) return `${name} 超出允许范围 [${min}, ${max}]（收到 ${v}）`;
    return v;
};

/** 解析并**严格校验**入口参数；未知值一律报错，不做静默回退。 */
export function parseThreeWayParams(search: string): ParseResult {
    const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    const methodsRaw = (q.get("methods") ?? "").trim();
    if (!methodsRaw) return { ok: false, error: "缺少 methods（例如 methods=ours,flux-gs,reduced-3dgs）" };
    const methods: BenchMethod[] = [];
    for (const raw of methodsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        const alias = REJECTED_METHOD_ALIASES[raw];
        if (alias) return { ok: false, error: `method "${raw}" 为未声明别名，请使用正式名称 "${alias}"` };
        if (!THREE_WAY_METHODS.includes(raw as BenchMethod)) {
            return { ok: false, error: `未知 method "${raw}"（允许：${THREE_WAY_METHODS.join(", ")}）` };
        }
        const m = raw as BenchMethod;
        if (!methods.includes(m)) methods.push(m);
    }
    if (methods.length === 0) return { ok: false, error: "methods 解析后为空" };

    const protocol = q.get("protocol") ?? "gpu-sync";
    if (protocol !== "gpu-sync") return { ok: false, error: `未知 protocol "${protocol}"（允许：gpu-sync）` };

    const yieldModeRaw = q.get("yieldMode") ?? "none";
    if (yieldModeRaw !== "none" && yieldModeRaw !== "messagechannel") {
        return { ok: false, error: `未知 yieldMode "${yieldModeRaw}"（允许：none, messagechannel）` };
    }

    const resRaw = q.get("res") ?? "";
    if (!/^\d+x\d+$/.test(resRaw)) return { ok: false, error: `res 必须形如 1600x1063（收到 "${resRaw}"）` };
    const [wRaw, hRaw] = resRaw.split("x");
    const width = Number(wRaw);
    const height = Number(hRaw);
    if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width > PARAM_LIMITS.dimension ||
        height > PARAM_LIMITS.dimension
    ) {
        return { ok: false, error: `res 非法：${resRaw}（需为正整数且 ≤ ${PARAM_LIMITS.dimension}）` };
    }

    const frames = intParam(q.get("frames"), "frames", 1, PARAM_LIMITS.frames, 300);
    if (typeof frames === "string") return { ok: false, error: frames };
    const warmup = intParam(q.get("warmup"), "warmup", 0, PARAM_LIMITS.warmup, 120);
    if (typeof warmup === "string") return { ok: false, error: warmup };
    const rounds = intParam(q.get("rounds"), "rounds", 1, PARAM_LIMITS.rounds, 12);
    if (typeof rounds === "string") return { ok: false, error: rounds };

    return {
        ok: true,
        config: {
            methods,
            protocol: "gpu-sync",
            yieldMode: yieldModeRaw,
            width,
            height,
            frames,
            warmup,
            rounds,
            label: (q.get("u") ?? "unknown-label").trim() || "unknown-label",
            only: q.get("only"),
        },
    };
}

/** 六种 O/F/R 排列循环使用；`rounds=12` ⇒ 每种排列出现两次（§12.5）。 */
export function roundPermutations(rounds: number, methods: readonly BenchMethod[]): BenchMethod[][] {
    const perms: BenchMethod[][] = [];
    const permute = (rest: BenchMethod[], acc: BenchMethod[]): void => {
        if (rest.length === 0) {
            perms.push([...acc]);
            return;
        }
        for (let i = 0; i < rest.length; i++) {
            permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
        }
    };
    permute([...methods], []);
    if (perms.length === 0) return [];
    const out: BenchMethod[][] = [];
    for (let r = 0; r < rounds; r++) out.push(perms[r % perms.length]);
    return out;
}

export interface CapabilitySnapshot {
    staticFrameRenderOnly: boolean;
    sortFreezeSupported: boolean;
}

export interface RoundGate {
    valid: boolean;
    reasons: string[];
    protocol: string;
    excludeFromMainTable: boolean;
}

/** §12.1 硬门槛：能力降级或任一排序/上传计数非 0 ⇒ 该轮不得进主表。 */
export function evaluateRoundGate(
    result: SyncedRoundResult,
    cfg: ThreeWayRunConfig,
    cap: CapabilitySnapshot,
): RoundGate {
    const reasons: string[] = [];
    const renderOnly = cap.staticFrameRenderOnly && cap.sortFreezeSupported;
    if (!renderOnly) reasons.push("capability:not-render-only（回落到 static-full-frame 协议）");
    if (!result.valid) reasons.push(`controller-invalid:${result.invalidReason ?? "unknown"}`);
    if (result.sortRequestsDuringMeasure !== 0)
        reasons.push(`sortRequestsDuringMeasure=${result.sortRequestsDuringMeasure}`);
    if (result.sortCompletedDuringMeasure !== 0)
        reasons.push(`sortCompletedDuringMeasure=${result.sortCompletedDuringMeasure}`);
    if (result.indexBufferUploadsDuringMeasure !== 0) {
        reasons.push(`indexBufferUploadsDuringMeasure=${result.indexBufferUploadsDuringMeasure}`);
    }
    if (result.pendingSortsAtStart !== 0) reasons.push(`pendingSortsAtStart=${result.pendingSortsAtStart}`);
    if (result.pendingSortsAtEnd !== 0) reasons.push(`pendingSortsAtEnd=${result.pendingSortsAtEnd}`);
    if (result.controllerRenderCalls !== cfg.frames)
        reasons.push(`controllerRenderCalls=${result.controllerRenderCalls}≠${cfg.frames}`);
    if (result.adapterFrameDelta !== cfg.frames)
        reasons.push(`adapterFrameDelta=${result.adapterFrameDelta}≠${cfg.frames}`);
    if (result.unexpectedDrawCalls !== 0) reasons.push(`unexpectedDrawCalls=${result.unexpectedDrawCalls}`);
    if (result.unexpectedFrameCallbacks !== 0)
        reasons.push(`unexpectedFrameCallbacks=${result.unexpectedFrameCallbacks}`);
    if (result.rafCallsDuringMeasure !== 0) reasons.push(`rafCallsDuringMeasure=${result.rafCallsDuringMeasure}`);
    if (result.timerSchedulesDuringMeasure !== 0)
        reasons.push(`timerSchedulesDuringMeasure=${result.timerSchedulesDuringMeasure}`);
    if (result.contextLost) reasons.push("context-lost");
    if (result.visibilityState !== "visible") reasons.push(`visibility=${result.visibilityState}`);
    if (!result.sortFrozenBeforeWarmup) reasons.push("sort-not-frozen-before-warmup");
    if (!result.sortWarmupDrawVerified) reasons.push("warmup-draw-not-verified");
    if (!result.sortToken || !result.sortAppliedProof?.proven) reasons.push("sort-token-not-proven");
    const [rw, rh] = result.resolution.requested;
    const [cw, ch] = result.resolution.canvas;
    const [bw, bh] = result.resolution.drawingBuffer;
    if (rw !== cfg.width || rh !== cfg.height) reasons.push(`requested-resolution=${rw}x${rh}`);
    if (cw !== cfg.width || ch !== cfg.height) reasons.push(`canvas-resolution=${cw}x${ch}`);
    if (bw !== cfg.width || bh !== cfg.height) reasons.push(`drawing-buffer=${bw}x${bh}`);
    if (!result.camera.viewMatrixSha256 || !result.camera.projectionMatrixSha256)
        reasons.push("camera/projection-hash-missing");
    if (!(typeof result.workload.gaussianTotal === "number" && result.workload.gaussianTotal > 0)) {
        reasons.push(`workload.gaussianTotal=${String(result.workload.gaussianTotal)}`);
    }
    const mw = result.measureWindowAudit;
    if (
        mw &&
        (mw.resolutionChanged ||
            mw.activeSortSerialChanged ||
            mw.lastDrawSortSerialChanged ||
            mw.warmupDrawMissingAtWindowStart)
    ) {
        reasons.push(`measure-window-audit:${mw.invalidReason || "changed"}`);
    }
    const valid = reasons.length === 0;
    return {
        valid,
        reasons,
        protocol: renderOnly ? PROTOCOL_STATIC_RENDER_ONLY : PROTOCOL_STATIC_FULL_FRAME,
        excludeFromMainTable: !valid,
    };
}

export interface RoundRecord {
    round: number;
    method: BenchMethod;
    label: string;
    order: BenchMethod[];
    gate: RoundGate;
    result: SyncedRoundResult;
    /** 诊断：adapter 侧事实日志（存在 getBridgeEventLog 时采集；无效轮尤其有用） */
    adapterLog?: string[];
}

export interface PlanDeps {
    config: ThreeWayRunConfig;
    capabilitiesOf(method: BenchMethod): CapabilitySnapshot;
    createAdapter(method: BenchMethod): Promise<ThreeWayBenchmarkAdapter>;
    controllerDeps: ControllerDeps;
    /** 默认 = 真实 controller（`runSyncedThroughput`）；测试可注入假实现 */
    runRound?: (
        adapter: ThreeWayBenchmarkAdapter,
        config: BenchmarkConfig,
        deps: ControllerDeps,
    ) => Promise<SyncedRoundResult>;
    onRecord?(rec: RoundRecord): void;
    onAdapterDisposed?(method: BenchMethod, ok: boolean): void;
}

export interface PlanOutcome {
    records: RoundRecord[];
    stoppedReason: string | null;
    disposed: BenchMethod[];
}

/** 按六种平衡排列执行 rounds 轮；Adapter **一律**在 finally 中 dispose（失败也清理）。 */
export interface SceneEntry {
    id: string;
    dataset: string;
    modelUrl: string;
    iframeUrl: string;
    modelSource: WorkloadAudit["model"];
}

/** 容错读取场景清单（`{scenes:[...]}` 或数组；缺字段用保守默认值）。 */
export function readSceneEntries(json: unknown): SceneEntry[] {
    const raw = Array.isArray(json) ? json : ((json as { scenes?: unknown[] } | null)?.scenes ?? []);
    const out: SceneEntry[] = [];
    for (const item of raw) {
        const o = item as Record<string, unknown>;
        const id = typeof o.id === "string" ? o.id : typeof o.scene === "string" ? o.scene : null;
        if (!id) continue;
        // H23：两份清单用的是**旧 schema**（模型叫 `file`、vendor 页叫 `page`）。不归一的话，
        // ours / reduced-3dgs 会同时拿到"空 modelUrl"和"flux 的页面路径"⇒ 浏览器里固定
        // `等待超时：__CASE_BENCH__(ours)`（详见 bench-slave-url.ts 顶部说明）。
        const modelUrl =
            typeof o.modelUrl === "string" && o.modelUrl !== "" ? o.modelUrl : typeof o.file === "string" ? o.file : "";
        const iframeUrl =
            typeof o.iframeUrl === "string" && o.iframeUrl !== ""
                ? o.iframeUrl
                : typeof o.page === "string" && o.page !== ""
                  ? o.page
                  : `flux-gs-project-gh-pages/render_${id}/index.html`;
        out.push({
            id,
            dataset: typeof o.dataset === "string" ? o.dataset : "unknown",
            modelUrl,
            iframeUrl,
            modelSource: {
                modelStorageBytes: typeof o.modelStorageBytes === "number" ? o.modelStorageBytes : null,
                networkTransferBytes: typeof o.networkTransferBytes === "number" ? o.networkTransferBytes : null,
                decodedBodyBytes: typeof o.decodedBodyBytes === "number" ? o.decodedBodyBytes : null,
                modelHash: typeof o.modelHash === "string" ? o.modelHash : null,
                modelSourceUrl: modelUrl === "" ? null : modelUrl,
                modelSourceCommit: typeof o.modelSourceCommit === "string" ? o.modelSourceCommit : null,
                modelDownloadDate: typeof o.modelDownloadDate === "string" ? o.modelDownloadDate : null,
                rendererSourceCommit: typeof o.rendererSourceCommit === "string" ? o.rendererSourceCommit : null,
            },
        });
    }
    return out;
}

export const SCENE_MANIFESTS: Record<string, string> = {
    ours: "bench-scenes.json",
    "reduced-3dgs": "baseline-scenes.json",
    "flux-gs": "flux-baseline-scenes.json",
};

/** 由入口配置生成 controller 的 BenchConfig（页面与计划共用同一份，避免两套口径）。 */
export function toBenchmarkConfig(cfg: ThreeWayRunConfig): BenchmarkConfig {
    return {
        warmupFrames: cfg.warmup,
        measureFrames: cfg.frames,
        yieldMode: cfg.yieldMode,
        batchSize: 1,
        width: cfg.width,
        height: cfg.height,
        cameraStatic: true,
    };
}

export async function runThreeWayPlan(deps: PlanDeps): Promise<PlanOutcome> {
    const cfg = deps.config;
    const runRound =
        deps.runRound ?? ((adapter, config, ctrlDeps) => runSyncedThroughput(adapter, ctrlDeps, { config }));
    const benchConfig = toBenchmarkConfig(cfg);
    const perms = roundPermutations(cfg.rounds, cfg.methods);
    const records: RoundRecord[] = [];
    const disposed: BenchMethod[] = [];
    let stoppedReason: string | null = null;

    for (let r = 0; r < perms.length; r++) {
        if (stoppedReason !== null) break;
        for (const method of perms[r]) {
            if (stoppedReason !== null) break;
            const adapter = await deps.createAdapter(method);
            let disposeOk = true;
            let rec: RoundRecord | null = null;
            try {
                const result = await runRound(adapter, benchConfig, deps.controllerDeps);
                const gate = evaluateRoundGate(result, cfg, deps.capabilitiesOf(method));
                rec = { round: r + 1, method, label: cfg.label, order: [...perms[r]], gate, result };
                records.push(rec);
                deps.onRecord?.(rec);
                if (result.contextLost) stoppedReason = "context-lost";
                else if (result.visibilityState !== "visible") stoppedReason = `visibility:${result.visibilityState}`;
            } catch (err) {
                stoppedReason = `round-failed:${method}:${String(err)}`;
            } finally {
                // 诊断优先：先取事实日志（dispose 会清空 bridge 状态）
                try {
                    const probe = adapter as unknown as { getBridgeEventLog?: () => string[] };
                    const log = probe.getBridgeEventLog?.();
                    if (log && log.length > 0) {
                        const tail = log.slice(-40);
                        if (rec) rec.adapterLog = tail;
                        else
                            records.push({
                                round: r + 1,
                                method,
                                label: cfg.label,
                                order: [...perms[r]],
                                gate: null as never,
                                result: null as never,
                                adapterLog: tail,
                            });
                    }
                } catch {
                    /* 诊断失败不影响测量与清理 */
                }
                try {
                    await adapter.dispose();
                } catch {
                    disposeOk = false;
                }
                disposed.push(method);
                deps.onAdapterDisposed?.(method, disposeOk);
            }
        }
    }
    return { records, stoppedReason, disposed };
}

/** 标准行主序透视投影（各臂共用同一公式；跨臂一致性由 gate 的哈希审计把关）。 */
export function buildProjectionRowMajor(
    fx: number,
    fy: number,
    near: number,
    far: number,
    width: number,
    height: number,
): number[] {
    const nf = 1 / (near - far);
    return [
        (2 * fx) / width,
        0,
        0,
        0,
        0,
        (2 * fy) / height,
        0,
        0,
        0,
        0,
        (far + near) * nf,
        -1,
        0,
        0,
        2 * far * near * nf,
        0,
    ];
}

export const EMPTY_ANCHOR_SET: AnchorSet = {
    file: "bench-camera/anchors.json",
    anchorSetHash: "unset",
    anchors: [],
} as unknown as AnchorSet;

function mountIframe(url: string): HTMLIFrameElement {
    const el = document.createElement("iframe");
    el.src = url;
    el.style.width = "1600px";
    el.style.height = "1063px";
    el.style.border = "0";
    document.getElementById("stage")?.appendChild(el);
    return el;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(get: () => T | undefined | null, timeoutMs: number, what: string): Promise<T> {
    const t0 = performance.now();
    for (;;) {
        const v = get();
        if (v !== undefined && v !== null) return v;
        if (performance.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
        await sleep(50);
    }
}

/** 浏览器入口：解析参数 → 建 Adapter（iframe 生命周期归 Adapter）→ 跑 controller → 输出结果。 */
export async function main(): Promise<void> {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const status = document.getElementById("status");
    const out = document.getElementById("out");
    const say = (line: string): void => {
        if (status) status.textContent = line;
    };
    const parse = parseThreeWayParams(window.location.search);
    if (!parse.ok) {
        say(`参数错误：${parse.error}`);
        return;
    }
    const cfg = parse.config;
    say(
        `[build ${FLUX_ADAPTER_BUILD} runner=H23] methods=${cfg.methods.join(",")} proto=${cfg.protocol} res=${cfg.width}x${cfg.height} frames=${cfg.frames} warmup=${cfg.warmup} rounds=${cfg.rounds} u=${cfg.label}`,
    );

    const manifestCache = new Map<string, SceneEntry[]>();
    const entriesFor = async (method: BenchMethod): Promise<SceneEntry[]> => {
        const file = SCENE_MANIFESTS[method];
        const hit = manifestCache.get(file);
        if (hit) return hit;
        const res = await fetch(file, { cache: "no-store" });
        if (!res.ok) throw new Error(`场景清单不可用：${file} (${res.status})`);
        const list = readSceneEntries(await res.json());
        manifestCache.set(file, list);
        return list;
    };

    const projection = buildProjectionRowMajor(
        BENCH_FOCAL_PX,
        BENCH_FOCAL_PX,
        BENCH_NEAR,
        BENCH_FAR,
        cfg.width,
        cfg.height,
    );
    const probe = { bindSortWorker: (): void => {}, detach: (): void => {}, getAuthority: (): unknown => null };

    const capabilityCache = new Map<BenchMethod, { staticFrameRenderOnly: boolean; sortFreezeSupported: boolean }>();

    const createAdapter = async (method: BenchMethod): Promise<ThreeWayBenchmarkAdapter> => {
        const list = await entriesFor(method);
        const entry = cfg.only ? list.find((s) => s.id === cfg.only) : list[0];
        if (!entry) throw new Error(`场景不存在：method=${method} only=${String(cfg.only)}`);
        const adapter = await buildAdapter(method, entry);
        // controller 不调用 init/loadScene/waitUntilReady ⇒ 页面必须完成 adapter 前导（否则 prims 未就绪）
        await adapter.init(toBenchmarkConfig(cfg));
        await adapter.loadScene({
            id: entry.id,
            file: entry.modelUrl,
            dataset: entry.dataset,
            anchorSetFile: EMPTY_ANCHOR_SET.file,
        });
        await adapter.waitUntilReady();
        const c = adapter.capabilities;
        capabilityCache.set(method, {
            staticFrameRenderOnly: c.staticFrameRenderOnly,
            sortFreezeSupported: c.sortFreezeSupported,
        });
        return adapter;
    };

    const buildAdapter = async (method: BenchMethod, entry: SceneEntry): Promise<ThreeWayBenchmarkAdapter> => {
        // H23：入口 URL 一律由构造器显式给出——
        //   ours / reduced-3dgs ⇒ `bench-case.html?slave=1&jobId=…&scene=…&model=…&res=WxH`
        //   flux-gs             ⇒ 清单声明的 vendor 页面（`bridge=` 只由 FluxGsAdapter 注入）
        // 缺字段时构造器**直接抛错**（记成 round-failed:…），禁止静默退化成长达 30s 的等待超时。
        const slaveUrl = slaveIframeUrl(method, entry, {
            jobId: `3way-${method}-${entry.id}-${Date.now().toString(36)}`,
            resW: cfg.width,
            resH: cfg.height,
        });
        console.log(`[three-way] ${method} iframe: ${describeSlaveUrl(slaveUrl)}`);
        const profile = {
            name: method,
            sceneId: entry.id,
            dataset: entry.dataset,
            modelUrl: entry.modelUrl,
            iframeUrl: slaveUrl,
            modelSource: entry.modelSource,
        };
        if (method === "ours" || method === "reduced-3dgs") {
            const deps = {
                createIframe: (url: string) => {
                    const el = mountIframe(url);
                    return { contentWindow: el.contentWindow as never, remove: (): void => el.remove() };
                },
                waitForSlave: async (
                    handle: { contentWindow: { __CASE_BENCH__?: unknown } | null },
                    timeoutMs: number,
                ) => waitFor(() => handle.contentWindow?.__CASE_BENCH__, timeoutMs, `__CASE_BENCH__(${method})`),
                probe,
                sleep,
                log: (line: string): void => console.log(`[three-way] ${method}: ${line}`),
            };
            return method === "ours"
                ? createOursAdapter(profile, deps as never)
                : createReduced3dgsAdapter(profile, deps as never);
        }
        return new FluxGsAdapter({
            sessionId: `3way-${Date.now().toString(36)}`,
            scene: { id: entry.id, dataset: entry.dataset, modelUrl: entry.modelUrl, iframeUrl: slaveUrl },
            modelSource: entry.modelSource,
            createIframe: (url: string) => {
                const el = mountIframe(url);
                return {
                    contentWindow: (el.contentWindow as unknown as FluxIframeHandle["contentWindow"]) ?? null,
                    remove: (): void => el.remove(),
                };
            },
            waitForPrimitives: async (handle: FluxIframeHandle, timeoutMs: number) =>
                waitFor(() => handle.contentWindow?.__FLUXGS_BENCH_SORT__, timeoutMs, "flux primitives"),
            hashView: (v: readonly number[]): string => v.map((x) => Math.round(x * 1e6) / 1e6).join(","),
            projectionMatrix: projection,
            focalPx: BENCH_FOCAL_PX,
            near: BENCH_NEAR,
            far: BENCH_FAR,
            anchorSet: EMPTY_ANCHOR_SET,
            probe,
            sleep,
            log: (line: string): void => console.log(`[three-way] flux-gs: ${line}`),
        });
    };

    const visibility = (): VisibilityState => {
        const v = document.visibilityState;
        return v === "visible" || v === "hidden" || v === "prerender" ? v : "unknown";
    };

    const outcome = await runThreeWayPlan({
        config: cfg,
        capabilitiesOf: (method) =>
            capabilityCache.get(method) ?? { staticFrameRenderOnly: false, sortFreezeSupported: false },
        createAdapter,
        controllerDeps: {
            now: () => performance.now(),
            yieldToMainThread: (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0)),
            logEvent: (name, payload) => console.log(`[event] ${name}`, payload ?? {}),
            getVisibilityState: visibility,
        },
    });

    const lines = outcome.records.flatMap((rec) => {
        const row = [
            `round=${rec.round}`,
            `method=${rec.method}`,
            `u=${rec.label}`,
            `order=${rec.order.join(">")}`,
            `protocol=${rec.gate?.protocol ?? "n/a"}`,
            `valid=${rec.gate?.valid ?? false}`,
            `exclude=${rec.gate?.excludeFromMainTable ?? true}`,
            `fps=${rec.result?.fps?.toFixed(2) ?? "0.00"}`,
            `frames=${rec.result?.completedFrames ?? 0}`,
            `sortReq=${rec.result?.sortRequestsDuringMeasure ?? "-"}`,
            `sortDone=${rec.result?.sortCompletedDuringMeasure ?? "-"}`,
            `idxUpload=${rec.result?.indexBufferUploadsDuringMeasure ?? "-"}`,
            `pendingStart=${rec.result?.pendingSortsAtStart ?? "-"}`,
            `pendingEnd=${rec.result?.pendingSortsAtEnd ?? "-"}`,
            `reasons=${rec.gate ? rec.gate.reasons.join("|") || "none" : "no-controller-result"}`,
        ].join(" ");
        // 无效轮带上 adapter 事实日志（自诊断：下次失败一步定位）
        if (rec.gate?.valid) return [row];
        return [row, ...(rec.adapterLog ?? []).map((l) => `   diag ${l}`)];
    });
    say(
        `完成：records=${outcome.records.length} disposed=${outcome.disposed.length} stopped=${outcome.stoppedReason ?? "none"}`,
    );
    if (out) out.textContent = lines.join("\n");
    console.log(`[RESULT]\n${lines.join("\n")}`);
}
