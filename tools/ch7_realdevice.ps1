<#
ch7_realdevice.ps1 —— 一条命令搞定真机采数链路：确认 dev server → 起/复用 cloudflared 隧道
                     → 生成「两臂 × 两协议」带自动回传的链接。

用法（在 gsplat.js 目录下执行）：
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\ch7_realdevice.ps1
      # 默认：构建产物(vite preview, 手机端强烈推荐) + 隧道 + name=liu + garden,flowers + 3 轮

  powershell ... -Serve dev
      # 退回 Vite dev server（**手机上会慢很多**：每轮整页重启要重拉几百个模块请求）

  powershell ... -Name wang -Rounds 1 -Subset garden
      # 先发一条做手机连通性验收（1 轮=快速，不进正式表）

  powershell ... -Base http://100.79.158.205:5173
      # 不走隧道，直接用内网/Tailscale 地址（要求手机在同一网络）

  powershell ... -Restart
      # 强制重启隧道/服务（隧道地址会变，旧链接立刻失效）

产出：屏幕打印 4 条链接 + 写入 _links_all.txt + 复制进剪贴板 + 打印发给测试者的话术。
回传落盘：thesis_project/data/ch7_measurements/raw/<name>_<时间戳>.txt（`/__ch7/report`，dev 与 preview 同一实现）
换协议/换轮次：改 _links_all.txt 里对应那条链接的参数即可（协议参数全部显式写在 URL 里）。
#>
param(
    [string]$Name = "liu",
    [int]$Rounds = 3,
    [string]$Subset = "garden,flowers",
    [string]$Base = "",                 # 非空则跳过隧道，直接用该地址当 base
    [int]$Port = 5173,
    [string]$Token = "",                # 缺省取环境变量 CH7_REPORT_TOKEN，再缺省 ch7-2026-phase4
    [ValidateSet("built", "dev")][string]$Serve = "built",  # built=构建产物(vite preview，**手机端强烈推荐**)；dev=vite dev server
    [switch]$Restart,                   # 强制重启隧道/服务
    [switch]$NoTunnel,                  # 用本机 localhost 当 base（仅本机自测用）
    [switch]$SelfTest                   # 额外做一次「本机访问隧道地址」自测（默认跳过）
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$root   = Split-Path -Parent $PSScriptRoot          # = gsplat.js
$outDir = Join-Path $root '_tmp_ch7probe\out'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
if (-not $Token) { $Token = if ($env:CH7_REPORT_TOKEN) { $env:CH7_REPORT_TOKEN } else { 'ch7-2026-phase4' } }

function Say($m) { Write-Host $m }

# 从 tunnel 日志 / cf_url.txt 里取**当前**隧道地址：
# cloudflared 的 banner 会把 URL 折行（"...tryclou\ndflare.com"），所以先去空白再正则；
# 日志里可能有历史地址，取**最后一个**；cf_url.txt 只作兜底（可能过期）。
function Get-TunnelUrl([string]$dir) {
    foreach ($f in @('cf_tunnel_err.log', 'cf_tunnel_out.log', 'cf_url.txt')) {
        $p = Join-Path $dir $f
        if (Test-Path $p) {
            $raw = Get-Content $p -Raw -ErrorAction SilentlyContinue
            if ($raw) {
                $flat = $raw -replace '\s', ''
                $ms = [regex]::Matches($flat, 'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com')
                if ($ms.Count -gt 0) { return $ms[$ms.Count - 1].Value }
            }
        }
    }
    return ''
}

# ── 1. 跑批服务（必须监听所有网卡：隧道/内网手机都要连）────────────────────
# 为什么默认 built：手机经隧道访问 dev server 时，每次整页重启（每轮都会）要重拉**几百个模块请求**
# 且源码模块是 no-cache，高 RTT 下累计到"一个场景一轮几分钟"；构建产物整站只有十几个文件。
function Get-ServedMode() {
    try {
        $html = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/bench.html" -UseBasicParsing -TimeoutSec 5).Content
        if ($html -match '@vite/client') { return 'dev' }
        return 'built'
    } catch { return '' }
}
Say "[1/5] 检查跑批服务 (:$Port，模式 $Serve) ..."
$listen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($Restart -and $listen) {
    $listen | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique |
        ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    $listen = $null
}
$cur = if ($listen) { Get-ServedMode } else { '' }
if ($listen -and $cur -ne $Serve) {
    Say "      当前是 '$cur' 模式，与请求的 '$Serve' 不符 → 重启"
    $listen | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique |
        ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
    $listen = $null; $cur = ''
}
if (-not $listen) {
    if ($Serve -eq 'built') {
        $site = Join-Path $root 'site-dist'
        if (-not (Test-Path (Join-Path $site 'index.html'))) { Say "      ✗ 没有构建产物：先跑  npm run site:build"; exit 1 }
        $hit = (Select-String -Path (Join-Path $site 'assets\*.js') -Pattern 'offscreen-paper-match' -List -ErrorAction SilentlyContinue | Measure-Object).Count
        if ($hit -eq 0) { Say "      ✗ 构建产物太旧（不含离屏协议代码）：先跑  npm run site:build"; exit 1 }
        $srvLog = Join-Path $outDir "preview_$Port.log"
        Remove-Item $srvLog -ErrorAction SilentlyContinue
        Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $root `
            -ArgumentList '/c', "npx vite preview --config vite.site.config.js --host --port $Port --strictPort 1> `"$srvLog`" 2>&1" | Out-Null
        Say "      启动构建产物（预览）中，日志 $srvLog"
    } else {
        $srvLog = Join-Path $outDir "dev_$Port.log"
        Remove-Item $srvLog -ErrorAction SilentlyContinue
        Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $root `
            -ArgumentList '/c', "npx vite --host --port $Port --strictPort 1> `"$srvLog`" 2>&1" | Out-Null
        Say "      启动 dev server 中，日志 $srvLog"
    }
} else {
    Say "      已在运行（复用，$cur 模式）"
}
$ready = $false
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/bench.html" -UseBasicParsing -TimeoutSec 5
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
}
if (-not $ready) { Say "      ✗ 90 秒内未就绪：看日志 $outDir\preview_$Port.log / dev_$Port.log"; exit 1 }
$modeNow = Get-ServedMode
Say "      OK http://127.0.0.1:$Port/bench.html -> 200（模式 $modeNow）"

