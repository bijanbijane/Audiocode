# AVAPARDAZ — Windows 10/11 x64 Installer for Adobe Audition CEP Plugin
# Preserves user projects & transcripts during upgrade/repair.
param(
  [switch]$EnableBetaDebugMode = $false
)

$ErrorActionPreference = "Stop"
$PluginId = "ir.avapardaz.audition.cep"
$CepDir = Join-Path $env:APPDATA "Adobe\CEP\extensions\$PluginId"
$AppData = Join-Path $env:LOCALAPPDATA "AVAPARDAZ"
$ScriptRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "[AVAPARDAZ] Installing Adobe Audition CEP plugin to: $CepDir"
New-Item -ItemType Directory -Force -Path $CepDir, "$AppData\models", "$AppData\runtime", "$AppData\config" | Out-Null

Copy-Item -Recurse -Force (Join-Path $ScriptRoot "CSXS") $CepDir
Copy-Item -Recurse -Force (Join-Path $ScriptRoot "client") $CepDir
Copy-Item -Recurse -Force (Join-Path $ScriptRoot "jsx") $CepDir

if ($EnableBetaDebugMode) {
  foreach ($ver in @("11", "12")) {
    $regPath = "HKCU:\Software\Adobe\CSXS.$ver"
    New-Item -Path $regPath -Force | Out-Null
    Set-ItemProperty -Path $regPath -Name "PlayerDebugMode" -Value "1" -Type String
  }
  Write-Host "[AVAPARDAZ] Enabled CEP PlayerDebugMode for internal beta testing."
}

Write-Host "[AVAPARDAZ] Installation complete. Restart Adobe Audition -> Window -> Extensions -> AVAPARDAZ."
