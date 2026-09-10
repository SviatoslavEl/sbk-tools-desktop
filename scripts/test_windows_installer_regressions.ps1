# Runs the production NSIS template and extractor against tiny synthetic files.
# CI only: the real installer writes its current-user shortcuts/registry keys.
# No application, scanner, office runtime or real user database is used.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Run this harness only on an isolated Windows GitHub Actions runner.'
}
if (-not $env:RUNNER_TEMP -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
    throw 'A valid runner-owned temporary directory is required.'
}

$Repo = Split-Path -Parent $PSScriptRoot
$Sandbox = Join-Path $env:RUNNER_TEMP ('sbk-installer-regression-' + [guid]::NewGuid())
$Results = Join-Path $env:RUNNER_TEMP 'sbk-installer-regression-results'
$Stage = Join-Path $Sandbox 'compiler'
$InstallerTemp = Join-Path $Sandbox 'installer-temp'
$Diagnostic = Join-Path $InstallerTemp 'SBK-Tools-Fast-Install-Error.log'
$CaseResults = [Collections.Generic.List[object]]::new()
$InvocationNumber = 0
$FatalTimeout = $false
$OriginalTemp = $env:TEMP
$OriginalTmp = $env:TMP
New-Item -ItemType Directory -Path $Sandbox, $Stage, $InstallerTemp -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Force -Path $Results | Out-Null
Start-Transcript -LiteralPath (Join-Path $Results 'transcript.log') | Out-Null

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-SandboxPath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Sandbox).TrimEnd('\') + '\'
    Assert-True ($absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) "Path is outside the synthetic sandbox: $Path"
}

