$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$appDir = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $appDir
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Please install Node.js 24 or newer: https://nodejs.org/' }
    $major = [int]((& node --version).TrimStart('v').Split('.')[0])
    if ($major -lt 24) { throw 'Node.js 24 or newer is required.' }
    Write-Host 'Installing local web dependencies...'
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Check your network and retry.' }
    $bin = Join-Path $appDir 'bin'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    if (-not ((Test-Path (Join-Path $bin 'ffmpeg.exe')) -and (Test-Path (Join-Path $bin 'ffprobe.exe')))) {
        $scratch = Join-Path $bin ('.install-' + [guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Path $scratch | Out-Null
        try {
            $url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
            $archive = Join-Path $scratch 'ffmpeg.zip'
            Write-Host 'Downloading FFmpeg Windows essentials (may take a few minutes)...'
            Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing -TimeoutSec 900
            $checksum = (Invoke-WebRequest -Uri ($url + '.sha256') -UseBasicParsing -TimeoutSec 60).Content
            if ($checksum -is [byte[]]) { $checksum = [Text.Encoding]::UTF8.GetString($checksum) }
            $expected = [regex]::Match([string]$checksum, '(?i)\b[0-9a-f]{64}\b').Value
            $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
            if (-not $expected -or $actual -ine $expected) { throw 'FFmpeg checksum mismatch. Please retry.' }
            Write-Host 'Checksum verified. Extracting FFmpeg...'
            Expand-Archive -LiteralPath $archive -DestinationPath $scratch
            foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
                $exe = Get-ChildItem -LiteralPath $scratch -Recurse -File -Filter $name | Select-Object -First 1
                if (-not $exe) { throw ('Missing binary: ' + $name) }
                Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $bin $name)
            }
            $license = Get-ChildItem -LiteralPath $scratch -Recurse -File -Filter 'LICENSE*' | Select-Object -First 1
            if ($license) { Copy-Item -LiteralPath $license.FullName -Destination (Join-Path $bin 'FFmpeg-LICENSE.txt') }
            Set-Content -LiteralPath (Join-Path $bin 'FFmpeg-SOURCE.txt') -Encoding UTF8 -Value @(
                ('Downloaded: ' + $url), ('SHA256: ' + $actual),
                'Build information and corresponding source: https://www.gyan.dev/ffmpeg/builds/',
                'Upstream: https://ffmpeg.org/ (GPL build; see FFmpeg-LICENSE.txt)'
            )
        } finally {
            $resolvedScratch = [IO.Path]::GetFullPath($scratch)
            $resolvedBin = [IO.Path]::GetFullPath($bin).TrimEnd('\') + '\'
            if ($resolvedScratch.StartsWith($resolvedBin, [StringComparison]::OrdinalIgnoreCase)) {
                Remove-Item -LiteralPath $resolvedScratch -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
    Write-Host 'Ready. Run the launch CMD file to open your local video player.' -ForegroundColor Green
    exit 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
