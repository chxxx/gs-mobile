/**
 * 三方同视角自检（第7章对比实测的前提）。
 *
 * `bench.html?cam=flux` 用 `bench-flux-camera.json` 里的 (position, quaternion) 复现 Flux-GS 原相机，
 * 本用例把这条路径与 Flux-GS 原矩阵的偏差钉成数值，避免以后改相机数学时悄悄放大。
 *
 * 背景：Flux-GS 源码里的 `defaultViewMatrix` 只写了 2 位小数、并非严格正交，因此"位置 + 四元数"
 * （先归一化为刚体旋转）与它原矩阵必然存在小偏差：实测最大 0.32°（1600px 画布下画面边缘约 4.4px），
 * 肉眼不可分、对测帧结论无影响。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Camera } from "./Camera";
import { Quaternion } from "../math/Quaternion";
import { Vector3 } from "../math/Vector3";

interface FluxPose {
    position: number[];
    quaternion: number[];
    view_matrix: number[];
}
interface FluxCameraFile {
    focal_px: number;
    cameras: FluxPose[];
    default_view: FluxPose;
}

const FILE = fileURLToPath(new URL("../../bench-flux-camera.json", import.meta.url));
const flux = JSON.parse(readFileSync(FILE, "utf-8")) as FluxCameraFile;

/** 视图矩阵前 3 行 = 相机基（世界→相机）；比较前归一化，避免把"非正交"的模长差算成角度差。 */
function basisRows(matrix: number[]): number[][] {
    const rows = [
        [matrix[0], matrix[1], matrix[2]],
        [matrix[3], matrix[4], matrix[5]],
        [matrix[6], matrix[7], matrix[8]],
    ];
    return rows.map((row) => {
        const len = Math.hypot(row[0], row[1], row[2]);
        return row.map((v) => v / len);
    });
}

function angleDeg(a: number[], b: number[]): number {
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}

/** 用"位置 + 四元数"驱动相机，返回视图矩阵（与 bench.ts 的 applyFluxCamera 同一条路径）。 */
function viewMatrixViaPose(pose: FluxPose): number[] {
    const camera = new Camera();
    camera.data.fx = flux.focal_px;
    camera.data.fy = flux.focal_px;
    camera.position = new Vector3(pose.position[0], pose.position[1], pose.position[2]);
    camera.rotation = new Quaternion(pose.quaternion[0], pose.quaternion[1], pose.quaternion[2], pose.quaternion[3]);
    camera.update();
    return camera.data.viewMatrix.buffer;
}

function maxAxisDeviationDeg(pose: FluxPose): number {
    const got = basisRows(viewMatrixViaPose(pose));
    const want = basisRows(pose.view_matrix);
    return Math.max(...[0, 1, 2].map((i) => angleDeg(got[i], want[i])));
}

describe("cam=flux 相机复现（三方同视角）", () => {
    it("default_view：位置+四元数复现的视图矩阵与原矩阵偏差 < 0.5°", () => {
        expect(maxAxisDeviationDeg(flux.default_view)).toBeLessThan(0.5);
    });

    it("平移分量由 position 直接决定，偏差 < 0.05", () => {
        const got = viewMatrixViaPose(flux.default_view);
        const want = flux.default_view.view_matrix;
        for (let i = 12; i < 15; i++) {
            expect(Math.abs(got[i] - want[i])).toBeLessThan(0.05);
        }
    });

    it("Flux-GS 硬编码镜头同样成立（COLMAP 焦距，9 位小数旋转）", () => {
        expect(flux.cameras.length).toBeGreaterThan(0);
        for (const pose of flux.cameras) {
            expect(maxAxisDeviationDeg(pose)).toBeLessThan(0.01);
        }
        expect(flux.focal_px).toBeCloseTo(1159.588, 3);
    });
});
