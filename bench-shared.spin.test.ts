/**
 * bench-shared.ts 里"动态相机轨迹 + 内容量探测"这两块纯逻辑的单元测试（`npm test`）。
 *
 * 为什么值得测：这两块是**两臂共用**的判定（本文臂算位姿、基线臂算注入的视图矩阵；内容量扫描
 * 用同一个裁剪盒测试），一旦算错，测出来的就不是"两臂做等量工作"，而是"两条不同的轨迹"，而
 * 结果行里的数字**看起来仍然正常**（历史上 `covered=` 那一列就是这么骗过一轮的）。
 * 这里覆盖：yaw 轨迹的取值与周期、采样帧号、裁剪盒判定、摘要压缩、逐轮标签格式。
 */
import { describe, expect, it } from "vitest";
import {
    ROUND_RESULT_BASE_KEYS,
    ROUND_RESULT_BOOL_KEYS,
    ROUND_RESULT_FIELD_KEYS,
    ROUND_RESULT_NUM_KEYS,
    ROUND_RESULT_STR_KEYS,
    clipInsideRatio,
    copyRoundResultFields,
    formatTriple,
    positionsBounds,
    sanitizeRoundResult,
    sceneBoundsRoundTags,
    sortLagRoundTags,
    spinRoundTags,
    spinSampleFrames,
    spinYawDegAt,
    summarizeSweep,
    sweepRoundTags,
    viewCameraPosition,
} from "./bench-shared";
import type { RoundResult, SpinSpec, SweepResult } from "./bench-shared";

const rateSpec: SpinSpec = { mode: "rate", deg: 10, period: 0, window: 300 };
const swingSpec: SpinSpec = { mode: "swing", deg: 30, period: 100, window: 300 };

describe("spinYawDegAt：两臂唯一的轨迹定义", () => {
    it("rate 档按帧号线性累加（历史口径不变）", () => {
        expect(spinYawDegAt(rateSpec, 0)).toBe(0);
        expect(spinYawDegAt(rateSpec, 1)).toBe(10);
        expect(spinYawDegAt(rateSpec, 30)).toBe(300);
    });

    it("swing 档是振幅 ±deg 的正弦往复：0 帧在基准朝向，1/4 周期到正向顶点", () => {
        expect(spinYawDegAt(swingSpec, 0)).toBeCloseTo(0, 12);
        expect(spinYawDegAt(swingSpec, 25)).toBeCloseTo(30, 12); // period/4
        expect(spinYawDegAt(swingSpec, 50)).toBeCloseTo(0, 12); // period/2
        expect(spinYawDegAt(swingSpec, 75)).toBeCloseTo(-30, 12); // 3·period/4
        expect(spinYawDegAt(swingSpec, 100)).toBeCloseTo(0, 12); // 一整个周期
    });

    it("swing 档的 |yaw| 恒不超过摆幅（这是'整段窗口看着同一片内容'的前提）", () => {
        for (let i = 0; i < 300; i++) {
            expect(Math.abs(spinYawDegAt(swingSpec, i))).toBeLessThanOrEqual(30 + 1e-9);
        }
    });
});

describe("spinSampleFrames：内容量扫描的采样帧", () => {
    it("k=1 只取基准帧（0 = 与静止轮同一个机位）", () => {
        expect(spinSampleFrames(swingSpec, 1)).toEqual([0]);
    });

    it("k=9 覆盖整个窗口的首尾，且帧号唯一", () => {
        const frames = spinSampleFrames(swingSpec, 9);
        expect(frames.length).toBe(9);
        expect(frames[0]).toBe(0);
        expect(frames[frames.length - 1]).toBe(swingSpec.window - 1);
        expect(new Set(frames).size).toBe(frames.length);
    });

    it("k 越界时被夹到 [1, 1000]；k ≥ 窗口长度时给出窗口内每一帧", () => {
        expect(spinSampleFrames(swingSpec, 0).length).toBe(1);
        expect(spinSampleFrames(swingSpec, 1000).length).toBe(swingSpec.window);
        // 逐帧档（`?sweep>=window`）：帧号 0..window-1 一个不漏
        const all = spinSampleFrames(swingSpec, 300);
        expect(all.length).toBe(swingSpec.window);
        expect(all[0]).toBe(0);
        expect(all[all.length - 1]).toBe(swingSpec.window - 1);
    });
});

