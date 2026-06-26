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
# ---------------------------------------------------------------------------------------------------------
# Runs VoidReality: reinstalls workspace deps if missing, recompiles and rebuilds the server
# jar, restarts it onto the fresh build, then starts the GUI in dev mode. Works from a freshly
# cleaned tree. Pass -NoServer to run only the GUI.
param(
    [switch]$NoServer
)

$ErrorActionPreference = "Stop"
$serverRoot = Join-Path $PSScriptRoot "VoidReality-Server"
$jar = Join-Path $serverRoot "server\desktop\build\libs\slimevr.jar"

# same JDK lookup as build.ps1
function Find-Jdk {
    $candidates = @()
    if ($env:JAVA_HOME) { $candidates += $env:JAVA_HOME }
    $globs = @(
        "$env:USERPROFILE\.jdks\jdk-*",
        "C:\Program Files\Eclipse Adoptium\jdk-*",
        "C:\Program Files\Java\jdk-*",
        "C:\Program Files\Microsoft\jdk-*",
        "C:\Program Files\Zulu\zulu-*",
        "C:\Program Files\Amazon Corretto\jdk*"
    )
    foreach ($g in $globs) {
        $candidates += (Get-Item -Path $g -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    }
    foreach ($jdkHome in $candidates) {
        $java = Join-Path $jdkHome "bin\java.exe"
        if (-not (Test-Path $java)) { continue }
        # java -version prints to stderr, cmd merges it without tripping powershell error handling
        $verLine = (cmd /c "`"$java`" -version 2>&1" | Select-Object -First 1)
        if ($verLine -match 'version "(\d+)') {
            if ([int]$Matches[1] -ge 17) { return $jdkHome }
        }
    }
    return $null
}

function Test-ServerRunning {
    # the server listens for the GUI websocket on 21110
    $conn = Get-NetTCPConnection -LocalPort 21110 -State Listen -ErrorAction SilentlyContinue
    return $null -ne $conn
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm not found, install it with: npm install -g pnpm@10.33.0"
}

if (-not (Test-Path (Join-Path $serverRoot "node_modules"))) {
    Write-Host "Installing workspace dependencies"
    Push-Location $serverRoot
    try { pnpm install; if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" } }
    finally { Pop-Location }
}

if (-not $NoServer) {
    $jdk = Find-Jdk
    if (-not $jdk) {
        Write-Warning "No JDK 17+ found, GUI will run without the server"
    } else {
        # Recompile and rebuild the server jar every run so .\run.ps1 always launches the latest
        # code. Gradle is incremental, so this is quick when nothing changed and a full rebuild
        # from a clean tree when it is not.
        Write-Host "Rebuilding server with JDK at $jdk"
        $env:JAVA_HOME = $jdk
        $env:Path = "$jdk\bin;$env:Path"
        Push-Location $serverRoot
        try {
            & .\gradlew.bat ":server:desktop:shadowJar"
            if ($LASTEXITCODE -ne 0) { throw "Server build failed" }
        } finally { Pop-Location }
        if (-not (Test-Path $jar)) { throw "Build finished but $jar is missing" }

        # Stop an already running server so the freshly built jar is the one that serves, instead
        # of an old process holding port 21110 and quietly running the previous build.
        $running = Get-NetTCPConnection -LocalPort 21110 -State Listen -ErrorAction SilentlyContinue
        if ($running) {
            Write-Host "Stopping the running server so the rebuilt jar takes over"
            $running | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
                Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
            }
        }
        Write-Host "Starting server from $jar"
        # the server main requires the run subcommand
        Start-Process (Join-Path $jdk "bin\java.exe") -ArgumentList "-Xmx512M", "-jar", "`"$jar`"", "run" -WorkingDirectory (Split-Path $jar)
    }
}

# clear the vite dep cache so a regenerated protocol is always picked up
$viteCache = Join-Path $serverRoot "gui\node_modules\.vite"
if (Test-Path $viteCache) {
    Remove-Item -Recurse -Force $viteCache -ErrorAction SilentlyContinue
}

# dev mode electron GUI, stays in the foreground until closed
Push-Location $serverRoot
try {
    pnpm run gui
} finally { Pop-Location }
