/**
 * PerfDebug
 * ------------------------------------------------------------------
 * Lightweight runtime profiler to help locate frame-time bottlenecks in the
 * WebGL splat renderer.
 *
 * The profiler is compiled in but stays near-zero-overhead while disabled.
 * Enable it in one of two ways:
 *   1. append  ?perf=1  to the page URL  (e.g. http://localhost:5173/?perf=1)
 *   2. run  window.__PERF_DEBUG__ = true  in the DevTools console at runtime
 *
 * The demo page (demo.ts) aggregates samples once per second and prints a
 * summary table that splits frame time into:
 *   - frame.interval.ms          -> real rAF cadence, keeps vsync honest
 *   - cpu.controls.update.ms     -> main-thread orbit controls math
 *   - cpu.camera.update.ms       -> camera matrix rebuild each frame
 *   - cpu.renderer.render.ms     -> total JS time inside render()
 *   - gl.*.ms                    -> main-thread GL command / upload cost
 *   - gpu.renderer.render.ms     -> actual GPU execution (timer query)
 *   - sort.*.ms                  -> depth-sort worker time + latency
 *
 * Overhead while enabled is <0.1 ms/frame; samples are ring-buffered.
 */

type PhaseKey = string;

const MAX_SAMPLES_PER_PHASE = 4096;

interface PerfPhaseState {
    count: number;
    sum: number;
    min: number;
    max: number;
    samples: number[];
}

export interface PerfPhaseSummary {
    phase: string;
    count: number;
    avgMs: number;
    minMs: number;
    maxMs: number;
    p95Ms: number;
    totalMs: number;
}

class PerfDebugImpl {
    private _phases = new Map<PhaseKey, PerfPhaseState>();
    private _urlChecked = false;
    private _urlEnabled = false;

    /** Effective runtime switch: URL ?perf=1 once, or window.__PERF_DEBUG__ anytime. */
    get enabled(): boolean {
        const w = typeof window !== "undefined" ? (window as unknown as { __PERF_DEBUG__?: boolean }) : null;
        if (w && w.__PERF_DEBUG__ === true) return true;

        if (!this._urlChecked) {
            this._urlChecked = true;
            try {
                if (typeof location !== "undefined" && new URLSearchParams(location.search).has("perf")) {
                    this._urlEnabled = true;
                }
            } catch {
                /* ignore */
            }
        }
        return this._urlEnabled;
    }

    /** Flip at runtime: perf.enableWindowDebug() in the DevTools console. */
    enableWindowDebug(): void {
        if (typeof window !== "undefined") {
            (window as unknown as { __PERF_DEBUG__?: boolean }).__PERF_DEBUG__ = true;
        }
    }

    now(): number {
        return performance.now();
    }

    sample(phase: PhaseKey, ms: number): void {
        if (!this.enabled) return;
        if (!Number.isFinite(ms) || ms < 0) return;

        let state = this._phases.get(phase);
        if (!state) {
            state = { count: 0, sum: 0, min: Infinity, max: -Infinity, samples: [] };
            this._phases.set(phase, state);
        }
        state.count++;
        state.sum += ms;
        if (ms < state.min) state.min = ms;
        if (ms > state.max) state.max = ms;
        if (state.samples.length < MAX_SAMPLES_PER_PHASE) state.samples.push(ms);
    }

    reset(): void {
        this._phases.clear();
    }

    /** Per-phase summary; optionally clears the recorded window. */
    summarize(clear = true): PerfPhaseSummary[] {
        const rows: PerfPhaseSummary[] = [];
        for (const [phase, state] of this._phases) {
            rows.push({
                phase,
                count: state.count,
                avgMs: state.samples.length ? state.sum / state.samples.length : NaN,
                minMs: state.count ? state.min : NaN,
                maxMs: state.count ? state.max : NaN,
                p95Ms: percentile(state.samples, 0.95),
                totalMs: state.sum,
            });
        }
        rows.sort((a, b) => b.totalMs - a.totalMs);
        if (clear) this._phases.clear();
        return rows;
    }
}

function percentile(samples: number[], q: number): number {
    if (samples.length === 0) return NaN;
    const arr = samples.slice().sort((a, b) => a - b);
    const idx = Math.min(arr.length - 1, Math.floor(q * arr.length));
    return arr[idx];
}

/**
 * GPU frame timer backed by EXT_disjoint_timer_query_webgl2.
 * Measures real GPU execution time of the wrapped draw commands. Results are
 * only available a frame later, so begin() first collects the previous
 * frame's result; if the GPU did not finish in time the sample is dropped and
 * counted as a miss.
 */
export class GpuFrameTimer {
    private _gl: WebGL2RenderingContext;
    private _ext: {
        TIME_ELAPSED_EXT: number;
    } | null;
    private _active: WebGLQuery | null = null;
    private _activeKey = "";
    private _pending: { query: WebGLQuery; key: string; startedAt: number }[] = [];
    private _collected = 0;
    private _misses = 0;

    constructor(gl: WebGL2RenderingContext) {
        this._gl = gl;
        this._ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number } | null;
    }

    get supported(): boolean {
        return this._ext !== null;
    }

    get collected(): number {
        return this._collected;
    }

    get misses(): number {
        return this._misses;
    }

    /** Begin a timed region. Call at most once per frame; pair with end(). */
    begin(key: string): void {
        if (!this._ext || !perf.enabled) return;
        if (this._active) this._abortActive();

        this._collectFinished();

        const query = this._gl.createQuery();
        if (!query) return;
        this._gl.beginQuery(this._ext.TIME_ELAPSED_EXT, query);
        this._active = query;
        this._activeKey = key;
    }

    end(): void {
        if (!this._ext || !this._active) return;
        this._gl.endQuery(this._ext.TIME_ELAPSED_EXT);
        this._pending.push({ query: this._active, key: this._activeKey, startedAt: performance.now() });
        this._active = null;
    }

    /** Try to read back finished queries; drop stale/unusable ones. */
    private _collectFinished(): void {
        if (!this._ext || this._pending.length === 0) return;
        const now = performance.now();

        for (let i = this._pending.length - 1; i >= 0; i--) {
            const entry = this._pending[i];
            if (now - entry.startedAt > 2000) {
                this._pending.splice(i, 1);
                this._misses++;
                this._gl.deleteQuery(entry.query);
                continue;
            }
            const available = this._gl.getQueryParameter(entry.query, this._gl.QUERY_RESULT_AVAILABLE);
            if (available) {
                const ns = this._gl.getQueryParameter(entry.query, this._gl.QUERY_RESULT) as number;
                const gpuMs = Number(ns) / 1e6; // 64-bit ns -> float ms
                if (Number.isFinite(gpuMs) && gpuMs >= 0 && gpuMs < 1000) {
                    perf.sample(entry.key, gpuMs);
                    this._collected++;
                } else {
                    this._misses++;
                }
                this._gl.deleteQuery(entry.query);
                this._pending.splice(i, 1);
            }
        }
    }

    private _abortActive(): void {
        if (!this._ext || !this._active) return;
        this._gl.endQuery(this._ext.TIME_ELAPSED_EXT);
        this._gl.deleteQuery(this._active);
        this._active = null;
        this._misses++;
    }
}

const perf = new PerfDebugImpl();

export { perf };
