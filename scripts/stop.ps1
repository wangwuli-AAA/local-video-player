$ErrorActionPreference = 'Stop'
$appDir = Split-Path $PSScriptRoot -Parent
$serverPath = Join-Path $appDir 'server.mjs'
$processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
foreach ($entry in $processes) {
    # Stop only this installation; do not kill other Node.js applications.
    if ($entry.CommandLine -and $entry.CommandLine.Contains('"' + $serverPath + '"')) {
        Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/shutdown' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            if (-not (Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 250
        }
        if (Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue) {
            throw 'The player is still stopping. Close any open file picker and retry.'
        }
    }
}
Write-Host 'Local video player stopped. Original files and history are preserved.'
