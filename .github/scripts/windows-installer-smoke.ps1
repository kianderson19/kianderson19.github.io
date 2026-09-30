# Published NSIS installer smoke. No UI automation or security-policy changes.
# NSIS switches: https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage
# /currentuser is supported by electron-builder's assistedInstaller.nsh.
[CmdletBinding()]
param([switch]$CleanupOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or -not $env:RUNNER_TEMP -or -not $env:GITHUB_RUN_ID -or -not $env:GITHUB_RUN_ATTEMPT -or -not $env:GITHUB_JOB) {
  throw 'Use a fresh Windows GitHub-hosted runner with PowerShell 7.'
}
$version = '0.1.0'
$expectedHash = 'be3022b088253ebb30971c7aaeb292a54c157fe7bb11bb005f085a161ae739be'
$installerUrl = "https://github.com/kianderson19/johap/releases/download/desktop-v$version/Johap-$version-win-x64.exe"
$ownerFile = Join-Path $env:RUNNER_TEMP 'johap-installer-owned.json'
$evidenceDirectory = Join-Path $env:RUNNER_TEMP 'johap-installer-evidence'
$summaryFile = Join-Path $evidenceDirectory 'summary.json'
$profileDirectory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Johap'
$logFile = Join-Path $profileDirectory 'desktop.log'
$state = $null
$summary = $null
$mayReadLog = $false
$stage = 'preflight'