describe("clipInsideRatio：两臂共用的裁剪盒判定", () => {
    // 单位 viewProj：裁剪盒 = |x| < 1.2w, |y| < 1.2w, -w < z < w（w = 1）
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    it("盒内/盒外/深度越界三种点被正确分类", () => {
        const points = new Float32Array([
            0,
            0,
            0.5, // 盒内（z=0.5 < w=1）
            2,
            0,
            0.5, // x=2 > 1.2 → 盒外
            0,
            0,
            1.5, // z=1.5 > w → 深度越界
        ]);
        const r = clipInsideRatio(points, 3, identity, 4000);
        expect(r.sampled).toBe(3);
        expect(r.inside).toBe(1);
        expect(r.insidePct).toBeCloseTo(100 / 3, 6);
    });

    it("按 maxSamples 稀疏采样（点数远大于采样上限时只取 stride 个）", () => {
        const n = 10000;
        const points = new Float32Array(n * 3); // 全部在盒内（原点）
        const r = clipInsideRatio(points, n, identity, 2000);
        expect(r.sampled).toBe(2000); // stride = floor(10000/2000) = 5
        expect(r.inside).toBe(2000);
        expect(r.insidePct).toBe(100);
    });

    it("输入缺失/维度不对时返回 0（不能让扫描把整轮测量搞崩）", () => {
        expect(clipInsideRatio(null, 10, identity).sampled).toBe(0);
        expect(clipInsideRatio(new Float32Array(30), 10, null).sampled).toBe(0);
        expect(clipInsideRatio(new Float32Array(30), 10, [1, 0, 0]).sampled).toBe(0);
        expect(clipInsideRatio(new Float32Array(30), 0, identity).sampled).toBe(0);
    });
});

describe("viewCameraPosition：从视图矩阵反解相机世界位置", () => {
    /** 用世界矩阵 C = T(p)·R 构造它的逆（= 视图矩阵，列主序）：`V = [Rᵀ | -Rᵀp]`。 */
    const viewOf = (R: number[], p: [number, number, number]): number[] => {
        const Rt = [R[0], R[4], R[8], 0, R[1], R[5], R[9], 0, R[2], R[6], R[10], 0, 0, 0, 0, 1];
        const t = [
            -(Rt[0] * p[0] + Rt[4] * p[1] + Rt[8] * p[2]),
            -(Rt[1] * p[0] + Rt[5] * p[1] + Rt[9] * p[2]),
            -(Rt[2] * p[0] + Rt[6] * p[1] + Rt[10] * p[2]),
        ];
        const V = [...Rt];
        V[12] = t[0];
        V[13] = t[1];
        V[14] = t[2];
        return V;
    };

    it("纯平移（恒等旋转）", () => {
        const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const p: [number, number, number] = [1, 2, 3];
        const got = viewCameraPosition(viewOf(identity, p));
        expect(got[0]).toBeCloseTo(1, 12);
        expect(got[1]).toBeCloseTo(2, 12);
        expect(got[2]).toBeCloseTo(3, 12);
    });

    it("带旋转（绕 Y 90°）—— 行/列混用会读出 (-1,2,-3)，本实现应给出 (1,2,3)", () => {
        // R_y(90°) 列主序：三列为 (0,0,-1) / (0,1,0) / (1,0,0)
        const Ry90 = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
        const got = viewCameraPosition(viewOf(Ry90, [1, 2, 3]));
        expect(got[0]).toBeCloseTo(1, 12);
        expect(got[1]).toBeCloseTo(2, 12);
        expect(got[2]).toBeCloseTo(3, 12);
    });
});

describe("summarizeSweep：扫描结果压缩成逐轮字段", () => {
    const sweep: SweepResult = {
        samples: [
            { frame: 0, yaw: 0, pos: [1, 2, 3], coveredPct: 99.8, seenPct: 70, seenCount: 1400, drawn: 610000 },
            { frame: 299, yaw: 10.5, pos: [1, 2, 3], coveredPct: 96.2, seenPct: 64, seenCount: 1280, drawn: 610000 },
        ],
    };

    it("均值/极值/逐姿态列表都按同一格式给出", () => {
        const s = summarizeSweep(sweep);
        expect(s.k).toBe(2);
        expect(s.covMean).toBeCloseTo(98, 6);
        expect(s.covMin).toBe(96.2);
        expect(s.covMax).toBe(99.8);
        expect(s.seenMean).toBeCloseTo(67, 6);
        expect(s.drawnMin).toBe(610000);
        expect(s.drawnMax).toBe(610000); // 相等 = 提交的实例数与视角无关
        expect(s.frames).toBe("0,299");
        expect(s.yaws).toBe("0.00,10.50");
        expect(s.poses).toBe("1.000,2.000,3.000|1.000,2.000,3.000");
        expect(s.covList).toBe("99.8,96.2");
        expect(s.seenList).toBe("70.0,64.0");
        expect(s.drawnList).toBe("610000,610000");
    });

    it("空扫描不抛异常（k=0 时各字段为 0/空串）", () => {
        const s = summarizeSweep({ samples: [] });
        expect(s.k).toBe(0);
        expect(s.covMean).toBe(0);
        expect(s.frames).toBe("");
    });
});

