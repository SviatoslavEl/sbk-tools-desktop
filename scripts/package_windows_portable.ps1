param(
    [string]$Target = "x86_64-pc-windows-msvc",
    [string]$Version = "1.0.0"
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
$Destination = Join-Path $Output "SBK-Tools-$Version-Windows-x64-Portable.exe"
$Bytes = [System.IO.File]::ReadAllBytes($Sfx) + [System.IO.File]::ReadAllBytes($Config) + [System.IO.File]::ReadAllBytes($Archive)
[System.IO.File]::WriteAllBytes($Destination, $Bytes)
Write-Output $Destination
