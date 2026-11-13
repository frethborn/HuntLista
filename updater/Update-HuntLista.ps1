# ============================================================
# Hunt Lista - Updater v1.3 (prosty, stabilny)
# ============================================================

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'HuntLista-Data.ps1')
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoOwner = "frethborn"
$RepoName  = "HuntLista"
$RawUrl    = "https://raw.githubusercontent.com/frethborn/HuntLista/main/HuntLista/Data.lua"
$ConfigFile = Join-Path $PSScriptRoot "updater-config.txt"

function Pause-Exit($code = 0) {
    Write-Host ""
    Read-Host "  Nacisnij Enter, aby zamknac"
    exit $code
}

Clear-Host
Write-Host ""
Write-Host "  ======================================" -ForegroundColor Red
Write-Host "       HUNT LISTA  -  UPDATER" -ForegroundColor Red
Write-Host "  ======================================" -ForegroundColor Red
Write-Host ""

# --- folder addona ---
$addonDir = $null

if (Test-Path $ConfigFile) {
    $saved = (Get-Content $ConfigFile -Raw -ErrorAction SilentlyContinue)
    if ($saved) {
        $saved = $saved.Trim()
        if ($saved -and (Test-Path $saved)) {
            $addonDir = $saved
            Write-Host "  Znaleziono zapisana sciezke." -ForegroundColor DarkGray
        }
    }
}

if (-not $addonDir) {
    $candidates = @(
        "${env:ProgramFiles(x86)}\World of Warcraft\_forever_\Interface\AddOns\HuntLista",
        "${env:ProgramFiles}\World of Warcraft\_forever_\Interface\AddOns\HuntLista",
        "$env:USERPROFILE\Games\World of Warcraft\_forever_\Interface\AddOns\HuntLista",
        "D:\World of Warcraft\_forever_\Interface\AddOns\HuntLista",
        "E:\World of Warcraft\_forever_\Interface\AddOns\HuntLista",
        "C:\Games\World of Warcraft\_forever_\Interface\AddOns\HuntLista",
        "D:\Games\World of Warcraft\_forever_\Interface\AddOns\HuntLista",
        "C:\Program Files (x86)\World of Warcraft\_forever_\Interface\AddOns\HuntLista"
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) {
            $addonDir = $p
            Write-Host "  Automatycznie znaleziono folder addona." -ForegroundColor DarkGray
            break
        }
    }
}

if (-not $addonDir) {
    Write-Host "  Nie znaleziono folderu HuntLista automatycznie." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Podaj PELNA sciezke do folderu HuntLista." -ForegroundColor Gray
    Write-Host "  Przyklad:" -ForegroundColor DarkGray
    Write-Host "  C:\Program Files (x86)\World of Warcraft\_forever_\Interface\AddOns\HuntLista" -ForegroundColor DarkGray
    Write-Host ""
    $inputPath = Read-Host "  Sciezka"
    $inputPath = $inputPath.Trim().Trim('"').Trim("'")
    if (-not $inputPath -or -not (Test-Path $inputPath)) {
        Write-Host ""
        Write-Host "  [BLAD] Taka sciezka nie istnieje." -ForegroundColor Red
        Pause-Exit 1
    }
    $addonDir = $inputPath
}

try { $addonDir | Set-Content -Path $ConfigFile -Encoding UTF8 -Force } catch {}

$targetFile = Join-Path $addonDir "Data.lua"

Write-Host ""
Write-Host "  Folder addona : $addonDir" -ForegroundColor Cyan
Write-Host "  Plik docelowy : $targetFile" -ForegroundColor DarkGray
Write-Host "  Zrodlo        : $RawUrl" -ForegroundColor DarkGray
Write-Host ""

if (-not (Test-Path $addonDir)) {
    Write-Host "  [BLAD] Folder addona nie istnieje." -ForegroundColor Red
    Write-Host "  Usun updater-config.txt i sprobuj ponownie." -ForegroundColor Yellow
    Pause-Exit 1
}

Write-Host "  Pobieram najnowsza liste z GitHuba..." -ForegroundColor Yellow

try {
    $info = Update-HuntListaData -Uri $RawUrl -TargetPath $targetFile
    $version = $info.Version
    $lastUpdate = $info.LastUpdate
    $playerCount = $info.PlayerCount

    Write-Host ""
    Write-Host "  ======================================" -ForegroundColor Green
    Write-Host "   AKTUALIZACJA UDANA" -ForegroundColor Green
    Write-Host "  ======================================" -ForegroundColor Green
    Write-Host "  Wersja danych  : $version" -ForegroundColor White
    if ($lastUpdate) { Write-Host "  Ostatnia zmiana: $lastUpdate" -ForegroundColor White }
    Write-Host "  Graczy na liscie: $playerCount" -ForegroundColor White
    Write-Host ""
    Write-Host "  W grze wpisz:  /reload" -ForegroundColor Yellow
    Write-Host ""
}
catch {
    Write-Host ""
    Write-Host "  [BLAD] Nie udalo sie pobrac / zapisac pliku:" -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Sprawdz internet / uprawnienia (Administrator)." -ForegroundColor Yellow
    Write-Host ""
    Pause-Exit 1
}

Pause-Exit 0
