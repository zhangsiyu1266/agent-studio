$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCache = Join-Path $taskRoot '.build\runtime-downloads'
$taskTools = Join-Path $taskRoot 'tools'
New-Item -ItemType Directory -Path $taskCache -Force | Out-Null

function Get-OfficialFile($Url, $Destination) {
  $taskArgs = @('--fail', '--location', '--silent', '--show-error', '--retry', '2', '--connect-timeout', '20', '--speed-time', '45', '--speed-limit', '1024', '--max-time', '600', '--output', $Destination)
  if (-not $env:HTTPS_PROXY -and -not $env:ALL_PROXY) {
    $taskProxy = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($taskProxy.ProxyEnable -eq 1 -and $taskProxy.ProxyServer -match '^[a-zA-Z0-9.\-\[\]:]+$') { $taskArgs += @('--proxy', ('http://' + $taskProxy.ProxyServer)) }
  }
  & curl.exe @taskArgs $Url
  if ($LASTEXITCODE -ne 0) { throw "Official download failed: $Url" }
}

# Download immutable versions, verify bytes, and copy only distribution files.
$taskNodeVersion = '24.21.0'
$taskNodeArchiveName = "node-v$taskNodeVersion-win-x64.zip"
$taskNodeArchive = Join-Path $taskCache $taskNodeArchiveName
$taskSums = Join-Path $taskCache 'node-SHASUMS256.txt'
Get-OfficialFile "https://nodejs.org/dist/v$taskNodeVersion/SHASUMS256.txt" $taskSums
$taskSumLine = Get-Content -LiteralPath $taskSums | Where-Object { $_ -match ('\s+' + [regex]::Escape($taskNodeArchiveName) + '$') }
if (@($taskSumLine).Count -ne 1) { throw 'Node.js checksum entry missing or ambiguous.' }
$taskNodeHash = ($taskSumLine -split '\s+')[0]
if (-not (Test-Path -LiteralPath $taskNodeArchive) -or (Get-FileHash -LiteralPath $taskNodeArchive -Algorithm SHA256).Hash -ne $taskNodeHash) {
  Get-OfficialFile "https://nodejs.org/dist/v$taskNodeVersion/$taskNodeArchiveName" $taskNodeArchive
}
if ((Get-FileHash -LiteralPath $taskNodeArchive -Algorithm SHA256).Hash -ne $taskNodeHash) { throw 'Node.js checksum mismatch.' }
Expand-Archive -LiteralPath $taskNodeArchive -DestinationPath $taskCache -Force
$taskNodeSource = Join-Path $taskCache "node-v$taskNodeVersion-win-x64"
$taskNodeTarget = Join-Path $taskTools 'node'
New-Item -ItemType Directory -Path $taskNodeTarget -Force | Out-Null
Copy-Item -Path (Join-Path $taskNodeSource '*') -Destination $taskNodeTarget -Recurse -Force

$taskCodexVersion = '0.160.0'
$taskMetadata = Join-Path $taskCache 'codex-metadata.json'
Get-OfficialFile "https://registry.npmjs.org/@openai%2Fcodex/$taskCodexVersion-win32-x64" $taskMetadata
$taskPackage = Get-Content -LiteralPath $taskMetadata -Raw | ConvertFrom-Json
$taskCodexArchive = Join-Path $taskCache 'codex-win32-x64.tgz'
if ($taskPackage.dist.tarball -notmatch '^https://registry\.npmjs\.org/@openai/codex/-/codex-[0-9.]+-win32-x64\.tgz$') { throw 'Unexpected Codex distribution URL.' }
$taskDigest = [BitConverter]::ToString([Convert]::FromBase64String($taskPackage.dist.integrity.Substring(7))).Replace('-', '').ToLowerInvariant()
$taskNpmCache = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA ('npm-cache\_cacache\content-v2\sha512\' + $taskDigest.Substring(0,2) + '\' + $taskDigest.Substring(2,2) + '\' + $taskDigest.Substring(4)) } else { $null }
if ($taskNpmCache -and (Test-Path -LiteralPath $taskNpmCache) -and (Get-FileHash -LiteralPath $taskNpmCache -Algorithm SHA512).Hash -eq $taskDigest) {
  Copy-Item -LiteralPath $taskNpmCache -Destination $taskCodexArchive -Force
  Write-Output 'Using integrity-verified official Codex distribution from npm download cache.'
} else {
  Get-OfficialFile $taskPackage.dist.tarball $taskCodexArchive
}
$taskHasher = [Security.Cryptography.SHA512]::Create()
$taskStream = [IO.File]::OpenRead($taskCodexArchive)
try { $taskIntegrity = 'sha512-' + [Convert]::ToBase64String($taskHasher.ComputeHash($taskStream)) } finally { $taskStream.Dispose(); $taskHasher.Dispose() }
if ($taskIntegrity -cne $taskPackage.dist.integrity) { throw 'Codex npm integrity mismatch.' }
$taskCodexTarget = Join-Path $taskTools 'codex'
New-Item -ItemType Directory -Path $taskCodexTarget -Force | Out-Null
& tar.exe -xzf $taskCodexArchive -C $taskCodexTarget --strip-components=1
if ($LASTEXITCODE -ne 0) { throw 'Codex extraction failed.' }
Get-OfficialFile "https://raw.githubusercontent.com/openai/codex/rust-v$taskCodexVersion/LICENSE" (Join-Path $taskCodexTarget 'LICENSE')
Get-OfficialFile "https://raw.githubusercontent.com/openai/codex/rust-v$taskCodexVersion/NOTICE" (Join-Path $taskCodexTarget 'NOTICE')
$taskManifest = [ordered]@{ node = $taskNodeVersion; nodeSha256 = $taskNodeHash; codex = $taskCodexVersion; codexIntegrity = $taskIntegrity }
$taskManifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskTools 'runtime-manifest.json') -Encoding utf8
Write-Output "Verified Node.js $taskNodeVersion and Codex $taskCodexVersion prepared. No user credentials were copied."
