$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$clientDir = Join-Path $root "clients\windows\AudioHub.WindowsClient"
$logPath = Join-Path $clientDir "client.log"
$errPath = Join-Path $clientDir "client.err.log"
$pidPath = Join-Path $clientDir "client.pid"

Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "dotnet.exe" -and $_.CommandLine -like "*AudioHub.WindowsClient*"
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Start-Sleep -Seconds 1

if (Test-Path $logPath) { Remove-Item $logPath -Force }
if (Test-Path $errPath) { Remove-Item $errPath -Force }
if (Test-Path $pidPath) { Remove-Item $pidPath -Force }

$process = Start-Process -FilePath "dotnet" `
  -ArgumentList ".\bin\Release\net8.0\AudioHub.WindowsClient.dll --server http://127.0.0.1:4010 --name PC" `
  -WorkingDirectory $clientDir `
  -RedirectStandardOutput $logPath `
  -RedirectStandardError $errPath `
  -PassThru

Set-Content -Path $pidPath -Value $process.Id
Write-Output "Client PID: $($process.Id)"
