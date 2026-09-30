# [SHFMT-DIAG 2026-09-29] 桌面复现（快版）：验证 `?shfmt=f16` 修复是否生效。
#   判据（每条都从控制台日志里取，本机 /__ch7/report 是 403 ⇒ 不看回传）：
#     mismatch = "Mismatch between texture format and sampler type" 出现次数（必须为 0）
#     [shfmt=f16] = 我新加的显式失败自证（必须为 0）
#     [result] ok=… fps=… = 该轮结果（f16 应变成 ok=1 且有 fps）
#   用法：powershell -NoProfile -ExecutionPolicy Bypass -File _tmp_ch7probe\desktop_f16_fix_verify.ps1
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$exe = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { Write-Output "NOBROWSER"; exit 1 }
Write-Output ("browser=" + $exe)

# 清理上次遗留的"诊断专用"浏览器实例：只匹配命令行里带 ch7diag 的进程，
# **绝不动用户自己打开的浏览器**（避免 profile 锁冲突 / 旧实例干扰新结果）。
Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "ch7diag" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Output "stale-diag-instances-cleaned"

$base = "http://127.0.0.1:5176/bench.html?mode=bench&res_mode=forced&res=1600x1063&dpr=1&frames=20&cold=1" +
        "&proto=flux&rounds=1&benchmode=offscreen-paper-match&profile=garden&sync=batch&driver=msgchannel" +
        "&runs=5&warmup=20&tickevery=16&fences=3&report=/__ch7/report?name=shfmt2&rtok=ch7-2026-phase4&u="

foreach ($case in @(@("f16incr", "&shfmt=f16_incr"))) {
    $tag = "fix2-" + $case[0]
    $url = $base + $tag + $case[1]
    $err = Join-Path $root ("_tmp_ch7probe\fix2_" + $case[0] + ".err")
    $out = Join-Path $root ("_tmp_ch7probe\fix2_" + $case[0] + ".out")
    # 独立 profile ⇒ 不会挂到你正在用的浏览器实例上，也不会互相干扰
    $profile = Join-Path $env:TEMP ("ch7diag_v3_" + $case[0])
    $argLine = '--no-sandbox --no-first-run --no-default-browser-check --enable-logging=stderr ' +
               '--window-size=1600,1063 --window-position=0,0 --user-data-dir="' + $profile + '" "' + $url + '"'
    Write-Output ("run=" + $tag)
    $p = Start-Process -FilePath $exe -ArgumentList $argLine -PassThru -RedirectStandardError $err -RedirectStandardOutput $out
    Start-Sleep -Seconds 30
    if (-not $p.HasExited) { $p.Kill() }
    $c = @(Get-Content $err -ErrorAction SilentlyContinue)
    Write-Output ("--- " + $tag + " ---")
    Write-Output ("mismatchCount=" + (@($c | Select-String -SimpleMatch "Mismatch between texture format")).Count)
    Write-Output ("shfmtFailCount=" + (@($c | Select-String -SimpleMatch "[shfmt=f16]")).Count)
    $c | Select-String -SimpleMatch "[result] ok=" | Select-Object -Last 2 | ForEach-Object { "  " + $_.Line.Trim() }
    $c | Select-String -SimpleMatch "存活探针" | Select-Object -Last 1 | ForEach-Object { "  LIVENESS-FAIL-PRESENT" }
}
Write-Output "=== DONE ==="
