/**
 * ch7_report_middleware.mjs — ch7 结果自动回传端点（`/__ch7/report`）的**唯一实现**。
 *
 * 为什么抽成独立模块（2026-09-26 真机实测后）：
 *   现场发现"手机上一个场景一轮要 5 分钟"的主因是**手机连的是 `vite dev server`（未打包）**——
 *   每轮整页重启（`cold=1`）都要重新拉几百个模块请求，且 dev 对源码模块是 `no-cache`，
 *   经 cloudflared 隧道（高 RTT）累计就是几十秒到几分钟/轮。对比：`site-dist/` 构建产物
 *   **整站只有 10 个文件 / 0.42MB**。改用构建产物能把每轮固定开销压掉一个数量级。
 *   但这段回传中间件原先只挂在 `configureServer`（dev）上，`vite preview`（构建产物）下
 *   `/__ch7/report` 不存在（vite.config.js 顶部注释也写明了这个限制），页面会退化成
 *   "提交失败 → 请手动复制发送"。因此把实现抽到这里，**dev 与 preview 共用同一份**：
 *   落盘目录、口令闸门、正文校验、命名/防覆盖规则在两种伺服方式下不可能分叉。
 *
 * 协议：POST /__ch7/report?name=<测试者标识>&token=<回传口令>，请求体 = 页面的 [RESULT]…[END] 纯文本，
 * 原样落盘到 <rawDir>/<name>_YYYYMMDD_HHmmss.txt
 *   - `token` 必须等于分发时的口令（不回显收到的值）；缺失/不符 → 403、不读 body、不写盘；
 *   - name 只保留 [A-Za-z0-9._-]，去掉前导 '.'，避免路径穿越；
 *   - 时间戳到秒 + 重名自动加序号：多个测试者（或同名测试者重复交）不会互相覆盖；
 *   - **先写 `<目标名>.txt.part` 再 rename**：报表脚本扫 raw/ 时永远不会读到"写了一半"的文件。
 */

import fs from 'node:fs';
import { join } from 'node:path';

/** 把 URL 里的 name 收敛成安全的文件名片段（中文/空格/斜杠/引号等一律换成 '_'）。 */
export function ch7SafeName(raw) {
    const cleaned = String(raw || '')
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/^[._]+/, '')
        .slice(0, 64);
    return cleaned || 'anon';
}

/** 本地时间戳 YYYYMMDD_HHmmss（到秒，避免同分钟的两个测试者撞名）。 */
export function ch7Stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 同秒撞名时依次尝试 `<name>_<ts>-2.txt`、`-3.txt`… */
export function ch7TargetPath(rawDir, name) {
    const ts = ch7Stamp();
    let file = join(rawDir, `${name}_${ts}.txt`);
    for (let n = 2; fs.existsSync(file); n++) {
        file = join(rawDir, `${name}_${ts}-${n}.txt`);
    }
    return file;
}

/** 单次回传体上限：结果文本正常只有几十 KB，超过说明不是结果文本 */
export const CH7_MAX_BODY_DEFAULT = 4 * 1024 * 1024;

/**
 * connect 风格中间件（dev / preview 通用）。
 * @param {{ rawDir: string, token: string, maxBody?: number }} opts
 */
export function ch7ReportMiddleware({ rawDir, token, maxBody = CH7_MAX_BODY_DEFAULT }) {
    return (req, res, next) => {
        if (!req.url || !req.url.startsWith('/__ch7/report')) return next();
        const cors = () => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        };
        if (req.method === 'OPTIONS') {
            cors();
            res.statusCode = 204;
            res.end();
            return;
        }
        const fail = (code, msg) => {
            cors();
            res.statusCode = code;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(msg + '\n');
            console.log(`[ch7-report] 拒收（${code}）：${msg}`);
        };
        if (req.method !== 'POST') return fail(405, 'only POST');
        const url = new URL(req.url, 'http://localhost');
        // 口令闸门：不符就"不读 body、不写盘"，并且**只在终端打印一行、不回显收到的值**（避免日志泄露口令）
        if ((url.searchParams.get('token') || '') !== token) {
            req.resume();
            return fail(403, 'token 不匹配');
        }
        const name = ch7SafeName(url.searchParams.get('name'));
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > maxBody) {
                req.destroy();
                return fail(413, `body too large (>${maxBody} bytes)`);
            }
            chunks.push(c);
        });
        req.on('error', () => {
            /* 客户端中断（测试者提前关页面）：下面的 end 不会触发，静默即可 */
        });
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const text = body.toString('utf-8');
            // 宽松但有效的协议校验：必须是跑批页面产出的结果文本，避免垃圾/探测请求污染数据目录
            if (!text.includes('[RESULT]') || !text.includes('[END]')) {
                return fail(400, 'not a [RESULT]...[END] report body');
            }
            try {
                fs.mkdirSync(rawDir, { recursive: true });
                const file = ch7TargetPath(rawDir, name);
                // 先写 .part 再改名：报表脚本永远不会读到半截文件
                fs.writeFileSync(file + '.part', body);
                fs.renameSync(file + '.part', file);
                cors();
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.end(`OK ${file}\n`);
                console.log(`[ch7-report] 已保存 ${file}（${body.length} 字节，name=${name}）`);
            } catch (e) {
                fail(500, `write failed: ${e && e.message ? e.message : e}`);
            }
        });
    };
}

/** Vite 插件：dev（`configureServer`）与 preview（`configurePreviewServer`）都挂同一个中间件。 */
export function ch7ReportPlugin({ rawDir, token, maxBody }) {
    return {
        name: 'configure-ch7-report',
        configureServer(server) {
            server.middlewares.use(ch7ReportMiddleware({ rawDir, token, maxBody }));
        },
        configurePreviewServer(server) {
            server.middlewares.use(ch7ReportMiddleware({ rawDir, token, maxBody }));
        },
    };
}
