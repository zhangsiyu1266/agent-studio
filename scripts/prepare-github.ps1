$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$downloadDirectory = Join-Path $projectRoot '.build\github-cli-2.102.0'
$destination = Join-Path $projectRoot 'tools\github'
$archive = Join-Path $downloadDirectory 'gh.zip'
$expected = 'ae64e556ecc240b200f7eba60d550e4bb60d78e860e69dd88c449405b86067f4'
New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
$downloadArgs = @('--fail', '--location', '--silent', '--show-error', '--max-time', '180', '--output', $archive)
if (-not $env:HTTPS_PROXY -and -not $env:ALL_PROXY) {
  $network = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  if ($network.ProxyEnable -eq 1 -and $network.ProxyServer -match '^[a-zA-Z0-9.\-\[\]:]+$') {
    $downloadArgs += @('--proxy', ('http://' + $network.ProxyServer))
  }
}
$downloadArgs += 'https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_windows_amd64.zip'
& curl.exe @downloadArgs
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI download failed.' }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'GitHub CLI checksum mismatch.' }
Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
& (Join-Path $destination 'bin\gh.exe') --version
Write-Output 'Official GitHub CLI prepared; authentication has not been started.'
