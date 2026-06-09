# Convenience wrapper for Windows: scripts\bump.ps1 <plugin> <level> [--dry-run] [--tag]
# Delegates to the cross-platform Node bumper (the single source of truth).
#   .\scripts\bump.ps1 both patch
#   .\scripts\bump.ps1 rider minor --tag
param(
  [Parameter(Mandatory = $true)][ValidateSet("rider", "gamedev", "both")][string]$Plugin,
  [Parameter(Mandatory = $true)][ValidateSet("major", "minor", "patch", "hotfix", "fix")][string]$Level
)
node "$PSScriptRoot/bump.mjs" $Plugin $Level @args
exit $LASTEXITCODE
