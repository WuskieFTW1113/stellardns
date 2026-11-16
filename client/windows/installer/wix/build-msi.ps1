# Build StellarDNS-<version>-<arch>.msi from a published client folder.
#
#   .\build-msi.ps1                     publishes win-x64 if needed, then builds the MSI
#   .\build-msi.ps1 -Runtime win-arm64
#   .\build-msi.ps1 -Source C:\build\win-x64 -Out C:\build\StellarDNS.msi
#
# WiX is pinned to v5 deliberately. v6 and later require accepting the Open Source
# Maintenance Fee EULA before the tool will run; v5 is the last release that builds without
# it, and the schema used here is identical. Nothing is added to the machine's global tools:
# WiX lives in this folder's .config/dotnet-tools.json.
param(
    [ValidateSet('win-x64', 'win-arm64')]
    [string]$Runtime = 'win-x64',
    [string]$Source = '',
    [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$windows = (Resolve-Path (Join-Path $here '..\..')).Path
$arch = if ($Runtime -eq 'win-arm64') { 'arm64' } else { 'x64' }

if (-not $Source) {
    $Source = Join-Path $windows "dist\$Runtime"
    if (-not (Test-Path (Join-Path $Source 'StellarDNS.Client.exe'))) {
        Write-Host "publishing $Runtime first"
        & (Join-Path $windows 'publish.ps1') -Runtime $Runtime
    }
}
$Source = (Resolve-Path $Source).Path
if (-not (Test-Path (Join-Path $Source 'StellarDNS.Client.exe'))) {
    throw "No published client at $Source - run publish.ps1 first."
}

if (-not $Out) {
    $Out = Join-Path $windows "dist\StellarDNS-26.0.0-$arch.msi"
}

$manifest = Join-Path $here '.config\dotnet-tools.json'
$needWix = $true
if (Test-Path $manifest) {
    try {
        $cfg = Get-Content $manifest -Raw | ConvertFrom-Json
        if ($cfg.tools.wix.version -match '^5\.') { $needWix = $false }
    } catch {}
}

Push-Location $here
try {
    if ($needWix) {
        if (-not (Test-Path $manifest)) { dotnet new tool-manifest | Out-Null }
        dotnet tool uninstall wix 2>$null | Out-Null
        dotnet tool install wix --version 5.* | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "could not install the WiX v5 CLI (dotnet tool install wix --version 5.*)" }
    }

    # WixToolset.UI.wixext supplies the wizard dialogs (WixUI_Minimal). It is a separate NuGet
    # package and must match the CLI major version exactly: an unpinned add pulls v7, which the
    # v5 tool refuses to load. Pin it to the CLI version and register it per-user.
    $wixVersion = '5.0.2'
    if (Test-Path $manifest) {
        try { $wixVersion = (Get-Content $manifest -Raw | ConvertFrom-Json).tools.wix.version } catch {}
    }
    dotnet tool run wix extension add -g "WixToolset.UI.wixext/$wixVersion" 2>$null | Out-Null

    dotnet tool run wix build `
        -arch $arch `
        -ext "WixToolset.UI.wixext/$wixVersion" `
        -loc "Strings.wxl" `
        -d "SourceDir=$Source" `
        -o "$Out" `
        StellarDNS.wxs
    if ($LASTEXITCODE -ne 0) { throw "wix build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

if (-not (Test-Path $Out)) { throw "wix reported success but produced no MSI at $Out" }
$item = Get-Item $Out
Write-Host ("built: {0} ({1:N0} bytes)" -f $item.FullName, $item.Length)
