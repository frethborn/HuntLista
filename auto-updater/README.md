# Hunt Lista - Auto Updater

Prosty program z oknem (Windows), ktory co X minut sciaga `Data.lua` z GitHuba
i nadpisuje plik w folderze addona.

## Start

1. Pobierz cały folder `auto-updater`, w tym `HuntLista-Data.ps1`
2. Dwuklik **`Start-AutoUpdater.bat`**
3. Sprawdz / wybierz sciezke do folderu `HuntLista`
4. Ustaw interwal (np. 5 minut)
5. **Update teraz** = jednorazowo
6. **Start auto** = petla co X minut

## Po update

W grze: `/reload`

Przed podmianą updater sprawdza UTF-8, składnię i strukturę danych bez wykonywania kodu Lua. Błędne pobranie daje status `BLAD` i pozostawia działający plik oraz backup bez zmian. Podmiana jest atomowa; `Data.lua.bak` zachowuje poprzednią poprawną wersję. Uszkodzony lokalny plik nie nadpisuje tej kopii. Walidacja korzysta z wbudowanego .NET, bez instalowania Node.js lub Lua.

## Uwagi

- Program musi byc uruchomiony w tle podczas gry
- WoW nie moze sam sciagac plikow z internetu - dlatego to zewnetrzny tool
- Wymaga Windows + PowerShell (wbudowany w system)
