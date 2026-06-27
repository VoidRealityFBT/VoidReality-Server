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
# ----------------------------------------------------------------------------------------------------------
# Builds VoidReality parts: .\build.ps1 [gui|server|firmware|app|all|dist|bindings|clean] [-Board BOARD_ENV]
#   app   - server + GUI only (the desktop app, no PlatformIO needed)
#   all   - everything: server + GUI + firmware. Firmware is best-effort here: if PlatformIO
#           is missing or the firmware build fails, it is skipped with a warning so you still
#           get the app jar. Use the 'firmware' target if you need a hard failure on problems.
#   dist  - the distributable executable: builds the server jar, the SteamVR bindings provider,
#           and the GUI, then packages them with electron-builder into a downloadable app
#           (a zip on Windows) and copies it to the server repo's Release folder.
#           Needs CMake and Visual Studio C++ build tools for the native bindings provider.
#   bindings - just the SteamVR bindings provider (the native bridge), via CMake.
# Firmware auto-detects the boards you own from the server config (the trackers that have
# connected to the app). Override with -Board BOARD_SLIMEVR to force a specific board.
# Built release artifacts are copied into a Release folder in each repo, ready to be distributed.
param(
    [ValidateSet("gui", "server", "firmware", "app", "all", "dist", "bindings", "clean")]
    [string]$Target = "all",
    # Firmware board env to build(e.g: BOARD_SLIMEVR). Empty auto detects from the server config.
    [string]$Board = "",
    # Server config to read connected-tracker boards from. Defaults to the desktop app's config.
    [string]$ConfigPath = (Join-Path $env:APPDATA "dev.slimevr.SlimeVR\vrconfig.yml")
)

$ErrorActionPreference = "Stop"

# Locate the server and firmware repo folders robustly: whether this script sits in the parent
# folder next to them (the recommended layout) or still inside one of the repos, and whether the
# folders kept DitHub's "-main" suffix from a downloaded zip or not. So a fresh clone just works
# without renaming anything
function Resolve-RepoRoot($base, $marker) {
    # script in the parent: the repo is a sibling folder
    foreach ($n in @($base, "$base-main")) {
        $p = Join-Path $PSScriptRoot $n
        if (Test-Path (Join-Path $p $marker)) { return $p }
    }
    # script still inside this repo: this folder is the repo root
    if (Test-Path (Join-Path $PSScriptRoot $marker)) { return $PSScriptRoot }
    # script inside the other repo: this repo is a sibling of the script's parent
    $parent = Split-Path $PSScriptRoot -Parent
    foreach ($n in @($base, "$base-main")) {
        $p = Join-Path $parent $n
        if (Test-Path (Join-Path $p $marker)) { return $p }
    }
    return (Join-Path $PSScriptRoot $base)
}
$serverRoot = Resolve-RepoRoot "VoidReality-Server" "server"
$trackerRoot = Resolve-RepoRoot "VoidReality-Tracker-ESP" "platformio.ini"

function Save-ToRelease($repoRoot, $sourceFile, $releaseName) {
    $releaseDir = Join-Path $repoRoot "Release"
    New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
    $dest = Join-Path $releaseDir $releaseName
    Copy-Item $sourceFile $dest -Force
    Write-Host "Saved release artifact $dest"
}

# Finds a JDK 17 or newer since the kotlin server cannot build on java 8
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
            $major = [int]$Matches[1]
            # java 8 reports itself as 1.8
            if ($major -ge 17) { return $jdkHome }
        }
    }
    return $null
}

function Ensure-Pnpm {
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        throw "pnpm not found, install it with: npm install -g pnpm@10.33.0"
    }
}

