/**
 * bench-constants.ts — 三方法 benchmark 的**唯一共享常量**（禁止各文件手写同一数值）。
 *
 * 依据 THREE_WAY_BENCH_DESIGN.md §4.2（D2）：统一 near/far、焦距与 drawing buffer。
 * 焦距必须精确等于 `1159.5880733038064`（Flux-GS 官方 COLMAP 焦距），
 * 任何文档/smoke 示例中的 `1159.5880738064`（少一位）都是**笔误**，不得再出现。
 */

/** 统一焦距（像素），fx = fy。来源：Flux-GS 官方相机资产 `bench-flux-camera.json`。 */
export const BENCH_FOCAL_PX = 1159.5880733038064;

/** 统一 near 平面。 */
export const BENCH_NEAR = 0.1;

/** 统一 far 平面。 */
export const BENCH_FAR = 100;

/** 统一 drawing buffer / canvas 宽（= 目标手机短边 × DPR 下的选定值，见 §5）。 */
export const BENCH_WIDTH = 1600;

/** 统一 drawing buffer / canvas 高。 */
export const BENCH_HEIGHT = 1063;

/** 主表分辨率元组（用于 `setResolution(w,h)` 与审计对比）。 */
export const BENCH_RESOLUTION: readonly [number, number] = [BENCH_WIDTH, BENCH_HEIGHT];

/** 主表静态协议轮数（条件 5）。 */
export const BENCH_MAIN_TABLE_ROUNDS = 12;

/** 预实验轮数（六种排列 + 1 随机）。 */
export const BENCH_PRELIM_ROUNDS = 7;