describe("逐轮行标签（两臂共用实现）", () => {
    it("spin 标签带模式/周期/峰值，rate 与 swing 的语义可区分", () => {
        const tags = spinRoundTags({ spinDeg: 30, spinMode: "swing", spinPeriod: 300, spinPeakDeg: 0.628 });
        expect(tags).toContain("spin=30.000");
        expect(tags).toContain("spin_mode=swing");
        expect(tags).toContain("spin_period=300");
        expect(tags).toContain("spin_peak=0.628");
        const rate = spinRoundTags({ spinDeg: 10, spinMode: "rate", spinPeakDeg: 10 });
        expect(rate).toContain("spin_mode=rate");
        expect(rate).toContain("spin_period=-"); // rate 档没有周期
    });

    it("没有内容量扫描数据时不追加任何字段（静止轮的历史行格式不变）", () => {
        expect(sweepRoundTags({})).toEqual([]);
        expect(sweepRoundTags({ sweepK: 0 })).toEqual([]);
    });

    it("有扫描数据时给出逐姿态列表与摘要，且能标出'实例数是否随视角变'", () => {
        const s = summarizeSweep({
            samples: [
                { frame: 0, yaw: 0, pos: [0, 0, 0], coveredPct: 99, seenPct: 70, seenCount: 7, drawn: 610000 },
                { frame: 1, yaw: 5, pos: [0, 0, 0], coveredPct: 97, seenPct: 60, seenCount: 6, drawn: 610000 },
            ],
        });
        const tags = sweepRoundTags({
            sweepK: s.k,
            sweepFrames: s.frames,
            sweepCoveredList: s.covList,
            sweepSeenList: s.seenList,
            sweepDrawnList: s.drawnList,
            sweepCoveredMean: s.covMean,
            sweepSeenMean: s.seenMean,
            sweepDrawnMin: s.drawnMin,
            sweepDrawnMax: s.drawnMax,
        });
        expect(tags).toContain("sweep_k=2");
        expect(tags).toContain("sweep_cov=99.0,97.0");
        expect(tags).toContain("sweep_seen=70.0,60.0");
        expect(tags).toContain("sweep_drawn_const=1");
    });

    it("实例数在各姿态不同时标 0（提醒‘要画的东西变了’）", () => {
        const tags = sweepRoundTags({ sweepK: 2, sweepDrawnMin: 100, sweepDrawnMax: 200 });
        expect(tags).toContain("sweep_drawn_const=0");
    });
});

