# Startup verification only: no UI automation, capture selection, debugging port,
# test-only application flags, or relaxed Electron security settings.
[CmdletBinding()]
param(
  [ValidatePattern('\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z')]
  [string]$Version,
  [ValidatePattern('\A[a-fA-F0-9]{64}\z')]
  [string]$ExpectedSha256,
  [switch]$CleanupOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or -not $env:RUNNER_TEMP) {
  throw 'Use a fresh GitHub-hosted Windows runner with PowerShell 7.'
}
$evidenceDirectory = Join-Path $env:RUNNER_TEMP 'johap-smoke-evidence'
$ownershipPath = Join-Path $env:RUNNER_TEMP 'johap-smoke-owned-process.json'

function Stop-OwnedProcessTree {
  if (-not (Test-Path -LiteralPath $ownershipPath)) { return }
  $owner = Get-Content -LiteralPath $ownershipPath -Raw | ConvertFrom-Json
  $current = Get-Process -Id ([int]$owner.processId) -ErrorAction SilentlyContinue
  if ($null -eq $current) { return }
  # A reused PID must never authorize terminating an unrelated process.
  if ($current.Path -ne $owner.executable -or $current.StartTime.ToUniversalTime().Ticks.ToString() -ne $owner.startTicks) {
    throw 'Cleanup refused: process identity no longer matches the test-owned executable.'
  }
  & "$env:SystemRoot\System32\taskkill.exe" /PID $current.Id /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $current.Refresh()
    if (-not $current.HasExited) { throw 'The test-owned process tree could not be stopped.' }
  }
}

if ($CleanupOnly) {
  Stop-OwnedProcessTree
  exit 0
}
if (-not $Version -or -not $ExpectedSha256) { throw 'Version and ExpectedSha256 are required.' }
New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
$profilePath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Johap'
$logPath = Join-Path $profilePath 'desktop.log'
$zipUrl = "https://github.com/kianderson19/johap/releases/download/desktop-v$Version/Johap-$Version-win-x64.zip"
$smokeDirectory = Join-Path $env:RUNNER_TEMP ('johap-smoke-' + [guid]::NewGuid().ToString('N'))
$summary = [ordered]@{
  result = 'failed'
  scope = 'Published Windows ZIP startup only; no Overwatch, OCR, DPI or overlay interaction verification.'
  version = $Version
  artifactUrl = $zipUrl
  expectedSha256 = $ExpectedSha256.ToLowerInvariant()
  actualSha256 = $null
  startedAt = [DateTimeOffset]::UtcNow.ToString('o')
  finishedAt = $null
  processId = $null
  error = $null
  readyMarkers = @()
}
$ownedProcess = $null
$mayReadLog = $false
function Read-OperationalLog {
  if (-not (Test-Path -LiteralPath $logPath)) { return '' }
  $file = Get-Item -LiteralPath $logPath
  if ($file.Length -gt 1048576) { throw 'Operational log exceeded the 1 MB startup limit.' }
  return [IO.File]::ReadAllText($logPath)
}
function Assert-NoFatalLog([string]$Content) {
  if ($Content -match '(?im)Startup failed:|Preload failed:|Renderer load failed|Renderer exited|Main error:|Async error:') {
    throw 'The operational log records a startup, renderer, preload or application failure.'
  }
}
try {
  if (Test-Path -LiteralPath $profilePath) { throw 'A pre-existing Johap profile makes startup evidence ambiguous. Use a fresh hosted runner.' }
  if (Get-Process -Name 'Johap' -ErrorAction SilentlyContinue) { throw 'Johap was already running. This smoke must own every process it starts.' }
  $mayReadLog = $true
  New-Item -ItemType Directory -Path $smokeDirectory -Force | Out-Null
  $zipPath = Join-Path $smokeDirectory 'Johap.zip'
  $extractPath = Join-Path $smokeDirectory 'package'
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -MaximumRedirection 5 -TimeoutSec 90
  $summary.actualSha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($summary.actualSha256 -ne $summary.expectedSha256) { throw 'Published ZIP SHA256 does not match the reviewed artifact.' }
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath
  $executables = @(Get-ChildItem -LiteralPath $extractPath -Filter 'Johap.exe' -File -Recurse)
  if ($executables.Count -ne 1) { throw 'Expected exactly one packaged Johap.exe.' }
  $executable = $executables[0].FullName
  $ownedProcess = Start-Process -FilePath $executable -WorkingDirectory $executables[0].DirectoryName -PassThru
  $summary.processId = $ownedProcess.Id
  @{ processId = $ownedProcess.Id; executable = $executable; startTicks = $ownedProcess.StartTime.ToUniversalTime().Ticks.ToString() } |
    ConvertTo-Json | Set-Content -LiteralPath $ownershipPath -Encoding utf8
  $requiredMarkers = @(
    ('Johap ' + [regex]::Escape($Version) + ' start \(win32, Electron '),
    'Renderer loaded: desktop',
    'Renderer loaded: overlay',
    'Desktop renderer ready',
    'Overlay renderer ready',
    'Capture sources listed: \d+'
  )
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
  $ready = $false
  do {
    $ownedProcess.Refresh()
    if ($ownedProcess.HasExited) { throw "Johap exited during startup with code $($ownedProcess.ExitCode)." }
    $content = Read-OperationalLog
    Assert-NoFatalLog $content
    $missing = @($requiredMarkers | Where-Object { $content -notmatch $_ })
    if ($missing.Count -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  if (-not $ready) { throw ('Readiness markers missing: ' + ($missing -join ', ')) }
  # Require successful renderer/IPC handshakes before checking short-term stability.
  for ($iteration = 0; $iteration -lt 20; $iteration++) {
    Start-Sleep -Milliseconds 500
    $ownedProcess.Refresh()
    if ($ownedProcess.HasExited) { throw "Johap exited after readiness with code $($ownedProcess.ExitCode)." }
    Assert-NoFatalLog (Read-OperationalLog)
  }
  $summary.readyMarkers = $requiredMarkers
  $summary.result = 'passed'
} catch {
  $summary.error = $_.Exception.Message
  throw
} finally {
  # Both this finally block and the workflow's always() step target only the recorded PID tree.
  try {
    Stop-OwnedProcessTree
  } catch {
    $summary.result = 'failed'
    $summary.error = 'Cleanup failure: ' + $_.Exception.Message
    throw
  } finally {
    $summary.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    try {
      if ($mayReadLog -and (Test-Path -LiteralPath $logPath)) {
        # Retain only a bounded text log, never profiles, screenshots, or captured frames.
        Get-Content -LiteralPath $logPath -Tail 300 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'desktop.log') -Encoding utf8
      }
    } finally {
      $summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'summary.json') -Encoding utf8
    }
  }
}
