$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $root "server"
$logPath = Join-Path $serverDir "server.log"
$errPath = Join-Path $serverDir "server.err.log"
$pidPath = Join-Path $serverDir "server.pid"

Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "node.exe" -and $_.CommandLine -like "*server\\src\\index.js*"
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Start-Sleep -Seconds 1

if (Test-Path $logPath) { Remove-Item $logPath -Force }
if (Test-Path $errPath) { Remove-Item $errPath -Force }
if (Test-Path $pidPath) { Remove-Item $pidPath -Force }

$env:FFMPEG_PATH = "C:\Users\CHARISMA\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe"
$env:FFPLAY_PATH = "C:\Users\CHARISMA\AppData\Local\Microsoft\WinGet\Links\ffplay.exe"

$process = Start-Process -FilePath "node" `
  -ArgumentList "src\index.js" `
  -WorkingDirectory $serverDir `
  -RedirectStandardOutput $logPath `
  -RedirectStandardError $errPath `
  -PassThru

Set-Content -Path $pidPath -Value $process.Id
Write-Output "Server PID: $($process.Id)"
