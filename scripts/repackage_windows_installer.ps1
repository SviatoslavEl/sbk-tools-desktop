# Rebuild only the installer wrapper. The released application's compressed
# payload is extracted, copied unchanged and verified again in the new EXE.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ARCH -ne 'X64') {
    throw 'Installer repair must run on an isolated Windows x64 GitHub runner.'
}
if (-not $env:RUNNER_TEMP -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
    throw 'A runner-owned temporary directory is required.'
}

$Repo = Split-Path -Parent $PSScriptRoot
$SourceUrl = 'https://github.com/SviatoslavEl/sbk-tools-desktop/releases/download/v2.8.6/SBK-Tools-Fast-Setup-2.8.6-x64.exe'
$SourceSha256 = '20e6e803b5b7ed42eb9f06a013e1ef849bb963fefce0ccc41267ff40d86e2a0f'
$InstallerVersion = '2.8.6-r2'
$VersionQuad = '2.8.6.2'
$Output = Join-Path $Repo 'release-artifacts'
$Work = Join-Path $env:RUNNER_TEMP ('sbk-installer-repair-' + [guid]::NewGuid())
$NsisStage = Join-Path $Work 'nsis'
$OriginalPayloadDirectory = Join-Path $Work 'original-payload'
$VerifiedPayloadDirectory = Join-Path $Work 'verified-new-payload'
$PackagingLog = Join-Path $env:RUNNER_TEMP 'SBK-Windows-Installer-Repair-Packaging.log'
New-Item -ItemType Directory -Path $Work, $NsisStage, $OriginalPayloadDirectory, $VerifiedPayloadDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $Output | Out-Null
if (@(Get-ChildItem -LiteralPath $Output -Filter 'SBK-Tools-Fast-Setup-*-x64.exe').Count -ne 0) {
    throw 'Repair output already contains an installer; refusing an ambiguous smoke-test input.'
}
Start-Transcript -LiteralPath $PackagingLog | Out-Null

function Download-Verified([string]$Url, [string]$Path, [string]$Algorithm, [string]$Expected) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Invoke-WebRequest -Uri $Url -OutFile $Path -TimeoutSec 180
            $actual = (Get-FileHash -LiteralPath $Path -Algorithm $Algorithm).Hash.ToLowerInvariant()
            if ($actual -ne $Expected.ToLowerInvariant()) { throw "Pinned $Algorithm mismatch for $Url" }
            return
        } catch {
            if ($attempt -eq 3) { throw }
            Write-Warning "Download attempt $attempt failed; retrying the same pinned file: $_"
            Start-Sleep -Seconds 2
        }
    }
}

