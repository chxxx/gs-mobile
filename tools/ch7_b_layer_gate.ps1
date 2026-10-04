# [B 层 2026-10-04] 桌面**无损**颜色闸门：逐个场景跑 BASE 与 FINAL（`?framedump=1` 回传整幅无损 PNG）。
#   与 tools/ch7_color_gate.ps1 的关系：那条是**单场景（garden）多臂**；这条是**多场景 × 两臂**（B 层证据），
#   口径逐字复用：`res=320x213&res_mode=forced&dpr=1&rounds=1` + 同一组 `runs/warmup/tickevery/fences`。
#
#   ⚠ 2026-10-04 事故与修复（必须保留，否则会再白跑一轮）：
#     上一版 13 场景全部 `ok=? framedump=0`、raw/ 里**一条新记录都没有** —— 根因不是渲染，而是
#     **dev server 没在跑**：`/__ch7/report` 只存在于 vite dev server（vite.config.js §12），页面打不开时
#     浏览器控制台**一行都没有**，看起来就像"渲染失败"（桌面上只能看到空白/错误页）。
#     因此本版强制三道自证：
#       ① 开跑前 `Invoke-WebRequest /bench.html` 必须 200，否则直接 exit 2；
#       ② 每轮结束对比 raw/ 里 `colorgate_*.txt` 的**数量增量**（地面真值：落盘了才算跑过）；
#       ③ 从 stderr 抓 `framedump_png` / `INFO:CONSOLE` / `GL_INVALID` 计数。
#     判据（离线 Python 侧）：对 BASE 的 PSNR 与 >8 级像素数；**交付红线 PSNR ≥ 50 dB 且 >8 级 = 0**。
#
#   ⚠ 2026-10-04 第二处坑（同一天内第二个白跑根因）：dev server 起来后仍然**一条记录都不落** ——
#     原因是 `bench.ts:238` 的收尾 `twoFrames()` = 连续两次 `requestAnimationFrame`，而 Edge 窗口
#     被**用户自己的浏览器遮挡/后台**时 Chromium **冻结 rAF** ⇒ `twoFrames()` 永不 resolve ⇒
#     走不到 `finishBench()` ⇒ 没有 `[RESULT]`、没有 `submitReport`（dev server 侧连一行日志都没有）。
#     证据：单场景 90 s 实测的控制台时间线停在 `iframe 已删除` 之后**再无任何一行**（含 ok=1 之后 84 s 空白）。
#     修法：加 `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
#     --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion,Translate`
#     （与 `_tmp_ch7probe/cdp.mjs` 同一组标志）。修后单轮 ~2–3 s 即完成并落盘（`[ch7-report] 已保存 …`）。
#   ⚠ 另：stderr 里 `framedump_png=` 计数**恒为 0** 是**正常**的 —— 该行是 0.26 MB 的 base64，
#     Chromium 打 stderr 时会把超长控制台行截断。**只有 `record+`（raw 目录增量）是判据**。
#   用法：
#     powershell -ExecutionPolicy Bypass -File tools\ch7_b_layer_gate.ps1
#     powershell -ExecutionPolicy Bypass -File tools\ch7_b_layer_gate.ps1 -Scenes garden,bicycle -SleepSec 40
param(
    [string]$Scenes = 'garden,bicycle,flowers,stump,treehill,room,counter,kitchen,bonsai,truck,train,drjohnson,playroom',
    [int]$SleepSec = 45
)
$ErrorActionPreference = 'Continue'
try { $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}
$root = Split-Path -Parent $PSScriptRoot                      # = gsplat.js
$RAW = Join-Path (Split-Path $root -Parent) 'thesis_project\data\ch7_measurements\raw'
$OUT = Join-Path $root '_tmp_ch7probe\out'
New-Item -ItemType Directory -Force -Path $OUT | Out-Null
$log = Join-Path $OUT 'b_layer.txt'
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; Write-Host $m }
"=== ch7_b_layer_gate $(Get-Date -Format 'HH:mm:ss') scenes=$Scenes ===" | Set-Content -Encoding UTF8 $log

# ---- 自证 ①：dev server 必须活着（见头注释：这一条就是上一轮白跑的根因）
$pre = $false
try { $pre = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 'http://127.0.0.1:5173/bench.html').StatusCode -eq 200 } catch { $pre = $false }
W "preflight bench.html 200 = $pre"
if (-not $pre) { W '✗ dev server 不可达：先跑 tools\ch7_serve.ps1 -NoTunnel 再执行本脚本（本轮中止）'; exit 2 }
$rawBefore = @(Get-ChildItem $RAW -Filter 'colorgate_*.txt' -ErrorAction SilentlyContinue).Count
W "raw colorgate_*.txt = $rawBefore"

$exe = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Google\Chrome\Application\chrome.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { W 'NOBROWSER'; exit 1 }
W "browser=$exe"
# 与 ch7_color_gate.ps1 同口径（320x213：无损 PNG 体积 ≈3.8 B/px ⇒ 单臂 body ≈0.26 MB，稳在 4 MB 上限内）
$OFF = 'mode=bench&res_mode=forced&res=320x213&dpr=1&frames=20&cold=1&proto=flux&rounds=1' +
       '&benchmode=offscreen-paper-match&sync=batch&driver=msgchannel' +
       '&runs=5&warmup=20&tickevery=16&fences=3&framedump=1'
$FINAL = '&shcache=frag&lr=1&notx=1&nocolortx=1'
foreach ($scene in $Scenes.Split(',')) {
    $scene = $scene.Trim()
    if (-not $scene) { continue }
    foreach ($case in @(@('base', ''), @('final', $FINAL))) {
        $tag = 'cg-' + $case[0] + '-' + $scene
        $url = "http://127.0.0.1:5173/bench.html?$OFF&profile=$scene" + $case[1] +
               "&report=/__ch7/report?name=colorgate&u=$tag&rtok=ch7-2026-phase4"
        $prof = Join-Path $env:TEMP ('ch7diag_b_' + $case[0] + '_' + $scene)   # 每轮独占 profile：并发/残留进程不会互删
        Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue
        $err = Join-Path $root ('_tmp_ch7probe\bl_' + $case[0] + '_' + $scene + '.err')
        $argLine = '--no-sandbox --no-first-run --no-default-browser-check --enable-logging=stderr ' +
                   '--disable-backgrounding-occluded-windows --disable-renderer-backgrounding ' +
                   '--disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion,Translate ' +
                   '--window-size=800,531 --window-position=0,0 --user-data-dir="' + $prof + '" "' + $url + '"'
        W "--- $tag ---"
        $p = Start-Process -FilePath $exe -ArgumentList $argLine -PassThru -RedirectStandardError $err
        Start-Sleep -Seconds $SleepSec
        if (-not $p.HasExited) { $p.Kill() }
        $c = @(Get-Content $err -ErrorAction SilentlyContinue)
        $nAfter = @(Get-ChildItem $RAW -Filter 'colorgate_*.txt' -ErrorAction SilentlyContinue).Count
        W ("  record+" + ($nAfter - $rawBefore) +
           " framedump=" + @($c | Select-String -SimpleMatch 'framedump_png').Count +
           " console=" + @($c | Select-String -SimpleMatch 'INFO:CONSOLE').Count +
           " glErr=" + @($c | Select-String -SimpleMatch 'GL_INVALID').Count)
        if ($nAfter -le $rawBefore) { W '  *** RED：本轮没有新 record（未落盘）***' } else { $rawBefore = $nAfter }
    }
}
W "=== done $(Get-Date -Format 'HH:mm:ss') raw total=$rawBefore ==="