# ── 2. base 地址（隧道 / 内网直连 / localhost）──────────────────────────────
$urlFile = Join-Path $outDir 'cf_url.txt'
if ($Base) {
    $base = $Base.TrimEnd('/')
    Say "[2/5] base = $base（-Base 指定，跳过隧道）"
} elseif ($NoTunnel) {
    $base = "http://localhost:$Port"
    Say "[2/5] base = $base（-NoTunnel，仅本机自测）"
} else {
    Say "[2/5] 准备 cloudflared 隧道 ..."
    $cf = @(
        (Join-Path $root 'tools\bin\cloudflared.exe'),
        (Join-Path $root '_tmp_ch7probe\bin\cloudflared.exe')
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $cf) {
        $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
        if ($cmd) { $cf = $cmd.Source }
    }
    if (-not $cf) { Say "      ✗ 找不到 cloudflared.exe：放到 tools\bin\ 或加入 PATH，或用 -Base/-NoTunnel"; exit 1 }

    $alive = Get-Process cloudflared -ErrorAction SilentlyContinue
    if ($Restart -and $alive) {
        $alive | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        $alive = $null
        Remove-Item $urlFile -ErrorAction SilentlyContinue
    }
    if (-not $alive) {
        $cfOut = Join-Path $outDir 'cf_tunnel_out.log'
        $cfErr = Join-Path $outDir 'cf_tunnel_err.log'
        Remove-Item $cfOut, $cfErr -ErrorAction SilentlyContinue
        $p = Start-Process -FilePath $cf -WindowStyle Hidden `
            -ArgumentList 'tunnel', '--url', "http://localhost:$Port", '--no-autoupdate' `
            -RedirectStandardOutput $cfOut -RedirectStandardError $cfErr -PassThru
        "$(Get-Date -Format s) cloudflared pid=$($p.Id) exe=$cf" | Set-Content -Encoding UTF8 (Join-Path $outDir 'cf_pid.txt')
        Say "      已启动 cloudflared pid=$($p.Id)（等公网地址，约 5–20 秒）"
    } else {
        Say "      已复用运行中的 cloudflared"
    }

    $base = ''
    for ($i = 0; $i -lt 40; $i++) {
        $base = Get-TunnelUrl $outDir
        if ($base) { break }
        Start-Sleep -Seconds 2
    }
    if (-not $base) { Say "      ✗ 80 秒内没取到 trycloudflare 地址：看 $outDir\cf_tunnel_err.log"; exit 1 }
    "URL=$base" | Set-Content -Encoding UTF8 $urlFile        # 回写，保持项目原有约定
    Say "      隧道地址 = $base"
    if ($SelfTest) {
        $localOk = $false
        try { $localOk = (Invoke-WebRequest -Uri "$base/bench.html" -UseBasicParsing -TimeoutSec 6).StatusCode -eq 200 } catch {}
        if ($localOk) { Say "      本机自测: 200（隧道通）" }
        else { Say "      ⚠ 本机自测不通（本机到 Cloudflare 可能被挡）：以手机能否打开为准" }
    } else {
        Say "      （跳过本机自测；手机能否打开为准。要自测加 -SelfTest）"
    }
}

