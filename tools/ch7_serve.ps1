<#
  第 7 章「远程协助测试」分发脚本（协议 §12）：本机 dev server + cloudflared 临时隧道。

  为什么用 dev server（`npm run dev`）而不是 site-dist/静态站：
    1) 结果自动回传端点 `/__ch7/report` 只存在于 vite dev server（见 vite.config.js）；
    2) dev server 直接从 `scenes/` 与 `bench-scenes.json` 取数，**不需要** `site:build`，
       也就不存在"site-dist 陈旧/被跟踪产物改动"的风险（协议 §1.2）；
    3) `server.allowedHosts` 已放行 `.trycloudflare.com`，隧道域名可直接访问。

  用法：
    powershell -ExecutionPolicy Bypass -File gsplat.js\tools\ch7_serve.ps1 `
        -Group main -Platform gen2-xweb -Name helper01 -Subset mip360

  ⚠ 隧道地址（https://xxxx.trycloudflare.com）**每次重启都会变**（quick tunnel 无账号、无固定域名）。
    重启后必须重新把链接发给所有协助测试者；旧链接立即失效。

  产物（不进 git）：
    thesis_project/data/ch7_measurements/raw/_tunnel/tunnel.json  隧道状态（url/token/时间/锚定 commit）
    gsplat.js/_tmp_ch7probe/out/tunnel_url.txt                    最近一次抓到的 URL
#>
[CmdletBinding()]
param(
    [ValidateSet('main', 'load', 'res', 'flux')][string]$Group = 'main',
    [Parameter(Mandatory = $true)][string]$Platform,
    [string]$Name = 'helper',
    [string]$Subset = '',                 # 逗号分隔场景 id（分片跑时用），空 = 该组全量
    [string]$Token = $env:CH7_REPORT_TOKEN,
    [int]$Port = 5173,
    [switch]$SkipDev,                     # 复用已在跑的 dev server
    [switch]$NoTunnel                     # 只起 dev server（仅本机/同网）
)

$ErrorActionPreference = 'Continue'
try { $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

$GS = Split-Path $PSScriptRoot -Parent                      # ...\gsplat.js
$ROOT = Split-Path $GS -Parent                              # ...\Plasticity-Pruning-GS
$OUT = Join-Path $GS '_tmp_ch7probe\out'
$TUN_DIR = Join-Path $ROOT 'thesis_project\data\ch7_measurements\raw\_tunnel'
New-Item -ItemType Directory -Force -Path $OUT, $TUN_DIR | Out-Null
if (-not $Token) { $Token = 'ch7-2026-phase4' }              # 与 vite.config.js 缺省值一致

$anchor = ''
try { $anchor = (& git -C $GS rev-parse --short=13 HEAD 2>$null).Trim() } catch {}

function Log($m) {
    $m | Tee-Object -FilePath (Join-Path $OUT 'ch7_serve.log') -Append | Write-Host
    return $m
}
Log ("=== ch7_serve {0} group={1} platform={2} name={3} anchor={4} ===" -f (Get-Date -Format 'HH:mm:ss'), $Group, $Platform, $Name, $anchor)

function Wait-Dev([int]$secs = 90) {
    for ($i = 0; $i -lt $secs; $i += 3) {
        $c = & curl.exe -sS -o NUL -w '%{http_code}' --max-time 5 "http://127.0.0.1:$Port/bench.html" 2>$null
        if ("$c" -eq '200') { return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}
function Wait-Flux([int]$secs = 90) {
    for ($i = 0; $i -lt $secs; $i += 3) {
        $c = & curl.exe -sS -o NUL -w '%{http_code}' --max-time 5 "http://127.0.0.1:$Port/bench-flux.html" 2>$null
        if ("$c" -eq '200') { return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}

# ---------------------------------------------------------------- 1) dev server
if (-not $SkipDev) {
    if (Wait-Dev 3) { Log 'dev server 已在运行，复用' }
    else {
        $stdout = Join-Path $OUT 'dev_host.log'
        $stderr = Join-Path $OUT 'dev_host.err.log'
        Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue
        $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev -- --host' `
            -WorkingDirectory $GS -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
            -WindowStyle Hidden -PassThru
        "vite host pid = $($p.Id)  log=$stdout" | Set-Content -Encoding UTF8 (Join-Path $OUT 'dev_host_pid.txt')
        Log "已启动 dev server pid=$($p.Id)（冷启动 30–60 s）"
    }
}
$devOk = Wait-Dev 120
Log "dev_server_bench=$devOk dev_server_flux=$(Wait-Flux 6)"
if (-not $devOk) { Log '✗ dev server 未就绪：见 out\dev_host.err.log'; exit 2 }

