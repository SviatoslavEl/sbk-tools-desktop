param(
    [string]$Target = "x86_64-pc-windows-msvc",
    [string]$Version = "1.0.1"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Stage = Join-Path $Root "portable-stage"
$Payload = Join-Path $Stage "SBK-Tools-Portable"
$Output = Join-Path $Root "release-artifacts"
$ReleaseDir = Join-Path $Root "src-tauri\target\$Target\release"

if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force $Payload, $Output | Out-Null
Copy-Item (Join-Path $ReleaseDir "sbk-tools-desktop.exe") (Join-Path $Payload "SBK-Tools.exe")
Copy-Item (Join-Path $Root "src-tauri\binaries\sbk-scanner-worker-$Target.exe") (Join-Path $Payload "sbk-scanner-worker.exe")
Copy-Item -Recurse (Join-Path $Root "src-tauri\runtime-resources") (Join-Path $Payload "scanner-runtime")
Copy-Item (Join-Path $Root "LICENSE") $Payload
Copy-Item (Join-Path $Root "THIRD_PARTY_LICENSES.md") $Payload
New-Item -ItemType Directory -Force (Join-Path $Payload "ProductData") | Out-Null

$Archive = Join-Path $Stage "payload.7z"
& 7z a -t7z $Archive "$Payload\*" -mx=9 | Out-Null
$Config = Join-Path $Stage "config.txt"
@"
;!@Install@!UTF-8!
Title="СБК Инструменты $Version"
InstallPath="%S\SBK-Tools-Portable"
RunProgram="SBK-Tools.exe"
GUIMode="2"
;!@InstallEnd@!
"@ | Set-Content -Encoding UTF8 $Config

$Sfx = Join-Path ${env:ProgramFiles} "7-Zip\7z.sfx"
if (-not (Test-Path $Sfx)) { throw "7-Zip SFX module not found: $Sfx" }

# The stock SFX module can be classified by Windows as an installer and trigger
# UAC heuristics. Embed an explicit asInvoker manifest so the portable launcher
# always runs with the current user's rights and never asks for administrator
# credentials.
$WindowsKits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
$Mt = Get-ChildItem -Path $WindowsKits -Filter "mt.exe" -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\mt\.exe$' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $Mt) { throw "Windows SDK manifest tool (mt.exe, x64) not found" }

$Manifest = Join-Path $Root "scripts\windows-as-invoker.manifest"
$PortableSfx = Join-Path $Stage "7z-as-invoker.sfx"
Copy-Item $Sfx $PortableSfx
& $Mt.FullName -nologo -manifest $Manifest "-outputresource:$PortableSfx;#1"
if ($LASTEXITCODE -ne 0) { throw "Failed to embed asInvoker manifest into SFX launcher" }

$Destination = Join-Path $Output "SBK-Tools-$Version-Windows-x64-Portable.exe"
$Bytes = [System.IO.File]::ReadAllBytes($PortableSfx) + [System.IO.File]::ReadAllBytes($Config) + [System.IO.File]::ReadAllBytes($Archive)
[System.IO.File]::WriteAllBytes($Destination, $Bytes)

& 7z t $Destination | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Portable launcher archive validation failed" }

$ExtractedManifest = Join-Path $Stage "portable-launcher.manifest"
& $Mt.FullName -nologo "-inputresource:$Destination;#1" "-out:$ExtractedManifest"
if ($LASTEXITCODE -ne 0) { throw "Failed to extract portable launcher manifest for verification" }
$ManifestText = Get-Content -Raw $ExtractedManifest
if ($ManifestText -notmatch 'requestedExecutionLevel' -or $ManifestText -notmatch 'level="asInvoker"') {
    throw "Portable launcher does not contain the required asInvoker manifest"
}
if ($ManifestText -match 'requireAdministrator|highestAvailable') {
    throw "Portable launcher unexpectedly requests elevated privileges"
}

Write-Output "Verified: portable launcher runs asInvoker and does not request administrator rights"
Write-Output $Destination
