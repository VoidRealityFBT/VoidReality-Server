# Dear developer >:3
# I personally have both the firmware and server repos under 1 parent folder called "VoidReality".
# I recommend that you have it set up the same and move this .ps1 file into that parent directory.
# This same script will be in the other repo's root so if you have moved this script out of this folder 
# into a parent folder, delete it from the other repo's folder as is pointless and will just clutter the 
# other repo's root. Much love!!!
#
# ------------VISUAL EXPLINATION------------
# /VoidReality(parent dir)
#   /VoidReality-Server-main (Server Repo)
#   /VoidReality-Tracker-ESP-main (Firmware Repo)
# /Build.ps1 (Out of the repo, under parent directory)
# /Clean.ps1 (Out of the repo, under parent directory)
# /Run.ps1 (Out of the repo, under parent directory)
# ------------VISUAL EXPLINATION------------
#
# ------------------------------------------------------------------------------------------------------
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$serverRoot = Join-Path $root "VoidReality-Server-main"
$trackerRoot = Join-Path $root "VoidReality-Tracker-ESP-main"

[long]$totalFreed = 0

function Get-DirSize($path) {
    if (-not (Test-Path $path)) { return [long]0 }
    try {
        $sum = (Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
        if ($null -eq $sum) { return [long]0 }
        return [long]$sum
    } catch { return [long]0 }
}

function Remove-Generated($path) {
    if (-not (Test-Path $path)) { return }
    $size = Get-DirSize $path
    Write-Host ("  removing {0} ({1:N1} MB)" -f $path, ($size / 1MB))
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    $script:totalFreed += $size
}

Write-Host "Cleaning server: $serverRoot"
$serverPaths = @(
    "node_modules",
    "gui\node_modules",
    "gui\dist",
    "gui\out",
    "gui\.vite",
    "solarxr-protocol\node_modules",
    "solarxr-protocol\protocol\typescript\dist",
    ".gradle",
    "build",
    "server\build",
    "server\core\build",
    "server\desktop\build",
    "bindings-provider\build",
    "Release"
)
foreach ($p in $serverPaths) { Remove-Generated (Join-Path $serverRoot $p) }

Write-Host "Cleaning tracker: $trackerRoot"
$trackerPaths = @(
    ".pio",
    "Release"
)
foreach ($p in $trackerPaths) { Remove-Generated (Join-Path $trackerRoot $p) }

# Python bytecode left by the PlatformIO preprocessor scripts
Get-ChildItem -Path $trackerRoot -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Generated $_.FullName }

Write-Host ("Done. Freed about {0:N1} MB" -f ($totalFreed / 1MB))
Write-Host "Next build will reinstall dependencies, so it will be slower than usual."