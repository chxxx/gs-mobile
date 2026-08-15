import { prepareLowRankQPLY, decodeLowRankRange } from "./QPLYLoaderUtils";

type LowRankDecodeRequest = {
    type: "decode";
    jobId: number;
    buffer: ArrayBuffer;
    start: number;
    end: number;
};

type LowRankDecodeResponse = {
    type: "decoded";
    jobId: number;
    start: number;
    end: number;
    splat: ArrayBuffer;
    shRgb: [ArrayBuffer, ArrayBuffer, ArrayBuffer];
};

self.onmessage = (event: { data: LowRankDecodeRequest }) => {
    const { jobId, buffer, start, end } = event.data;

    try {
        const decodeStart = performance.now();
        const prepared = prepareLowRankQPLY(buffer);
        const result = decodeLowRankRange(prepared, start, end);
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
        };

        self.postMessage(response, [
            result.splat,
            result.shRgb[0].buffer as ArrayBuffer,
            result.shRgb[1].buffer as ArrayBuffer,
            result.shRgb[2].buffer as ArrayBuffer,
        ]);
    } catch (error) {
        self.postMessage({
            type: "error",
            jobId,
            message: error instanceof Error ? error.message : String(error),
        });
    }
};

export {};