function Protect-Text([string]$Text) {
  foreach ($prefix in @($env:RUNNER_TEMP, $env:USERPROFILE, $env:APPDATA, $env:LOCALAPPDATA)) {
    if ($prefix) { $Text = [regex]::Replace($Text, [regex]::Escape($prefix), '<runner-path>', 'IgnoreCase') }
  }
  $Text = [regex]::Replace($Text, '(?i)\b[a-z]:[\\/][^\r\n"<>|]*', '<windows-path>')
  return [regex]::Replace($Text, '\\\\[^\r\n"<>|]+', '<network-path>')
}
function Save-State {
  # Keep the last complete ownership record usable if a workflow step times out.
  $pending = $ownerFile + '.tmp'
  $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $pending -Encoding utf8
  [IO.File]::Move($pending, $ownerFile, $true)
}
function Assert-ControlledState {
  if ($state.runId -ne $env:GITHUB_RUN_ID -or $state.runAttempt -ne $env:GITHUB_RUN_ATTEMPT -or $state.job -ne $env:GITHUB_JOB) {
    throw 'Cleanup refused: ownership belongs to a different workflow run, attempt or job.'
  }
  $root = [IO.Path]::GetFullPath([string]$state.root)
  $parent = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
  if ([IO.Path]::GetDirectoryName($root) -ne $parent -or [IO.Path]::GetFileName($root) -notmatch '^johap-installer-smoke-[a-f0-9]{32}$') {
    throw 'Cleanup refused: installation is not in this smoke-owned runner directory.'
  }
  if ($state.installDirectory -ne (Join-Path $root 'Johap')) { throw 'Cleanup refused: controlled install directory mismatch.' }
}
function Get-JohapRegistrations {
  $found = @{}
  foreach ($hiveName in @('CurrentUser', 'LocalMachine')) {
    foreach ($viewName in @('Registry64', 'Registry32')) {
      $base = $null; $uninstall = $null
      try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$hiveName, [Microsoft.Win32.RegistryView]$viewName)
        $uninstall = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
        if ($null -eq $uninstall) { continue }
        foreach ($keyName in $uninstall.GetSubKeyNames()) {
          $entry = $null
          try {
            $entry = $uninstall.OpenSubKey($keyName)
            if ($null -eq $entry -or [string]$entry.GetValue('DisplayName') -notmatch '^Johap(?:\s|$)') { continue }
            $found["$hiveName/$keyName"] = [pscustomobject]@{
              hive = $hiveName; key = $keyName
              location = [string]$entry.GetValue('InstallLocation')
              version = [string]$entry.GetValue('DisplayVersion')
            }
          } finally { if ($null -ne $entry) { $entry.Dispose() } }
        }
      } finally {
        if ($null -ne $uninstall) { $uninstall.Dispose() }
        if ($null -ne $base) { $base.Dispose() }
      }
    }
  }
  return @($found.Values)
}
function Assert-OwnedRegistration {
  $entries = @(Get-JohapRegistrations)
  if ($entries.Count -ne 1 -or $entries[0].hive -ne 'CurrentUser' -or $entries[0].version -ne $version) {
    throw 'Expected exactly one current-user registration of the tested version.'
  }
  $registered = [IO.Path]::GetFullPath($entries[0].location).TrimEnd('\')
  if ($registered -ne [IO.Path]::GetFullPath($state.installDirectory).TrimEnd('\')) {
    throw 'Uninstall refused: registration does not point to this controlled installation.'
  }
}
function Start-OwnedProcess([string]$Executable, [string]$Arguments, [string]$Kind) {
  $options = @{ FilePath = $Executable; WorkingDirectory = $state.root; PassThru = $true }
  if ($Arguments) { $options.ArgumentList = $Arguments }
  $process = Start-Process @options
  $state.processes += [pscustomobject]@{
    processId = $process.Id; executable = $Executable
    startTicks = $process.StartTime.ToUniversalTime().Ticks.ToString(); kind = $Kind
  }
  Save-State
  return $process
}
function Stop-OwnedProcessTrees {
  if ($null -eq $state) { return }
  Assert-ControlledState
  $remaining = @()
  $cleanupErrors = @()
  foreach ($owner in @($state.processes)) {
    try {
      $current = Get-Process -Id ([int]$owner.processId) -ErrorAction SilentlyContinue
      if ($null -eq $current -or $current.HasExited) { continue }
      if ($current.Path -ne $owner.executable -or $current.StartTime.ToUniversalTime().Ticks.ToString() -ne $owner.startTicks) {
        # The original process has exited. Never signal the replacement PID.
        Write-Host 'Previously owned process has exited; reused PID left untouched.'
        continue
      }
      & "$env:SystemRoot\System32\taskkill.exe" /PID $current.Id /T /F | Out-Null
      if ($LASTEXITCODE -ne 0) {
        $current.Refresh()
        if (-not $current.HasExited) { throw 'Could not terminate the smoke-owned process tree.' }
      }
      if (-not $current.WaitForExit(10000)) { throw 'The smoke-owned process did not stop within ten seconds.' }
    } catch {
      $remaining += $owner
      $cleanupErrors += (Protect-Text $_.Exception.Message)
    }
  }
  $state.processes = $remaining
  Save-State
  if ($cleanupErrors.Count -gt 0) { throw ($cleanupErrors -join '; ') }
}
function Wait-OwnedProcess($Process, [int]$Seconds, [string]$Label) {
  if (-not $Process.WaitForExit($Seconds * 1000)) { throw "$Label timed out; no UI automation was attempted." }
  $Process.Refresh()
  # Do not retain an exited installer PID until it can be reused by the OS.
  $state.processes = @($state.processes | Where-Object { $_.processId -ne $Process.Id })
  Save-State
  if ($Process.ExitCode -ne 0) { throw "$Label exited with code $($Process.ExitCode)." }
  return [int]$Process.ExitCode
}
function Invoke-OwnedUninstall {
  if ($null -eq $state -or -not $state.installAttempted) { return }
  Assert-ControlledState
  if (-not (Test-Path -LiteralPath $state.installDirectory)) {
    if (@(Get-JohapRegistrations).Count -ne 0) { throw 'The installation directory is absent, but a Johap registration remains.' }
    $state.installRemoved = $true; Save-State; return
  }
  Assert-OwnedRegistration
  $installedUninstaller = Join-Path $state.installDirectory 'Uninstall Johap.exe'
  if (-not (Test-Path -LiteralPath $installedUninstaller -PathType Leaf)) { throw 'This installation has no scoped NSIS uninstaller; cleanup cannot be verified.' }
  # Execute an identical copy outside the installation so the original directory
  # can be removed. _?= is NSIS's documented no-self-respawn mode, allowing a real
  # process exit code rather than just waiting for the temporary launcher to exit.
  $uninstallerCopy = Join-Path $state.root 'Uninstall Johap.exe'
  Copy-Item -LiteralPath $installedUninstaller -Destination $uninstallerCopy -Force
  if ((Get-FileHash -LiteralPath $installedUninstaller -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $uninstallerCopy -Algorithm SHA256).Hash) {
    throw 'Copied uninstaller does not match this installation.'
  }
  $uninstallProcess = Start-OwnedProcess $uninstallerCopy "/S /currentuser _?=$($state.installDirectory)" 'uninstaller'
  $state.uninstallExitCode = Wait-OwnedProcess $uninstallProcess 90 'Silent uninstaller'
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
  while ((Test-Path -LiteralPath $state.installDirectory) -and [DateTimeOffset]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Test-Path -LiteralPath $state.installDirectory) { throw 'The uninstaller did not remove the controlled installation directory.' }
  if (@(Get-JohapRegistrations).Count -ne 0) { throw 'The uninstaller left a Johap registration behind.' }
  $state.installRemoved = $true
  Save-State
}
function Read-OperationalLog {
  if (-not (Test-Path -LiteralPath $logFile)) { return '' }
  if ((Get-Item -LiteralPath $logFile).Length -gt 1048576) { throw 'Operational startup log exceeded 1 MB.' }
  return [IO.File]::ReadAllText($logFile)
}
function Assert-NoFatalLog([string]$Text) {
  if ($Text -match '(?im)Startup failed:|Preload failed:|Renderer load failed|Renderer exited|Main error:|Async error:') {
    throw 'The installed application logged a startup, renderer, preload or native error.'
  }
}
function Save-Evidence {
  if ($null -eq $summary) { return }
  $summary.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
  if ($null -ne $state) {
    $summary.uninstallExitCode = $state.uninstallExitCode
    $summary.installationRemoved = $state.installRemoved
  }
  try {
    if ($mayReadLog -and (Test-Path -LiteralPath $logFile)) {
      $bounded = ((Get-Content -LiteralPath $logFile -Tail 300) -join "`n")
      $bounded = Protect-Text $bounded
      # At most 300 lines and 16,000 UTF-16 characters (under 64 KB as UTF-8).
      if ($bounded.Length -gt 16000) { $bounded = '[Earlier log text omitted]' + "`n" + $bounded.Substring($bounded.Length - 16000) }
      $bounded | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'desktop.log') -Encoding utf8
    }
  } finally {
    $pending = $summaryFile + '.tmp'
    $summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $pending -Encoding utf8
    [IO.File]::Move($pending, $summaryFile, $true)
  }
}

if ($CleanupOnly) {
  if (-not (Test-Path -LiteralPath $ownerFile)) { exit 0 }
  $state = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
  if (Test-Path -LiteralPath $summaryFile) { $summary = Get-Content -LiteralPath $summaryFile -Raw | ConvertFrom-Json -AsHashtable }
  $cleanupFailed = $false
  try {
    Assert-ControlledState
    $mayReadLog = $true
    Stop-OwnedProcessTrees
    Invoke-OwnedUninstall
  } catch {
    $cleanupFailed = $true
    $detail = Protect-Text $_.Exception.Message
    if ($null -ne $summary) { $summary.result = 'failed'; $summary.error = "Cleanup: $detail" }
    Write-Host "::error::$detail"
  } finally { Save-Evidence }
  if ($cleanupFailed) { exit 1 }
  exit 0
}

New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
$summary = [ordered]@{
  result = 'failed'; version = $version; artifactUrl = $installerUrl
  expectedSha256 = $expectedHash; actualSha256 = $null
  scope = 'Silent current-user NSIS install, installed-app startup, and scoped silent uninstall on Windows Server 2022. No game, DPI, UI or non-admin validation.'
  startedAt = [DateTimeOffset]::UtcNow.ToString('o'); finishedAt = $null
  installerExitCode = $null; uninstallExitCode = $null
  currentUserRegistrationVerified = $false; installedFilesVerified = $false
  startupVerified = $false; installationRemoved = $false; error = $null
}
$failure = $null
Save-Evidence
try {
  if (Test-Path -LiteralPath $ownerFile) { throw 'Existing smoke ownership state found; use a fresh runner.' }
  if (Test-Path -LiteralPath $profileDirectory) { throw 'Existing Johap profile found; use a fresh runner.' }
  if (Get-Process -Name 'Johap' -ErrorAction SilentlyContinue) { throw 'Johap is already running; no existing process will be touched.' }
  if (@(Get-JohapRegistrations).Count -ne 0) { throw 'A prior Johap installation is registered; this smoke must not replace it.' }
  $mayReadLog = $true
  $root = Join-Path $env:RUNNER_TEMP ('johap-installer-smoke-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $root | Out-Null
  $state = [pscustomobject]@{
    runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT; job = $env:GITHUB_JOB
    root = $root; installDirectory = (Join-Path $root 'Johap'); processes = @()
    installAttempted = $false; installRemoved = $false; uninstallExitCode = $null
  }
  Save-State
  $stage = 'download'
  $installer = Join-Path $root 'Johap-installer.exe'
  Invoke-WebRequest -Uri $installerUrl -OutFile $installer -MaximumRedirection 5 -TimeoutSec 90
  $summary.actualSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($summary.actualSha256 -ne $expectedHash) { throw 'Published installer SHA256 does not match the reviewed binary.' }
  $stage = 'install'
  $state.installAttempted = $true; Save-State
  # /D is deliberately final and unquoted, as required by NSIS, including spaces.
  $installerProcess = Start-OwnedProcess $installer "/S /currentuser /D=$($state.installDirectory)" 'installer'
  $summary.installerExitCode = Wait-OwnedProcess $installerProcess 90 'Silent installer'
  Assert-OwnedRegistration
  $summary.currentUserRegistrationVerified = $true
  $application = Join-Path $state.installDirectory 'Johap.exe'
  foreach ($relative in @('Johap.exe', 'Uninstall Johap.exe', 'resources\app.asar')) {
    if (-not (Test-Path -LiteralPath (Join-Path $state.installDirectory $relative) -PathType Leaf)) { throw 'Required installed application files are missing.' }
  }
  $summary.installedFilesVerified = $true
  $stage = 'startup'
  $applicationProcess = Start-OwnedProcess $application '' 'application'
  $markers = @(
    ('Johap ' + [regex]::Escape($version) + ' start \(win32, Electron '),
    'Renderer loaded: desktop', 'Renderer loaded: overlay',
    'Desktop renderer ready', 'Overlay renderer ready', 'Capture sources listed: \d+'
  )
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
  $ready = $false
  do {
    $applicationProcess.Refresh()
    if ($applicationProcess.HasExited) { throw 'The installed application exited before readiness.' }
    $content = Read-OperationalLog
    Assert-NoFatalLog $content
    $missing = @($markers | Where-Object { $content -notmatch $_ })
    if ($missing.Count -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  if (-not $ready) { throw ('Installed application readiness markers missing: ' + ($missing -join ', ')) }
  for ($iteration = 0; $iteration -lt 20; $iteration++) {
    Start-Sleep -Milliseconds 500
    $applicationProcess.Refresh()
    if ($applicationProcess.HasExited) { throw 'The installed application exited during the ten-second stability check.' }
    Assert-NoFatalLog (Read-OperationalLog)
  }
  $summary.startupVerified = $true
  $stage = 'uninstall'
  Stop-OwnedProcessTrees
  Invoke-OwnedUninstall
  $summary.result = 'passed'
} catch {
  $failure = "$stage`: $(Protect-Text $_.Exception.Message)"
  $summary.error = $failure
} finally {
  try {
    Stop-OwnedProcessTrees
    Invoke-OwnedUninstall
  } catch {
    $failure = 'Cleanup: ' + (Protect-Text $_.Exception.Message)
    $summary.result = 'failed'; $summary.error = $failure
  } finally { Save-Evidence }
}
if ($null -ne $failure) { Write-Host "::error::$failure"; exit 1 }
Write-Host 'Published installer passed current-user install, installed startup and scoped uninstall checks.'
