param(
    [string]$Target = "x86_64-pc-windows-msvc",
    [string]$Version = "2.8.3"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Config = Join-Path $Root "src-tauri\tauri.installed.windows.conf.json"
$ReleaseDir = Join-Path $Root "src-tauri\target\$Target\release"
$BundleDir = Join-Path $ReleaseDir "bundle\nsis"
$Output = Join-Path $Root "release-artifacts"
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

    Invoke-Tauri "Installed Windows NSIS packaging" @(
        "bundle", "--target", $Target, "--bundles", "nsis", "--features", "installed-fast-start",
        "--config", $Config, "--ci", "--verbose"
    )
} finally {
    if ($null -eq $PreviousFastStart) {
        Remove-Item Env:VITE_SBK_INSTALLED_FAST_START -ErrorAction SilentlyContinue
    } else {
        $env:VITE_SBK_INSTALLED_FAST_START = $PreviousFastStart
    }
    Pop-Location
}

$Installer = Get-ChildItem $BundleDir -Filter "*-setup.exe" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $Installer) { throw "NSIS installer was not produced" }
if ($Installer.Name -eq "ScanDocument.exe") { throw "Installed artifact must not use the portable filename" }
Assert-AsInvoker $Installer.FullName "installer"

New-Item -ItemType Directory -Force $Output | Out-Null
$SafeVersion = $Version.TrimStart("v")
$Destination = Join-Path $Output "SBK-Tools-Fast-Setup-$SafeVersion-x64.exe"
Copy-Item $Installer.FullName $Destination -Force
$Hash = (Get-FileHash -Algorithm SHA256 $Destination).Hash.ToLowerInvariant()
Set-Content -Encoding ASCII -Path "$Destination.sha256" -Value "$Hash  $(Split-Path -Leaf $Destination)"

Write-Output "Verified: separate current-user NSIS installer, fixed offline runtimes, asInvoker application and installer"
Write-Output $Destination
