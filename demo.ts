import * as SPLAT from "./src/index";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const progressEl = document.getElementById("progress") as HTMLDivElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const fpsValueEl = document.getElementById("fps-value") as HTMLSpanElement;
const shValueEl = document.getElementById("sh-value") as HTMLSpanElement;

const renderer = new SPLAT.WebGLRenderer(canvas);
const scene = new SPLAT.Scene();
const camera = new SPLAT.Camera();
const controls = new SPLAT.OrbitControls(camera, canvas);

function setProgress(visible: boolean, text = "Loading...") {
    progressEl.style.display = visible ? "block" : "none";
    progressEl.textContent = text;
}

async function loadPlyFromUrl(url: string) {
    scene.reset();
    setProgress(true, "Loading PLY...");
    await SPLAT.PLYLoader.LoadAsync(
        url,
        scene,
        (progress) => {
            setProgress(true, `Loading PLY... ${Math.round(progress * 100)}%`);
        },
        "",
        false,
    );
    updateSHInfo();
    setProgress(false);
}

async function loadPlyFromFile(file: File) {
    scene.reset();
    setProgress(true, `Loading ${file.name}...`);
    await SPLAT.PLYLoader.LoadFromFileAsync(
        file,
        scene,
        (progress) => {
            setProgress(true, `Loading ${file.name}... ${Math.round(progress * 100)}%`);
        },
        "",
    );
    updateSHInfo();
    setProgress(false);
}

function updateSHInfo() {
    let hasSH = false;
    for (const object of scene.objects) {
        if (object instanceof SPLAT.Splat && object.data.hasSphericalHarmonics) {
            hasSH = true;
            break;
        }
    }
    shValueEl.textContent = hasSH ? "3阶" : "DC (0阶)";
}

function startRenderLoop() {
    const handleResize = () => {
        renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    };

    let frameCount = 0;
    let lastFpsTime = performance.now();

    const frame = () => {
        const now = performance.now();
        frameCount++;

        if (now - lastFpsTime >= 1000) {
            const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
            fpsValueEl.textContent = String(fps);
            frameCount = 0;
            lastFpsTime = now;
        }

        controls.update();
        renderer.render(scene, camera);
        requestAnimationFrame(frame);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    requestAnimationFrame(frame);
}

fileInput.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    await loadPlyFromFile(file);
});

async function main() {
    // 默认尝试加载 public/point_cloud_quantised_half.ply；如果没有，可通过页面左上角按钮选择本地文件。
    try {
        await loadPlyFromUrl("/point_cloud_quantised_half.ply");
    } catch (e) {
        console.warn("public/point_cloud_quantised_half.ply 未找到，等待用户选择本地 PLY 文件", e);
        setProgress(true, "请将 PLY 文件放入 public/point_cloud_quantised_half.ply，或点击左上角选择本地文件");
    }

    startRenderLoop();
}

main();
