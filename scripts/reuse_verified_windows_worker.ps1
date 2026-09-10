param([string]$Target = 'x86_64-pc-windows-msvc')
$ErrorActionPreference = 'Stop'
# Reuse only the identical worker from a successful installed-build job.
# Never launch the downloaded installer, application, or bundled extractor.
$sourceRun = '34363270973'
$sourceJob = '102507431765'
$sourceCommit = '3a4c7a4ac8effab2413be7044d1607f1c9b7735d'
$sourceRunNumber = 62
$repo = 'SviatoslavEl/sbk-tools-desktop'
$artifactName = 'SBK-Tools-Windows-x64-Installed'
$download = $null
$reused = $false
try {
    if ($Target -ne 'x86_64-pc-windows-msvc') { throw 'Verified worker has a different target' }
    git fetch --no-tags origin $sourceCommit
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify worker source commit' }
    git diff --exit-code $sourceCommit -- scanner-worker scripts/build_scanner_worker.py
    if ($LASTEXITCODE -ne 0) { throw 'Scanner sources or build script differ; a fresh worker is required' }

    $job = gh api "repos/$repo/actions/jobs/$sourceJob" | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $job.status -ne 'completed' -or $job.conclusion -ne 'success' -or
        "$($job.run_id)" -ne $sourceRun -or $job.head_sha -ne $sourceCommit -or
        $job.name -ne 'Windows x64 installed fast start') { throw 'Source Windows installed job is not verified successfully' }
    $run = gh api "repos/$repo/actions/runs/$sourceRun" | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $run.head_sha -ne $sourceCommit -or $run.repository.full_name -ne $repo -or
        $run.path -ne '.github/workflows/release.yml' -or $run.run_attempt -ne $job.run_attempt -or
        $run.run_number -ne $sourceRunNumber -or $run.event -ne 'push' -or
        $run.head_branch -ne 'codex/v2.8.6-scanner-shared-lock-fixes') { throw 'Unexpected source workflow, repository, commit, attempt, or candidate run' }
    $artifacts = gh api "repos/$repo/actions/runs/$sourceRun/artifacts?per_page=100" | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect source artifacts' }
    $matching = @($artifacts.artifacts | Where-Object { $_.name -eq $artifactName -and -not $_.expired })
    if ($matching.Count -ne 1 -or "$($matching[0].workflow_run.id)" -ne $sourceRun -or
        $matching[0].workflow_run.head_sha -ne $sourceCommit) { throw 'Expected one unexpired installed artifact from the verified source' }

    $sevenZipCommand = Get-Command 7z -ErrorAction SilentlyContinue
    $sevenZip = if ($sevenZipCommand) { $sevenZipCommand.Source } else { 'C:\Program Files\7-Zip\7z.exe' }
    if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) { throw '7-Zip is unavailable; installer extraction will not be attempted' }
    $temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
    $download = Join-Path $temporaryRoot ('sbk-worker-reuse-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $download | Out-Null
    gh run download $sourceRun --repo $repo --name $artifactName --dir $download
    if ($LASTEXITCODE -ne 0) { throw 'Could not download verified installed artifact' }
    # The pinned non-tag push uses format('2.8.6-test.{0}', github.run_number).
    $installer = Join-Path $download ('SBK-Tools-Fast-Setup-2.8.6-test.{0}-x64.exe' -f $sourceRunNumber)
    $checksum = ((Get-Content -LiteralPath "$installer.sha256" -Raw).Trim() -split '\s+', 2)
    if ($checksum.Count -ne 2 -or $checksum[0] -notmatch '^[a-fA-F0-9]{64}$' -or
        $checksum[1] -ne (Split-Path -Leaf $installer) -or
        (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $checksum[0]) { throw 'Installed artifact checksum mismatch' }

    $payloadDirectory = Join-Path $download 'payload'
    New-Item -ItemType Directory -Path $payloadDirectory | Out-Null
    # e extracts without paths; the recursive include selects this one basename.
    & $sevenZip e -y "-o$payloadDirectory" '-ir!payload.tar.zst' $installer | Out-Host
    if ($LASTEXITCODE -ne 0) { throw '7-Zip could not read the NSIS payload' }
    $payload = Join-Path $payloadDirectory 'payload.tar.zst'
    if (-not (Test-Path -LiteralPath $payload -PathType Leaf)) { throw 'Expected installer payload.tar.zst is missing' }
    $extracted = Join-Path $download 'verified-worker'
    python scripts/extract_verified_installed_worker.py --archive $payload --directory $extracted
    if ($LASTEXITCODE -ne 0) { throw 'Installed worker/manifest integrity check failed' }

    New-Item -ItemType Directory -Force src-tauri/binaries | Out-Null
    Copy-Item -LiteralPath (Join-Path $extracted 'sbk-scanner-worker.exe') "src-tauri/binaries/sbk-scanner-worker-$Target.exe"
    # Runtime resources are staged from this checkout, never from the artifact.
    New-Item -ItemType Directory -Force src-tauri/runtime-resources/resources | Out-Null
    Copy-Item -Path 'scanner-worker/resources/*' -Destination src-tauri/runtime-resources/resources -Recurse -Force
    $reused = $true
    Write-Host "Reused identical scanner worker from installed job $sourceJob ($sourceCommit); application/runtime will be built and tested fresh"
} catch {
    Write-Warning "Verified installed-worker reuse unavailable: $($_.Exception.Message). Compiling the scanner worker fresh."
} finally {
    if ($download -and (Test-Path -LiteralPath $download -PathType Container) -and
        (Split-Path -Leaf $download).StartsWith('sbk-worker-reuse-')) {
        Remove-Item -LiteralPath $download -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if (-not $reused) {
    python scripts/build_scanner_worker.py --target $Target
    if ($LASTEXITCODE -ne 0) { throw 'Fresh scanner build failed' }
}
