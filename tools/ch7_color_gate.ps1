# [CLRGATE 2026-09-30] 颜色正确性闸门（桌面，同会话两臂各一次）：
#   BASE(`cg-base`) 与 FRAG(`cg-frag&shcache=frag`) 都带 `?framedump=1`（基准位姿整幅**无损 PNG** 回传）。
#   为什么 `res=320x213`（而不是 800x531）：这里是**无损 PNG**（判据是 PSNR ≥ 45 dB，JPEG 的共同损失
#   会把两臂压到 35–40 dB ⇒ 会假阴性），而这类带噪画面 PNG 压缩率很低（实测 ≈3.8 B/px）：
#   `res=800x531` 单臂 body 就有 1.6 MB，**frag 那份超了 `/__ch7/report` 的 4 MB 上限**，被服务端
#   `req.destroy()` 拒收 ⇒ 客户端只拿到网络错误 ⇒ **静默失败**（第一轮就是这么白跑的）。
#   `res=320x213`（0.068 MP）⇒ 单臂 body 仅 0.26 MB，两臂都能落盘；而"全幅、逐像素、无损"
#   这三条性质一个不少（SH 数学与分辨率无关，闸门结论不受影响）。
#   注：canvas 尺寸**等于**标称 `res`（`dpr=1&res_mode=forced`；此前"canvas 是 res 的 2.5 倍"的说法已作废）。
#   产出：`thesis_project/data/ch7_measurements/raw/colorgate_*.txt`（两份），解析交给 Python。
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot      # = gsplat.js
$exe = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { Write-Output "NOBROWSER"; exit 1 }
Write-Output ("browser=" + $exe)
Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'ch7diag' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$base = "http://127.0.0.1:5173/bench.html?mode=bench&res_mode=forced&res=320x213&dpr=1&frames=20&cold=1" +
        "&proto=flux&rounds=1&benchmode=offscreen-paper-match&profile=garden&sync=batch&driver=msgchannel" +
        "&runs=5&warmup=20&tickevery=16&fences=3&framedump=1" +
        "&report=/__ch7/report?name=colorgate&rtok=ch7-2026-phase4&u="

foreach ($case in @(@("base", "cg-base"), @("frag", "cg-frag&shcache=frag"))) {
    $tag = "cg-" + $case[0]
    $url = $base + $case[1]
    $err = Join-Path $root ("_tmp_ch7probe\color_" + $case[0] + ".err")
    $profile = Join-Path $env:TEMP "ch7diag_v5_fresh"
    Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
    $argLine = '--no-sandbox --no-first-run --no-default-browser-check --enable-logging=stderr ' +
               '--window-size=800,531 --window-position=0,0 --user-data-dir="' + $profile + '" "' + $url + '"'
    Write-Output ("run=" + $tag)
    $p = Start-Process -FilePath $exe -ArgumentList $argLine -PassThru -RedirectStandardError $err
    Start-Sleep -Seconds 45
    if (-not $p.HasExited) { $p.Kill() }
    $c = @(Get-Content $err -ErrorAction SilentlyContinue)
    Write-Output ("  shcacheErr=" + (@($c | Select-String -SimpleMatch "[shcache=frag]")).Count +
                  " glErr=" + (@($c | Select-String -SimpleMatch "GL_INVALID_OPERATION")).Count +
                  " framedump=" + (@($c | Select-String -SimpleMatch "framedump_png")).Count)
    $c | Select-String -SimpleMatch "[result] ok=" | Select-Object -Last 1 | ForEach-Object { "  " + $_.Line.Trim() }
}
Write-Output "=== DONE ==="