function Ensure-NodeModules {
    if (-not (Test-Path (Join-Path $serverRoot "node_modules"))) {
        Write-Host "Installing workspace dependencies"
        Push-Location $serverRoot
        try { pnpm install; if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" } }
        finally { Pop-Location }
    }
}

function Get-FlatbuffersVersion {
    $buildFile = Join-Path $serverRoot "solarxr-protocol\protocol\java\build.gradle"
    if (Test-Path $buildFile) {
        foreach ($line in Get-Content $buildFile) {
            if ($line -match "flatbuffers-java',\s*version:\s*'([0-9]+\.[0-9]+\.[0-9]+)'") {
                return $Matches[1]
            }
        }
    }
    return "22.10.26"
}

function Ensure-FlatBuffersSubmodule {
    $protocolRoot = Join-Path $serverRoot "solarxr-protocol"
    $flatbuffersRoot = Join-Path $protocolRoot "lib\flatbuffers"
    $version = Get-FlatbuffersVersion
    $tag = "v$version"
    $versionHeader = Join-Path $flatbuffersRoot "include\flatbuffers\base.h"
    $flatbuffersVersion = $null
    if (Test-Path $versionHeader) {
        $major = $null; $minor = $null; $rev = $null
        foreach ($line in Get-Content $versionHeader) {
            if ($line -match '^[ \t]*#define[ \t]+FLATBUFFERS_VERSION_MAJOR[ \t]+([0-9]+)') { $major = $Matches[1] }
            if ($line -match '^[ \t]*#define[ \t]+FLATBUFFERS_VERSION_MINOR[ \t]+([0-9]+)') { $minor = $Matches[1] }
            if ($line -match '^[ \t]*#define[ \t]+FLATBUFFERS_VERSION_REVISION[ \t]+([0-9]+)') { $rev = $Matches[1] }
        }
        if ($major -and $minor -and $rev) { $flatbuffersVersion = "$major.$minor.$rev" }
    }

    if ($flatbuffersVersion -eq $version) { return }

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "FlatBuffers library missing or mismatched at solarxr-protocol\lib\flatbuffers. Install Git and rerun, or clone https://github.com/google/flatbuffers@$tag into $flatbuffersRoot"
    }

    Write-Host "FlatBuffers headers missing or mismatched ($flatbuffersVersion vs $version); fetching google/flatbuffers@$tag into $flatbuffersRoot"
    if (Test-Path (Join-Path $flatbuffersRoot ".git")) {
        Push-Location $flatbuffersRoot
        try {
            & git fetch --tags origin
            if ($LASTEXITCODE -ne 0) { throw "Git fetch of FlatBuffers failed" }
            & git checkout --force $tag
            if ($LASTEXITCODE -ne 0) { throw "Git checkout of FlatBuffers tag $tag failed" }
        } finally {
            Pop-Location
        }
    } else {
        if (Test-Path $flatbuffersRoot) {
            Remove-Item -Recurse -Force $flatbuffersRoot
        }
        & git clone --branch $tag --depth 1 https://github.com/google/flatbuffers "$flatbuffersRoot"
        if ($LASTEXITCODE -ne 0) { throw "Git clone of FlatBuffers tag $tag failed" }
    }

    if (-not (Test-Path $versionHeader)) {
        throw "FlatBuffers headers still missing after init/update. Ensure $flatbuffersRoot contains the google/flatbuffers repository."
    }
}

function Ensure-FlatBuffersSources {
    Ensure-FlatBuffersSubmodule
    $protocolRoot = Join-Path $serverRoot "solarxr-protocol"
    $generatedJava = Join-Path $protocolRoot "protocol\java\src"
    if (-not (Test-Path $generatedJava)) {
        Write-Host "FlatBuffers sources missing; generating protocol code"
        Push-Location $protocolRoot
        try {
            & .\generate-flatbuffer.ps1
            if ($LASTEXITCODE -ne 0) { throw "FlatBuffers generation failed" }
        } finally {
            Pop-Location
        }
    }
}

