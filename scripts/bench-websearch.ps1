# 联网搜索链路速度基准测试
# 使用方法：
#   1. 准备请求体文件 scripts/test-websearch-body.json（已存在）
#   2. 运行：powershell -ExecutionPolicy Bypass -File scripts/bench-websearch.ps1
#   说明：连续 3 次调用 Dify 联网搜索工作流，输出每次耗时与响应大小
$ErrorActionPreference = "Stop"

$bodyFile = Join-Path $PSScriptRoot "test-websearch-body.json"
$key = "app-rltYouknLyLJsRUrLvuh39By"
$url = "http://114.214.241.106/v1/workflows/run"

for ($i = 1; $i -le 3; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $code = curl.exe -s -m 70 -X POST $url `
        -H "Content-Type: application/json" `
        -H "Authorization: Bearer $key" `
        --data "@$bodyFile" `
        -o "$env:TEMP\ws_result.json" -w "%{http_code}"
    $sw.Stop()
    $size = (Get-Item "$env:TEMP\ws_result.json").Length
    Write-Host ("web_search run#{0}: HTTP {1}  {2}ms  {3} bytes" -f $i, $code, $sw.ElapsedMilliseconds, $size)
}
