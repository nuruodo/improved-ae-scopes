<#
  Installs the Improved AE Scopes panel into After Effects (per-user, no admin rights needed).

    .\install.ps1              copy the panel into %APPDATA%\Adobe\CEP\extensions\com.aetools.scopes
    .\install.ps1 -Dev         junction instead of copy, so edits here show up when you reopen the panel
    .\install.ps1 -Uninstall   remove it

  Never edits the registry. Unsigned CEP panels need PlayerDebugMode = 1 for your CSXS version.
  After installing, restart After Effects and open  Window > Extensions > Scopes.
#>
param(
  [switch]$Dev,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root "scopes"
$target = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.aetools.scopes"

function Remove-Existing($path) {
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.LinkType) { $item.Delete() } else { Remove-Item -LiteralPath $path -Recurse -Force }
  }
}

if ($Uninstall) { Remove-Existing $target; Write-Host "Removed $target"; return }
if (-not (Test-Path $src)) { throw "panel folder not found: $src" }

New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
Remove-Existing $target
if ($Dev) {
  New-Item -ItemType Junction -Path $target -Target $src | Out-Null
  Write-Host "Linked  $target  ->  $src"
} else {
  Copy-Item $src $target -Recurse -Force
  Write-Host "Copied panel to $target"
}

$debugOn = $false
foreach ($v in 9..13) {
  $k = "HKCU:\Software\Adobe\CSXS.$v"
  if ((Test-Path $k) -and ((Get-ItemProperty $k -ErrorAction SilentlyContinue).PlayerDebugMode -eq "1")) { $debugOn = $true }
}
if (-not $debugOn) {
  Write-Warning "PlayerDebugMode is not enabled for CSXS 9-13, so After Effects will ignore unsigned panels. Set HKCU\Software\Adobe\CSXS.<n>\PlayerDebugMode = 1 (string) - this script does not change the registry."
}
Write-Host "Done. Restart After Effects, then open  Window > Extensions > Scopes."
