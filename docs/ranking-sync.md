# Automatyczny wspólny ranking — 1.4.0

Po jednorazowej konfiguracji nie trzeba wpisywać `/hunt kill` dla nowych zabójstw wykrytych automatycznie. Zmiana obejmuje addon, opcjonalny endpoint dotychczasowego bota i program synchronizujący na komputerze gracza. Kod jest przygotowany do wdrożenia; hosting i HTTPS musi skonfigurować administrator. Bez `RANKING_SYNC_CONFIG` bot działa jak dotąd.

## Kiedy wynik trafia do rankingu

```
potwierdzone zabójstwo → dziennik addona → /reload lub wylogowanie
    → plik WTF/SavedVariables → program gracza → HTTPS → bot → Data.lua na GitHubie
```

WoW utrwala SavedVariables przy przeładowaniu UI lub wylogowaniu. Dlatego nie jest to synchronizacja natychmiastowa podczas nieprzerwanej sesji gry. Korzystamy z normalnego zapisu zadeklarowanego w `.toc`, a nie z odczytu pamięci gry, wykonywania pobranego Lua czy ograniczonego combat logu. [Przykład SavedVariables w kodzie Blizzarda](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_AuctionHouseUI/Blizzard_AuctionHouseUI.toc).

Program domyślnie sprawdza plik co 30 sekund. Discord `/hunt kills` odczyta nowy ranking z GitHuba bez dodatkowego zgłoszenia. Aby zobaczyć go w grze, nadal trzeba pobrać `Data.lua` dotychczasowym updaterem i wykonać `/reload`.

## Administrator bota — jednorazowe wdrożenie

