import createSortModule from "../../../wasm/sort.js";

let wasmModule: any;
let sortData: {
    positions: Float32Array;
    transforms: Float32Array;
    transformIndices: Uint32Array;
    vertexCount: number;
};

let viewProjPtr: number;
let transformsPtr: number;
let transformIndicesPtr: number;
let positionsPtr: number;
let depthBufferPtr: number;
let depthIndexPtr: number;
let startsPtr: number;
let countsPtr: number;

let allocatedVertexCount: number = 0;
let allocatedTransformCount: number = 0;
let viewProj: number[] = [];

let dirty = true;
let lock = false;
let allocationPending = false;
let sorting = false;
let cullEnabled = true;

async function initWasm() {
    if (!wasmModule) {
        wasmModule = await createSortModule();

        if (!wasmModule || !wasmModule.HEAPF32 || !wasmModule._sort) {
            throw new Error("WASM module failed to initialize properly");
        }
    }
}

const allocateBuffers = async () => {
    if (lock) {
        allocationPending = true;
        return;
    }
    lock = true;
    allocationPending = false;

    if (!wasmModule) {
        await initWasm();
    }

    const targetAllocatedVertexCount = Math.pow(2, Math.ceil(Math.log2(sortData.vertexCount)));
    if (allocatedVertexCount < targetAllocatedVertexCount) {
        if (allocatedVertexCount > 0) {
            wasmModule._free(viewProjPtr);
            wasmModule._free(transformIndicesPtr);
            wasmModule._free(positionsPtr);
            wasmModule._free(depthBufferPtr);
            wasmModule._free(depthIndexPtr);
            wasmModule._free(startsPtr);
            wasmModule._free(countsPtr);
        }

        allocatedVertexCount = targetAllocatedVertexCount;

        viewProjPtr = wasmModule._malloc(16 * 4);
        transformIndicesPtr = wasmModule._malloc(allocatedVertexCount * 4);
        positionsPtr = wasmModule._malloc(3 * allocatedVertexCount * 4);
        depthBufferPtr = wasmModule._malloc(allocatedVertexCount * 4);
        depthIndexPtr = wasmModule._malloc(allocatedVertexCount * 4);
        startsPtr = wasmModule._malloc(allocatedVertexCount * 4);
        countsPtr = wasmModule._malloc(allocatedVertexCount * 4);
    }

    if (allocatedTransformCount < sortData.transforms.length) {
        if (allocatedTransformCount > 0) {
            wasmModule._free(transformsPtr);
        }

        allocatedTransformCount = sortData.transforms.length;
        transformsPtr = wasmModule._malloc(allocatedTransformCount * 4);
    }

    lock = false;
    if (allocationPending) {
        allocationPending = false;
        await allocateBuffers();
    }
};

/**
 * Frustum culling that exactly mirrors the vertex shader's early-out test
 * (RenderProgram.ts lines ~170-174):
 *
 *   clip = 1.2 * pos2d.w;
 *   if (pos2d.z < -pos2d.w || pos2d.z > pos2d.w ||
 *       pos2d.x < -clip || pos2d.x > clip ||
 *       pos2d.y < -clip || pos2d.y > clip) -> splat draws nothing
 *
 * Points that fail this test never produce pixels, so dropping them from the
 * index buffer is visually lossless. We evaluate
 *   clipPos = (proj*view) * (objectTransform) * position
 * using exactly the same matrices the shader composes (viewProj * transform).
 */
const cullFrustum = (order: Uint32Array): Uint32Array => {
    if (!sortData || viewProj.length !== 16) {
        return order;
    }

    const positions = sortData.positions;
    const transforms = sortData.transforms;
    const transformIndices = sortData.transformIndices;
    const objectCount = Math.floor(transforms.length / 16);
    const vp = viewProj;

    // Pre-multiply proj*view with each object transform once per sort pass.
    const combined = new Float64Array(objectCount * 16);
    for (let o = 0; o < objectCount; o++) {
        const base = o * 16;
        for (let c = 0; c < 4; c++) {
            const b0 = transforms[base + c * 4];
            const b1 = transforms[base + c * 4 + 1];
            const b2 = transforms[base + c * 4 + 2];
            const b3 = transforms[base + c * 4 + 3];
            const col = c * 4;
            combined[base + col] = vp[0] * b0 + vp[4] * b1 + vp[8] * b2 + vp[12] * b3;
            combined[base + col + 1] = vp[1] * b0 + vp[5] * b1 + vp[9] * b2 + vp[13] * b3;
            combined[base + col + 2] = vp[2] * b0 + vp[6] * b1 + vp[10] * b2 + vp[14] * b3;
            combined[base + col + 3] = vp[3] * b0 + vp[7] * b1 + vp[11] * b2 + vp[15] * b3;
        }
    }

    const kept = new Uint32Array(order.length);
    let k = 0;
    for (let i = 0; i < order.length; i++) {
        const id = order[i];
        const mBase = transformIndices[id] * 16;
        const pBase = id * 3;
        const x = positions[pBase];
        const y = positions[pBase + 1];
        const z = positions[pBase + 2];

        const w = combined[mBase + 3] * x + combined[mBase + 7] * y + combined[mBase + 11] * z + combined[mBase + 15];
        const cx = combined[mBase] * x + combined[mBase + 4] * y + combined[mBase + 8] * z + combined[mBase + 12];
        const cy = combined[mBase + 1] * x + combined[mBase + 5] * y + combined[mBase + 9] * z + combined[mBase + 13];
        const cz = combined[mBase + 2] * x + combined[mBase + 6] * y + combined[mBase + 10] * z + combined[mBase + 14];

        const clip = 1.2 * w;
        if (cz < -w || cz > w || cx < -clip || cx > clip || cy < -clip || cy > clip) {
            continue; // vertex shader would discard this splat anyway
        }
        kept[k++] = id;
    }

    return k === order.length ? kept : kept.slice(0, k);
};

