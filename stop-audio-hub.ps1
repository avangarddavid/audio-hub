$ErrorActionPreference = "SilentlyContinue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPidPath = Join-Path $root "server\server.pid"
$clientPidPath = Join-Path $root "clients\windows\AudioHub.WindowsClient\client.pid"

if (Test-Path $serverPidPath) {
  $serverPid = Get-Content $serverPidPath
  if ($serverPid) { Stop-Process -Id ([int]$serverPid) -Force }
  Remove-Item $serverPidPath -Force
}

if (Test-Path $clientPidPath) {
  $clientPid = Get-Content $clientPidPath
  if ($clientPid) { Stop-Process -Id ([int]$clientPid) -Force }
  Remove-Item $clientPidPath -Force
}

Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "ffplay.exe" -or
    ($_.Name -eq "node.exe" -and $_.CommandLine -like "*server\\src\\index.js*") -or
    ($_.Name -eq "dotnet.exe" -and (
      $_.CommandLine -like "*AudioHub.WindowsClient*" -or
      $_.CommandLine -like "*--server http://127.0.0.1:4010 --name PC*"
    ))
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
  }

Write-Output "Audio hub processes stopped."
