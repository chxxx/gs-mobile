export async function initiateFetchRequest(url: string, useCache: boolean, signal?: AbortSignal): Promise<Response> {
    const req = await fetch(url, {
        mode: "cors",
        credentials: "omit",
        cache: useCache ? "force-cache" : "default",
        signal,
    });

    if (req.status != 200) {
        throw new Error(req.status + " Unable to load " + req.url);
    }

    return req;
}

/** 读取响应体到内存。传入 `signal` 时可在读取过程中被中止（bench-case 的 dispose 用）。 */
export async function loadDataIntoBuffer(
    res: Response,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    const reader = res.body!.getReader();
    const contentLength = res.headers.get("content-length");
    const estimatedBytes = contentLength && !isNaN(parseInt(contentLength)) ? parseInt(contentLength) : undefined;

    const chunks = [];
    let receivedLength = 0;

    try {
        while (true) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const { done, value } = await reader.read();
            if (done) break;

            chunks.push(value);
            receivedLength += value.length;

            if (onProgress && estimatedBytes) {
                // Cap progress at 95% to account for inaccurate content-length (compression, etc.)
                const rawProgress = receivedLength / estimatedBytes;
                const cappedProgress = Math.min(rawProgress * 0.95, 0.95);
                onProgress(cappedProgress);
            }
        }

        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const buffer = new Uint8Array(receivedLength);
        let position = 0;
        for (const chunk of chunks) {
            buffer.set(chunk, position);
            position += chunk.length;
        }

        // Always send final 100% progress when complete
        if (onProgress) {
            onProgress(1.0);
        }

        return buffer;
    } finally {
        // 无论成功、失败还是被中止，都断开分块引用与读取流：
        // 这些 Uint8Array 分块合计等于整个模型体积，留着会让旧轮的下载缓冲迟迟无法回收。
        chunks.length = 0;
        try {
            reader.releaseLock();
        } catch {
            /* ignore */
        }
    }
}