function Ensure-GradleWrapper {
    $wrapperDir = Join-Path $serverRoot "gradle\wrapper"
    $wrapperJar = Join-Path $wrapperDir "gradle-wrapper.jar"
    if (Test-Path $wrapperJar) { return }

    Write-Host "Gradle wrapper jar missing; attempting to restor wrapper"
    $gradleCmd = Get-Command gradle -ErrorAction SilentlyContinue
    if ($gradleCmd) {
        Push-Location $serverRoot
        try {
            & gradle wrapper
            if ($LASTEXITCODE -eq 0 -and (Test-Path $wrapperJar)) { return }
        } finally { Pop-Location }
    }

    $propsPath = Join-Path $wrapperDir "gradle-wrapper.properties"
    if (-not (Test-Path $propsPath)) {
        throw "Gradle wrapper properties missing; cannot bootstrap wrapper."
    }

    $distributionUrl = Get-Content -Path $propsPath | ForEach-Object {
        if ($_ -match '^[ \t]*distributionUrl[ \t]*=[ \t]*(.+)$') { $Matches[1].Trim() }
    } | Select-Object -First 1
    if (-not $distributionUrl) {
        throw "Could not read distributionUrl from gradle-wrapper.properties"
    }

    $distributionUrl = $distributionUrl -replace '\\', ''
    $tempZip = Join-Path $env:TEMP ("gradle-wrapper-bootstrap-{0}.zip" -f [guid]::NewGuid())
    $tempDir = Join-Path $env:TEMP ("gradle-wrapper-bootstrap-{0}" -f [guid]::NewGuid())

    try {
        Write-Host "Downloading Gradle distribution from $distributionUrl"
        Invoke-WebRequest -Uri $distributionUrl -OutFile $tempZip -UseBasicParsing
        New-Item -ItemType Directory -Path $tempDir | Out-Null
        Expand-Archive -LiteralPath $tempZip -DestinationPath $tempDir
        $wrapperJarSrc = Get-ChildItem -Path $tempDir -Filter "gradle-wrapper.jar" -Recurse -File | Select-Object -First 1
        if (-not $wrapperJarSrc) { throw "Downloaded Gradle distribution did not contain gradle-wrapper.jar" }
        Copy-Item $wrapperJarSrc.FullName $wrapperJar -Force
    } finally {
        if (Test-Path $tempZip) { Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue }
        if (Test-Path $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
    }

    if (-not (Test-Path $wrapperJar)) { throw "Failed to restore gradle wrapper jar" }
}

function Build-Gui {
    Ensure-Pnpm
    Ensure-NodeModules
    Write-Host "Building GUI"
    Push-Location $serverRoot
    try {
        pnpm run build
        if ($LASTEXITCODE -ne 0) { throw "GUI build failed" }
    } finally { Pop-Location }
    Write-Host "GUI built to $serverRoot\gui\out"
}

function Build-Server {
    # Ensure a JDK 17+ is available; if missing, offer to install Adoptium Temurin 17
    function Ensure-Jdk {
        $jdk = Find-Jdk
        if ($jdk) { return $jdk }

        Write-Host "No JDK 17+ found on the system. I can try to install Adoptium Temurin 17 for you."
        $accept = Read-Host "Install Adoptium Temurin 17 now? (Y/N)"
        if ($accept -notin @('Y','y')) { return $null }

        # Prefer winget if available T>T
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            Write-Host "Attempting to install via winget..."
            & winget install --id EclipseAdoptium.Temurin.17.JDK -e --accept-package-agreements --accept-source-agreements
            Start-Sleep -Seconds 2
            $jdk = Find-Jdk
            if ($jdk) { return $jdk }
            Write-Warning "winget install finished but JDK not detected. You may need to log out/in or rerun the script."
        }

        try {
            $api = 'https://api.adoptium.net/v3/assets/latest/17/hotspot?os=windows&architecture=x64&image_type=jdk'
            $assets = Invoke-RestMethod -Uri $api -UseBasicParsing -ErrorAction Stop
            if ($assets -and $assets.Count -gt 0) {
                $candidate = $assets[0]
                $link = $candidate.binaries[0].package.link
                $file = Join-Path $env:TEMP ([IO.Path]::GetFileName($link))
                Write-Host "Downloading JDK installer to $file"
                Invoke-WebRequest -Uri $link -OutFile $file -UseBasicParsing -ErrorAction Stop
                Write-Host "Launching installer (you may be prompted for UAC). Please complete installation and then press ENTER to continue."
                Start-Process -FilePath $file
                Read-Host "Press ENTER after the installer completes"
                $jdk = Find-Jdk
                if ($jdk) { return $jdk }
                Write-Warning "JDK still not detected after installation. You may need to log out/in or reboot."
            }
        } catch {
            Write-Warning "Automatic installer download/launch failed: $_. Please install Java 17+ manually from https://adoptium.net/."
        }

        return $null
    }

    $jdk = Ensure-Jdk
    if (-not $jdk) {
        throw "No JDK 17+ found. Install one and re-run the build. Example: winget install EclipseAdoptium.Temurin.17.JDK"
    }
    Ensure-FlatBuffersSources
    Ensure-GradleWrapper
    Write-Host "Building server with JDK at $jdk"
    $env:JAVA_HOME = $jdk
    $env:Path = "$jdk\bin;$env:Path"
    Push-Location $serverRoot
    try {
        & .\gradlew.bat ":server:desktop:shadowJar"
        if ($LASTEXITCODE -ne 0) { throw "Server build failed" }
    } finally { Pop-Location }
    $jar = Join-Path $serverRoot "server\desktop\build\libs\voidreality.jar"
    if (-not (Test-Path $jar)) { throw "Build finished but $jar is missing" }
    Write-Host "Server jar built to $jar"
    Save-ToRelease $serverRoot $jar "voidreality.jar"
}