# ── 3. 生成「两臂 × 两协议」链接（复用 ch7_batch.py link，链接口径与 CLI 逐字一致）──
Say "[3/5] 生成链接（name=$Name  subset=$Subset  rounds=$Rounds）..."
$combos = @(
    @{ n = '① 本文方法 / 离屏论文协议 (offscreen-paper-match)'; g = 'main'; p = 'offscreen-paper-match' },
    @{ n = '② 本文方法 / 在屏真实协议 (onscreen-realworld)';     g = 'main'; p = 'onscreen-realworld'   },
    @{ n = '③ Flux-GS  / 离屏论文协议 (offscreen-paper-match)'; g = 'flux'; p = 'offscreen-paper-match' },
    @{ n = '④ Flux-GS  / 在屏真实协议 (onscreen-realworld)';     g = 'flux'; p = 'onscreen-realworld'   }
)
$rows = @()
foreach ($c in $combos) {
    $a = @('tools\ch7_batch.py', 'link', '--platform', 'gen3-xweb', '--group', $c.g,
           '--subset', $Subset, '--protocol', $c.p, '--base', $base,
           '--name', $Name, '--rounds', "$Rounds", '--token', $Token)
    $txt = & python @a 2>&1 | Out-String
    $u = ($txt -split "\r?\n" | Where-Object { $_ -match '^https?://\S+$' } | Select-Object -First 1)
    if (-not $u) { $u = "✗ 生成失败（group=$($c.g) protocol=$($c.p)）：`n$($txt.Trim())" }
    $rows += [pscustomobject]@{ label = $c.n; url = $u.Trim() }
}

# ── 4. 输出：屏幕 / 文件 / 剪贴板 ───────────────────────────────────────────
$lines = @("# 真机测试链接（base=$base  name=$Name  subset=$Subset  rounds=$Rounds  生成于 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')）", "")
foreach ($r in $rows) { $lines += $r.label; $lines += $r.url; $lines += "" }
$linksFile = Join-Path $root '_links_all.txt'
$lines | Set-Content -Encoding UTF8 $linksFile
($rows | ForEach-Object { $_.url }) -join "`r`n" | Set-Clipboard

Say ""
Say ("=" * 96)
Say "  真机测试链接（已写 $linksFile，并已复制进剪贴板）"
Say ("=" * 96)
foreach ($r in $rows) { Say ""; Say "  $($r.label)"; Say "  $($r.url)" }
Say ""
Say ("=" * 96)
Say "  发给测试者的话术（可直接复制）"
Say ("=" * 96)
Say "  请用微信打开这些链接（微信内置浏览器）；插电、屏幕常亮、别锁屏、别切后台。"
Say "  页面会自动逐场景跑，跑完自动回传，看到「已回传」即可关页面。"
Say "  若提示提交失败：点页面上的「复制结果」把文本发回。"
Say "  若提示「WebGL 上下文耗尽」：完全关闭浏览器 → 重开同一条链接（会自动续跑）。"
Say "  打不开就是隧道在重启或网络挡了，告诉我，我重发。"

# ── 5. 下一步命令 ──────────────────────────────────────────────────────────
Say ""
Say "[4/5] 盯进度：  python tools\ch7_batch.py status"
Say "[5/5] 收数出表："
Say "  copy ..\thesis_project\data\ch7_measurements\raw\${Name}_*.txt ..\thesis_project\data\ch7_measurements\raw\paper_protocol_mobile\"
Say "  python tools\ch7_paper_protocol_report.py --raw-dir ..\thesis_project\data\ch7_measurements\raw\paper_protocol_mobile --out-dir ..\thesis_project\data\ch7_measurements\paper_protocol\mobile"
Say ""
Say "提示：先只发 ①④ 两条做手机连通性验收（更省时间）；验收通过再发全部 4 条。"
Say "     只想快速验收链路：  -Rounds 1 -Subset garden"
Say "     隧道地址失效或想换内网直连：  -Restart   /   -Base http://<本机内网IP>:$Port"


