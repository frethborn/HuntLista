# ============================================================
# Hunt Lista - Auto Updater (GUI) v2
# ============================================================

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HuntLista-Data.ps1')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[System.Windows.Forms.Application]::EnableVisualStyles()

$RawUrl = "https://raw.githubusercontent.com/frethborn/HuntLista/main/HuntLista/Data.lua"
$ConfigPath = Join-Path $PSScriptRoot "auto-updater-config.txt"

$script:addonDir = $null
$script:intervalMin = 5
$script:running = $false
$script:lastVersion = "-"
$script:lastCount = 0
$script:lastOk = $null

function Write-Log {
    param([string]$msg, [string]$color = "White")
    $ts = Get-Date -Format "HH:mm:ss"
    try {
        $script:box.SelectionStart = $script:box.TextLength
        $script:box.SelectionColor = [System.Drawing.Color]::FromName($color)
        if (-not $script:box.SelectionColor.IsKnownColor) {
            $script:box.SelectionColor = [System.Drawing.Color]::LightGray
        }
        $script:box.AppendText("[$ts] $msg`r`n")
        $script:box.ScrollToCaret()
    } catch {
        Write-Host "[$ts] $msg"
    }
}

function Find-AddonDir {
    $candidates = @(
        "${env:ProgramFiles(x86)}\World of Warcraft\_forever_\Interface\AddOns\HuntLista",
        "${env:ProgramFiles}\World of Warcraft\_forever_\Interface\AddOns\HuntLista",
        "$env:USERPROFILE\Games\World of Warcraft\_forever_\Interface\AddOns\HuntLista",
        "D:\World of Warcraft\_forever_\Interface\AddOns\HuntLista",
        "E:\World of Warcraft\_forever_\Interface\AddOns\HuntLista",
        "C:\Games\World of Warcraft\_forever_\Interface\AddOns\HuntLista",
        "D:\Games\World of Warcraft\_forever_\Interface\AddOns\HuntLista"
    )
    if (Test-Path $ConfigPath) {
        $saved = (Get-Content $ConfigPath -Raw -ErrorAction SilentlyContinue)
        if ($saved) {
            $saved = $saved.Trim()
            if ($saved -and (Test-Path $saved)) { return $saved }
        }
    }
    foreach ($p in $candidates) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Save-Config {
    if ($script:addonDir) {
        try { $script:addonDir | Set-Content -Path $ConfigPath -Encoding UTF8 -Force } catch {}
    }
}

function Update-Data {
    if (-not $script:addonDir -or -not (Test-Path $script:addonDir)) {
        Write-Log "Brak folderu addona - ustaw sciezke." "Orange"
        return $false
    }

    $target = Join-Path $script:addonDir "Data.lua"
    $script:lblStatus.Text = "Status: pobieranie..."
    $script:lblStatus.ForeColor = [System.Drawing.Color]::Orange

    try {
        $info = Update-HuntListaData -Uri $RawUrl -TargetPath $target
        $ver = $info.Version
        $count = $info.PlayerCount

        $script:lastVersion = $ver
        $script:lastCount = $count
        $script:lastOk = Get-Date

        $script:lblVersion.Text = "Wersja danych: $ver"
        $script:lblPlayers.Text = "Graczy na liscie: $count"
        $script:lblLast.Text = "Ostatni update: $($script:lastOk.ToString('HH:mm:ss'))"
        $script:lblStatus.Text = "Status: OK"
        $script:lblStatus.ForeColor = [System.Drawing.Color]::LightGreen

        Write-Log "OK  v=$ver  graczy=$count  -> Data.lua" "LightGreen"
        return $true
    }
    catch {
        $script:lblStatus.Text = "Status: BLAD"
        $script:lblStatus.ForeColor = [System.Drawing.Color]::Red
        Write-Log "BLAD: $($_.Exception.Message)" "Red"
        return $false
    }
}

function Set-Running {
    param([bool]$on)
    $script:running = $on
    if ($on) {
        $mins = [int]$script:numInterval.Value
        if ($mins -lt 1) { $mins = 1 }
        $script:intervalMin = $mins
        $script:timer.Interval = $mins * 60 * 1000
        $script:timer.Start()
        $script:btnToggle.Text = "Stop auto"
        $script:btnToggle.BackColor = [System.Drawing.Color]::LightCoral
        Write-Log "Auto-update WLaczony co $mins min." "Cyan"
        Update-Data | Out-Null
    } else {
        $script:timer.Stop()
        $script:btnToggle.Text = "Start auto"
        $script:btnToggle.BackColor = [System.Drawing.Color]::LightGreen
        Write-Log "Auto-update wylaczony." "Cyan"
    }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Hunt Lista - Auto Updater"
$form.Size = New-Object System.Drawing.Size(520, 420)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedSingle"
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
$form.ForeColor = [System.Drawing.Color]::WhiteSmoke

$fontTitle = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)
$fontNorm = New-Object System.Drawing.Font("Segoe UI", 9)

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = "Hunt Lista - Auto Updater"
$lblTitle.Font = $fontTitle
$lblTitle.ForeColor = [System.Drawing.Color]::IndianRed
$lblTitle.Location = New-Object System.Drawing.Point(16, 12)
$lblTitle.AutoSize = $true
$form.Controls.Add($lblTitle)

$lblPath = New-Object System.Windows.Forms.Label
$lblPath.Text = "Folder addona:"
$lblPath.Font = $fontNorm
$lblPath.Location = New-Object System.Drawing.Point(16, 48)
$lblPath.AutoSize = $true
$form.Controls.Add($lblPath)

$txtPath = New-Object System.Windows.Forms.TextBox
$txtPath.Location = New-Object System.Drawing.Point(16, 70)
$txtPath.Size = New-Object System.Drawing.Size(360, 24)
$txtPath.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
$txtPath.ForeColor = [System.Drawing.Color]::White
$form.Controls.Add($txtPath)

$btnBrowse = New-Object System.Windows.Forms.Button
$btnBrowse.Text = "Wybierz..."
$btnBrowse.Location = New-Object System.Drawing.Point(386, 68)
$btnBrowse.Size = New-Object System.Drawing.Size(100, 26)
$btnBrowse.FlatStyle = "Flat"
$btnBrowse.BackColor = [System.Drawing.Color]::FromArgb(60, 60, 60)
$btnBrowse.ForeColor = [System.Drawing.Color]::White
$btnBrowse.Add_Click({
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "Wybierz folder HuntLista (AddOns\HuntLista)"
    if ($dlg.ShowDialog() -eq "OK") {
        $script:addonDir = $dlg.SelectedPath
        $txtPath.Text = $script:addonDir
        Save-Config
        Write-Log "Sciezka: $script:addonDir"
    }
})
$form.Controls.Add($btnBrowse)

$lblInt = New-Object System.Windows.Forms.Label
$lblInt.Text = "Interwal (minuty):"
$lblInt.Font = $fontNorm
$lblInt.Location = New-Object System.Drawing.Point(16, 108)
$lblInt.AutoSize = $true
$form.Controls.Add($lblInt)

$numInterval = New-Object System.Windows.Forms.NumericUpDown
$numInterval.Location = New-Object System.Drawing.Point(140, 106)
$numInterval.Size = New-Object System.Drawing.Size(60, 24)
$numInterval.Minimum = 1
$numInterval.Maximum = 120
$numInterval.Value = 5
$numInterval.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
$numInterval.ForeColor = [System.Drawing.Color]::White
$form.Controls.Add($numInterval)
$script:numInterval = $numInterval

$btnNow = New-Object System.Windows.Forms.Button
$btnNow.Text = "Update teraz"
$btnNow.Location = New-Object System.Drawing.Point(220, 104)
$btnNow.Size = New-Object System.Drawing.Size(110, 28)
$btnNow.FlatStyle = "Flat"
$btnNow.BackColor = [System.Drawing.Color]::FromArgb(70, 100, 160)
$btnNow.ForeColor = [System.Drawing.Color]::White
$btnNow.Add_Click({
    if (-not $script:addonDir) { $script:addonDir = $txtPath.Text.Trim() }
    Save-Config
    Update-Data | Out-Null
})
$form.Controls.Add($btnNow)

$btnToggle = New-Object System.Windows.Forms.Button
$btnToggle.Text = "Start auto"
$btnToggle.Location = New-Object System.Drawing.Point(340, 104)
$btnToggle.Size = New-Object System.Drawing.Size(146, 28)
$btnToggle.FlatStyle = "Flat"
$btnToggle.BackColor = [System.Drawing.Color]::LightGreen
$btnToggle.ForeColor = [System.Drawing.Color]::Black
$btnToggle.Add_Click({
    if (-not $script:addonDir) { $script:addonDir = $txtPath.Text.Trim() }
    if (-not $script:addonDir -or -not (Test-Path $script:addonDir)) {
        [System.Windows.Forms.MessageBox]::Show("Ustaw poprawna sciezke do folderu HuntLista.", "Hunt Lista")
        return
    }
    Save-Config
    if ($script:running) { Set-Running $false } else { Set-Running $true }
})
$form.Controls.Add($btnToggle)
$script:btnToggle = $btnToggle

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Text = "Status: gotowy"
$lblStatus.Font = $fontNorm
$lblStatus.Location = New-Object System.Drawing.Point(16, 148)
$lblStatus.AutoSize = $true
$lblStatus.ForeColor = [System.Drawing.Color]::LightGray
$form.Controls.Add($lblStatus)
$script:lblStatus = $lblStatus

$lblVersion = New-Object System.Windows.Forms.Label
$lblVersion.Text = "Wersja danych: -"
$lblVersion.Location = New-Object System.Drawing.Point(16, 172)
$lblVersion.AutoSize = $true
$form.Controls.Add($lblVersion)
$script:lblVersion = $lblVersion

$lblPlayers = New-Object System.Windows.Forms.Label
$lblPlayers.Text = "Graczy na liscie: -"
$lblPlayers.Location = New-Object System.Drawing.Point(200, 172)
$lblPlayers.AutoSize = $true
$form.Controls.Add($lblPlayers)
$script:lblPlayers = $lblPlayers

$lblLast = New-Object System.Windows.Forms.Label
$lblLast.Text = "Ostatni update: -"
$lblLast.Location = New-Object System.Drawing.Point(16, 194)
$lblLast.AutoSize = $true
$form.Controls.Add($lblLast)
$script:lblLast = $lblLast

$lblHint = New-Object System.Windows.Forms.Label
$lblHint.Text = "Po update w grze wpisz:  /reload"
$lblHint.ForeColor = [System.Drawing.Color]::Gold
$lblHint.Location = New-Object System.Drawing.Point(16, 218)
$lblHint.AutoSize = $true
$form.Controls.Add($lblHint)

$box = New-Object System.Windows.Forms.RichTextBox
$box.Location = New-Object System.Drawing.Point(16, 248)
$box.Size = New-Object System.Drawing.Size(470, 120)
$box.ReadOnly = $true
$box.BackColor = [System.Drawing.Color]::FromArgb(20, 20, 20)
$box.ForeColor = [System.Drawing.Color]::LightGray
$box.Font = New-Object System.Drawing.Font("Consolas", 8.5)
$form.Controls.Add($box)
$script:box = $box

$timer = New-Object System.Windows.Forms.Timer
$timer.Add_Tick({ Update-Data | Out-Null })
$script:timer = $timer

$script:addonDir = Find-AddonDir
if ($script:addonDir) {
    $txtPath.Text = $script:addonDir
    Write-Log "Znaleziono addon: $script:addonDir" "LightGreen"
} else {
    Write-Log "Ustaw sciezke do folderu HuntLista." "Orange"
}
Write-Log "Gotowy. Kliknij Update teraz albo Start auto."

$form.Add_FormClosing({
    $script:timer.Stop()
    Save-Config
})

[void]$form.ShowDialog()
