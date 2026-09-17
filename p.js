/**
 * p.js — 手机端实测落地页（p.html）的腿定义与渲染。
 *
 * 为什么单独一个文件：腿清单要经常改（Phase A 探测 → Phase B 正式口径换 res），
 * 改这里不用动页面结构。所有链接都取当前 origin 拼出来，所以
 * 「局域网 IP」与「cloudflared 隧道域名」两种访问方式共用同一份清单。
 *
 * 口径（与《三臂公平对比测试操作手册》§11.5 一致）：
 *   ① 本文方法：bench.html?mode=bench&profile=<scene>&rounds=1&cold=1&frames=300&warmup=0
 *                &driver=timer&diag=1&cam=flux&proto=flux&res=...&u=...&report=...&rtok=...
 *   ③ Flux-GS： bench-flux.html?profile=<scene>&rounds=1&cold=1&frames=300&warmup=0&diag=1
 *                &res=...（它自己把 res 当强制像素附加 benchres=，不要写 force=）
 * 自动回传：report=%2F__ch7%2Freport%3Fname%3D<腿名> + rtok=<口令>
 *           → vite dev server 落盘 raw/<腿名>_<时间戳>.txt
 * 只用于本地/手机实测，不参与任何构建（vite 只把 p.html 当静态文件发出去）。
 */
(function () {
    "use strict";

    var TOKEN = "ch7-2026-phase4"; // 与 vite.config.js 的 CH7_REPORT_TOKEN 一致
    var SCENE = "garden";          // Phase A 用最重的场景（61 万点）
    var BASE_OURS = "bench.html?mode=bench&profile=" + SCENE +
        "&rounds=1&cold=1&frames=300&warmup=0&driver=timer&diag=1&cam=flux&proto=flux";
    var BASE_FLUX = "bench-flux.html?profile=" + SCENE +
        "&rounds=1&cold=1&frames=300&warmup=0&diag=1";

    // Phase A：渐进加负载（只改 res，两臂成对）
    var LEGS_A = [
        { id: "A1-ours", arm: "ours", res: "1600x1063", name: "hl-ours-r1600", note: "基准档 1× 像素" },
        { id: "A1-flux", arm: "flux", res: "1600x1063", name: "hl-flux-r1600", note: "基准档 1× 像素" },
        { id: "A2-ours", arm: "ours", res: "2400x1596", name: "hl-ours-r2400", note: "2.25× 像素" },
        { id: "A2-flux", arm: "flux", res: "2400x1596", name: "hl-flux-r2400", note: "2.25× 像素" },
        { id: "A3-ours", arm: "ours", res: "3200x2126", name: "hl-ours-r3200", note: "4× 像素" },
        { id: "A3-flux", arm: "flux", res: "3200x2126", name: "hl-flux-r3200", note: "4× 像素" }
    ];

    // A4：只在 A3 两臂仍贴地板时才跑；4096 已贴近移动 GPU 的渲染缓冲上限，失败就放弃
    var LEGS_A4 = [
        { id: "A4-ours", arm: "ours", res: "4096x2722", name: "hl-ours-r4096", note: "6.9× 像素" },
        { id: "A4-flux", arm: "flux", res: "4096x2722", name: "hl-flux-r4096", note: "6.9× 像素" }
    ];

    // Phase B：等 Phase A 结论确认档位后再填（这里是占位，点不动）
    var LEGS_B = [
        { id: "B1", arm: "ours", res: "TBD", name: "待定", note: "ours mip360 rounds=3" },
        { id: "B2", arm: "ours", res: "TBD", name: "待定", note: "ours tnt rounds=3" },
        { id: "B3", arm: "ours", res: "TBD", name: "待定", note: "ours db rounds=3" },
        { id: "B4", arm: "flux", res: "TBD", name: "待定", note: "flux mip360 / tnt / db" }
    ];

    var origin = location.origin;
    document.getElementById("origin").textContent = origin;

    function linkFor(leg) {
        if (leg.res === "TBD") return origin + "/p.html";
        var base = leg.arm === "ours" ? BASE_OURS : BASE_FLUX;
        return origin + "/" + base +
            "&res=" + leg.res +
            "&u=" + leg.id + "-" + leg.res +
            "&report=%2F__ch7%2Freport%3Fname%3D" + leg.name +
            "&rtok=" + TOKEN;
    }

    function render(hostId, list) {
        var host = document.getElementById(hostId);
        list.forEach(function (leg) {
            var a = document.createElement("a");
            a.className = "leg";
            a.target = "_self"; // 同页跳转：返回后只剩本页一个上下文，避免后台标签影响下一轮
            a.href = linkFor(leg);
            var b = document.createElement("b");
            b.className = "tag";
            b.textContent = leg.id;
            a.appendChild(b);
            a.appendChild(document.createTextNode(
                (leg.arm === "ours" ? "① 本文方法" : "③ Flux-GS") + " · " + leg.res + " · " + leg.note));
            var s = document.createElement("span");
            s.textContent = "自动回传名：" + leg.name;
            a.appendChild(s);
            host.appendChild(a);
        });
    }

    render("phaseA", LEGS_A);
    render("phaseA3", LEGS_A4);
    render("phaseB", LEGS_B);
})();
