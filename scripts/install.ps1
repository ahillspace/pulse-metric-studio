# Pulse Metric Studio installer for Windows.
#
# One-line install (the repository is private, so this needs the GitHub CLI
# signed in with an account that can read it):
#   & ([scriptblock]::Create((gh release download --repo sfdc-qbranch-emu/pulse-metric-studio --pattern install.ps1 -O - | Out-String)))
#
# Pass options after the script block, for example:
#   & ([scriptblock]::Create((gh release download --repo sfdc-qbranch-emu/pulse-metric-studio --pattern install.ps1 -O - | Out-String))) -Action Uninstall

[CmdletBinding()]
param(
    [ValidateSet('Install', 'Uninstall')]
    [string]$Action = 'Install',
    [string]$Version = $(if ($env:PULSE_METRIC_STUDIO_VERSION) { $env:PULSE_METRIC_STUDIO_VERSION } else { 'latest' }),
    [string]$Repo = $(if ($env:PULSE_METRIC_STUDIO_REPO) { $env:PULSE_METRIC_STUDIO_REPO } else { 'sfdc-qbranch-emu/pulse-metric-studio' }),
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

# Throw rather than exit: this script usually runs as a script block inside the
# user's own PowerShell session, and exit would close their window.
function Fail([string]$Message) {
    throw "Pulse Metric Studio installer error: $Message"
}

# The NSIS installer's default per-user location.
$InstallDir = Join-Path $env:LOCALAPPDATA 'Pulse Metric Studio'

function Stop-PulseMetricStudio {
    $running = Get-Process -Name 'pulse-metric-studio' -ErrorAction SilentlyContinue
    if (-not $running) { return }
    Write-Host 'Quitting the running Pulse Metric Studio...'
    $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    Get-Process -Name 'pulse-metric-studio' -ErrorAction SilentlyContinue | Stop-Process -Force
}

if ($Action -eq 'Uninstall') {
    Stop-PulseMetricStudio
    $uninstaller = Join-Path $InstallDir 'uninstall.exe'
    if (Test-Path $uninstaller) {
        Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait
        Write-Host 'Pulse Metric Studio was uninstalled. Your data is kept in %APPDATA%\com.ahillspace.pulsemetricstudio, and saved Tableau tokens stay in Credential Manager.'
    } else {
        Write-Host "Pulse Metric Studio is not installed at $InstallDir."
    }
    return
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Fail 'The GitHub CLI (gh) is required. Install it with: winget install --id GitHub.cli'
}
gh auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) { Fail 'The GitHub CLI is not signed in. Run: gh auth login' }

if ($Version -eq 'latest') {
    $tag = gh release view --repo $Repo --json tagName --jq .tagName 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $tag) {
        Fail "Could not find the latest release of $Repo. Check that your GitHub account can open https://github.com/$Repo."
    }
} else {
    $tag = 'v' + $Version.TrimStart('v')
}

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pulse-metric-studio-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $workDir | Out-Null
try {
    Write-Host "Downloading Pulse Metric Studio $tag..."
    gh release download $tag --repo $Repo --dir $workDir --pattern 'Pulse-Metric-Studio_*_x64-setup.exe' --pattern 'checksums.txt' *> $null
    if ($LASTEXITCODE -ne 0) { Fail "Could not download Pulse Metric Studio $tag from $Repo." }

    $setup = @(Get-ChildItem -Path $workDir -Filter 'Pulse-Metric-Studio_*_x64-setup.exe')
    if ($setup.Count -ne 1) { Fail "Release $tag must contain exactly one Windows installer." }
    $setup = $setup[0]
    $manifest = Join-Path $workDir 'checksums.txt'
    if (-not (Test-Path $manifest)) { Fail "Release $tag has no checksums.txt, so the download cannot be verified." }

    $found = @(foreach ($line in Get-Content $manifest) {
        $parts = $line -split '\s+', 2
        if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $setup.Name) { $parts[0] }
    })
    if ($found.Count -eq 0) { Fail "checksums.txt has no entry for $($setup.Name)." }
    if ($found.Count -gt 1) { Fail "checksums.txt has more than one entry for $($setup.Name)." }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $setup.FullName).Hash
    if ($actual -ne $found[0]) { Fail "Checksum mismatch for $($setup.Name). Nothing was installed." }
    Write-Host 'Checksum verified.'

    Stop-PulseMetricStudio
    $process = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) { Fail "The installer exited with code $($process.ExitCode)." }
    Write-Host "Installed Pulse Metric Studio $tag to $InstallDir."

    if (-not $NoLaunch) {
        $exe = Get-ChildItem -Path $InstallDir -Filter '*.exe' |
            Where-Object { $_.Name -notlike 'uninstall*' } |
            Select-Object -First 1
        if ($exe) {
            Start-Process -FilePath $exe.FullName
            Write-Host 'Pulse Metric Studio is starting.'
        }
    }
} finally {
    Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
}
