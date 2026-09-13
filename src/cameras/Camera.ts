import { CameraData } from "./CameraData";
import { Object3D } from "../core/Object3D";
import { Vector3 } from "../math/Vector3";
import { Vector4 } from "../math/Vector4";

class Camera extends Object3D {
    private _data: CameraData;

    screenPointToRay: (x: number, y: number) => Vector3;

    constructor(camera: CameraData | undefined = undefined) {
        super();

        this._data = camera ? camera : new CameraData();
        this._position = new Vector3(0, 0, -5);

        this.update = () => {
            this.data.update(this.position, this.rotation);
        };

        this.screenPointToRay = (x: number, y: number) => {
            const clipSpaceCoords = new Vector4(x, y, -1, 1);
            const inverseProjectionMatrix = this._data.projectionMatrix.invert();
            const cameraSpaceCoords = clipSpaceCoords.multiply(inverseProjectionMatrix);
            const inverseViewMatrix = this._data.viewMatrix.invert();
            const worldSpaceCoords = cameraSpaceCoords.multiply(inverseViewMatrix);
            const worldSpacePosition = new Vector3(
                worldSpaceCoords.x / worldSpaceCoords.w,
                worldSpaceCoords.y / worldSpaceCoords.w,
                worldSpaceCoords.z / worldSpaceCoords.w,
            );
            const direction = worldSpacePosition.subtract(this.position).normalize();
            return direction;
        };
    }

    get data() {
        return this._data;
    }

    /** 直接注入视图矩阵（16 个数，行主序），用于精确复现外部渲染器的相机；注入后会被锁定。 */
    setViewMatrix(matrix: number[]): void {
        this._data.setViewMatrix(matrix);
    }

    /** 解除视图矩阵锁定，恢复由 position/rotation 驱动的相机。 */
    unlockViewMatrix(): void {
        this._data.unlockViewMatrix();
    }
}

export { Camera };
