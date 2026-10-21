$ErrorActionPreference = 'Stop'
$appDir = Split-Path $PSScriptRoot -Parent
$url = 'http://127.0.0.1:8765'
function Test-Player {
    try {
        $health = Invoke-RestMethod -Uri ($url + '/api/health') -TimeoutSec 2
        return $health.app -eq 'local-video-player'
    } catch { return $false }
}
try {
    if (Test-Player) { Start-Process $url; exit 0 }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Please install Node.js 24 or newer: https://nodejs.org/' }
    $major = [int]((& node --version).TrimStart('v').Split('.')[0])
    if ($major -lt 24) { throw 'Node.js 24 or newer is required.' }
    if (-not (Test-Path (Join-Path $appDir 'node_modules/express'))) { throw 'Please run the first-install CMD file first.' }
    $data = Join-Path $appDir 'data'
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    $arguments = '--no-warnings "' + (Join-Path $appDir 'server.mjs') + '"'
    $child = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList $arguments -WorkingDirectory $appDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $data 'server.log') -RedirectStandardError (Join-Path $data 'server-error.log')
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Test-Player) { Start-Process $url; exit 0 }
        if ($child.HasExited) { break }
    }
    throw ('Could not start the player. Port 8765 may be in use. See logs in: ' + $data)
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}
