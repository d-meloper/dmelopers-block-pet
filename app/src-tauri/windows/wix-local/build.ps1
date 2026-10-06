param(
  [Parameter(Mandatory=$true)][string]$ToolRoot,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$MsvcRoot = 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/14.44.35207',
  [string]$WindowsSdkRoot = 'C:/Program Files (x86)/Windows Kits/10',
  [ValidateSet("test","official")][string]$Profile = "test",
  [string]$WindowsSdkVersion = '10.0.26100.0'
)
$ErrorActionPreference = 'Stop'
$ba = Join-Path $ToolRoot 'wixtoolset.bootstrapperapplicationapi/build/native'
$dutil = Join-Path $ToolRoot 'wixtoolset.dutil/build/native'
foreach ($package in @('wixtoolset.bootstrapperapplicationapi','wixtoolset.dutil')) {
  & dotnet nuget verify --all (Join-Path $ToolRoot "$package.7.0.0.nupkg")
  if ($LASTEXITCODE -ne 0) { throw "SDK package verification failed: $package" }
  $archive = [IO.Compression.ZipFile]::OpenRead((Join-Path $ToolRoot "$package.7.0.0.nupkg"))
  try {
    foreach ($entry in $archive.Entries | Where-Object { $_.FullName.StartsWith('build/native/') -and $_.Length -gt 0 }) {
      $extracted = Join-Path (Join-Path $ToolRoot $package) $entry.FullName
      $stream=$entry.Open(); $sha=[Security.Cryptography.SHA256]::Create()
      try { $expected=[Convert]::ToHexString($sha.ComputeHash($stream)) } finally { $stream.Dispose(); $sha.Dispose() }
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $extracted).Hash -ne $expected) { throw "Extracted SDK bytes differ from signed package: $extracted" }
    }
  } finally { $archive.Dispose() }
}
$out = [IO.Path]::GetFullPath($OutputDirectory)
if ((Test-Path -LiteralPath $out -PathType Leaf) -or
    ((Test-Path -LiteralPath $out -PathType Container) -and
     @(Get-ChildItem -LiteralPath $out -Force | Select-Object -First 1).Count)) {
  throw 'Choose a fresh output directory; previous and failed build files are immutable.'
}
New-Item -ItemType Directory -Force -Path $out | Out-Null
$savedInclude=$env:INCLUDE; $savedLib=$env:LIB; $savedPath=$env:PATH
try {
  $env:INCLUDE = (@("$MsvcRoot/include", "$WindowsSdkRoot/Include/$WindowsSdkVersion/ucrt", "$WindowsSdkRoot/Include/$WindowsSdkVersion/shared", "$WindowsSdkRoot/Include/$WindowsSdkVersion/um", "$ba/include", "$dutil/include") -join ';')
  $env:LIB = (@("$MsvcRoot/lib/x64", "$WindowsSdkRoot/Lib/$WindowsSdkVersion/ucrt/x64", "$WindowsSdkRoot/Lib/$WindowsSdkVersion/um/x64", "$ba/v14/x64", "$dutil/v14/x64") -join ';')
  $env:PATH = "$MsvcRoot/bin/Hostx64/x64;$savedPath"
  Push-Location $PSScriptRoot
  try {
    & "$WindowsSdkRoot/bin/$WindowsSdkVersion/x64/rc.exe" /nologo "/fo$out/Bootstrapper.res" Bootstrapper.rc
    if ($LASTEXITCODE -ne 0) { throw 'Resource compilation failed.' }
    $compilerFlags = @('/nologo','/std:c++17','/W4','/EHsc','/MT','/O2','/utf-8','/DUNICODE','/D_UNICODE','/DNDEBUG')
    if ($Profile -eq 'official') { $compilerFlags += '/DBP_OFFICIAL_BUILD' }
    $linkerFlags = @('/SUBSYSTEM:WINDOWS','/MANIFEST:NO','/INCREMENTAL:NO','/DYNAMICBASE','/NXCOMPAT','/HIGHENTROPYVA','balutil.lib','dutil.lib','user32.lib','gdi32.lib','shell32.lib','ole32.lib','oleaut32.lib','advapi32.lib','bcrypt.lib','comctl32.lib','msi.lib','shlwapi.lib','version.lib','wininet.lib','urlmon.lib','uuid.lib','wintrust.lib','crypt32.lib')
    function Build-NativeBa {
      param([string]$Name, [string[]]$ProfileFlags = @())
      & "$MsvcRoot/bin/Hostx64/x64/cl.exe" @compilerFlags @ProfileFlags /sourceDependencies "$out/$Name-source-dependencies.json" "/Fo$out/$Name.obj" "/Fe$out/$Name.exe" Bootstrapper.cpp "$out/Bootstrapper.res" /link @linkerFlags
      if ($LASTEXITCODE -ne 0) { throw "Native BA compilation failed: $Name" }
    }
    # QA fixtures and their command are compiled only into this retained test binary.
    Build-NativeBa -Name 'BlockPetWixLocalBA.SelfTest' -ProfileFlags @('/DBP_BA_SELF_TEST')
    $process = Start-Process -FilePath (Join-Path $out 'BlockPetWixLocalBA.SelfTest.exe') -ArgumentList '--bp-self-test' -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "BA helper regression failed: $($process.ExitCode)" }
    Build-NativeBa -Name 'BlockPetWixLocalBA'
  } finally { Pop-Location }
  Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $out 'BlockPetWixLocalBA.exe')
  $notice = "WiX Toolset native SDK 7.0.0`r`nCopyright (c) .NET Foundation and contributors.`r`nSource: https://github.com/wixtoolset/wix/tree/b8977d6f88e7b68e000bac226a2814f236770570`r`nBootstrapperApplicationApi and DUtil static libraries are unmodified.`r`n`r`n" + (Get-Content -LiteralPath (Join-Path $ToolRoot 'LICENSE.TXT') -Raw) + "`r`n`r`n" + (Get-Content -LiteralPath (Join-Path $ToolRoot 'wixtoolset.dutil/OSMFEULA.txt') -Raw)
  [IO.File]::WriteAllText((Join-Path $out 'ThirdParty-WiX.txt'), $notice, [Text.UTF8Encoding]::new($false))
  $inputFiles = @(Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object Extension -in '.cpp','.rc','.manifest','.ps1')
  $inputFiles += @(Get-Item "$ToolRoot/wixtoolset.bootstrapperapplicationapi.7.0.0.nupkg", "$ToolRoot/wixtoolset.dutil.7.0.0.nupkg", "$MsvcRoot/bin/Hostx64/x64/cl.exe", "$MsvcRoot/bin/Hostx64/x64/link.exe", "$WindowsSdkRoot/bin/$WindowsSdkVersion/x64/rc.exe")
  $inputFiles += @(Get-ChildItem "$ba/include", "$dutil/include" -Recurse -File)
  $inputFiles += @(Get-Item "$ba/v14/x64/balutil.lib", "$dutil/v14/x64/dutil.lib", "$PSScriptRoot/../../icons/icon.ico", "$ToolRoot/LICENSE.TXT", "$ToolRoot/wixtoolset.dutil/OSMFEULA.txt")
  foreach ($name in @('BlockPetWixLocalBA','BlockPetWixLocalBA.SelfTest')) {
    $dependencies=Get-Content -LiteralPath "$out/$name-source-dependencies.json" -Raw | ConvertFrom-Json
    $inputFiles += @($dependencies.Data.Includes | ForEach-Object { Get-Item -LiteralPath $_ })
  }
  $inputFiles += @(Get-ChildItem "$MsvcRoot/lib/x64" -File -Filter '*.lib')
  $inputFiles += @(Get-ChildItem "$WindowsSdkRoot/Lib/$WindowsSdkVersion/ucrt/x64" -File -Filter '*.lib')
  $inputFiles += @(@('kernel32','user32','gdi32','shell32','ole32','oleaut32','advapi32','bcrypt','comctl32','msi','shlwapi','version','wininet','urlmon','uuid','wintrust','crypt32') | ForEach-Object { Get-Item -LiteralPath "$WindowsSdkRoot/Lib/$WindowsSdkVersion/um/x64/$_.lib" })
  $inputFiles = @($inputFiles | Sort-Object -Property FullName -Unique)
  $selfTestBinary = Get-Item -LiteralPath (Join-Path $out 'BlockPetWixLocalBA.SelfTest.exe')
  $manifest = [ordered]@{ schemaVersion=2; distributionProfile=$Profile; sdkVersion='7.0.0'; sourceCommit='b8977d6f88e7b68e000bac226a2814f236770570'; crt='static'; arch='x64'; selfTest='PASS'; selfTestBinary=@{path=$selfTestBinary.FullName;bytes=$selfTestBinary.Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $selfTestBinary.FullName).Hash.ToLowerInvariant()}; productionTestCodeIncluded=$false; compilerFlags=$compilerFlags; linkerFlags=$linkerFlags; selfTestCompilerFlags=@($compilerFlags + '/DBP_BA_SELF_TEST'); msvcRoot=$MsvcRoot; windowsSdkVersion=$WindowsSdkVersion; inputs=@($inputFiles | ForEach-Object { @{path=$_.FullName;size=$_.Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()} }); binary=@{path=(Join-Path $out 'BlockPetWixLocalBA.exe');sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $out 'BlockPetWixLocalBA.exe')).Hash.ToLowerInvariant()} }
  [IO.File]::WriteAllText((Join-Path $out 'ba-build.json'), ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
} finally { $env:INCLUDE=$savedInclude; $env:LIB=$savedLib; $env:PATH=$savedPath }
