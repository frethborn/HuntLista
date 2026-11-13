param([string]$FixtureDirectory, [ValidateSet('valid', 'invalid')][string]$Mode)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Clear-Host {}
function Read-Host { return '' }
function Invoke-WebRequest {
    param($Uri, [switch]$UseBasicParsing, $TimeoutSec, $OutFile, $ErrorAction)
    if ($Mode -eq 'invalid') {
        [System.IO.File]::WriteAllText($OutFile, 'HuntLista_Data = {')
    } else {
        [System.IO.File]::WriteAllBytes($OutFile, [System.IO.File]::ReadAllBytes((Join-Path $FixtureDirectory 'valid.lua')))
    }
}
. (Join-Path $FixtureDirectory 'Update-HuntLista.ps1')
exit $LASTEXITCODE