describe("结果字段法表：清洗与逐字段合并的**唯一来源**（治'第五次漏拷贝'）", () => {
    const table = [
        ...ROUND_RESULT_BASE_KEYS,
        ...ROUND_RESULT_NUM_KEYS,
        ...ROUND_RESULT_STR_KEYS,
        ...ROUND_RESULT_BOOL_KEYS,
    ];

    it("字段表无重复键，且与遍历表 ROUND_RESULT_FIELD_KEYS 数量一致", () => {
        expect(new Set(table).size).toBe(table.length);
        expect(ROUND_RESULT_FIELD_KEYS.length).toBe(table.length);
        // '字段进了接口却忘了登记'由编译期闸门（MissingResultKeys 必须收敛到 never）拦截，
        // 不是在运行时 —— 见 bench-shared 顶部说明与 assertResultKeysRegistered<…>()。
    });

    it("sanitizeRoundResult 只放行登记过的基本类型：对象/TypedArray/NaN/类型不符一律丢弃", () => {
        const raw = {
            scene: "garden",
            round: 2,
            ts: "2026-09-21T00:00:00.000Z",
            ok: true,
            fps: 199.5,
            coveredPct: Number.NaN, // 非有限数 → 丢弃
            points: "610000", // 类型不符 → 丢弃
            spinMode: "swing",
            spinDeg: 60,
            sortLagOn: true,
            drawOk: true,
            sweepCoveredList: "99.0,98.0",
            // 下面这些**绝不能**进入结果数组（会把旧轮的模型数据钉在内存里）
            splat: { data: new Float32Array(9) },
            depthIndex: new Uint32Array(4),
            unknownField: 42,
        } as unknown as RoundResult;
        const clean = sanitizeRoundResult(raw);
        expect(clean.fps).toBe(199.5);
        expect(clean.spinMode).toBe("swing");
        expect(clean.sortLagOn).toBe(true);
        expect(clean.drawOk).toBe(true);
        expect(clean.sweepCoveredList).toBe("99.0,98.0");
        expect(clean.coveredPct).toBeUndefined();
        expect(clean.points).toBeUndefined();
        const keys = Object.keys(clean);
        expect(keys).not.toContain("splat");
        expect(keys).not.toContain("depthIndex");
        expect(keys).not.toContain("unknownField");
        expect(clean.scene).toBe("garden");
    });

    it("copyRoundResultFields 搬走**每一个登记字段**（父页面不再逐字段手抄）", () => {
        const src = { scene: "s", round: 1, ts: "t", ok: true } as RoundResult;
        const srcRec = src as unknown as Record<string, unknown>;
        for (const k of ROUND_RESULT_NUM_KEYS) srcRec[k] = 1.25;
        for (const k of ROUND_RESULT_STR_KEYS) srcRec[k] = "x";
        for (const k of ROUND_RESULT_BOOL_KEYS) srcRec[k] = true;
        const dst: RoundResult = { scene: "", round: 0, ts: "", ok: false };
        copyRoundResultFields(dst, src);
        // 关键断言：目标对象的键集合**恰好等于**字段表 —— 少一个就说明又出现了"漏拷"，
        // 多一个就说明有人绕开字段表往结果里塞了东西。
        expect(Object.keys(dst).sort()).toEqual([...ROUND_RESULT_FIELD_KEYS].sort());
        const dstRec = dst as unknown as Record<string, unknown>;
        for (const k of ROUND_RESULT_FIELD_KEYS) {
            expect(dstRec[k]).toEqual(srcRec[k]);
        }
    });

    it("未上报（undefined）的字段不覆盖目标对象的缺省值", () => {
        const dst: RoundResult = { scene: "s", round: 1, ts: "t", ok: true, fpsCapped: false };
        copyRoundResultFields(dst, { scene: "s", round: 1, ts: "t", ok: true });
        expect(dst.fpsCapped).toBe(false);
    });
});

describe("逐轮标签：交给它几个字段就必须打印几个（'漏打印'会被这题抓住）", () => {
    it("spinRoundTags 打印全部入参", () => {
        const tags = spinRoundTags({
            spinDeg: 11.111,
            spinMode: "swing",
            spinPeriod: 22,
            spinPeakDeg: 33.333,
            spinPivot: "p-44",
            spinErr: 5.5e-6,
        });
        for (const t of [
            "spin=11.111",
            "spin_mode=swing",
            "spin_period=22",
            "spin_peak=33.333",
            "spin_pivot=p-44",
            "spin_err=5.5e-6",
        ]) {
            expect(tags).toContain(t);
        }
    });

    it("sweepRoundTags 打印全部入参（含逐姿态列表与 drawn_const）", () => {
        const tags = sweepRoundTags({
            sweepK: 3,
            sweepFrames: "0,150,299",
            sweepYaws: "0.0,15.0,0.0",
            sweepPoses: "1,2,3|4,5,6|7,8,9",
            sweepCoveredList: "99.0,98.0,99.5",
            sweepSeenList: "66.5,60.1,66.0",
            sweepDrawnList: "610000,610000,610000",
            sweepCoveredMean: 98.83,
            sweepCoveredMin: 98.0,
            sweepCoveredMax: 99.5,
            sweepSeenMean: 64.2,
            sweepSeenMin: 60.1,
            sweepSeenMax: 66.5,
            sweepDrawnMin: 610000,
            sweepDrawnMax: 610000,
        });
        for (const t of [
            "sweep_k=3",
            "sweep_frm=0,150,299",
            "sweep_yaw=0.0,15.0,0.0",
            "sweep_pos=1,2,3|4,5,6|7,8,9",
            "sweep_cov=99.0,98.0,99.5",
            "sweep_seen=66.5,60.1,66.0",
            "sweep_drawn=610000,610000,610000",
            "sweep_cov_mean=98.8",
            "sweep_cov_min=98.0",
            "sweep_cov_max=99.5",
            "sweep_seen_mean=64.2",
            "sweep_seen_min=60.1",
            "sweep_seen_max=66.5",
            "sweep_drawn_min=610000",
            "sweep_drawn_max=610000",
            "sweep_drawn_const=1",
        ]) {
            expect(tags).toContain(t);
        }
    });
});

