# Pulse Metric Studio installer for Windows.
#
# One-line install:
#   irm https://github.com/sfdc-qbranch-emu/pulse-metric-studio/releases/latest/download/install.ps1 | iex
#
# Options come from environment variables when piped into iex, for example:
#   $env:PULSE_METRIC_STUDIO_ACTION = 'Uninstall'; irm https://github.com/sfdc-qbranch-emu/pulse-metric-studio/releases/latest/download/install.ps1 | iex

[CmdletBinding()]
param(
    [ValidateSet('Install', 'Uninstall')]
    [string]$Action = $(if ($env:PULSE_METRIC_STUDIO_ACTION) { $env:PULSE_METRIC_STUDIO_ACTION } else { 'Install' }),
    [string]$Version = $(if ($env:PULSE_METRIC_STUDIO_VERSION) { $env:PULSE_METRIC_STUDIO_VERSION } else { 'latest' }),
    [string]$Repo = $(if ($env:PULSE_METRIC_STUDIO_REPO) { $env:PULSE_METRIC_STUDIO_REPO } else { 'sfdc-qbranch-emu/pulse-metric-studio' }),
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

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

$releaseUrl = if ($Version -eq 'latest') { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/v$($Version.TrimStart('v'))" }

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pulse-metric-studio-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $workDir | Out-Null
try {
    $manifest = Join-Path $workDir 'checksums.txt'
    try { Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/checksums.txt" -OutFile $manifest }
    catch { Fail "Could not read the release from https://github.com/$Repo/releases (version $Version)." }
    # The manifest names every installer, so it also tells us which file to fetch.
    $names = @(foreach ($line in Get-Content $manifest) {
        $parts = $line -split '\s+', 2
        if ($parts.Count -eq 2) { $name = $parts[1].TrimStart('*'); if ($name -like 'Pulse-Metric-Studio_*_x64-setup.exe') { $name } }
    })
    if ($names.Count -ne 1) { Fail 'The release must list exactly one Windows installer.' }
    $tag = 'v' + ($names[0] -replace '^Pulse-Metric-Studio_(.*)_x64-setup\.exe$', '$1')
    Write-Host "Downloading Pulse Metric Studio $tag..."
    $setupPath = Join-Path $workDir $names[0]
    try { Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$($names[0])" -OutFile $setupPath }
    catch { Fail "Could not download $($names[0])." }
    $setup = Get-Item $setupPath

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
