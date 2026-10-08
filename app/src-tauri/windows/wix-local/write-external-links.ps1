param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Output) { throw 'Generated link headers require a fresh output path.' }
$links = Get-Content -LiteralPath $Source -Raw -Encoding UTF8 | ConvertFrom-Json
$header = @('#pragma once', '// Generated from src/config/externalLinks.json; do not edit.')
foreach ($audience in @('korean', 'global')) {
  $url = $links.$audience.webviewGuide
  if ($url -isnot [string] -or $url -notmatch '^https://[!-~]+$' -or $url -match '["\\]') {
    throw "Invalid source-owned WebView guide: $audience"
  }
  $header += 'inline constexpr wchar_t kWebViewGuide_' + $audience + '[] = L"' + $url + '";'
}
$header += 'inline const wchar_t* WebViewGuide(bool korean) { return korean ? kWebViewGuide_korean : kWebViewGuide_global; }'
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Output), ($header -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
