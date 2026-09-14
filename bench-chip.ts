/**
 * bench.html / bench-flux.html 共用的 GPU/SoC 识别：把 WebGL 的 renderer 字符串翻成人类可读的 SoC 名。
 * 两个测帧页共用同一份映射，结果头里的 `chip=` / `vendor=` 在两臂中写法完全一致（论文表同一列可比）。
 */

export interface ChipGuess {
    vendor: string;
    chip: string;
}

/** 根据 WebGL renderer 字符串识别 GPU/SoC（Adreno→骁龙、Mali/Immortalis→天玑等）。
 *  识别不到时回退显示原始 renderer 名；renderer 为空（尚未读到）时返回 chip="unknown"。 */
export function guessChip(renderer: string): ChipGuess {
    const g = renderer;
    if (/qualcomm|adreno/i.test(g)) {
        const m = /Adreno[^0-9]*(\d+)/i.exec(g);
        const v = m ? parseInt(m[1], 10) : 0;
        let chip = "Qualcomm Adreno";
        if (v >= 830) chip = "Snapdragon 8 Elite (Adreno " + v + ")";
        else if (v === 750) chip = "Snapdragon 8 Gen 3 (Adreno 750)";
        else if (v === 740) chip = "Snapdragon 8 Gen 2 (Adreno 740)";
        else if (v === 730) chip = "Snapdragon 8 Gen 1 / 8+ (Adreno 730)";
        else if (v >= 700) chip = "Snapdragon 8/7 系列 (Adreno " + v + ")";
        else if (v > 0) chip = "Qualcomm Adreno " + v;
        return { vendor: "Qualcomm", chip };
    }
    if (/immortalis|mali|mediatek/i.test(g)) {
        const m = /Immortalis[^0-9]*(\d+)|Mali[^0-9]*G?(\d+)/i.exec(g);
        const v = m ? m[1] || m[2] : "";
        let chip = "ARM Mali";
        if (v === "G615") chip = "Dimensity 8300/8200 系列 (Mali-G615)";
        else if (v === "G610") chip = "Dimensity 8100 系列 (Mali-G610)";
        else if (v === "G715" || v === "G720") chip = "Dimensity 9200/9300 级 (Immortalis-" + v + ")";
        else if (v === "G710") chip = "Dimensity 9000 系列 (Mali-G710)";
        else if (v === "G78") chip = "Kirin 9000/980 级 (Mali-G78)";
        else if (v) chip = "ARM Mali-" + v;
        return { vendor: "MediaTek/Arm", chip };
    }
    return { vendor: "other", chip: g || "unknown" };
}

/** 在线结果头 `u=` 的默认设备标识：auto-adreno-750 / auto-mali-610 / auto-device。
 *  与 `guessChip` 用同一套正则，保证 bench.html 与 bench-flux.html 的 `u=` 写法一致。 */
export function chipSlug(renderer: string): string {
    const mm = /(Adreno|Mali|Immortalis)[^0-9]*(\d+)/i.exec(renderer);
    return mm ? `auto-${mm[1].toLowerCase()}-${mm[2]}` : "auto-device";
}
