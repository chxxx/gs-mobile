import { Quaternion } from "../math/Quaternion";
import { Matrix3 } from "../math/Matrix3";
import { Matrix4 } from "../math/Matrix4";
import { Vector3 } from "../math/Vector3";

class CameraData {
    private _fx: number = 1132;
    private _fy: number = 1132;
    private _near: number = 0.1;
    private _far: number = 100;

    private _width: number = 512;
    private _height: number = 512;

    private _projectionMatrix: Matrix4 = new Matrix4();
    private _viewMatrix: Matrix4 = new Matrix4();
    private _viewProj: Matrix4 = new Matrix4();
    private _viewMatrixLocked: boolean = false;

    update: (position: Vector3, rotation: Quaternion) => void;
    setSize: (width: number, height: number) => void;
    /** 直接注入 16 个数的视图矩阵（行主序，与 update() 产出的布局一致）。
     *  用于"复现外部渲染器相机"这类场景，避免 position+quaternion 往返重建带来的误差。
     *  注入后视图矩阵会被**锁定**：后续 update() 不再覆盖它，直到调用 unlockViewMatrix()。 */
    setViewMatrix: (matrix: number[]) => void;
    /** 解除视图矩阵锁定，恢复由 position/rotation 驱动的正常相机。 */
    unlockViewMatrix: () => void;

    private _updateProjectionMatrix: () => void;

    constructor() {
        this._updateProjectionMatrix = () => {
            // prettier-ignore
            this._projectionMatrix = new Matrix4(
                2 * this.fx / this.width, 0, 0, 0,
                0, -2 * this.fy / this.height, 0, 0,
                0, 0, this.far / (this.far - this.near), 1,
                0, 0, -(this.far * this.near) / (this.far - this.near), 0
            );

            this._viewProj = this.projectionMatrix.multiply(this.viewMatrix);
        };

        this.update = (position: Vector3, rotation: Quaternion) => {
            // 视图矩阵被显式注入并锁定时，忽略由 position/rotation 驱动的重建，
            // 否则渲染器内部的 update() 调用会覆盖注入的相机（表现为"视角被转动"）。
            if (this._viewMatrixLocked) {
                return;
            }
            const R = Matrix3.RotationFromQuaternion(rotation).buffer;
            const t = position.flat();

            // prettier-ignore
            this._viewMatrix = new Matrix4(
                R[0], R[1], R[2], 0,
                R[3], R[4], R[5], 0,
                R[6], R[7], R[8], 0,
                -t[0] * R[0] - t[1] * R[3] - t[2] * R[6],
                -t[0] * R[1] - t[1] * R[4] - t[2] * R[7],
                -t[0] * R[2] - t[1] * R[5] - t[2] * R[8],
                1,
            );

            this._viewProj = this.projectionMatrix.multiply(this.viewMatrix);
        };

        this.setSize = (width: number, height: number) => {
            this._width = width;
            this._height = height;
            this._updateProjectionMatrix();
        };

        this.setViewMatrix = (matrix: number[]) => {
            if (!Array.isArray(matrix) || matrix.length !== 16) {
                return;
            }
            const m = new Matrix4();
            for (let i = 0; i < 16; i++) {
                m.buffer[i] = matrix[i];
            }
            this._viewMatrix = m;
            this._viewMatrixLocked = true;
            this._viewProj = this.projectionMatrix.multiply(this.viewMatrix);
        };

        this.unlockViewMatrix = () => {
            this._viewMatrixLocked = false;
        };
    }

    get fx() {
        return this._fx;
    }

    set fx(fx: number) {
        if (this._fx !== fx) {
            this._fx = fx;
            this._updateProjectionMatrix();
        }
    }

    get fy() {
        return this._fy;
    }

    set fy(fy: number) {
        if (this._fy !== fy) {
            this._fy = fy;
            this._updateProjectionMatrix();
        }
    }

    get near() {
        return this._near;
    }

    set near(near: number) {
        if (this._near !== near) {
            this._near = near;
            this._updateProjectionMatrix();
        }
    }

    get far() {
        return this._far;
    }

    set far(far: number) {
        if (this._far !== far) {
            this._far = far;
            this._updateProjectionMatrix();
        }
    }

    get width() {
        return this._width;
    }

    get height() {
        return this._height;
    }

    get projectionMatrix() {
        return this._projectionMatrix;
    }

    get viewMatrix() {
        return this._viewMatrix;
    }

    get viewProj() {
        return this._viewProj;
    }
}

export { CameraData };
