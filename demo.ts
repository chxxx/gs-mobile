import * as SPLAT from "./src/index";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const progressDialog = document.getElementById("progress-dialog") as HTMLDialogElement;
const progressIndicator = document.getElementById("progress-indicator") as HTMLProgressElement;
const progressContainer = document.getElementById("progress-container") as HTMLDivElement;
const fpsCounter = document.getElementById("fps-counter") as HTMLDivElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const dropZone = document.getElementById("drop-zone") as HTMLDivElement;

const renderer = new SPLAT.WebGLRenderer(canvas);
const scene = new SPLAT.Scene();
const camera = new SPLAT.Camera();
const controls = new SPLAT.OrbitControls(camera, canvas);

let lastTime = performance.now();
let frameCount = 0;

function updateFps() {
    const now = performance.now();
    frameCount++;
    if (now - lastTime >= 1000) {
        fpsCounter.textContent = `FPS: ${frameCount}`;
        frameCount = 0;
        lastTime = now;
    }
}

async function loadFile(file: File) {
    progressContainer.style.display = "grid";
    progressDialog.open = true;

    await SPLAT.PLYLoader.LoadFromFileAsync(file, scene, (progress) => {
        progressIndicator.value = progress * 100;
    });

    progressDialog.close();
    progressContainer.style.display = "none";
    dropZone.style.display = "none";
}

fileInput.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
        void loadFile(file);
    }
});

dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer?.files[0];
    if (file) {
        void loadFile(file);
    }
});

dropZone.addEventListener("click", () => {
    fileInput.click();
});

function main() {
    const handleResize = () => {
        renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    };

    const frame = () => {
        controls.update();
        renderer.render(scene, camera);
        updateFps();
        requestAnimationFrame(frame);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    requestAnimationFrame(frame);
}

main();