function Get-TreeSnapshot([string]$Directory) {
    Assert-SandboxPath $Directory
    $snapshot = [ordered]@{}
    foreach ($entry in @(Get-ChildItem -LiteralPath $Directory -Recurse -Force | Sort-Object FullName)) {
        $relative = [IO.Path]::GetRelativePath($Directory, $entry.FullName)
        $snapshot[$relative] = if ($entry.PSIsContainer) { 'directory' } else { (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash }
    }
    return ($snapshot | ConvertTo-Json -Compress -Depth 4)
}

function Assert-NoTransactionDebris([string]$Directory) {
    $parent = Split-Path -Parent $Directory
    $debris = @(Get-ChildItem -LiteralPath $parent -Force | Where-Object {
        $_.Name.StartsWith('.sbk-tools-fast-installing-') -or $_.Name.StartsWith('.sbk-tools-fast-previous-')
    })
    $names = @($debris | ForEach-Object { $_.FullName }) -join ', '
    Assert-True ($debris.Count -eq 0) "Installer left staging/backup entries: $names"
}

function Invoke-FixtureInstaller(
    [string]$Name,
    [string]$Executable,
    [string]$Destination,
    [bool]$ExpectSuccess = $true,
    [string]$WorkingDirectory = $Stage,
    [switch]$Uninstall
) {
    Assert-SandboxPath $Executable
    Assert-SandboxPath $Destination
    Assert-SandboxPath $WorkingDirectory
    $script:InvocationNumber++
    $logName = '{0:d2}-{1}.log' -f $script:InvocationNumber, $Name
    if (Test-Path -LiteralPath $Diagnostic) { Remove-Item -LiteralPath $Diagnostic }
    # NSIS /D= and _?= must be last and unquoted. The uninstaller is copied
    # OUTSIDE the destination before _?= disables its normal detached relaunch.
    # Waiting the original /S-only uninstaller could otherwise report an early
    # success while its temporary child is still deleting the installation.
    $arguments = if ($Uninstall) { '/S _?=' + $Destination } else { '/S /D=' + $Destination }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process -FilePath $Executable -ArgumentList $arguments -WorkingDirectory $WorkingDirectory -PassThru
    if (-not $process.WaitForExit(60000)) {
        # Only our exact child and its descendants, never processes selected by
        # name/path glob. Do not continue other cases after an incomplete install.
        $script:FatalTimeout = $true
        $process.Kill($true)
        [void]$process.WaitForExit(10000)
        throw "$Name timed out; stopped only test child PID $($process.Id)"
    }
    $process.Refresh()
    $watch.Stop()
    $message = if (Test-Path -LiteralPath $Diagnostic) { Get-Content -LiteralPath $Diagnostic -Raw } else { '' }
    [IO.File]::WriteAllText((Join-Path $Results $logName), "Exit: $($process.ExitCode)`nSeconds: $($watch.Elapsed.TotalSeconds)`n$message")
    Write-Host "$Name exit=$($process.ExitCode) elapsed=$([math]::Round($watch.Elapsed.TotalSeconds, 2))s"
    if ($message) { Write-Host $message.Trim() }
    if ($ExpectSuccess) {
        Assert-True ($process.ExitCode -eq 0) "$Name failed with exit $($process.ExitCode): $message"
    } else {
        Assert-True ($process.ExitCode -ne 0) "$Name unexpectedly succeeded while an owned program file was locked"
        Assert-True (-not [string]::IsNullOrWhiteSpace($message)) "$Name failed without an installer diagnostic"
    }
}

function New-InstalledFixture([string]$Name) {
    $parent = Join-Path $Sandbox $Name
    New-Item -ItemType Directory -Path $parent | Out-Null
    $destination = Join-Path $parent 'СБК Tools installed'
    Invoke-FixtureInstaller "$Name-initial" $Installer $destination
    Assert-True (Test-Path -LiteralPath (Join-Path $destination '.sbk-tools-fast-installation')) 'Installation marker is missing'
    New-Item -ItemType Directory -Path (Join-Path $destination 'ProductData') | Out-Null
    [IO.File]::WriteAllText((Join-Path $destination 'ProductData\preserve.txt'), "synthetic database sentinel: $Name")
    [IO.File]::WriteAllText((Join-Path $destination 'user-owned.txt'), "unknown user file: $Name")
    New-Item -ItemType Directory -Path (Join-Path $destination 'user-documents') | Out-Null
    [IO.File]::WriteAllText((Join-Path $destination 'user-documents\preserve.txt'), "unknown user folder: $Name")
    return $destination
}

function Get-UserDataSnapshot([string]$Destination) {
    return @(
        (Get-TreeSnapshot (Join-Path $Destination 'ProductData')),
        (Get-FileHash -LiteralPath (Join-Path $Destination 'user-owned.txt') -Algorithm SHA256).Hash,
        (Get-TreeSnapshot (Join-Path $Destination 'user-documents'))
    ) -join '|'
}

function Mark-OldProgram([string]$Destination) {
    [IO.File]::WriteAllText((Join-Path $Destination 'SBK-Tools-Fast.exe'), 'older synthetic application')
}

function Assert-Upgraded([string]$Destination, [string]$Preserved) {
    $content = [IO.File]::ReadAllText((Join-Path $Destination 'SBK-Tools-Fast.exe'))
    Assert-True ($content -eq "SBK installer test fixture`n") 'Update did not install the new synthetic application'
    Assert-True ((Get-UserDataSnapshot $Destination) -eq $Preserved) 'Update changed ProductData or unknown user files'
    Assert-NoTransactionDebris $Destination
}

function Test-Case([string]$Name, [scriptblock]$Body) {
    Write-Host "START $Name"
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        & $Body
        $script:CaseResults.Add([ordered]@{ name = $Name; result = 'passed'; seconds = $watch.Elapsed.TotalSeconds })
        Write-Host "PASS $Name"
    } catch {
        $script:CaseResults.Add([ordered]@{ name = $Name; result = 'failed'; seconds = $watch.Elapsed.TotalSeconds; error = $_.ToString() })
        Write-Warning "FAIL $Name : $_"
        if ($script:FatalTimeout) { throw }
    } finally {
        ConvertTo-Json -InputObject $script:CaseResults.ToArray() -Depth 5 | Set-Content -LiteralPath (Join-Path $Results 'results.json') -Encoding utf8
    }
}