# Builds the native SteamVR bindings provider with CMake. electron-builder expects the binary
# at bindings-provider\build\win-<arch>\Release\SlimeVR-Bindings-Provider.exe and the OpenVR dll
# next to that build folder, so the build dir is named to match.
function Build-BindingsProvider {
    if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
        throw "CMake not found. Install CMake (and Visual Studio C++ build tools) to build the SteamVR bindings provider."
    }
    Ensure-FlatBuffersSubmodule
    $bp = Join-Path $serverRoot "bindings-provider"
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $vsArch = if ($arch -eq "x64") { "x64" } else { "Win32" }
    $openvrPlat = if ($arch -eq "x64") { "win64" } else { "win32" }
    $buildDir = Join-Path $bp "build\win-$arch"
    $openvrDir = Join-Path $bp "openvr"
    $openvrLib = Join-Path $openvrDir "lib\$openvrPlat\openvr_api.lib"
    # The OpenVR SDK is a submodule that is empty in a fresh tree; the native bridge cannot
    # compile or ship its dll without it. Attempt to clone or update it automatically.
    if (-not (Test-Path $openvrLib)) {
        if (Get-Command git -ErrorAction SilentlyContinue) {
            Write-Host "OpenVR SDK missing; cloning/updating https://github.com/ValveSoftware/openvr into $openvrDir"
            if (-not (Test-Path $openvrDir)) {
                New-Item -ItemType Directory -Force -Path $openvrDir | Out-Null
            }
            Push-Location $bp
            try {
                if (-not (Test-Path (Join-Path $openvrDir ".git"))) {
                    & git clone https://github.com/ValveSoftware/openvr "$openvrDir"
                } else {
                    & git -C "$openvrDir" pull --ff-only
                }
                if ($LASTEXITCODE -ne 0) { throw "Git checkout of OpenVR SDK failed" }
            } finally {
                Pop-Location
            }
        } else {
            throw "OpenVR SDK missing at bindings-provider\openvr. Install Git and rerun, or clone https://github.com/ValveSoftware/openvr into $openvrDir"
        }
        if (-not (Test-Path $openvrLib)) {
            throw "OpenVR SDK still missing after clone/update. Ensure $openvrDir contains the ValveSoftware/openvr repository."
        }
    }
    Write-Host "Building SteamVR bindings provider with CMake into $buildDir"
    Push-Location $bp
    # CMake shells out to the compiler which writes progress to stderr; don't let that abort us.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & cmake -B $buildDir -S . -A $vsArch
        if ($LASTEXITCODE -ne 0) { throw "CMake configure failed. Install Visual Studio with the C++ desktop workload." }
        & cmake --build $buildDir --config Release
        if ($LASTEXITCODE -ne 0) { throw "CMake build failed" }
    } finally {
        $ErrorActionPreference = $prevEAP
        Pop-Location
    }
    $exe = Join-Path $buildDir "Release\SlimeVR-Bindings-Provider.exe"
    if (-not (Test-Path $exe)) { throw "Bindings provider built but $exe is missing" }
    # The packager wants openvr_api.dll directly inside the build dir; copy the vendored one
    # there if CMake left it elsewhere, so packaging doesn't fail on a missing file.
    $dll = Join-Path $buildDir "openvr_api.dll"
    if (-not (Test-Path $dll)) {
        $vendored = Join-Path $bp "openvr\bin\win64\openvr_api.dll"
        if (Test-Path $vendored) { Copy-Item $vendored $dll -Force }
    }
    Write-Host "Bindings provider built to $exe"
}

