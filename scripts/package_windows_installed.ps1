param(
    [string]$Target = "x86_64-pc-windows-msvc",
    [string]$Version = "2.8.3"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Config = Join-Path $Root "src-tauri\tauri.installed.windows.conf.json"
$ReleaseDir = Join-Path $Root "src-tauri\target\$Target\release"
$Output = Join-Path $Root "release-artifacts"
$Stage = Join-Path $Root "installed-stage"
$Payload = Join-Path $Stage "payload"
$NsisStage = Join-Path $Stage "nsis"
$ExtractorTarget = Join-Path $Stage "extractor-target"
$Application = Join-Path $ReleaseDir "SBK-Tools-Fast.exe"
$Worker = Join-Path $Root "src-tauri\binaries\sbk-scanner-worker-$Target.exe"
$Runtime = Join-Path $Root "src-tauri\runtime-resources"
$WebView = Join-Path $Root "src-tauri\webview2-runtime\Microsoft.WebView2.FixedVersionRuntime.151.0.4129.107.x64"
$InspectionRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$BuildLog = Join-Path $InspectionRoot "sbk-fast-installed-build.log"

if (-not $IsWindows -and $env:OS -ne "Windows_NT") { throw "Installed Windows package must be built on Windows" }
if ($Version -notmatch '^v?[0-9A-Za-z][0-9A-Za-z._-]*$') { throw "Invalid artifact version: $Version" }
if (-not (Test-Path $Config -PathType Leaf)) { throw "Installed Windows Tauri config is missing" }
if (-not (Test-Path $Worker -PathType Leaf)) { throw "Scanner sidecar is missing: $Worker" }
if (-not (Test-Path (Join-Path $Runtime "resources\resource-manifest.json") -PathType Leaf)) {
    throw "Trusted runtime manifest is missing"
}
if (-not (Test-Path (Join-Path $Runtime "resources\ocr\windows\tessdata\eng.traineddata") -PathType Leaf) -or
    -not (Test-Path (Join-Path $Runtime "resources\ocr\windows\tessdata\rus.traineddata") -PathType Leaf)) {
    throw "Offline English and Russian OCR models are missing"
}
if (-not (Test-Path (Join-Path $Runtime "resources\office\windows") -PathType Container)) {
    throw "Offline LibreOffice runtime is missing"
}
if (-not (Test-Path (Join-Path $WebView "msedgewebview2.exe") -PathType Leaf)) {
    throw "Pinned offline WebView2 runtime is missing"
}
foreach ($license in @("LICENSE", "THIRD_PARTY_LICENSES.md")) {
    if (-not (Test-Path (Join-Path $Root $license) -PathType Leaf)) {
        throw "License file is missing: $license"
    }
}

function Get-ManifestTool {
    $windowsKits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $manifestTool = Get-ChildItem -Path $windowsKits -Filter "mt.exe" -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\mt\.exe$' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $manifestTool) { throw "Windows SDK manifest tool (mt.exe, x64) not found" }
    return $manifestTool.FullName
}

$ManifestTool = Get-ManifestTool

function Write-BuildFailure([string]$Stage, [string]$Fallback) {
    $details = if (Test-Path $BuildLog -PathType Leaf) {
        (Get-Content $BuildLog -Tail 30) -join "`n"
    } else {
        $Fallback
    }
    $escaped = $details.Replace('%', '%25').Replace("`r", '').Replace("`n", '%0A')
    Write-Output "::error file=scripts/package_windows_installed.ps1,title=${Stage}::$escaped"
    throw $Fallback
}

function Invoke-Tauri([string]$Stage, [string[]]$Arguments) {
    & npm run tauri -- @Arguments 2>&1 | Tee-Object -FilePath $BuildLog -Append
    if ($LASTEXITCODE -ne 0) {
        Write-BuildFailure $Stage "$Stage failed with exit code $LASTEXITCODE"
    }
}

function Assert-AsInvoker([string]$Executable, [string]$Label) {
    $inspection = Join-Path $InspectionRoot "sbk-fast-$Label.manifest"
    & $ManifestTool -nologo "-inputresource:$Executable;#1" "-out:$inspection"
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract $Label manifest" }
    $text = Get-Content -Raw $inspection
    if ($text -notmatch 'requestedExecutionLevel' -or $text -notmatch 'level="asInvoker"') {
        throw "$Label is not marked asInvoker"
    }
    if ($text -match 'requireAdministrator|highestAvailable') {
        throw "$Label unexpectedly requests elevation"
    }
}

python (Join-Path $Root "scripts\verify_runtime_manifest.py") --root $Runtime --worker $Worker
if ($LASTEXITCODE -ne 0) { throw "Packaged scanner runtime verification failed" }

Push-Location $Root
$PreviousFastStart = $env:VITE_SBK_INSTALLED_FAST_START
$env:VITE_SBK_INSTALLED_FAST_START = "true"
try {
    Remove-Item $BuildLog -Force -ErrorAction SilentlyContinue
    Invoke-Tauri "Installed Windows application build" @(
        "build", "--target", $Target, "--no-bundle", "--features", "installed-fast-start",
        "--config", $Config, "--ci"
    )
    if (-not (Test-Path $Application -PathType Leaf)) {
        throw "Installed application binary was not produced: $Application"
    }
    Assert-AsInvoker $Application "application"
} finally {
    if ($null -eq $PreviousFastStart) {
        Remove-Item Env:VITE_SBK_INSTALLED_FAST_START -ErrorAction SilentlyContinue
    } else {
        $env:VITE_SBK_INSTALLED_FAST_START = $PreviousFastStart
    }
    Pop-Location
}

if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force $Payload, $NsisStage, $Output | Out-Null
Copy-Item $Application (Join-Path $Payload "SBK-Tools-Fast.exe")
Copy-Item $Worker (Join-Path $Payload "sbk-scanner-worker.exe")
Copy-Item -Recurse $Runtime (Join-Path $Payload "scanner-runtime")
Copy-Item -Recurse (Join-Path $Root "src-tauri\webview2-runtime") (Join-Path $Payload "webview2-runtime")
Copy-Item (Join-Path $Root "LICENSE") $Payload
Copy-Item (Join-Path $Root "THIRD_PARTY_LICENSES.md") $Payload

$Archive = Join-Path $Stage "payload.tar.zst"
python (Join-Path $Root "scripts\create_payload_archive.py") --root $Payload --output $Archive
if ($LASTEXITCODE -ne 0) { throw "Installed payload compression failed" }
if ((Get-Item $Archive).Length -ge 1800MB) {
    throw "Compressed installed payload is too large for a single NSIS executable"
}

cargo build `
    --manifest-path (Join-Path $Root "windows-installer-helper\Cargo.toml") `
    --release `
    --target $Target `
    --target-dir $ExtractorTarget
if ($LASTEXITCODE -ne 0) { throw "Installed payload extractor build failed" }
$Extractor = Join-Path $ExtractorTarget "$Target\release\sbk-tools-installed-extractor.exe"
if (-not (Test-Path $Extractor -PathType Leaf)) { throw "Installed payload extractor is missing" }
Assert-AsInvoker $Extractor "extractor"

$NsisZip = Join-Path $Stage "nsis-3.11.zip"
$NsisTools = Join-Path $Stage "nsis-tools"
$NsisUrl = "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip"
Invoke-WebRequest $NsisUrl -OutFile $NsisZip
$NsisHash = (Get-FileHash -Algorithm SHA1 $NsisZip).Hash.ToUpperInvariant()
if ($NsisHash -ne "EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D") {
    throw "NSIS toolset checksum mismatch: $NsisHash"
}
Expand-Archive $NsisZip -DestinationPath $NsisTools -Force
$NsisHome = Join-Path $NsisTools "nsis-3.11"
$MakeNsis = Join-Path $NsisHome "makensis.exe"
if (-not (Test-Path $MakeNsis -PathType Leaf)) { throw "Pinned makensis.exe is missing" }

Copy-Item (Join-Path $Root "scripts\windows-installed.nsi") $NsisStage
Copy-Item (Join-Path $Root "LICENSE") (Join-Path $NsisStage "LICENSE.txt")
Copy-Item (Join-Path $Root "src-tauri\icons\icon.ico") $NsisStage
Copy-Item (Join-Path $NsisHome "COPYING") (Join-Path $NsisStage "NSIS-COPYING")
Copy-Item $Archive $NsisStage
Copy-Item $Extractor (Join-Path $NsisStage "sbk-installed-extractor.exe")

$SafeVersion = $Version.TrimStart("v")
$VersionParts = [regex]::Match($SafeVersion, '^(\d+)\.(\d+)\.(\d+)')
if (-not $VersionParts.Success) { throw "Installer version must start with three numeric parts" }
$VersionQuad = "$($VersionParts.Groups[1].Value).$($VersionParts.Groups[2].Value).$($VersionParts.Groups[3].Value).0"
$NsisLog = Join-Path $InspectionRoot "sbk-fast-nsis.log"
Remove-Item $NsisLog -Force -ErrorAction SilentlyContinue
Push-Location $NsisStage
try {
    & $MakeNsis "/DPRODUCT_VERSION=$SafeVersion" "/DVERSION_QUAD=$VersionQuad" "-V4" "windows-installed.nsi" 2>&1 |
        Tee-Object -FilePath $NsisLog
    if ($LASTEXITCODE -ne 0) {
        $BuildLog = $NsisLog
        Write-BuildFailure "Installed Windows NSIS packaging" "Installed Windows NSIS packaging failed"
    }
} finally {
    Pop-Location
}

$Installer = Get-Item (Join-Path $NsisStage "SBK-Tools-Fast-Setup.exe") -ErrorAction SilentlyContinue
if (-not $Installer) { throw "NSIS installer was not produced" }
if ($Installer.Length -ge 1900MB) { throw "NSIS installer exceeds its safe single-file limit" }
Assert-AsInvoker $Installer.FullName "installer"

$Destination = Join-Path $Output "SBK-Tools-Fast-Setup-$SafeVersion-x64.exe"
Copy-Item $Installer.FullName $Destination -Force
$Hash = (Get-FileHash -Algorithm SHA256 $Destination).Hash.ToLowerInvariant()
Set-Content -Encoding ASCII -Path "$Destination.sha256" -Value "$Hash  $(Split-Path -Leaf $Destination)"

Write-Output "Verified: separate current-user NSIS installer, compressed offline payload, asInvoker application and installer"
Write-Output $Destination
