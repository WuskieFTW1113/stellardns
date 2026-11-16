# Publish the Windows client.
#
#   .\publish.ps1                       win-x64, self-contained, node.exe bundled
#   .\publish.ps1 -Runtime win-arm64    ARM64
#   .\publish.ps1 -FrameworkDependent   small output; the target needs the .NET 9 runtime
#   .\publish.ps1 -NodeExe C:\...\node.exe
#
# Self-contained by default: the .NET runtime ships inside the folder, so the MSI has no
# prerequisite to install first. node.exe is bundled as well - the core is Node, and the machine
# an installer targets is usually one that has never had Node on it.
param(
    [ValidateSet('win-x64', 'win-arm64')]
    [string]$Runtime = 'win-x64',
    [string]$NodeExe = '',
    [switch]$FrameworkDependent
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$proj = Join-Path $root 'StellarDNS.Client\StellarDNS.Client.csproj'
$out = Join-Path $root "dist\$Runtime"

if (Test-Path $out) { Remove-Item $out -Recurse -Force }

$selfContained = -not $FrameworkDependent
dotnet publish $proj -c Release -r $Runtime --self-contained $selfContained.ToString().ToLower() -o $out `
    -p:PublishSingleFile=false -p:DebugType=none
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

# node.exe is not optional: a build without it opens a window and cannot resolve anything on a
# machine that has never installed Node, which is precisely the machine an installer is for.
if (-not $NodeExe) {
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { $NodeExe = $onPath.Source }
}
if (-not $NodeExe -or -not (Test-Path $NodeExe)) {
    throw "node.exe was not found - pass -NodeExe C:\path\to\node.exe (it is bundled into core\)"
}
Copy-Item $NodeExe (Join-Path $out 'core\node.exe') -Force
Write-Host ("bundled node: {0} ({1:N1} MB)" -f (Split-Path -Leaf $NodeExe), ((Get-Item $NodeExe).Length / 1MB))

# Stage the runtime dependency tree explicitly. An MSBuild Include that named the
# @leichtgewicht folder matched nothing (and silently shipped an app that died on launch), so
# the copy is done here, where the path is just a path.
$nodeModules = (Resolve-Path (Join-Path $root '..\..\node_modules')).Path
foreach ($pkg in @('dns-packet', '@leichtgewicht\ip-codec')) {
    $src = Join-Path $nodeModules $pkg
    if (-not (Test-Path $src)) { throw "missing runtime dependency: $pkg (run npm install in the repo root)" }
    $dst = Join-Path (Join-Path $out 'core\node_modules') $pkg
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
}

# Fail the build rather than ship a core that cannot start. dns-packet needs ip-codec, and a
# package that is present in the repo but missing here kills the app on first launch.
$required = @(
    'core\node.exe',
    'core\src\cli.js',
    'core\src\gui.js',
    'core\public\index.html',
    'core\node_modules\dns-packet\index.js',
    'core\node_modules\@leichtgewicht\ip-codec\package.json'   # entry is index.cjs, not index.js
)
$missing = @($required | Where-Object { -not (Test-Path (Join-Path $out $_)) })
if ($missing.Count -gt 0) {
    throw ("published core is incomplete, missing: " + ($missing -join ', '))
}

# Prove the core is self-contained by running it from a copy outside the repository. Node walks
# up parent folders for node_modules, so a check run inside the repo would find the missing
# package anyway and pass - which is exactly how the broken MSI got shipped.
$probe = Join-Path ([System.IO.Path]::GetTempPath()) ("stellardns-core-" + [guid]::NewGuid().ToString('N'))
Copy-Item (Join-Path $out 'core') $probe -Recurse -Force
try {
    Push-Location $probe
    try {
        # encode/decode, not just require: dns-packet loads ip-codec inside these calls, so a
        # bare import can pass while the app still dies on its first query.
        # The bundled binary, not the one on PATH: the point is to prove the node.exe going into
        # the MSI can run this core, on a machine that will never have Node installed.
        $bundled = Join-Path $probe 'node.exe'
        $check = & $bundled -e "const p=require('./node_modules/dns-packet'); const b=p.encode({type:'query',id:1,flags:0,questions:[{type:'A',name:'example.com'}]}); p.decode(b); require('./src/proxy.js'); console.log('ok')" 2>&1
        if ($LASTEXITCODE -ne 0) { throw "published core is not self-contained: $check" }
        $ver = & $bundled 'src\cli.js' version 2>&1
        Write-Host "core check: loads outside the repo, cli.js reports v$ver"
    } finally { Pop-Location }
} finally {
    Remove-Item $probe -Recurse -Force -ErrorAction SilentlyContinue
}

if ($selfContained) {
    $mb = [math]::Round(((Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
    Write-Host "self-contained: $mb MB on disk (the MSI compresses it)"
}

Write-Host "published: $out"
Write-Host "contents :"
Get-ChildItem $out -Name | ForEach-Object { Write-Host "  $_" }
