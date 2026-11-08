# kill_ch7browsers.ps1 -- 清掉所有 ch7 桌面探针的浏览器与残留驱动器（只动 ch7diag*/ch7b* 的进程，不碰用户自己的浏览器）。
$me = $PID
Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" |
    Where-Object { $_.CommandLine -match 'ch7diag|ch7b_solo' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq 'powershell.exe' -and $_.ProcessId -ne $me -and $_.CommandLine -match 'b_probe1|b_layer|ch7_b_layer_gate' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
Write-Output ('edge_left=' + @(Get-Process msedge -ErrorAction SilentlyContinue).Count)
Write-Output ('node_left=' + @(Get-Process node -ErrorAction SilentlyContinue).Count)
