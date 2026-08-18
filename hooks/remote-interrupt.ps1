# Claude Code PostToolUse command hook. Any local failure exits 0 so the
# remote channel never changes the normal local Claude Code behavior.
$ErrorActionPreference = 'Stop'

try {
  $inputText = [Console]::In.ReadToEnd()
  $hook = $inputText | ConvertFrom-Json
  $sessionId = [string]$hook.session_id
  $endpoint = [Environment]::GetEnvironmentVariable('CLAUDE_REMOTE_CONTROL_URL')
  $token = [Environment]::GetEnvironmentVariable('CLAUDE_REMOTE_CONTROL_TOKEN')
  if ([string]::IsNullOrWhiteSpace($sessionId) -or [string]::IsNullOrWhiteSpace($endpoint) -or [string]::IsNullOrWhiteSpace($token)) {
    exit 0
  }

  $headers = @{ Authorization = "Bearer $token" }
  $body = @{ session_id = $sessionId } | ConvertTo-Json -Compress
  $result = Invoke-RestMethod -Uri "$($endpoint.TrimEnd('/'))/hook/interrupt" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 10
  if ($result.interrupt -eq $true) {
    [Console]::Error.WriteLine('Remote user requested that Claude stop the current task')
    exit 2
  }
} catch {
  exit 0
}

exit 0
