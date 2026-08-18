#Requires -Version 5.1
<#
.SYNOPSIS
  打印当前 Claude Code 会话的 ID 与远程控制台 URL。
.DESCRIPTION
  Claude Code 的每个会话对应 ~/.claude/projects/<项目>/<session-id>.jsonl 一个文件，
  文件名即 session ID。脚本按当前工作目录推导项目目录，取修改时间最新的会话文件，
  拼出手机端控制台地址，方便在 VSCode 扩展里快速获取 session ID 用手机连接。
.PARAMETER ProjectPath
  要查询的项目路径，默认取当前工作目录。
.PARAMETER WorkerUrl
  worker 的根地址，默认读环境变量 CLAUDE_REMOTE_CONTROL_URL，未设置时回退到
  项目默认部署地址。
.EXAMPLE
  pwsh -NoProfile -File scripts/get-session.ps1
#>
[CmdletBinding()]
param(
  [string]$ProjectPath = (Get-Location).Path,
  [string]$WorkerUrl = $env:CLAUDE_REMOTE_CONTROL_URL
)

$ErrorActionPreference = 'Stop'

# 脚本内中文按 UTF-8 输出，避免在 GBK 代码页的 PowerShell 5.1 里乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$DEFAULT_WORKER_URL = 'https://claude-remote-control.2519175810.workers.dev'

if ([string]::IsNullOrWhiteSpace($WorkerUrl)) {
  $WorkerUrl = $DEFAULT_WORKER_URL
}

# 项目路径小写后把非字母数字字符替换为 '-'，得到 Claude Code 的项目目录名。
# 例：F:\project\connect -> f--project-connect
$encoded = ($ProjectPath.ToLower() -replace '[^a-z0-9]', '-')
$projectDir = Join-Path $HOME ".claude\projects\$encoded"

if (-not (Test-Path $projectDir)) {
  Write-Error "找不到会话目录: $projectDir"
  exit 1
}

$latest = Get-ChildItem -Path $projectDir -Filter '*.jsonl' -ErrorAction Stop |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $latest) {
  Write-Error "目录中没有会话文件: $projectDir"
  exit 1
}

$sessionId = $latest.BaseName
$url = "$($WorkerUrl.TrimEnd('/'))/s/$sessionId"

Write-Host "Session ID: $sessionId"
Write-Host "控制台 URL: $url"