function Extract-OnlyPayload([string]$Archive, [string]$Directory) {
    # 7-Zip parses the archive: never launch either the old setup or its helper.
    $listing = & $SevenZip l -slt $Archive 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not list installer archive: $Archive" }
    $payloadEntries = @($listing | ForEach-Object {
        if ("$_" -match '^Path = (.+)$') {
            $entry = $Matches[1]
            if ([IO.Path]::GetFileName($entry.Replace('/', '\')) -eq 'payload.tar.zst') { $entry }
        }
    })
    if ($payloadEntries.Count -ne 1) { throw 'Expected exactly one payload.tar.zst in the verified NSIS archive' }
    & $SevenZip e -y "-o$Directory" '-ir!payload.tar.zst' $Archive | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'NSIS payload extraction failed' }
    $files = @(Get-ChildItem -LiteralPath $Directory -Force)
    if ($files.Count -ne 1 -or $files[0].Name -ne 'payload.tar.zst' -or $files[0].PSIsContainer) {
        throw 'Archive extraction produced unexpected objects'
    }
    return $files[0].FullName
}

function Assert-AsInvoker([string]$Executable, [string]$Label) {
    $inspection = Join-Path $Work "$Label.manifest"
    & $ManifestTool -nologo "-inputresource:$Executable;#1" "-out:$inspection"
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect $Label manifest" }
    $text = Get-Content -LiteralPath $inspection -Raw
    if ($text -notmatch 'level="asInvoker"' -or $text -match 'requireAdministrator|highestAvailable') {
        throw "$Label unexpectedly requests elevation"
    }
}

try {
    $commit = (& git -C $Repo rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve the repair source commit' }
    if ((Get-Content -LiteralPath (Join-Path $Repo 'package.json') -Raw | ConvertFrom-Json).version -ne '2.8.6') {
        throw 'This repair is exclusively for the unchanged 2.8.6 application payload'
    }
    $sevenZipCommand = Get-Command 7z -ErrorAction SilentlyContinue
    $SevenZip = if ($sevenZipCommand) { $sevenZipCommand.Source } else { 'C:\Program Files\7-Zip\7z.exe' }
    if (-not (Test-Path -LiteralPath $SevenZip -PathType Leaf)) { throw '7-Zip is required for non-executing archive extraction' }
    $windowsKits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $manifestToolItem = Get-ChildItem -LiteralPath $windowsKits -Filter mt.exe -File -Recurse |
        Where-Object { $_.FullName -match '\\x64\\mt\.exe$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $manifestToolItem) { throw 'Windows SDK x64 manifest tool is missing' }
    $ManifestTool = $manifestToolItem.FullName

    $sourceInstaller = Join-Path $Work 'verified-original-2.8.6.exe'
    Download-Verified $SourceUrl $sourceInstaller SHA256 $SourceSha256
    $sourceSize = (Get-Item -LiteralPath $sourceInstaller).Length
    $sourcePayload = Extract-OnlyPayload $sourceInstaller $OriginalPayloadDirectory
    $payloadHash = (Get-FileHash -LiteralPath $sourcePayload -Algorithm SHA256).Hash.ToLowerInvariant()
    $payloadSize = (Get-Item -LiteralPath $sourcePayload).Length
    if ($payloadSize -le 0 -or $payloadSize -ge 1800MB) { throw 'Unexpected compressed payload size' }
    Copy-Item -LiteralPath $sourcePayload -Destination (Join-Path $NsisStage 'payload.tar.zst')
    Write-Host "Verified original installer $SourceSha256; unchanged compressed payload $payloadHash ($payloadSize bytes)"

    cargo build --locked --release --manifest-path (Join-Path $Repo 'windows-installer-helper\Cargo.toml')
    if ($LASTEXITCODE -ne 0) { throw 'Repaired installed extractor build failed' }
    $extractor = Join-Path $Repo 'windows-installer-helper\target\release\sbk-tools-installed-extractor.exe'
    Assert-AsInvoker $extractor 'extractor'
    Copy-Item -LiteralPath $extractor -Destination (Join-Path $NsisStage 'sbk-installed-extractor.exe')
    Copy-Item -LiteralPath (Join-Path $Repo 'scripts\windows-installed.nsi') -Destination $NsisStage
    Copy-Item -LiteralPath (Join-Path $Repo 'src-tauri\icons\icon.ico') -Destination $NsisStage
    $license = Get-Content -LiteralPath (Join-Path $Repo 'LICENSE') -Raw -Encoding UTF8
    [IO.File]::WriteAllText((Join-Path $NsisStage 'LICENSE.txt'), $license, [Text.Encoding]::Unicode)

    $nsisArchive = Join-Path $Work 'nsis-3.11.zip'
    Download-Verified 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip' $nsisArchive SHA1 'EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D'
    Expand-Archive -LiteralPath $nsisArchive -DestinationPath (Join-Path $Work 'nsis-tools')
    $nsisRoot = Join-Path $Work 'nsis-tools\nsis-3.11'
    Copy-Item -LiteralPath (Join-Path $nsisRoot 'COPYING') -Destination (Join-Path $NsisStage 'NSIS-COPYING')
    Push-Location $NsisStage
    try {
        & (Join-Path $nsisRoot 'makensis.exe') /INPUTCHARSET UTF8 "/DPRODUCT_VERSION=$InstallerVersion" "/DVERSION_QUAD=$VersionQuad" 'windows-installed.nsi'
        if ($LASTEXITCODE -ne 0) { throw 'Repaired NSIS package compilation failed' }
    } finally { Pop-Location }

    $newInstaller = Join-Path $NsisStage 'SBK-Tools-Fast-Setup.exe'
    Assert-AsInvoker $newInstaller 'installer'
    $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($newInstaller)
    $actualQuad = "$($versionInfo.FileMajorPart).$($versionInfo.FileMinorPart).$($versionInfo.FileBuildPart).$($versionInfo.FilePrivatePart)"
    if ($actualQuad -ne $VersionQuad -or $versionInfo.ProductVersion -ne $InstallerVersion) {
        throw "Unexpected repaired installer version: $actualQuad / $($versionInfo.ProductVersion)"
    }
    $newPayload = Extract-OnlyPayload $newInstaller $VerifiedPayloadDirectory
    $newPayloadHash = (Get-FileHash -LiteralPath $newPayload -Algorithm SHA256).Hash.ToLowerInvariant()
    $newPayloadSize = (Get-Item -LiteralPath $newPayload).Length
    if ($newPayloadHash -ne $payloadHash -or $newPayloadSize -ne $payloadSize) {
        throw 'Repackaging changed the compressed application payload; refuse this repair'
    }

    $baseName = "SBK-Tools-Fast-Setup-$InstallerVersion-x64"
    $destination = Join-Path $Output "$baseName.exe"
    Copy-Item -LiteralPath $newInstaller -Destination $destination
    $installerHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    $installerSize = (Get-Item -LiteralPath $destination).Length
    if ($installerSize -ge 1900MB) { throw 'Installer exceeds the safe NSIS single-file limit' }
    [IO.File]::WriteAllText("$destination.sha256", "$installerHash  $baseName.exe`n", [Text.Encoding]::ASCII)
    $provenance = [ordered]@{
        schemaVersion = 1
        applicationVersion = '2.8.6'
        installerVersion = $InstallerVersion
        installerVersionQuad = $VersionQuad
        buildCommit = $commit
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
        sourceInstaller = [ordered]@{ url = $SourceUrl; sha256 = $SourceSha256; sizeBytes = $sourceSize }
        sourcePayload = [ordered]@{ sha256 = $payloadHash; sizeBytes = $payloadSize }
        rebuiltPayload = [ordered]@{ sha256 = $newPayloadHash; sizeBytes = $newPayloadSize; unchanged = $true }
        repairedInstaller = [ordered]@{ fileName = "$baseName.exe"; sha256 = $installerHash; sizeBytes = $installerSize }
        extractorSha256 = (Get-FileHash -LiteralPath $extractor -Algorithm SHA256).Hash.ToLowerInvariant()
        nsisTemplateSha256 = (Get-FileHash -LiteralPath (Join-Path $Repo 'scripts\windows-installed.nsi') -Algorithm SHA256).Hash.ToLowerInvariant()
        nsisToolset = [ordered]@{ version = '3.11'; sha1 = 'ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d' }
        note = 'Only installer/extractor replaced. The compressed application, worker, runtimes and licenses payload is byte-identical to released v2.8.6. No old installer or worker was executed during repackaging.'
    }
    $provenance | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Output "$baseName.provenance.json") -Encoding utf8
    Write-Host "Repaired installer: $destination SHA256 $installerHash"
    Write-Host 'Byte-identical compressed payload confirmed by extraction from both installer EXEs.'
    # Exact unique temporary workspace, not any user/workspace directory.
    if ((Split-Path -Parent $Work) -ne $env:RUNNER_TEMP -or -not (Split-Path -Leaf $Work).StartsWith('sbk-installer-repair-')) {
        throw 'Unexpected temporary workspace; refusing packaging cleanup'
    }
    Remove-Item -LiteralPath $Work -Recurse -Force
    Write-Host 'Removed only temporary downloaded/extracted packaging inputs before the installed smoke test.'
} finally {
    Stop-Transcript | Out-Null
}
