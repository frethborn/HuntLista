param([string]$FixtureDirectory, [string]$RepositoryRoot)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $RepositoryRoot 'updater/HuntLista-Data.ps1')
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$script:checks = 0
function Check($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Reject([scriptblock]$Action) {
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Check $failed 'Expected an error, not a success result'
}
function Case($Name, [scriptblock]$Action) {
    try { & $Action; $script:checks++ } catch { throw ($Name + ': ' + $_.Exception.Message) }
}
$cases = ConvertFrom-Json ([System.IO.File]::ReadAllText((Join-Path $FixtureDirectory 'cases.json'), $utf8))
foreach ($case in $cases) {
    Case $case.name {
        if ($case.accepted) {
            $info = [HuntLista.UpdateDataParser]::Parse($case.content)
            Check ($info.Version -ceq $case.version) 'Version differs from bot parser'
            Check ($info.LastUpdate -ceq $case.lastUpdate) 'Timestamp differs from bot parser'
            Check ($info.PlayerCount -eq $case.count) 'Count differs from bot parser'
        } else { Reject { [HuntLista.UpdateDataParser]::Parse($case.content) } }
    }
}
$original = [System.IO.File]::ReadAllText((Join-Path $FixtureDirectory 'valid.lua'), $utf8)
$next = $original.Replace('test-v1', 'test-v2')
$target = Join-Path $FixtureDirectory 'Data.lua'
$backup = $target + '.bak'
function Same($Path, $Expected) { Check ([System.IO.File]::ReadAllText($Path, $utf8) -ceq $Expected) ('Changed unexpectedly: ' + $Path) }
Case 'first install' {
    $info = Save-HuntListaData -Content $original -TargetPath $target
    Check ($info.Version -eq 'test-v1' -and $info.PlayerCount -eq 1) 'Wrong install metadata'
    Same $target $original
    Check (-not (Test-Path -LiteralPath $backup)) 'Unexpected backup on first install'
}
Case 'replace and back up valid data' {
    Save-HuntListaData -Content $next -TargetPath $target | Out-Null
    Same $target $next
    Same $backup $original
}
Case 'repeat invalid downloads cannot erase the last good backup' {
    1..2 | ForEach-Object { Reject { Save-HuntListaData -Content 'HuntLista_Data = {' -TargetPath $target } }
    Same $target $next
    Same $backup $original
}
Case 'no-op preserves previous backup' {
    Save-HuntListaData -Content $next -TargetPath $target | Out-Null
    Same $backup $original
}
Case 'repair invalid local data without backing it up' {
    [System.IO.File]::WriteAllText($target, 'HuntLista_Data = {', $utf8)
    Save-HuntListaData -Content $next -TargetPath $target | Out-Null
    Same $target $next
    Same $backup $original
}
Case 'repair invalid local UTF-8 without backing it up' {
    [System.IO.File]::WriteAllBytes($target, [byte[]]@(255, 254, 255))
    Save-HuntListaData -Content $next -TargetPath $target | Out-Null
    Same $target $next
    Same $backup $original
}
Case 'locked destination aborts without success or data loss' {
    $lock = [System.IO.File]::Open($target, 'Open', 'Read', 'None')
    try { Reject { Save-HuntListaData -Content $original -TargetPath $target } } finally { $lock.Dispose() }
    Same $target $next
    Same $backup $original
}
Case 'backup write failure aborts without truncating live data' {
    $lock = [System.IO.File]::Open($backup, 'Open', 'Read', 'None')
    try { Reject { Save-HuntListaData -Content $original -TargetPath $target } } finally { $lock.Dispose() }
    Same $target $next
    Same $backup $original
}

# Download bytes exactly as Invoke-WebRequest -OutFile would, with no network.
function Invoke-WebRequest {
    param($Uri, [switch]$UseBasicParsing, $TimeoutSec, $OutFile, $ErrorAction)
    [System.IO.File]::WriteAllBytes($OutFile, $script:downloadBytes)
    if ($script:downloadFailure) { throw 'Simulated interrupted download' }
}
Case 'invalid UTF-8 download leaves installation unchanged' {
    $script:downloadBytes = [byte[]]@(255)
    Reject { Update-HuntListaData -Uri 'https://unused.invalid/' -TargetPath $target }
    Same $target $next
    Same $backup $original
}
Case 'interrupted download leaves installation unchanged' {
    $script:downloadBytes = $utf8.GetBytes('HuntLista_Data = {')
    $script:downloadFailure = $true
    Reject { Update-HuntListaData -Uri 'https://unused.invalid/' -TargetPath $target }
    $script:downloadFailure = $false
    Same $target $next
    Same $backup $original
}
Case 'valid UTF-8 download uses parsed metadata and atomic backup' {
    $script:downloadBytes = $utf8.GetBytes($original)
    $info = Update-HuntListaData -Uri 'https://unused.invalid/' -TargetPath $target
    Check ($info.Version -eq 'test-v1' -and $info.PlayerCount -eq 1) 'Wrong downloaded metadata'
    Same $target $original
    Same $backup $next
}

# Exercise the GUI update handler without showing a window.
Add-Type -AssemblyName System.Drawing
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $RepositoryRoot 'auto-updater/HuntLista-AutoUpdater.ps1'), [ref]$tokens, [ref]$errors)
Check ($errors.Count -eq 0) 'GUI script syntax error'
$handler = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Update-Data' }, $true)
. ([scriptblock]::Create($handler.Extent.Text))
function Write-Log { param($msg, $color) }
$RawUrl = 'https://unused.invalid/'
$script:addonDir = $FixtureDirectory
$script:lblStatus = [pscustomobject]@{ Text = ''; ForeColor = $null }
$script:lblVersion = [pscustomobject]@{ Text = '' }
$script:lblPlayers = [pscustomobject]@{ Text = '' }
$script:lblLast = [pscustomobject]@{ Text = '' }
Case 'GUI reports rejected data as failure and does not change files' {
    $script:downloadBytes = $utf8.GetBytes('HuntLista_Data = {')
    Check ((Update-Data) -eq $false) 'GUI claimed success'
    Check ($script:lblStatus.Text -eq 'Status: BLAD') 'GUI did not report failure'
    Same $target $original
    Same $backup $next
}
Case 'GUI reports parsed metadata only after success' {
    $script:downloadBytes = $utf8.GetBytes($next)
    Check ((Update-Data) -eq $true) 'GUI rejected valid data'
    Check ($script:lblVersion.Text -eq 'Wersja danych: test-v2') 'GUI version mismatch'
    Check ($script:lblPlayers.Text -eq 'Graczy na liscie: 1') 'GUI player count mismatch'
    Same $target $next
    Same $backup $original
}
Check (@(Get-ChildItem -LiteralPath $FixtureDirectory -Filter '.HuntLista-*.tmp').Count -eq 0) 'Staging files leaked after success/failure'
Write-Output ('PASS: updater checks ' + $script:checks + ' on PowerShell ' + $PSVersionTable.PSVersion)
