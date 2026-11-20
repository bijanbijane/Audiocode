# AVAPARDAZ — Windows Uninstaller (preserves user transcripts & models by default)
param(
  [switch]$RemoveModels = $false
)

$ErrorActionPreference = "Stop"
$PluginId = "ir.avapardaz.audition.cep"
$CepDir = Join-Path $env:APPDATA "Adobe\CEP\extensions\$PluginId"
$AppData = Join-Path $env:LOCALAPPDATA "AVAPARDAZ"

Write-Host "[AVAPARDAZ] Removing Adobe Audition CEP plugin..."
if (Test-Path $CepDir) { Remove-Item -Recurse -Force $CepDir }
if (Test-Path "$AppData\runtime") { Remove-Item -Recurse -Force "$AppData\runtime" }

if ($RemoveModels) {
  Write-Host "[AVAPARDAZ] Removing downloaded AI models as explicitly requested..."
  if (Test-Path "$AppData\models") { Remove-Item -Recurse -Force "$AppData\models" }
} else {
  Write-Host "[AVAPARDAZ] Preserved AI models and user transcripts in: $AppData"
}

Write-Host "[AVAPARDAZ] Uninstall complete."