# ---------------------------------------------------------------- 2) cloudflared 临时隧道
$url = 'NOT_YET'
if (-not $NoTunnel) {
    $exe = Join-Path $GS '_tmp_ch7probe\bin\cloudflared.exe'
    if (-not (Test-Path $exe)) {
        $cmd = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
        if ($cmd) { $exe = $cmd.Source }
        else {
            Log '✗ 找不到 cloudflared.exe。期望 gsplat.js\_tmp_ch7probe\bin\cloudflared.exe 或已入 PATH。'
            Log '  安装：winget install --id Cloudflare.cloudflared （或下载单文件 exe 放到上述路径）'
            exit 2
        }
    }
    $tOut = Join-Path $OUT 'cf_tunnel_out.log'
    $tErr = Join-Path $OUT 'cf_tunnel_err.log'
    Remove-Item $tOut, $tErr -ErrorAction SilentlyContinue
    $tp = Start-Process -FilePath $exe -ArgumentList 'tunnel', '--url', "http://localhost:$Port", '--no-autoupdate' `
        -RedirectStandardOutput $tOut -RedirectStandardError $tErr -WindowStyle Hidden -PassThru
    "cloudflared pid = $($tp.Id)  exe=$exe" | Set-Content -Encoding UTF8 (Join-Path $OUT 'cf_pid.txt')
    Log "已启动 cloudflared pid=$($tp.Id)（quick tunnel → localhost:$Port）"

    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 2
        $txt = ''
        foreach ($f in @($tErr, $tOut)) { if (Test-Path $f) { $c = Get-Content $f -Raw -ErrorAction SilentlyContinue; if ($c) { $txt += $c } } }
        $m = [regex]::Match($txt, 'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com')
        if ($m.Success) { $url = $m.Value; break }
    }
    Log "tunnel_url=$url（等待 $($i * 2) s）"
    "$url" | Set-Content -Encoding UTF8 (Join-Path $OUT 'tunnel_url.txt')
    if ($url -eq 'NOT_YET') { Log '✗ 隧道未给出地址：见 out\cf_tunnel_err.log'; exit 2 }

    $codeB = & curl.exe -sS -o NUL -w '%{http_code}' --max-time 30 "$url/bench.html" 2>$null
    $codeF = & curl.exe -sS -o NUL -w '%{http_code}' --max-time 30 "$url/bench-flux.html" 2>$null
    $codeR = & curl.exe -sS -o NUL -w '%{http_code}' --max-time 30 -X POST -H 'Content-Type: text/plain;charset=utf-8' `
        --data-binary 'PING' "$url/__ch7/report?name=selftest&token=$Token" 2>$null
    Log "selfcheck bench=$codeB bench_flux=$codeF report=$codeR（report 期望 200；403 = token 不符）"
}
else {
    $url = "http://127.0.0.1:$Port"
    Log "已跳过隧道（-NoTunnel）：本次仅本机/同网可用 base=$url"
}

# ---------------------------------------------------------------- 3) 生成分发链接
$linkArgs = @('--base', $url, '--group', $Group, '--platform', $Platform, '--name', $Name, '--token', $Token)
if ($Subset) { $linkArgs += @('--subset', $Subset) }
Log '--- 分发给协助测试者的链接（含 report= 自动回传与 rtok= 口令）---'
& python (Join-Path $PSScriptRoot 'ch7_batch.py') link @linkArgs 2>&1 | ForEach-Object { Log $_ }

# ---------------------------------------------------------------- 4) 状态落盘
$state = [ordered]@{
    generated_at = (Get-Date).ToString('s')
    url          = $url
    port         = $Port
    group        = $Group
    platform     = $Platform
    name         = $Name
    subset       = $Subset
    token        = $Token
    anchor       = $anchor
    note         = 'quick tunnel 地址每次重启都会变：重启后必须重新分发链接，旧链接立即失效'
}
$state | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $TUN_DIR 'tunnel.json')
Log "隧道状态已写：$TUN_DIR\tunnel.json"
Log '⚠ 分享前请自己先用手机打开一次，确认能完整跑完一轮再扩散给协助者。'