# Packages the desktop app into a distributable executable with electron-builder, after making
# sure the jar, the native bridge, and the GUI bundle all exist. The artifact lands in
# gui\dist\artifacts and is copied to the server Release folder.
function Build-Dist {
    Build-Server
    Build-BindingsProvider
    Ensure-Pnpm
    Ensure-NodeModules
    $guiRoot = Join-Path $serverRoot "gui"
    
    # Kill any running VoidReality processes
    $running = Get-Process -Name "VoidReality" -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "Stopping running VoidReality processes..."
        Stop-Process -InputObject $running -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    
    # Kill all Node.js processes to release any file handles held by pnpm/electron-builder
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    
    # Forcefully clean the entire dist directory to avoid EBUSY (resource locked) errors on app.asar.
    # Use multiple cleanup attempts and longer waits to ensure file handles are released.
    $distDir = Join-Path $guiRoot "dist"
    for ($i = 0; $i -lt 5; $i++) {
        if (-not (Test-Path $distDir)) { break }
        Write-Host "Cleaning dist directory (attempt $($i + 1))..."
        Remove-Item -Path $distDir -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $distDir)) { break }
        Start-Sleep -Seconds 3
    }
    
    Write-Host "Building the GUI bundle and packaging the executable"
    # Free the Gradle daemons memory before the memory heavy renderer build, and give node a
    # bigger heap.
    try { & (Join-Path $serverRoot "gradlew.bat") --stop *> $null } catch { }
    $env:NODE_OPTIONS = "--max-old-space-size=4096"
    Push-Location $guiRoot
    try {
        $maxBuild = 3
        $b = 0
        while ($b -lt $maxBuild) {
            pnpm run build
            if ($LASTEXITCODE -eq 0) { break }
            $b++
            if ($b -lt $maxBuild) {
                Write-Warning "GUI bundle build failed (attempt $b); freeing memory and retrying in 5 seconds..."
                Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 5
            }
        }
        if ($LASTEXITCODE -ne 0) { throw "GUI bundle build failed after $maxBuild attempts" }

        # Retry packaging up to 3 times if EBUSY occurs (file lock released after delay)
        $maxRetries = 3
        $retry = 0
        while ($retry -lt $maxRetries) {
            pnpm run package
            if ($LASTEXITCODE -eq 0) { break }
            $retry++
            if ($retry -lt $maxRetries) {
                Write-Warning "Packaging failed (attempt $retry); killing Node processes and retrying in 5 seconds..."
                Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 5
            }
        }
        if ($LASTEXITCODE -ne 0) { throw "electron-builder packaging failed after $maxRetries attempts" }
    } finally { Pop-Location }
    # Collect the packaged artifacts (zip/exe/AppImage, plus the matching blockmap/yml) into the
    # server Release folder.
    $artifacts = Join-Path $guiRoot "dist\artifacts"
    if (-not (Test-Path $artifacts)) { throw "Packaging finished but $artifacts is missing" }
    # Only the final packaged artifacts (the zip or an installer) live directly under
    # dist\artifacts\<os>. Skip the *-unpacked folders, which hold the loose intermediate exes
    # that are already inside the zip, so /Release does not fill up with redundant 200 MB copies.
    $built = Get-ChildItem -Path $artifacts -Recurse -File -Include *.zip, *.exe, *.AppImage, *.deb, *.rpm, *.dmg -ErrorAction SilentlyContinue |
        Where-Object { $_.DirectoryName -notmatch 'unpacked' }
    if (-not $built) { throw "No packaged executable found under $artifacts" }
    foreach ($a in $built) { Save-ToRelease $serverRoot $a.FullName $a.Name }
    Write-Host "Distributable executable(s) ready in $serverRoot\Release"
}

