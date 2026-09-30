import { prepareLowRankQPLY, decodeLowRankRange } from "./QPLYLoaderUtils";

type LowRankDecodeRequest = {
    type: "decode";
    jobId: number;
    buffer: ArrayBuffer;
    start: number;
    end: number;
    /** [阶段1 2026-09-30] `?lr=1` 时为 true：只打包 r 个 rank 系数（跳过 `C@B`）；缺省/缺字段 ⇒ false。 */
    wantLowRank?: boolean;
};

type LowRankDecodeResponse = {
    type: "decoded";
    jobId: number;
    start: number;
    end: number;
    splat: ArrayBuffer;
    shRgb: [ArrayBuffer, ArrayBuffer, ArrayBuffer];
    /** 低秩载荷（每点 4×uint）；`wantLowRank=false` 时为 null。 */
    lrRank: ArrayBuffer | null;
};

self.onmessage = (event: { data: LowRankDecodeRequest }) => {
    const { jobId, buffer, start, end, wantLowRank } = event.data;

    try {
        const decodeStart = performance.now();
        const prepared = prepareLowRankQPLY(buffer);
        // [阶段1 2026-09-30] `?lr=1` ⇒ wantLowRank=true ⇒ 只反量化 r 个 rank 系数并打包入 `lrRank`，
        //   **跳过** `C@B`（45 维重建）与 48-half 打包；缺省 false ⇒ 与历史**逐字相同**。
        const result = decodeLowRankRange(prepared, start, end, wantLowRank === true);
        console.log(
            `[LowRankQPLYWorker#${jobId}] decode [${start}, ${end}): ${(performance.now() - decodeStart).toFixed(1)} ms`,
        );

        const response: LowRankDecodeResponse = {
            type: "decoded",
            jobId,
            start,
            end,
            splat: result.splat,
            shRgb: [
                result.shRgb[0].buffer as ArrayBuffer,
                result.shRgb[1].buffer as ArrayBuffer,
                result.shRgb[2].buffer as ArrayBuffer,
            ],
            lrRank: result.lrRank ? (result.lrRank.buffer as ArrayBuffer) : null,
        };

        const transfer: ArrayBuffer[] = [
            result.splat,
            result.shRgb[0].buffer as ArrayBuffer,
            result.shRgb[1].buffer as ArrayBuffer,
            result.shRgb[2].buffer as ArrayBuffer,
        ];
        if (result.lrRank) transfer.push(result.lrRank.buffer as ArrayBuffer);

        self.postMessage(response, transfer);
    } catch (error) {
        self.postMessage({
            type: "error",
            jobId,
            message: error instanceof Error ? error.message : String(error),
        });
    }
};

export {};
