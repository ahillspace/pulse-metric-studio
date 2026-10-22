# Pulse Metric Studio installer for Windows.
#
# One-line install, if this repository is public:
#   & ([scriptblock]::Create((irm https://github.com/sfdc-qbranch-emu/pulse-metric-studio/releases/latest/download/install.ps1)))
#
# If it is private, with the GitHub CLI signed in to an account that can read it:
#   & ([scriptblock]::Create((gh release download --repo sfdc-qbranch-emu/pulse-metric-studio --pattern install.ps1 -O - | Out-String)))
#
# Pass options after the script block, for example:
#   & ([scriptblock]::Create(...)) -Action Uninstall
#
# The installer records the repository it installed from, and Pulse Metric
# Studio checks that repository for updates and runs this script to apply them.

[CmdletBinding()]
param(
    [ValidateSet('Install', 'Uninstall', 'LatestVersion')]
    [string]$Action = 'Install',
    [string]$Version = $(if ($env:PULSE_METRIC_STUDIO_VERSION) { $env:PULSE_METRIC_STUDIO_VERSION } else { 'latest' }),
    [string]$Repo = $(if ($env:PULSE_METRIC_STUDIO_REPO) { $env:PULSE_METRIC_STUDIO_REPO } else { 'sfdc-qbranch-emu/pulse-metric-studio' }),
    [switch]$NoLaunch,
    # Used by Pulse Metric Studio when it updates itself.
    [switch]$Update
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 needs TLS 1.2 enabled for GitHub, and downloads
# slowly while it draws a progress bar.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

# The NSIS installer's default per-user location.
$InstallDir = Join-Path $env:LOCALAPPDATA 'Pulse Metric Studio'
$DataDir = Join-Path $env:APPDATA 'com.ahillspace.pulsemetricstudio'

function Start-PulseMetricStudio {
    $exe = Get-ChildItem -Path $InstallDir -Filter '*.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike 'uninstall*' } |
        Select-Object -First 1
    if ($exe) {
        Start-Process -FilePath $exe.FullName
        Write-Host 'Pulse Metric Studio is starting.'
    }
}

# Throw rather than exit: this script usually runs as a script block inside the
# user's own PowerShell session, and exit would close their window.
function Fail([string]$Message) {
    if ($Update) {
        # The app closed itself for this update: tell it why the update did
        # not happen, and bring it back.
        try {
            New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
            Set-Content -Path (Join-Path $DataDir 'update-error') -Value $Message -Encoding UTF8
        } catch {}
        Start-PulseMetricStudio
    }
    throw "Pulse Metric Studio installer error: $Message"
}

# A public repository serves its releases over plain HTTPS. Anything else
# (a private repository, or one without releases yet) needs the GitHub CLI.
function Get-PublicLatestTag {
    try {
        $response = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" -Method Head -UseBasicParsing -TimeoutSec 30
    } catch {
        return $null
    }
    # Windows PowerShell and PowerShell 7 report the redirected address differently.
    $uri = if ($response.BaseResponse.ResponseUri) { $response.BaseResponse.ResponseUri } else { $response.BaseResponse.RequestMessage.RequestUri }
    if ("$uri" -match '/releases/tag/(v[^/?#]+)$') { return $Matches[1] }
    return $null
}

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
        Remove-Item -Force (Join-Path $DataDir 'update-channel') -ErrorAction SilentlyContinue
        Write-Host 'Pulse Metric Studio was uninstalled. Your data is kept in %APPDATA%\com.ahillspace.pulsemetricstudio, and saved Tableau tokens stay in Credential Manager.'
    } else {
        Write-Host "Pulse Metric Studio is not installed at $InstallDir."
    }
    return
}

$latest = Get-PublicLatestTag
$access = if ($latest) { 'https' } else { 'gh' }
if ($access -eq 'gh') {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Fail "$Repo has no public release, and the GitHub CLI (gh) that private repositories need is not installed. Install it with: winget install --id GitHub.cli"
    }
    gh auth status --hostname github.com *> $null
    if ($LASTEXITCODE -ne 0) { Fail 'The GitHub CLI is not signed in. Run: gh auth login' }
}

if ($Version -eq 'latest') {
    if (-not $latest) {
        $latest = gh release view --repo $Repo --json tagName --jq .tagName 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $latest) {
            Fail "Could not find the latest release of $Repo. Check that your GitHub account can open https://github.com/$Repo."
        }
    }
    $tag = $latest
} else {
    $tag = 'v' + $Version.TrimStart('v')
}

if ($Action -eq 'LatestVersion') {
    Write-Output $tag.TrimStart('v')
    return
}

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pulse-metric-studio-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $workDir | Out-Null
try {
    $setupName = "Pulse-Metric-Studio_$($tag.TrimStart('v'))_x64-setup.exe"
    Write-Host "Downloading Pulse Metric Studio $tag..."
    if ($access -eq 'https') {
        foreach ($asset in @($setupName, 'checksums.txt')) {
            try {
                Invoke-WebRequest -Uri "https://github.com/$Repo/releases/download/$tag/$asset" -OutFile (Join-Path $workDir $asset) -UseBasicParsing
            } catch {
                Fail "Could not download $asset for Pulse Metric Studio $tag from $Repo."
            }
        }
    } else {
        gh release download $tag --repo $Repo --dir $workDir --pattern $setupName --pattern 'checksums.txt' *> $null
        if ($LASTEXITCODE -ne 0) { Fail "Could not download Pulse Metric Studio $tag from $Repo." }
    }

    $setupPath = Join-Path $workDir $setupName
    if (-not (Test-Path $setupPath)) { Fail "Release $tag has no Windows installer." }
    $setup = Get-Item $setupPath
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

    # Pulse Metric Studio checks this repository for updates.
    try {
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        Remove-Item -Force (Join-Path $DataDir 'update-error') -ErrorAction SilentlyContinue
        Set-Content -Path (Join-Path $DataDir 'update-channel') -Value $Repo -Encoding ASCII
    } catch {
        Write-Host "Could not record $Repo for in-app updates. Run this installer again to update."
    }

    if ($Update -or -not $NoLaunch) { Start-PulseMetricStudio }
} finally {
    Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
}
