#Requires -Version 5.1
<#
.SYNOPSIS
  R1a 网络层基线：测量到 Cloudflare 边缘的往返延迟，对比直连与经代理两种环境。
.DESCRIPTION
  目标端点与 workers.dev 走同一张 Cloudflare 边缘网络，因此不依赖本项目是否已部署。
  判定线：p95 < 300 ms。
#>
[CmdletBinding()]
param(
  [string]$Url = 'https://cloudflare.com/cdn-cgi/trace',
  [int]$Samples = 20,
  [string]$ProxyUrl = 'http://127.0.0.1:7890',
  [int]$ThresholdMs = 300
)

$ErrorActionPreference = 'Stop'
$supportsNoProxy = (Get-Command Invoke-WebRequest).Parameters.ContainsKey('NoProxy')

function Get-Percentile {
  param([double[]]$Values, [double]$Percentile)
  if ($Values.Count -eq 0) { return [double]::NaN }
  $sorted = @($Values | Sort-Object)
  $index = [Math]::Ceiling($Percentile / 100.0 * $sorted.Count) - 1
  if ($index -lt 0) { $index = 0 }
  if ($index -ge $sorted.Count) { $index = $sorted.Count - 1 }
  return [double]$sorted[$index]
}

function Measure-Endpoint {
  param([string]$Label, [string]$TargetUrl, [int]$Count, [string]$Proxy)

  $timings = New-Object System.Collections.Generic.List[double]
  $failures = 0

  for ($i = 1; $i -le $Count; $i++) {
    $request = @{ Uri = $TargetUrl; Method = 'GET'; TimeoutSec = 10; UseBasicParsing = $true }
    if ($Proxy) {
      $request.Proxy = $Proxy
    } elseif ($supportsNoProxy) {
      $request.NoProxy = $true
    }

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
      Invoke-WebRequest @request | Out-Null
      $watch.Stop()
      $timings.Add($watch.Elapsed.TotalMilliseconds)
    } catch {
      $watch.Stop()
      $failures++
    }
    Write-Progress -Activity $Label -Status "$i / $Count" -PercentComplete ($i * 100 / $Count)
  }
  Write-Progress -Activity $Label -Completed

  [pscustomobject]@{
    Label    = $Label
    Ok       = $timings.Count
    Failures = $failures
    P50Ms    = [Math]::Round((Get-Percentile -Values $timings.ToArray() -Percentile 50), 1)
    P95Ms    = [Math]::Round((Get-Percentile -Values $timings.ToArray() -Percentile 95), 1)
  }
}

$savedHttp = $env:HTTP_PROXY
$savedHttps = $env:HTTPS_PROXY
$results = @()
try {
  $env:HTTP_PROXY = $null
  $env:HTTPS_PROXY = $null
  $results += Measure-Endpoint -Label 'direct' -TargetUrl $Url -Count $Samples -Proxy $null
  $results += Measure-Endpoint -Label "proxy $ProxyUrl" -TargetUrl $Url -Count $Samples -Proxy $ProxyUrl
} finally {
  $env:HTTP_PROXY = $savedHttp
  $env:HTTPS_PROXY = $savedHttps
}

$results | Format-Table -AutoSize

$verdict = 0
foreach ($row in $results) {
  if ($row.Ok -eq 0) {
    Write-Warning "$($row.Label): 全部失败（$($row.Failures) 次），无法给出基线"
    $verdict = 1
    continue
  }
  if ($row.P95Ms -ge $ThresholdMs) {
    Write-Warning "$($row.Label): p95 = $($row.P95Ms) ms，超过判定线 $ThresholdMs ms"
    $verdict = 1
  } else {
    Write-Host "$($row.Label): p95 = $($row.P95Ms) ms，达标" -ForegroundColor Green
  }
}
exit $verdict
