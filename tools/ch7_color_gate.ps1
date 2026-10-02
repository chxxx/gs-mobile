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
param([string[]]$Cases = @("base", "frag"), [int]$SleepSec = 45)
# [O1 2026-10-02] 参数化 case 列表（缺省 = base,frag ⇒ 原行为逐字不变）：
#   powershell -Command "& 'tools\ch7_color_gate.ps1' -Cases base,frag,fragntx,fragboth"
#   可用 case：base / frag / fragntx / fragctx / fragboth / lrboth / lrfrzzboth
#   ⚠ `param()` 之前**除注释外不能有任何语句**（否则 ParserError: InvalidLeftHandSide）⇒
#     它必须紧跟头注释、放在 $ErrorActionPreference 之前。
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

$caseDefs = [ordered]@{
    "base"     = "cg-base"
    "frag"     = "cg-frag&shcache=frag"
    "fragntx"  = "cg-frag-ntx&shcache=frag&notx=1"
    "fragctx"  = "cg-frag-ctx&shcache=frag&nocolortx=1"
    "fragboth" = "cg-frag-both&shcache=frag&notx=1&nocolortx=1"
    "lrboth"   = "cg-lr-both&shcache=frag&lr=1&notx=1&nocolortx=1"
    "lrfrzzboth" = "cg-lr-frz-both&shcache=frag&lr=1&notx=1&nocolortx=1&shfreeze=2"
    # [阶段3 2026-10-02] 预处理臂（O2/O3）：判据与其它臂一致（对 BASE 的 PSNR ≥ 45 dB、无 >8 级像素）
    #   ⚠ 这条闸门本来必须先跑：它能抓到"vSelected 恒 1 ⇒ 每个 splat 画描边"这类**视觉错误**
    #     （`covered` 这类覆盖度指标看不出来 —— 2026-10-02 移动端肉眼发现）。
    "prep"     = "cg-prep&shcache=frag&notx=1&nocolortx=1&prep=1"
    "prepboth" = "cg-prep-both&shcache=frag&notx=1&nocolortx=1&prep=1&mrt=0"
    "prepslot" = "cg-prep-slot&shcache=frag&notx=1&nocolortx=1&prep=1&slot=1"
}
foreach ($name in $Cases) {
    if (-not $caseDefs.Contains($name)) { Write-Output ("skip-unknown=" + $name); continue }
    $tag = "cg-" + $name
    $url = $base + $caseDefs[$name]
    $err = Join-Path $root ("_tmp_ch7probe\color_" + $name + ".err")
    $profile = Join-Path $env:TEMP "ch7diag_v5_fresh"
    Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
    $argLine = '--no-sandbox --no-first-run --no-default-browser-check --enable-logging=stderr ' +
               '--window-size=800,531 --window-position=0,0 --user-data-dir="' + $profile + '" "' + $url + '"'
    Write-Output ("run=" + $tag)
    $p = Start-Process -FilePath $exe -ArgumentList $argLine -PassThru -RedirectStandardError $err
    Start-Sleep -Seconds $SleepSec
    if (-not $p.HasExited) { $p.Kill() }
    $c = @(Get-Content $err -ErrorAction SilentlyContinue)
    Write-Output ("  shcacheErr=" + (@($c | Select-String -SimpleMatch "[shcache=frag]")).Count +
                  " glErr=" + (@($c | Select-String -SimpleMatch "GL_INVALID_OPERATION")).Count +
                  " framedump=" + (@($c | Select-String -SimpleMatch "framedump_png")).Count)
    $c | Select-String -SimpleMatch "[result] ok=" | Select-Object -Last 1 | ForEach-Object { "  " + $_.Line.Trim() }
}
Write-Output "=== DONE ==="
