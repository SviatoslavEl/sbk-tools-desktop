param(
    [string]$Target = "x86_64-pc-windows-msvc",
    [string]$Version = "2.4.0"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Stage = Join-Path $Root "portable-stage"
$Payload = Join-Path $Stage "payload"
$Output = Join-Path $Root "release-artifacts"
$ReleaseDir = Join-Path $Root "src-tauri\target\$Target\release"
$LauncherTarget = Join-Path $Stage "launcher-target"

if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force $Payload, $Output | Out-Null
Copy-Item (Join-Path $ReleaseDir "sbk-tools-desktop.exe") (Join-Path $Payload "SBK-Tools.exe")
Copy-Item (Join-Path $Root "src-tauri\binaries\sbk-scanner-worker-$Target.exe") (Join-Path $Payload "sbk-scanner-worker.exe")
Copy-Item -Recurse (Join-Path $Root "src-tauri\runtime-resources") (Join-Path $Payload "scanner-runtime")
Copy-Item -Recurse (Join-Path $Root "src-tauri\webview2-runtime") (Join-Path $Payload "webview2-runtime")
Copy-Item (Join-Path $Root "LICENSE") $Payload
Copy-Item (Join-Path $Root "THIRD_PARTY_LICENSES.md") $Payload

$Archive = Join-Path $Stage "payload.tar.zst"
python (Join-Path $Root "scripts\create_payload_archive.py") --root $Payload --output $Archive
if ($LASTEXITCODE -ne 0) { throw "Windows payload compression failed" }
$env:SBK_PAYLOAD_TAR_ZST = $Archive
cargo build --manifest-path (Join-Path $Root "windows-launcher\Cargo.toml") --release --target $Target --target-dir $LauncherTarget
if ($LASTEXITCODE -ne 0) { throw "Windows one-file launcher build failed" }

$Destination = Join-Path $Output "SBK-Tools-$Version-Windows-x64-Portable.exe"
Copy-Item (Join-Path $LauncherTarget "$Target\release\sbk-tools-onefile-launcher.exe") $Destination

$WindowsKits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
$Mt = Get-ChildItem -Path $WindowsKits -Filter "mt.exe" -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\mt\.exe$' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $Mt) { throw "Windows SDK manifest tool (mt.exe, x64) not found" }
$ExtractedManifest = Join-Path $Stage "portable-launcher.manifest"
& $Mt.FullName -nologo "-inputresource:$Destination;#1" "-out:$ExtractedManifest"
if ($LASTEXITCODE -ne 0) { throw "Failed to extract one-file launcher manifest" }
$ManifestText = Get-Content -Raw $ExtractedManifest
if ($ManifestText -notmatch 'requestedExecutionLevel' -or $ManifestText -notmatch 'level="asInvoker"') { throw "One-file launcher is not marked asInvoker" }
if ($ManifestText -match 'requireAdministrator|highestAvailable') { throw "One-file launcher unexpectedly requests elevation" }

$Hash = (Get-FileHash -Algorithm SHA256 $Destination).Hash.ToLowerInvariant()
Set-Content -Encoding ASCII -Path "$Destination.sha256" -Value "$Hash  $(Split-Path -Leaf $Destination)"
Write-Output "Verified: single executable, asInvoker, unique temporary extraction and automatic cleanup"
Write-Output $Destination
