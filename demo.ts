import * as SPLAT from "./src/index";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const progressDialog = document.getElementById("progress-dialog") as HTMLDialogElement;
const progressIndicator = document.getElementById("progress-indicator") as HTMLProgressElement;
const progressContainer = document.getElementById("progress-container") as HTMLDivElement;
const fpsCounter = document.getElementById("fps-counter") as HTMLDivElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const dropZone = document.getElementById("drop-zone") as HTMLDivElement;
const sceneSelect = document.getElementById("scene-select") as HTMLSelectElement;

const renderer = new SPLAT.WebGLRenderer(canvas);
const scene = new SPLAT.Scene();
const camera = new SPLAT.Camera();
const controls = new SPLAT.OrbitControls(camera, canvas);

let lastTime = performance.now();
let frameCount = 0;
let firstFrameStart: number | null = null;
let firstFrameLogged = false;

function updateFps() {
    const now = performance.now();
    frameCount++;
    if (now - lastTime >= 1000) {
        fpsCounter.textContent = `FPS: ${frameCount}`;
        frameCount = 0;
        lastTime = now;
    }
}

function resetScene() {
    scene.reset();
    firstFrameStart = null;
    firstFrameLogged = false;
}

function showProgress() {
    progressContainer.hidden = false;
    progressDialog.open = true;
}

function hideProgress() {
    progressDialog.close();
    progressContainer.hidden = true;
}

function adjustPixelRatio() {
    const splat = scene.objects.find((o) => o instanceof SPLAT.Splat) as SPLAT.Splat | undefined;
    const vertexCount = splat?.data?.vertexCount ?? 0;
    // Use physical (DPR) resolution for all scenes.
    const pixelRatio = window.devicePixelRatio || 1;
    renderer.setPixelRatio(pixelRatio);
    console.log(`Vertex count: ${vertexCount}, pixel ratio set to: ${pixelRatio.toFixed(2)}`);
    console.log(`Render resolution: ${renderer.canvas.width} x ${renderer.canvas.height}`);
}

async function loadFromUrl(url: string) {
    resetScene();
    showProgress();
    firstFrameStart = performance.now();
    firstFrameLogged = false;

    try {
        await SPLAT.PLYLoader.LoadAsync(url, scene, (progress) => {
            progressIndicator.value = progress * 100;
        });
        adjustPixelRatio();
    } catch (err) {
        console.error("Failed to load scene:", err);
        alert(`Failed to load scene: ${url}`);
    } finally {
        hideProgress();
        dropZone.style.display = "none";
    }
}

async function loadFile(file: File) {
    resetScene();
    showProgress();
    firstFrameStart = performance.now();
    firstFrameLogged = false;

    await SPLAT.PLYLoader.LoadFromFileAsync(file, scene, (progress) => {
        progressIndicator.value = progress * 100;
    });

    adjustPixelRatio();
    hideProgress();
    dropZone.style.display = "none";
    sceneSelect.value = "";
}

async function populateSceneSelector() {
    try {
        const response = await fetch("scenes.json");
        if (!response.ok) {
            console.warn("scenes.json not found");
            return;
        }
        const scenes: { name: string; file: string }[] = await response.json();
        for (const scene of scenes) {
            const option = document.createElement("option");
            option.value = scene.file;
            option.textContent = scene.name;
            sceneSelect.appendChild(option);
        }
    } catch (err) {
        console.warn("Failed to load scenes.json:", err);
    }
}

sceneSelect.addEventListener("change", (e) => {
    const target = e.target as HTMLSelectElement;
    const url = target.value;
    if (url) {
        void loadFromUrl(url);
    }
});

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
        renderer.resize();
    };

    const frame = () => {
        controls.update();
        renderer.render(scene, camera);
        if (firstFrameStart !== null && !firstFrameLogged && scene.objects.length > 0) {
            const elapsedSeconds = (performance.now() - firstFrameStart) / 1000;
            console.log(`First Frame: ${elapsedSeconds.toFixed(3)} s`);
            firstFrameLogged = true;
        }
        updateFps();
        requestAnimationFrame(frame);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    void populateSceneSelector();
    requestAnimationFrame(frame);
}

function setBenchmarkResolution(width: number, height: number) {
    renderer.disableAutoResize();
    renderer.setPixelRatio(1);
    renderer.setSize(width, height);
    console.log(`Benchmark resolution set to: ${renderer.canvas.width} x ${renderer.canvas.height}`);
}

async function benchmarkFPS(frameCount: number = 300, batchSize: number = 60) {
    if (scene.objects.length === 0) {
        console.warn("No scene loaded");
        return;
    }

    // Warm-up
    for (let i = 0; i < 30; i++) {
        controls.update();
        renderer.render(scene, camera);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const start = performance.now();
    let rendered = 0;
    while (rendered < frameCount) {
        const currentBatch = Math.min(batchSize, frameCount - rendered);
        for (let i = 0; i < currentBatch; i++) {
            controls.update();
            renderer.render(scene, camera);
        }
        rendered += currentBatch;
        if (rendered < frameCount) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    const elapsed = (performance.now() - start) / 1000;
    const fps = frameCount / elapsed;
    console.log(`Benchmark FPS: ${fps.toFixed(2)} (${frameCount} frames in ${elapsed.toFixed(3)} s)`);
    console.log(`Render resolution: ${renderer.canvas.width} x ${renderer.canvas.height}`);
}

(window as unknown as { benchmarkFPS: typeof benchmarkFPS }).benchmarkFPS = benchmarkFPS;
(window as unknown as { setBenchmarkResolution: typeof setBenchmarkResolution }).setBenchmarkResolution = setBenchmarkResolution;

main();
