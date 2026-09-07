param([string]$Target = 'x86_64-pc-windows-msvc')
$ErrorActionPreference = 'Stop'
# Reuse only the unchanged worker from this repository's verified portable job.
# Later scanner source changes automatically fall back to a fresh compilation.
$sourceRun = '34124493213'
$sourceJob = '101750452867'
$sourceCommit = '35e8d76b5aeedf71a53354c8dbf7720364d4b591'
$repo = 'SviatoslavEl/sbk-tools-desktop'
git fetch --no-tags origin $sourceCommit
if ($LASTEXITCODE -ne 0) { throw 'Could not verify worker source commit' }
git diff --exit-code $sourceCommit HEAD -- scanner-worker scripts/build_scanner_worker.py
if ($LASTEXITCODE -ne 0) {
    python scripts/build_scanner_worker.py --target $Target
    if ($LASTEXITCODE -ne 0) { throw 'Fresh scanner build failed' }
    exit 0
}
$job = gh api "repos/$repo/actions/jobs/$sourceJob" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $job.conclusion -ne 'success' -or "$($job.run_id)" -ne $sourceRun) {
    throw 'Source portable job was not verified successfully'
}
$run = gh api "repos/$repo/actions/runs/$sourceRun" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $run.head_sha -ne $sourceCommit) { throw 'Unexpected source commit' }
$download = Join-Path $env:RUNNER_TEMP ('sbk-verified-worker-' + [guid]::NewGuid())
New-Item -ItemType Directory $download | Out-Null
gh run download $sourceRun --repo $repo --name SBK-Tools-Windows-x64-Portable --dir $download
if ($LASTEXITCODE -ne 0) { throw 'Could not download verified portable artifact' }
$portable = Join-Path $download 'ScanDocument.exe'
$expected = ((Get-Content "$portable.sha256" -Raw).Trim() -split '\s+')[0]
if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash $portable -Algorithm SHA256).Hash -ne $expected) {
    throw 'Verified portable artifact checksum mismatch'
}
$token = [guid]::NewGuid().ToString()
$marker = Join-Path $env:TEMP "SBKTools-ready-$token.marker"
$env:SBK_TOOLS_WORKSPACE = Join-Path $download 'qa-workspace'
$env:SBK_ONEFILE_GUI_READY_TOKEN = $token
$launcher = $null
$runtime = @()
try {
    $launcher = Start-Process $portable -PassThru
    $deadline = (Get-Date).AddSeconds(240)
    while (-not (Test-Path $marker)) {
        $launcher.Refresh()
        if ($launcher.HasExited -or (Get-Date) -gt $deadline) { throw 'Verified portable did not finish extraction and open its window' }
        Start-Sleep -Milliseconds 500
    }
    $runtime = @(Get-ChildItem $env:TEMP -Directory -Filter "SBKTools-runtime-$($launcher.Id)-*")
    if ($runtime.Count -ne 1) { throw 'Expected one isolated runtime directory' }
    $worker = Join-Path $runtime[0].FullName 'sbk-scanner-worker.exe'
    python scripts/verify_runtime_manifest.py --root (Join-Path $runtime[0].FullName 'scanner-runtime') --worker $worker
    if ($LASTEXITCODE -ne 0) { throw 'Extracted worker integrity check failed' }
    New-Item -ItemType Directory -Force src-tauri/binaries | Out-Null
    Copy-Item $worker "src-tauri/binaries/sbk-scanner-worker-$Target.exe"
    Write-Host "Reused unchanged scanner worker from verified job $sourceJob ($sourceCommit)"
} finally {
    Remove-Item Env:SBK_ONEFILE_GUI_READY_TOKEN, Env:SBK_TOOLS_WORKSPACE -ErrorAction SilentlyContinue
    if ($launcher -and -not $launcher.HasExited) { Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue }
    if ($runtime.Count -eq 1 -and $runtime[0].Name.StartsWith("SBKTools-runtime-$($launcher.Id)-")) {
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            try { Remove-Item -LiteralPath $runtime[0].FullName -Recurse -Force -ErrorAction Stop; break }
            catch { Start-Sleep -Seconds 1 }
        }
    }
    Remove-Item -LiteralPath $download -Recurse -Force -ErrorAction SilentlyContinue
}
