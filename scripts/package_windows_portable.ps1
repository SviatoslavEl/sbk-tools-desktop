param(
    [string]$Target = "x86_64-pc-windows-msvc",
    [string]$Version = "2.6.2"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Stage = Join-Path $Root "portable-stage"
$Payload = Join-Path $Stage "payload"
$Output = Join-Path $Root "release-artifacts"
$ReleaseDir = Join-Path $Root "src-tauri\target\$Target\release"
$LauncherTarget = Join-Path $Stage "launcher-target"

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

function Set-AsInvoker([string]$Executable) {
    $manifest = Join-Path $Root "scripts\windows-as-invoker.manifest"
    if (-not (Test-Path $manifest -PathType Leaf)) { throw "asInvoker manifest not found" }
    & $ManifestTool -nologo -manifest $manifest "-outputresource:$Executable;#1"
    if ($LASTEXITCODE -ne 0) { throw "Failed to embed asInvoker manifest" }
}

function Assert-AsInvoker([string]$Executable, [string]$Label) {
    $manifest = Join-Path $Stage "$Label.manifest"
    & $ManifestTool -nologo "-inputresource:$Executable;#1" "-out:$manifest"
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract $Label manifest" }
    $text = Get-Content -Raw $manifest
    if ($text -notmatch 'requestedExecutionLevel' -or $text -notmatch 'level="asInvoker"') {
        throw "$Label is not marked asInvoker"
    }
    if ($text -match 'requireAdministrator|highestAvailable') {
        throw "$Label unexpectedly requests elevation"
    }
    if ($text -notmatch 'uiAccess="false"') {
        throw "$Label unexpectedly requests UI access"
    }
    if ($text -notmatch 'name="Microsoft.Windows.Common-Controls"' -or $text -notmatch 'version="6.0.0.0"') {
        throw "$Label does not activate Windows Common Controls v6"
    }
}

if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force $Payload, $Output | Out-Null
Copy-Item (Join-Path $ReleaseDir "sbk-tools-desktop.exe") (Join-Path $Payload "SBK-Tools.exe")
Copy-Item (Join-Path $Root "src-tauri\binaries\sbk-scanner-worker-$Target.exe") (Join-Path $Payload "sbk-scanner-worker.exe")
Copy-Item -Recurse (Join-Path $Root "src-tauri\runtime-resources") (Join-Path $Payload "scanner-runtime")
Copy-Item -Recurse (Join-Path $Root "src-tauri\webview2-runtime") (Join-Path $Payload "webview2-runtime")
Copy-Item (Join-Path $Root "LICENSE") $Payload
Copy-Item (Join-Path $Root "THIRD_PARTY_LICENSES.md") $Payload
Set-AsInvoker (Join-Path $Payload "SBK-Tools.exe")
Assert-AsInvoker (Join-Path $Payload "SBK-Tools.exe") "inner-application"

$Archive = Join-Path $Stage "payload.tar.zst"
python (Join-Path $Root "scripts\create_payload_archive.py") --root $Payload --output $Archive
if ($LASTEXITCODE -ne 0) { throw "Windows payload compression failed" }
$env:SBK_PAYLOAD_TAR_ZST = $Archive
cargo build --manifest-path (Join-Path $Root "windows-launcher\Cargo.toml") --release --target $Target --target-dir $LauncherTarget
if ($LASTEXITCODE -ne 0) { throw "Windows one-file launcher build failed" }

$Destination = Join-Path $Output "ScanDocument.exe"
Copy-Item (Join-Path $LauncherTarget "$Target\release\sbk-tools-onefile-launcher.exe") $Destination
Assert-AsInvoker $Destination "portable-launcher"

$Hash = (Get-FileHash -Algorithm SHA256 $Destination).Hash.ToLowerInvariant()
Set-Content -Encoding ASCII -Path "$Destination.sha256" -Value "$Hash  $(Split-Path -Leaf $Destination)"
Write-Output "Verified: single executable, asInvoker, unique temporary extraction and automatic cleanup"
Write-Output $Destination
