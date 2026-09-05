# 完整对话链路速度测试（/api/chat，触发联网搜索与知识库工具）
# 使用方法：
#   1. 确保 dev server 已启动（npm run dev，端口 3000）
#   2. 运行：powershell -ExecutionPolicy Bypass -File scripts/bench-chat.ps1
#   说明：两次测试使用不同问题（避免 3 分钟回答缓存），输出 TTFB 与总耗时
$ErrorActionPreference = "Stop"

# 每次用随机后缀构造新问题，绕过回答缓存
$suffix = Get-Random -Maximum 100000
$questions = @(
    "最近学校有什么最新通知？(测试$suffix)",
    "中国科学技术大学 最近新闻 (测试$($suffix+1))"
)

$i = 0
foreach ($q in $questions) {
    $i++
    $body = @{ messages = @(@{ role = "user"; parts = @(@{ type = "text"; text = $q }) }) } | ConvertTo-Json -Depth 5
    $tmp = "$env:TEMP\chat_body.json"
    $body | Out-File -FilePath $tmp -Encoding utf8

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    # -N 关闭缓冲读取流式响应；time_starttransfer 即首字节(首文本块)到达时间
    $code = curl.exe -s -N -m 120 -X POST "http://localhost:3000/api/chat" `
        -H "Content-Type: application/json" `
        --data "@$tmp" `
        -o "$env:TEMP\chat_resp.txt" -w "%{http_code} %{time_starttransfer} %{time_total}"
    $sw.Stop()
    $parts = $code -split " "
    $respLen = (Get-Item "$env:TEMP\chat_resp.txt").Length
    Write-Host ("chat run#{0}: HTTP {1}  TTFB={2}s  total={3}s  resp={4} bytes" -f $i, $parts[0], $parts[1], $parts[2], $respLen)
}