describe("sortlag / scene_bounds 标签：新字段的打印与'0.039 单位'的分母", () => {
    it("sortLagRoundTags 打印数值一栏；没有探针数据时返回空数组", () => {
        expect(sortLagRoundTags({})).toEqual([]);
        const tags = sortLagRoundTags({
            sortLagOn: true,
            sortLagFrames: 300,
            sortLagCadenceMed: 3.5,
            sortLagCadenceMax: 6,
            sortLagLagMed: 1.75,
            sortLagLagMax: 5,
            sortLagHotFrame: 12,
            sortLagHotLag: 5,
            sortLagHotDeg: 9.42,
            sortLagPipeFrames: 4.1,
            sortLagWorkerMs: 21.5,
            sortLagLatencyMs: 24.25,
            sortLagRealLag: 9,
            sortLagLagList: "0,1,2",
            sortLagRefPct8: 12.345,
            sortLagRefMax: 200,
            sortLagDiff8x1: 0.123,
            sortLagDiff8x2: 0.234,
            sortLagDiff8x4: 0.345,
            sortLagDiff8x8: 0.456,
            sortLagDiff8Real: 0.567,
            sortLagDiffMax1: 40,
            sortLagDiffMax2: 60,
            sortLagDiffMax4: 80,
            sortLagDiffMax8: 100,
            sortLagDiffMaxReal: 120,
            sortLagNote: "note x",
        });
        for (const t of [
            "sortlag_frames=300",
            "sortlag_cadence_med=3.50",
            "sortlag_cadence_max=6",
            "sortlag_lag_med=1.75",
            "sortlag_lag_max=5",
            "sortlag_hot=12@5f/9.42deg",
            "sortlag_pipe=4.10f",
            "sortlag_worker=21.50ms",
            "sortlag_latency=24.25ms",
            "sortlag_real=9f",
            "sortlag_ref=pct8:12.345%/max:200",
            "sortlag_diff=pct8:0.123/0.234/0.345/0.456%",
            "sortlag_diff_real=pct8:0.567%",
            "sortlag_diff_max=40/60/80/100",
            "sortlag_diff_max_real=120",
            "sortlag_lag_list=0,1,2",
            "sortlag_note=note_x",
        ]) {
            expect(tags).toContain(t);
        }
        // 截图（base64）很长：没带 `?sortlag=shot` 时一个都不打印，带了就原样带出
        expect(tags.some((t) => t.startsWith("sortlag_shot_"))).toBe(false);
        expect(sortLagRoundTags({ sortLagOn: true, sortLagShotA1: "data:image/jpeg;base64,AA" })).toContain(
            "sortlag_shot_a1=data:image/jpeg;base64,AA",
        );
    });

    it("sceneBoundsRoundTags：两臂同格式；缺数据时不打印（历史行格式不变）", () => {
        expect(sceneBoundsRoundTags({})).toEqual([]);
        const tags = sceneBoundsRoundTags({
            sceneMin: "-6.0000,-1.0000,-5.0000",
            sceneMax: "6.0000,2.0000,5.0000",
            sceneDiag: 13.5,
        });
        expect(tags).toContain("scene_min=-6.0000,-1.0000,-5.0000");
        expect(tags).toContain("scene_max=6.0000,2.0000,5.0000");
        expect(tags).toContain("scene_diag=13.5000");
    });
});

describe("positionsBounds：'0.039 单位算不算大' 的分母（场景包围盒对角线）", () => {
    it("单位立方体的对角线 = sqrt(3)，min/max 与点数正确", () => {
        const b = positionsBounds(new Float32Array([0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1]), 4);
        expect(b).not.toBeNull();
        expect(b!.min).toEqual([0, 0, 0]);
        expect(b!.max).toEqual([1, 1, 1]);
        expect(b!.diag).toBeCloseTo(Math.sqrt(3), 12);
        expect(b!.count).toBe(4);
        expect(formatTriple(b!.min)).toBe("0.0000,0.0000,0.0000");
    });

    it("空 / 缺输入返回 null（不能把场景尺度算成 0 当作分母）", () => {
        expect(positionsBounds(null, 10)).toBeNull();
        expect(positionsBounds(undefined, 10)).toBeNull();
        expect(positionsBounds(new Float32Array(9), 0)).toBeNull();
    });
});
