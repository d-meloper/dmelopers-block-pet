param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$MsvcRoot = 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/14.44.35207',
  [string]$WindowsSdkRoot = 'C:/Program Files (x86)/Windows Kits/10',
  [ValidateSet("test","official")][string]$Profile = "test",
  [string]$WindowsSdkVersion = '10.0.26100.0'
)
$ErrorActionPreference = 'Stop'
$out = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $out) { throw 'Choose a fresh output directory; retain previous builds.' }
New-Item -ItemType Directory -Path $out | Out-Null
$savedInclude=$env:INCLUDE; $savedLib=$env:LIB; $savedPath=$env:PATH
try {
  $env:INCLUDE = (@("$MsvcRoot/include", "$WindowsSdkRoot/Include/$WindowsSdkVersion/ucrt", "$WindowsSdkRoot/Include/$WindowsSdkVersion/shared", "$WindowsSdkRoot/Include/$WindowsSdkVersion/um") -join ';')
  $env:LIB = (@("$MsvcRoot/lib/x64", "$WindowsSdkRoot/Lib/$WindowsSdkVersion/ucrt/x64", "$WindowsSdkRoot/Lib/$WindowsSdkVersion/um/x64") -join ';')
  $env:PATH = "$MsvcRoot/bin/Hostx64/x64;$savedPath"
  Push-Location $PSScriptRoot
  try {
    & "$WindowsSdkRoot/bin/$WindowsSdkVersion/x64/rc.exe" /nologo "/fo$out/Launcher.res" Launcher.rc
    if ($LASTEXITCODE -ne 0) { throw 'Uninstall launcher resource compilation failed.' }
    $profileFlags = @()
    if ($Profile -eq 'official') { $profileFlags += '/DBP_OFFICIAL_BUILD' }
    & "$MsvcRoot/bin/Hostx64/x64/cl.exe" @profileFlags /nologo /std:c++17 /W4 /EHsc /MT /O2 /utf-8 /DUNICODE /D_UNICODE /DNDEBUG /sourceDependencies "$out/source-dependencies.json" "/Fo$out/Launcher.obj" "/Fe$out/uninstall.exe" Launcher.cpp "$out/Launcher.res" /link /SUBSYSTEM:WINDOWS /MANIFEST:NO /INCREMENTAL:NO /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA user32.lib shell32.lib ole32.lib advapi32.lib msi.lib version.lib uuid.lib
    if ($LASTEXITCODE -ne 0) { throw 'Uninstall launcher compilation failed.' }
  } finally { Pop-Location }
  $test = Start-Process -FilePath (Join-Path $out 'uninstall.exe') -ArgumentList '--bp-self-test' -WindowStyle Hidden -PassThru -Wait
  if ($test.ExitCode -ne 0) { throw "Uninstall launcher regression failed: $($test.ExitCode)" }
  $inputFiles = @(Get-ChildItem -LiteralPath $PSScriptRoot -File)
  $inputFiles += @(Get-Item "$MsvcRoot/bin/Hostx64/x64/cl.exe", "$MsvcRoot/bin/Hostx64/x64/link.exe", "$WindowsSdkRoot/bin/$WindowsSdkVersion/x64/rc.exe", "$PSScriptRoot/../../icons/icon.ico")
  $dependencies = Get-Content -LiteralPath "$out/source-dependencies.json" -Raw | ConvertFrom-Json
  $inputFiles += @($dependencies.Data.Includes | ForEach-Object { Get-Item -LiteralPath $_ })
  $inputFiles += @(Get-ChildItem "$MsvcRoot/lib/x64" -File -Filter '*.lib')
  $inputFiles += @(Get-ChildItem "$WindowsSdkRoot/Lib/$WindowsSdkVersion/ucrt/x64" -File -Filter '*.lib')
  $inputFiles += @(@('kernel32','user32','shell32','ole32','advapi32','msi','version','uuid') | ForEach-Object { Get-Item -LiteralPath "$WindowsSdkRoot/Lib/$WindowsSdkVersion/um/x64/$_.lib" })
  $binary = Get-Item -LiteralPath (Join-Path $out 'uninstall.exe')
  $receipt = [ordered]@{schemaVersion=1; distributionProfile=$Profile; role='wix-local-uninstall-launcher-v1'; componentVersion='1.0.0'; arch='x64'; crt='static'; selfTest='PASS'; inputs=@($inputFiles | Sort-Object FullName -Unique | ForEach-Object {@{path=$_.FullName;bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}}); binary=@{path=$binary.FullName;bytes=$binary.Length;sha256=(Get-FileHash -LiteralPath $binary.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}}
  [IO.File]::WriteAllText((Join-Path $out 'launcher-build.json'),($receipt | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  $receipt.binary | ConvertTo-Json
} finally { $env:INCLUDE=$savedInclude; $env:LIB=$savedLib; $env:PATH=$savedPath }
