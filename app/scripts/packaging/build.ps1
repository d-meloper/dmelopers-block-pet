[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PackageArguments
)

$ErrorActionPreference = 'Stop'
# This entry point only builds packages. It never installs, launches or publishes.
$originalEnvironment = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
    $originalEnvironment[[string]$entry.Key] = [string]$entry.Value
}
$originalLocation = Get-Location
$pythonCommand = (Get-Command python.exe -ErrorAction Stop).Source
$locationNames = @('APPDATA', 'CARGO_HOME', 'COREPACK_HOME', 'HOME', 'HOMEDRIVE',
    'HOMEPATH', 'LOCALAPPDATA', 'NPM_CONFIG_CACHE', 'PNPM_HOME', 'PSModulePath',
    'RUSTUP_HOME', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE')
$exitCode = 1
try {
    Set-Location -LiteralPath (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'Visual Studio x64 C++ tools are required' }
    $developerCommand = Join-Path $installation 'Common7/Tools/VsDevCmd.bat'
    $command = '"{0}" -no_logo -arch=x64 -host_arch=x64 >nul && set' -f $developerCommand
    $lines = & $env:ComSpec /d /s /c $command
    if ($LASTEXITCODE -ne 0) { throw 'Visual Studio x64 environment setup failed' }
    $developerEnvironment = @{}
    foreach ($line in $lines) {
        if ($line -match '^([^=][^=]*)=(.*)$') {
            $developerEnvironment[$Matches[1]] = $Matches[2]
        }
    }
    foreach ($entry in $developerEnvironment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    # VsDevCmd's text round trip can corrupt Unicode profile paths. Retain the
    # caller's exact location values and any other non-ASCII environment values.
    foreach ($entry in $originalEnvironment.GetEnumerator()) {
        if ($entry.Key -in $locationNames -or $entry.Value -match '[^\x00-\x7F]') {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
    }
    $cleanToolPaths = @($developerEnvironment['PATH'] -split [IO.Path]::PathSeparator |
        Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) })
    $env:Path = (@($cleanToolPaths) + @($originalEnvironment['PATH'] -split [IO.Path]::PathSeparator) |
        Select-Object -Unique) -join [IO.Path]::PathSeparator
    foreach ($tool in @('cl.exe', 'link.exe')) { Get-Command $tool -ErrorAction Stop | Out-Null }
    $env:PYTHONUTF8 = '1'
    & git rev-parse --show-toplevel | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Git cannot read the source checkout after toolchain activation' }
    if (-not $PackageArguments) { $PackageArguments = @('--help') }
    & $pythonCommand -X utf8 (Join-Path $PSScriptRoot 'package.py') @PackageArguments
    $exitCode = $LASTEXITCODE
}
finally {
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        if (-not $originalEnvironment.ContainsKey([string]$name)) {
            [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
        }
    }
    foreach ($entry in $originalEnvironment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    Set-Location -LiteralPath $originalLocation.Path
}
exit $exitCode