# Parses src/consts.h "#define BOARD_X N" lines into a board-id -> env-name map, so we never
# have to hardcode the numbers (they have to match the firmware to be correct anyway).
function Get-BoardEnvById {
    $map = @{}
    $consts = Join-Path $trackerRoot "src\consts.h"
    if (-not (Test-Path $consts)) { return $map }
    foreach ($line in Get-Content $consts) {
        if ($line -match '^\s*#define\s+(BOARD_[A-Z0-9_]+)\s+(\d+)') {
            $map[[int]$matches[2]] = $matches[1]
        }
    }
    return $map
}

# The board envs platformio.ini actually defines an [env:...] section for. consts.h lists many
# more board ids (haritora, mocopi, generic nrf, etc.) than the firmware can build here, so a
# detected board with no env must be skipped or pio aborts the whole run with "unknown env".
function Get-PioEnvs {
    $set = New-Object System.Collections.Generic.HashSet[string]
    $ini = Join-Path $trackerRoot "platformio.ini"
    if (-not (Test-Path $ini)) { return $set }
    foreach ($line in Get-Content $ini) {
        if ($line -match '^\s*\[env:([A-Za-z0-9_]+)\]') { [void]$set.Add($matches[1]) }
    }
    return $set
}

# Reads the deviceBoardTypes map the server records for each connected tracker, and returns the
# board envs the user actually owns AND that this firmware can build. Empty if the config has
# none (server not yet run with this feature, or no tracker has connected). Owned boards
# that have no buildable env are reported and skipped so one unsupported board does not abort
# the build for the boards that are supported.
function Get-DetectedBoardEnvs {
    if (-not (Test-Path $ConfigPath)) { return @() }
    $byId = Get-BoardEnvById
    $pioEnvs = Get-PioEnvs
    $lines = Get-Content $ConfigPath
    $ids = New-Object System.Collections.Generic.HashSet[int]
    $inBlock = $false
    foreach ($line in $lines) {
        if ($line -match '^\S') { $inBlock = $false }
        if ($line -match '^deviceBoardTypes:\s*$') { $inBlock = $true; continue }
        if ($inBlock -and $line -match ':\s*(\d+)\s*$') { [void]$ids.Add([int]$matches[1]) }
    }
    $envs = @()
    foreach ($id in $ids) {
        if (-not $byId.ContainsKey($id)) { continue }
        $env = $byId[$id]
        if ($pioEnvs.Contains($env)) {
            $envs += $env
        } else {
            Write-Warning "Skipping owned board $env (id $id): no buildable [env:$env] in platformio.ini"
        }
    }
    return $envs | Select-Object -Unique
}