1. Najpierw wdroż kod wykrywania z PR #5, potem cały ten zestaw zmian. Zatrzymaj stare procesy bota i podmień cały folder `HuntListaBot`; nie uruchamiaj jednocześnie starej wersji zapisującej `Data.lua`. Node.js 22 LTS lub nowszy, `npm ci`. Dotychczasowe zmienne Discord/GitHub pozostają na serwerze.
2. Skopiuj `ranking-server.example.json` do `ranking-server.json`. Dla każdego użytkownika wygeneruj **inny** klucz:
   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```
   Wpisz klucz do `token`. W `characters` wpisz GUID-y z `/hl status` oraz przypisane im pełne nicki; jeden GUID może należeć do jednego reportera. Etykiety administratora, a nie dane nadesłane przez gracza, określają `lastKillBy` w rankingu. `id` to krótka nazwa techniczna użytkownika.
3. W `.env` dodaj `RANKING_SYNC_CONFIG=./ranking-server.json`, a następnie uruchom bota jak dotąd przez `npm start` (z folderu `HuntListaBot`). Endpoint słucha wyłącznie na `127.0.0.1:3210`.
4. Wystaw `/v1/kills` przez istniejący reverse proxy z HTTPS. Przykład konfiguracji Caddy na tym samym hoście, po skierowaniu własnej domeny na serwer:
   ```caddyfile
   sync.example.org {
       reverse_proxy 127.0.0.1:3210
   }
   ```
   Zastąp domenę własną. Publiczne DNS i dostępne porty wymagane przez konfigurację certyfikatów zapewnia administrator. [Dokumentacja Caddy: HTTPS](https://caddyserver.com/docs/automatic-https), [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). Przy kontenerach proxy musi mieć dostęp do loopback procesu bota, np. przez wspólną przestrzeń sieciową; samo przekierowanie portu kontenera nie udostępnia serwera słuchającego na loopback.
5. Przekaż użytkownikowi **wyłącznie jego** klucz, adres HTTPS i listę przypisanych GUID-ów. Plik konfiguracyjny serwera powinien być czytelny tylko dla konta uruchamiającego bota. Nie udostępniaj tokenów GitHuba ani Discorda. Zmiana/revokacja klucza wymaga edycji pliku i restartu bota.

To import od zaufanych członków gildii, podobnie jak ręczne zgłoszenia `/hunt kill`. Klucz ogranicza użytkownika do przypisanych postaci, lecz nie jest kryptograficznym dowodem zabójstwa z serwera gry: właściciel komputera może zmienić swój plik. Nie należy otwierać importu anonimowo.

## Gracz — konfiguracja i użycie

1. Zainstaluj cały addon **1.4.0**, razem z `RankingSync.lua`, `KillDetection.lua` i `.toc`. Uruchom grę ponownie. Odczytaj GUID przez `/hl status` i przekaż go administratorowi, aby otrzymać klucz dla swojej postaci.
2. Zainstaluj Node.js 22 LTS lub nowszy. Pobierz cały folder `HuntListaBot` do osobnego katalogu na komputerze i wykonaj w nim `npm ci`. **Nie uruchamiaj `npm start` i nie konfiguruj tokenów Discorda/GitHuba na komputerze gracza.**
3. Skopiuj `ranking-companion.example.json` do `ranking-companion.json`, uzupełnij adres i klucz od administratora. `characters` zawiera tylko GUID-y przydzielone do tego klucza.
4. `savedVariables` ma wskazywać **zapis gry**:
   ```text
   World of Warcraft/_forever_/WTF/Account/NAZWA_KONTA/SavedVariables/HuntLista.lua
   ```
   To inny plik niż `Interface/AddOns/HuntLista/Data.lua`. W JSON używaj `/` albo podwójnych `\\`. Plik powstanie po `/reload`/wylogowaniu z włączonym addonem. Jeden program może obsłużyć wskazane postacie z jednego konta WoW; dla innego pliku uruchom osobną konfigurację.
5. Uruchom `Start-RankingSync.bat` albo:
   ```sh
   npm run sync -- ranking-companion.json
   ```
   Pozostaw program uruchomiony. Można go uruchamiać przy logowaniu do Windows; samo zamknięcie programu nie kasuje oczekujących danych. `Ctrl+C` zatrzymuje program. Jednorazowa próba: `npm run sync -- ranking-companion.json --once`.
6. Dopiero po konfiguracji włącz dla każdej postaci `/hl rankingsync on`. Synchronizacja domyślnie jest **OFF**. Eksportuje wyłącznie nowe potwierdzone zabójstwa; nie importuje starych lokalnych liczników, ręcznego `/hl kill` ani powiadomień odbieranych od gildii.
7. Po zabójstwie wykonaj `/reload` albo wyloguj się. Program powinien zgłosić potwierdzony zapis GitHuba. `/hl status` pokazuje liczbę zapisów w dzienniku, **nie** liczbę wysłanych danych. Nie wpisuj dodatkowo `/hunt kill` dla tego samego zabójstwa — ręczne zgłoszenie i import to dwa różne działania.

`/hl rankingsync off` zatrzymuje dopisywanie nowych zdarzeń. Już zapisane nadal mogą zostać wysłane. Aby wstrzymać również wysyłkę, zatrzymaj program. Nie kasuj i nie edytuj dziennika w trakcie działania gry. Po awarii lub przywróceniu starszej kopii zapisu nie usuwaj rejestru po stronie serwera, aby „wymusić” ponowienie.

## Ponawianie i zgodność danych

- Dziennik zawiera liczniki narastające dla postaci, strumienia zapisu i pełnego nicku ofiary. Bot dolicza tylko przyrost ponad zapamiętaną wartość. To pozwala bezpiecznie ponawiać wysyłkę po utracie sieci, restarcie lub utracie odpowiedzi po udanym zapisie.
- Rejestr odebranych wartości jest komentarzem `-- HuntListaSyncLedger v1: ...` na początku `Data.lua`. Licznik i rejestr trafiają do **tego samego zapisu GitHuba z kontrolą SHA**. Nie wykonuje się osobnego, podatnego na awarię zapisu „potwierdzenia”. Rejestr zawiera hasze kluczy zdarzeń i wartości liczników, bez tokenów.
- Ręczne komendy nowego bota zachowują rejestr, również `/hunt killreset`. Starsze wersje bota lub ręczne odtworzenie `Data.lua` bez tego komentarza mogą utracić historię importu. Przed naprawą/odtworzeniem rankingu zatrzymaj importer i zachowaj rejestr. Nie usuwa się go ani nie skraca automatycznie.
- Nieznana lub niejednoznaczna nazwa jest pomijana i oznaczana jako przetworzona, by jej późniejsze dodanie nie naliczyło historycznego zabójstwa. Program raportuje liczbę pominięć. Skróty nicków nie są dopasowywane.
- Limity: 64 postacie i 256 nazw na postać w dzienniku, licznik do 1 miliarda, SavedVariables do 8 MiB; maksymalnie 50 rekordów/64 KiB w żądaniu oraz 4096 pozycji rejestru w `Data.lua`. Pełny lub niepoprawny rejestr blokuje zapis zamiast wymazywać historię. Po osiągnięciu limitu potrzebna jest świadoma migracja przez administratora, nie usunięcie komentarza.
- Program wyłącznie czyta plik gry. Nie uruchamia Lua i nie nadpisuje plików w `WTF`. Konfiguracje z kluczami są ignorowane przez Git. Endpointy inne niż HTTPS są odrzucane, poza adresem loopback do lokalnych testów; przekierowania HTTP nie są śledzone.

### Przywrócenie starszej kopii gry

Jeśli licznik w pliku jest niższy niż już odebrany przez bota, program zgłasza starszy zapis i zatrzymuje się z kodem 2. Nie potwierdza wtedy pełnej synchronizacji; w komunikacie podaje również ewentualne przyrosty innych rekordów z tej samej próby. Starsza kopia lub drugi program czytający nieaktualny plik nie mogą cofnąć rankingu.

W takim przypadku zatrzymaj wszystkie programy synchronizujące, wyłącz `/hl rankingsync off` dla danej postaci i zachowaj kopię aktualnego pliku. Po zamknięciu gry przywróć ostatnią poprawną kopię SavedVariables w porozumieniu z administratorem. Zabójstwa zdobyte już po cofnięciu zapisu trzeba uzgodnić osobno przed ponownym włączeniem eksportu. Nie zeruj strumienia ani rejestru GitHuba, aby ominąć komunikat.

Automatyczne odzyskanie skasowanych danych nie jest możliwe. Jeśli po odtworzeniu starego pliku zdążysz zdobyć tyle nowych zabójstw, że licznik osiągnie poprzednią wartość, samo porównanie liczników nie rozpozna tej sytuacji; może być potrzebna ręczna korekta administratora. Dlatego nie przywracaj starszych SavedVariables przy działającej synchronizacji.

## Próba odbiorcza

1. Sprawdź `/hl status`, działanie natywnego wykrywania i stan ON. Zanotuj wynik `/hunt kills`.
2. Zadaj rzeczywisty śmiertelny cios graczowi z listy. Po `/reload` poczekaj na komunikat programu. Ranking powinien wzrosnąć o 1, bez `/hunt kill`.
3. Uruchom program ponownie z tym samym plikiem i wykonaj kolejne `/reload` bez zabójstwa. Ranking nie powinien wzrosnąć.
4. Wyłącz chwilowo program, zdobądź kolejny kill i zapisz grę. Po uruchomieniu programu oczekiwany przyrost to 1. Po restarcie nie powinno być kolejnego przyrostu.

Walidacja w repo obejmuje Lua/Fengari → serializację SavedVariables → parser programu → import do atrapy GitHuba, realny lokalny serwer HTTP, ponowienia po utracie potwierdzeń, częściowe pakiety, równoległe zapisy, autoryzację i zgodność komentarza z updaterem PowerShell 5.1. Nie przeprowadzono wdrożenia na hostingu administratora ani próby w żywym WoW.
