$ErrorActionPreference = 'Stop'
$vesperTaskRoot = Split-Path -Parent $PSScriptRoot
$vesperToolDir = Join-Path $vesperTaskRoot '.workbench/kernel-toolchain'
$vesperResult = [ordered]@{ startedAt = [DateTime]::UtcNow.ToString('o'); status = 'running'; operations = @() }
$vesperReport = Join-Path $vesperToolDir 'installation.json'
function Save-VesperReport { $vesperResult | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $vesperReport -Encoding utf8 }
Save-VesperReport
try {
  $vesperPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $vesperPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator elevation is required for the Microsoft native build components.' }
  $vesperSetup = 'C:/Program Files (x86)/Microsoft Visual Studio/Installer/setup.exe'
  $vesperSdk = Join-Path $vesperToolDir 'winsdksetup-28000.2270.exe'
  foreach ($vesperInstaller in @($vesperSetup, $vesperSdk)) {
    $vesperSignature = Get-AuthenticodeSignature -LiteralPath $vesperInstaller
    if ($vesperSignature.Status -ne 'Valid' -or $vesperSignature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw "Installer signature verification failed: $vesperInstaller" }
  }
  # Add the missing component to the existing Build Tools product. VCTools is
  # already installed; do not install another IDE or remove other components.
  $vesperVs = Start-Process -FilePath $vesperSetup -ArgumentList 'modify --installPath "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools" --channelId VisualStudio.18.Release --add Microsoft.VisualStudio.Component.VC.ATLMFC --quiet --norestart' -WindowStyle Hidden -Wait -PassThru
  $vesperResult.operations += @{ product = 'Visual Studio 2026 MFC/ATL'; exitCode = $vesperVs.ExitCode }; Save-VesperReport
  if ($vesperVs.ExitCode -notin @(0,3010)) { throw "MFC/ATL installation failed with exit $($vesperVs.ExitCode)" }
  $vesperSdkArguments = '/quiet /norestart /features OptionId.DesktopCPPx64 OptionId.DesktopCPPx86 OptionId.WindowsDesktopDebuggers /log "' + (Join-Path $vesperToolDir 'sdk-install.log') + '"'
  $vesperSdkProcess = Start-Process -FilePath $vesperSdk -ArgumentList $vesperSdkArguments -WindowStyle Hidden -Wait -PassThru
  $vesperResult.operations += @{ product = 'Windows SDK 28000.2270 and debugging tools'; exitCode = $vesperSdkProcess.ExitCode }; Save-VesperReport
  if ($vesperSdkProcess.ExitCode -notin @(0,3010)) { throw "Windows SDK installation failed with exit $($vesperSdkProcess.ExitCode)" }
  $vesperResult.status = 'installed-pending-validation'
} catch { $vesperResult.status = 'failed'; $vesperResult.error = $_.Exception.Message }
finally { $vesperResult.completedAt = [DateTime]::UtcNow.ToString('o'); Save-VesperReport }