function Build-Firmware {
    # Find a way to run PlatformIO: a pio/platformio on PATH, or the python module it ships as
    $pioCmd = $null
    foreach ($name in @("pio", "platformio")) {
        if (Get-Command $name -ErrorAction SilentlyContinue) { $pioCmd = @($name); break }
    }
    if (-not $pioCmd) {
        foreach ($py in @("python", "py")) {
            if (Get-Command $py -ErrorAction SilentlyContinue) {
                & $py -m platformio --version *> $null
                if ($LASTEXITCODE -eq 0) { $pioCmd = @($py, "-m", "platformio"); break }
            }
        }
    }
    if (-not $pioCmd) {
        throw "PlatformIO not found. Install it: pip install platformio, or the PlatformIO IDE extension."
    }

    # Decide which board envs to build: an explicit -Board wins, otherwise auto-detect from the
    # boards your trackers have reported to the app. Fall back to the default env if neither.
    $envs = @()
    if ($Board) {
        $pioEnvs = Get-PioEnvs
        if (-not $pioEnvs.Contains($Board)) {
            throw "Unknown board env '$Board'. platformio.ini defines: $(($pioEnvs | Sort-Object) -join ', ')"
        }
        $envs = @($Board)
        Write-Host "Building firmware for requested board: $Board"
    } else {
        $envs = Get-DetectedBoardEnvs
        if ($envs.Count -gt 0) {
            Write-Host "Auto-detected boards from your trackers: $($envs -join ', ')"
        } else {
            Write-Host "Could not auto-detect a board (no connected trackers in $ConfigPath)."
            Write-Host "Connect a tracker to the app once, or pass -Board BOARD_X. Building the default env for now."
        }
    }

    $exe = $pioCmd[0]
    $baseArgs = @()
    if ($pioCmd.Length -gt 1) { $baseArgs = $pioCmd[1..($pioCmd.Length - 1)] }
    $runArgs = @("run")
    foreach ($e in $envs) { $runArgs += @("-e", $e) }
    $exeArgs = $baseArgs + $runArgs
    Write-Host "Building firmware with $exe $($exeArgs -join ' ')"
    Push-Location $trackerRoot
    # PlatformIO shells out to git for library installs, and git writes "Cloning into..."
    # to stderr. With ErrorActionPreference=Stop that native stderr aborts the build, so drop
    # to Continue for the run and judge success only by the real exit code.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $exe @exeArgs
        if ($LASTEXITCODE -ne 0) { throw "Firmware build failed" }
    } finally {
        $ErrorActionPreference = $prevEAP
        Pop-Location
    }
    # Collect every built firmware.bin into Release, named so the app's update parser finds
    # it: <BOARD_ENV>-firmware.bin, matching the asset names it looks for.
    $built = Get-ChildItem -Path (Join-Path $trackerRoot ".pio\build") -Recurse -Filter "firmware.bin" -ErrorAction SilentlyContinue
    if (-not $built) { throw "Firmware build finished but no firmware.bin was found" }
    foreach ($bin in $built) {
        $envName = Split-Path $bin.DirectoryName -Leaf
        Save-ToRelease $trackerRoot $bin.FullName "$envName-firmware.bin"
    }
    # deploy.json controls the staged rollout the app reads. This makes every build available
    # to everyone immediately (range 1 from a past date).
    # next to the firmware binaries.
    $releaseDir = Join-Path $trackerRoot "Release"
    $deploy = Join-Path $releaseDir "deploy.json"
    '{ "1": "2020-01-01T00:00:00Z" }' | Out-File -FilePath $deploy -Encoding utf8
    Write-Host "Wrote rollout file $deploy"
}

function Clean-Builds {
    # removes build outputs only, node_modules and gradle caches stay
    $paths = @(
        (Join-Path $serverRoot "gui\dist"),
        (Join-Path $serverRoot "gui\out"),
        (Join-Path $serverRoot "server\desktop\build"),
        (Join-Path $serverRoot "server\core\build"),
        (Join-Path $serverRoot "server\build"),
        (Join-Path $serverRoot "build"),
        (Join-Path $serverRoot "solarxr-protocol\protocol\typescript\dist"),
        (Join-Path $serverRoot "Release"),
        (Join-Path $trackerRoot "Release")
    )
    foreach ($p in $paths) {
        if (Test-Path $p) {
            Write-Host "Removing $p"
            Remove-Item -Recurse -Force $p
        }
    }
    Write-Host "Clean done"
}

switch ($Target) {
    "gui" { Build-Gui }
    "server" { Build-Server }
    "firmware" { Build-Firmware }
    "app" { Build-Server; Build-Gui }
    "dist" { Build-Dist }
    "bindings" { Build-BindingsProvider }
    "all" {
        Build-Server
        Build-Gui
        # Firmware is best effort in 'all': the app is already built and saved, so a missing
        # PlatformIO or a firmware compile error is a warning, not a failure of the whole build.
        try { Build-Firmware }
        catch { Write-Warning "Skipped firmware build: $($_.Exception.Message)" }
    }
    "clean" { Clean-Builds }
}