const runSort = () => {
    if (lock || allocationPending || !wasmModule || !sortData) {
        return;
    }
    lock = true;
    const workerStart = performance.now();

    try {
        // Validate buffer sizes before setting
        const heapF32 = wasmModule.HEAPF32;
        const heapU32 = wasmModule.HEAPU32;

        if (positionsPtr / 4 + sortData.positions.length > heapF32.length) {
            throw new Error("Positions buffer overflow");
        }
        if (transformsPtr / 4 + sortData.transforms.length > heapF32.length) {
            throw new Error("Transforms buffer overflow");
        }
        if (transformIndicesPtr / 4 + sortData.transformIndices.length > heapU32.length) {
            throw new Error("Transform indices buffer overflow");
        }

        heapF32.set(sortData.positions, positionsPtr / 4);
        heapF32.set(sortData.transforms, transformsPtr / 4);
        heapU32.set(sortData.transformIndices, transformIndicesPtr / 4);
        heapF32.set(new Float32Array(viewProj), viewProjPtr / 4);

        const sortStart = performance.now();
        wasmModule._sort(
            viewProjPtr,
            transformsPtr,
            transformIndicesPtr,
            sortData.vertexCount,
            positionsPtr,
            depthBufferPtr,
            depthIndexPtr,
            startsPtr,
            countsPtr,
        );
        console.log(`sort: ${performance.now() - sortStart} ms`);

        // Validate depth index buffer size
        if (depthIndexPtr + sortData.vertexCount * 4 > heapU32.buffer.byteLength) {
            throw new Error("Depth index buffer overflow");
        }

        const depthIndex = new Uint32Array(heapU32.buffer, depthIndexPtr, sortData.vertexCount);
        let detachedDepthIndex = new Uint32Array(depthIndex.slice().buffer);

        if (cullEnabled) {
            detachedDepthIndex = cullFrustum(detachedDepthIndex);
        }

        self.postMessage(
            {
                depthIndex: detachedDepthIndex,
                workerMs: performance.now() - workerStart,
                keptCount: detachedDepthIndex.length,
                totalCount: sortData.vertexCount,
            },
            [detachedDepthIndex.buffer],
        );
    } catch {
        self.postMessage({ depthIndex: new Uint32Array(0) }, []);
    }

    lock = false;
    dirty = false;
};

const throttledSort = () => {
    if (!sorting) {
        sorting = true;
        if (dirty) runSort();

        setTimeout(() => {
            sorting = false;
            throttledSort();
        });
    }
};

self.onmessage = (e) => {
    if (typeof e.data.cullEnabled === "boolean") {
        cullEnabled = e.data.cullEnabled;
    }
    if (e.data.sortData) {
        if (!sortData) {
            sortData = {
                positions: new Float32Array(e.data.sortData.positions),
                transforms: new Float32Array(e.data.sortData.transforms),
                transformIndices: new Uint32Array(e.data.sortData.transformIndices),
                vertexCount: e.data.sortData.vertexCount,
            };
        } else {
            sortData.positions.set(e.data.sortData.positions);
            sortData.transforms.set(e.data.sortData.transforms);
            sortData.transformIndices.set(e.data.sortData.transformIndices);
            sortData.vertexCount = e.data.sortData.vertexCount;
        }

        dirty = true;
        allocateBuffers();
    }
    if (e.data.viewProj) {
        if ((e.data.viewProj as number[]).every((item) => viewProj.includes(item)) === false) {
            viewProj = e.data.viewProj;
            dirty = true;
        }

        throttledSort();
    }
};