try {
    $env:TEMP = $InstallerTemp
    $env:TMP = $InstallerTemp
    $Extractor = Join-Path $Repo 'windows-installer-helper\target\release\sbk-tools-installed-extractor.exe'
    Assert-True (Test-Path -LiteralPath $Extractor -PathType Leaf) 'Build the real installed extractor first'
    Copy-Item -LiteralPath (Join-Path $Repo 'scripts\windows-installed.nsi') -Destination $Stage
    Copy-Item -LiteralPath (Join-Path $Repo 'src-tauri\icons\icon.ico') -Destination $Stage
    Copy-Item -LiteralPath $Extractor -Destination (Join-Path $Stage 'sbk-installed-extractor.exe')
    $license = Get-Content -LiteralPath (Join-Path $Repo 'LICENSE') -Raw -Encoding UTF8
    [IO.File]::WriteAllText((Join-Path $Stage 'LICENSE.txt'), $license, [Text.Encoding]::Unicode)
    python (Join-Path $Repo 'scripts\create_installer_smoke_payload.py') (Join-Path $Stage 'payload.tar.zst')
    Assert-True ($LASTEXITCODE -eq 0) 'Tiny fixture creation failed'

    $nsisArchive = Join-Path $Stage 'nsis-3.11.zip'
    $nsisUrl = 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip'
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Invoke-WebRequest -Uri $nsisUrl -OutFile $nsisArchive -TimeoutSec 60
            $hash = (Get-FileHash -LiteralPath $nsisArchive -Algorithm SHA1).Hash
            Assert-True ($hash -eq 'EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D') 'Pinned NSIS checksum mismatch'
            break
        } catch {
            if ($attempt -eq 3) { throw }
            Write-Warning "NSIS download attempt $attempt failed; retrying the same pinned archive: $_"
            Start-Sleep -Seconds 2
        }
    }
    Expand-Archive -LiteralPath $nsisArchive -DestinationPath (Join-Path $Stage 'tools')
    $nsisRoot = Join-Path $Stage 'tools\nsis-3.11'
    Copy-Item -LiteralPath (Join-Path $nsisRoot 'COPYING') -Destination (Join-Path $Stage 'NSIS-COPYING')
    $package = Get-Content -LiteralPath (Join-Path $Repo 'package.json') -Raw | ConvertFrom-Json
    $version = $package.version
    Assert-True ($version -match '^\d+\.\d+\.\d+$') 'Fixture requires the normal three-component project version'
    Push-Location $Stage
    try {
        & (Join-Path $nsisRoot 'makensis.exe') /INPUTCHARSET UTF8 "/DPRODUCT_VERSION=$version" "/DVERSION_QUAD=$version.0" 'windows-installed.nsi'
        Assert-True ($LASTEXITCODE -eq 0) 'Production NSIS fixture compilation failed'
    } finally { Pop-Location }
    $Installer = Join-Path $Stage 'SBK-Tools-Fast-Setup.exe'
    Assert-True (Test-Path -LiteralPath $Installer -PathType Leaf) 'NSIS fixture installer is missing'

    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class InstallerRegressionLocks {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    public static SafeFileHandle HoldWithoutDeleteSharing(string path, bool directory) {
        // READ_ATTRIBUTES, SHARE_READ|SHARE_WRITE, OPEN_EXISTING. Deliberately no SHARE_DELETE.
        var handle = CreateFileW(path, 0x80, 3, IntPtr.Zero, 3,
            directory ? 0x02000000u : 0x80u, IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }
    public static void AssertDeleteAccessBlocked(string path, bool directory) {
        // Probe DELETE access without renaming/deleting anything. This verifies
        // that the fixture really holds a Windows sharing violation, not merely
        // a handle which would permit the operation being tested.
        using (var probe = CreateFileW(path, 0x10000, 7, IntPtr.Zero, 3,
            directory ? 0x02000000u : 0x80u, IntPtr.Zero)) {
            int error = Marshal.GetLastWin32Error();
            if (!probe.IsInvalid) throw new InvalidOperationException("Fixture did not deny DELETE access");
            if (error != 32) throw new Win32Exception(error, "Expected sharing violation from fixture handle");
        }
    }
}
'@

    Test-Case 'clean-install-and-update' {
        $destination = New-InstalledFixture 'normal'
        $preserved = Get-UserDataSnapshot $destination
        Mark-OldProgram $destination
        Invoke-FixtureInstaller 'normal-update' $Installer $destination
        Assert-Upgraded $destination $preserved
    }

    Test-Case 'locked-root-is-not-renamed' {
        $destination = New-InstalledFixture 'root-lock'
        $preserved = Get-UserDataSnapshot $destination
        Mark-OldProgram $destination
        $handle = [InstallerRegressionLocks]::HoldWithoutDeleteSharing($destination, $true)
        try {
            [InstallerRegressionLocks]::AssertDeleteAccessBlocked($destination, $true)
            Invoke-FixtureInstaller 'root-handle-update' $Installer $destination
            Assert-True (-not $handle.IsClosed -and -not $handle.IsInvalid) 'Installer closed the unrelated root handle'
            Assert-Upgraded $destination $preserved
        } finally { $handle.Dispose() }
    }

    Test-Case 'locked-owned-child-fails-without-changing-files' {
        $destination = New-InstalledFixture 'child-lock'
        $preserved = Get-UserDataSnapshot $destination
        Mark-OldProgram $destination
        $before = Get-TreeSnapshot $destination
        $lockedPath = Join-Path $destination 'scanner-runtime\resources\ocr\windows\bin\tesseract.exe'
        $handle = [InstallerRegressionLocks]::HoldWithoutDeleteSharing($lockedPath, $false)
        try {
            [InstallerRegressionLocks]::AssertDeleteAccessBlocked($lockedPath, $false)
            Write-Host "Controlled external lock: PID $PID, path $lockedPath"
            Invoke-FixtureInstaller 'owned-child-blocked-update' $Installer $destination $false
            $blockedMessage = Get-Content -LiteralPath $Diagnostic -Raw
            Assert-True ($blockedMessage -match '\b32\b' -and $blockedMessage.Contains('tesseract.exe')) 'Blocked update did not identify its locked file and Windows sharing violation'
            Assert-True (-not $handle.IsClosed -and -not $handle.IsInvalid) 'Installer closed the unrelated child handle'
            Assert-True ((Get-TreeSnapshot $destination) -eq $before) 'Failed update changed the previous installation or user data'
            Assert-NoTransactionDebris $destination
        } finally { $handle.Dispose() }
        Invoke-FixtureInstaller 'owned-child-released-update' $Installer $destination
        Assert-Upgraded $destination $preserved
    }

    Test-Case 'locked-unknown-user-file-is-not-touched' {
        $destination = New-InstalledFixture 'user-file-lock'
        $preserved = Get-UserDataSnapshot $destination
        Mark-OldProgram $destination
        $handle = [InstallerRegressionLocks]::HoldWithoutDeleteSharing((Join-Path $destination 'user-owned.txt'), $false)
        try {
            [InstallerRegressionLocks]::AssertDeleteAccessBlocked((Join-Path $destination 'user-owned.txt'), $false)
            Invoke-FixtureInstaller 'unknown-file-handle-update' $Installer $destination
            Assert-True (-not $handle.IsClosed -and -not $handle.IsInvalid) 'Installer closed an unrelated user-file handle'
            Assert-Upgraded $destination $preserved
        } finally { $handle.Dispose() }
    }

    Test-Case 'installer-launched-from-inside-target' {
        $destination = New-InstalledFixture 'inside-target'
        $insideInstaller = Join-Path $destination 'setup.exe'
        Copy-Item -LiteralPath $Installer -Destination $insideInstaller
        $setupHash = (Get-FileHash -LiteralPath $insideInstaller -Algorithm SHA256).Hash
        $preserved = Get-UserDataSnapshot $destination
        Mark-OldProgram $destination
        Invoke-FixtureInstaller 'inside-target-update' $insideInstaller $destination $true $destination
        Assert-Upgraded $destination $preserved
        Assert-True ((Get-FileHash -LiteralPath $insideInstaller -Algorithm SHA256).Hash -eq $setupHash) 'Update changed the user-supplied installer inside the destination'
    }

    Test-Case 'installer-current-directory-is-target' {
        $destination = New-InstalledFixture 'self-cwd'
        $preserved = Get-UserDataSnapshot $destination
        Mark-OldProgram $destination
        Invoke-FixtureInstaller 'self-cwd-update' $Installer $destination $true $destination
        Assert-Upgraded $destination $preserved
    }

    Test-Case 'uninstall-and-reinstall-preserve-product-data' {
        $destination = New-InstalledFixture 'uninstall'
        $before = Get-TreeSnapshot (Join-Path $destination 'ProductData')
        $externalUninstaller = Join-Path (Split-Path -Parent $destination) 'external-uninstall.exe'
        Copy-Item -LiteralPath (Join-Path $destination 'uninstall.exe') -Destination $externalUninstaller
        Invoke-FixtureInstaller 'uninstall' $externalUninstaller $destination -Uninstall
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $destination 'SBK-Tools-Fast.exe'))) 'Uninstaller did not remove the synthetic application'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $destination '.sbk-tools-fast-installation'))) 'Uninstaller did not remove the installation marker'
        Assert-True ((Get-TreeSnapshot (Join-Path $destination 'ProductData')) -eq $before) 'Uninstall changed ProductData'
        Invoke-FixtureInstaller 'reinstall-after-uninstall' $Installer $destination
        Assert-True ((Get-TreeSnapshot (Join-Path $destination 'ProductData')) -eq $before) 'Reinstall changed ProductData'
        Assert-NoTransactionDebris $destination
    }

    $failures = @($CaseResults | Where-Object { $_.result -ne 'passed' })
    Assert-True ($failures.Count -eq 0) "$($failures.Count) installer regression case(s) failed; inspect results.json and per-invocation logs"
    Write-Host "All $($CaseResults.Count) real NSIS installer regression cases passed. Synthetic sandbox: $Sandbox"
} finally {
    $env:TEMP = $OriginalTemp
    $env:TMP = $OriginalTmp
    Stop-Transcript | Out-Null
}
