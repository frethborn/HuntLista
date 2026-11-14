# Hunt Lista

Gildyjny addon do **WoW Forever** — wspólna lista graczy PvP do oznaczania ("hunt list").

Gdy ktoś z listy pojawi się w grze, dostajesz **alert**, **dźwięk** i **czerwoną czaszkę** przy nameplate / targetcie.
Po śmierci wyskakuje **okienko z nickiem zabójcy** do skopiowania, jeśli gra wysłała rozpoznany komunikat o Twojej śmierci. Sam target nie jest uznawany za zabójcę.
Jeśli dostępny jest tylko log obrażeń, okno pokazuje **„Ostatni atak”** z informacją, że zabójca nie jest potwierdzony. Tekst może zawierać nazwę umiejętności. Późniejszy komunikat potwierdzający zabójcę zastępuje tę wskazówkę; po wskrzeszeniu dane są czyszczone.

Lista jest wspólna dla gildii: dodajecie ludzi przez **bota na Discordzie**, a addon ściąga aktualne dane z tego repo.

---

## Funkcje

| Funkcja | Opis |
|--------|------|
| Lista hunt | Wspólna baza graczy (nick + powód + kto dodał) |
| Czaszka na nameplate | Czerwona ikona przy osobach z listy |
| Alert + dźwięk | Raid warning gdy ktoś z listy jest w pobliżu / na targetcie |
| Okno listy | `/hl` — podgląd całej listy |
| Okienko po śmierci | Nick zabójcy do skopiowania (Ctrl+C) |
| Powiadomienia gildii | Kto zabił gracza z listy — komunikat i dźwięk dla członków gildii z addonem |
| Automatyczny ranking (opcjonalny) | Nowe potwierdzone zabójstwa → zapis po `/reload`/wylogowaniu → program gracza → bot → GitHub |
| Updater (ręczny) | Jednorazowe ściągnięcie `Data.lua` |
| **Auto Updater** | Okno Windows — aktualizacja bazy co X minut |
| Discord bot | `/hunt add` / `remove` / `list` → push na GitHub |
| Tryb testowy | Alerty także na sojusznikach (do testów) |

---

## Instalacja addona

1. Pobierz folder [`HuntLista/`](https://github.com/frethborn/HuntLista/tree/main/HuntLista)
2. Wrzuć folder `HuntLista` do:
   ```
   World of Warcraft\_forever_\Interface\AddOns\
   ```
3. Na ekranie wyboru postaci włącz **Hunt Lista**.
4. W grze: `/hl` — powinno otworzyć listę.

W folderze addona muszą być m.in.:
```
HuntLista.toc
Data.lua
Core.lua
UI.lua
Alerts.lua
Death.lua
Kills.lua
RankingSync.lua
KillDetection.lua
GuildKills.lua
```

---

## Komendy w grze

| Komenda | Opis |
|--------|------|
| `/hl` | Otwiera listę huntowanych graczy |
| `/hl status` | Wersja addona, wersja danych, liczba graczy, status modułów |
| `/hl reload` | Przeładowuje listę z `Data.lua` (bez `/reload` gry) |
| `/hl test` | **Tryb testowy ON** — alertuje też sojuszników |
| `/hl test off` | Tryb testowy OFF — tylko wroga frakcja |
| `/hl death` | Włącza okienko po śmierci |
| `/hl death off` | Wyłącza okienko po śmierci |
| `/hl killer` | Test okienka zabójcy (target albo przykładowy nick) |
| `/hl killer Nick` | Test okienka z podanym nickiem |
| `/hl check` | Debug: target / mouseover — czy jest na liście |
| `/hl debug` | Włącza/wyłącza logi w chacie |
| `/hl close` | Zamyka okienko zabójcy |
| `/hl guildkills on` | Włącza wysyłanie i odbieranie powiadomień o zabójstwach |
| `/hl guildkills off` | Wyłącza powiadomienia o zabójstwach dla tej instalacji addona |
| `/hl kills` | Wspólny ranking i osobny licznik lokalny |
| `/hl kill Nick` | Ręczna korekta lokalna; wspólny ranking zmienia `/hunt kill Nick` na Discordzie |
| `/hl rankingsync on` | Włącza eksport nowych automatycznych zabójstw tej postaci (wymaga konfiguracji programu i bota) |
| `/hl rankingsync off` | Zatrzymuje dopisywanie nowych zabójstw do eksportu |

Alias: `/huntlista` działa tak samo jak `/hl`.

### Powiadomienia o zabójstwach w gildii

Wersja **1.3.9** wykrywa zabójstwa przez natywne zdarzenie Forever `PARTY_KILL`: sprawdza, czy śmiertelny cios należał do Ciebie lub Twojego peta, czy ofiarą jest gracz i czy pełny nick jednoznacznie pasuje do listy. Imię i nazwisko są odczytywane razem. Śmierć targetu, asysta lub zabójstwo innego członka grupy nie wystarczają.

Nadawca powinien mieć **1.3.9 lub nowszą**; odbiorcy mogą mieć **1.3.0 lub nowszą**. Wszyscy muszą być online w tej samej gildii. Powiadomienia są domyślnie włączone. Addon wysyła informację ukrytym kanałem addonowym `GUILD`. Pozostali zobaczą komunikat „Zabójstwo: kto → kogo” i usłyszą dźwięk zgodnie ze swoim ustawieniem `sound`. Zwykły czat gildyjny pozostaje bez nowych wpisów.

Wiadomości nie zwiększają lokalnych liczników odbiorców i nie są przekazywane dalej. Powtórzenia tego samego zgłoszenia są tłumione przez 3 sekundy. Odbiorca może mieć starszą listę i nadal otrzyma powiadomienie.

Jeśli klient ukrywa GUID lub nazwę (`secret values`), addon pomija zdarzenie. Gdy zniknie token jednostki, może użyć pełnego nicku zaobserwowanego dla dokładnie tego GUID-u na targetcie, mouseover lub nameplate w ostatnich 120 sekundach (pamięć maksymalnie 256 graczy). Nie zgaduje nazwiska po pierwszym słowie. Brak pełnego nicku oznacza brak naliczenia. Rozpoznany komunikat w pierwszej osobie, np. `You have slain Mega Enemy.`, pozostaje dodatkowym źródłem potwierdzenia; duplikaty obu źródeł są tłumione wspólnie.

`/hl status` pokazuje rejestrację wykrywania, liczbę zdarzeń od `/reload`, naliczenia z listy oraz pominięcia przez ukryte dane, brak nicku i cudzego zabójcę. Sama rejestracja nie potwierdza otrzymania zabójstwa. Błędy wysyłania są pokazane lokalnie. [Źródła API i procedura sprawdzenia w grze](docs/forever-kill-detection.md).

Domyślnie automatyka zmienia **lokalny licznik i wysyła powiadomienie w grze**. Od **1.4.0** można też włączyć [automatyczną synchronizację wspólnego rankingu](docs/ranking-sync.md). Wymaga programu na komputerze gracza oraz endpointu HTTPS bota i działa po zapisaniu danych gry przez `/reload` lub wylogowanie. Eksport jest domyślnie wyłączony; `/hl rankingsync on` obejmuje tylko nowe automatyczne zabójstwa. Bez konfiguracji pozostaje `/hunt kill Nick` na Discordzie. Nie zgłaszaj ręcznie tego samego zabójstwa, które eksportujesz. `/hl kill Nick` jest wyłącznie korektą lokalną.

Instalacja tej funkcji wymaga aktualizacji całego folderu `HuntLista`, w tym `RankingSync.lua`, `KillDetection.lua`, `GuildKills.lua` i pliku `.toc`, oraz ponownego uruchomienia gry po dodaniu nowego modułu. Updatery pobierające tylko `Data.lua` nie instalują nowego kodu addona.

---

## Aktualizacja listy graczy

Lista żyje w `HuntLista/Data.lua`. Gdy ktoś doda osobę przez Discord, plik zmienia się na GitHubie — trzeba go zaciągnąć do gry.

### Opcja A — Auto Updater (zalecane)

Folder: [`auto-updater/`](https://github.com/frethborn/HuntLista/tree/main/auto-updater)

1. Pobierz cały folder `auto-updater`, razem z `HuntLista-Data.ps1`
2. Odpal **`Start-AutoUpdater.bat`**
3. Ustaw ścieżkę do `HuntLista` (często wykryje sam)
4. Ustaw interwał (np. 5 minut) → **Start auto**
5. Po każdym update w grze:`/reload`

Program musi działać w tle przy grze (WoW sam nie ściąga plików z netu).

### Opcja B — Updater jednorazowy

1. Pobierz cały folder [`updater/`](https://github.com/frethborn/HuntLista/tree/main/updater), razem z `HuntLista-Data.ps1`
2. Odpal **`Update-HuntLista.bat`**
3. W grze: `/reload`

### Opcja C — ręcznie

1. Pobierz [Data.lua](https://raw.githubusercontent.com/frethborn/HuntLista/main/HuntLista/Data.lua)
2. Nadpisz `Interface\AddOns\HuntLista\Data.lua`
3. W grze: `/reload`

---

## Flow w gildii

```
Discord  →  /hunt add Nick "powod"
    ↓
Bot zapisuje Data.lua na GitHubie
    ↓
Auto Updater / updater sciaga Data.lua
    ↓
W grze /reload  →  czaszka + alert dzialaja
```

Po śmierci przeciwnika:
```
Smierc → okienko z nickiem → Ctrl+C → /hunt add na Discordzie
```

---

## Discord bot (dla adminów)

Folder: [`HuntListaBot/`](https://github.com/frethborn/HuntLista/tree/main/HuntListaBot)

### Komendy na Discordzie

| Komenda | Opis |
|--------|------|
| `/hunt add <nick> [powód]` | Dodaje gracza na listę |
| `/hunt remove <nick>` | Usuwa z listy |
| `/hunt list` | Pokazuje aktualną listę |
| `/hunt info <nick>` | Szczegóły wpisu |

### Szybki setup

1. [Discord Developer Portal](https://discord.com/developers/applications) — stwórz bota, skopiuj token
2. Zaproś bota (scope: `bot` + `applications.commands`)
3. GitHub → Personal Access Token z uprawnieniem `repo`
4. W folderze bota:
   ```bash
   cp .env.example .env
   # uzupelnij DISCORD_TOKEN, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO
   npm install
   npm start
   ```

Bot odczytuje `Data.lua` z GitHuba przed każdą komendą. Plik w repozytorium jest źródłem danych; brak lub uszkodzenie starego `local_data.json` nie zeruje listy. Ten lokalny plik nie jest już używany. Przed aktualizacją bota zachowaj jego kopię, jeśli zawiera zmiany, których poprzednia wersja nie wysłała na GitHuba, i dodaj brakujące wpisy ponownie przez Discord.

Komendy zmieniające dane (`/hunt add`, `remove`, `kill`, `killreset`) dopasowują **pełny nick**, bez rozróżniania wielkości liter. Skrót nie usuwa wpisu ani nie zmienia jego licznika. `/hunt add Audit` tworzy osobnego gracza `Audit`, nawet gdy istnieje `Audit Alpha`; aktualizacja wymaga wpisania `Audit Alpha`.

Odczyt danych nie wykonuje kodu Lua. Niepoprawny format, brak pliku lub błąd odczytu blokują zapis. Komendy zmieniające listę są wykonywane kolejno, a konflikt SHA z innym zapisem wymaga ponowienia komendy. Przy niepewnym wyniku połączenia najpierw sprawdź `/hunt list`.

Testy regresji (Node.js 22+): w folderze `HuntListaBot` uruchom `npm ci` i `npm test`. Testy obejmują zapis/odczyt tekstu Lua, operacje na liście z atrapą GitHuba, wykrywanie zabójcy, licznik, dźwięki oraz powiadomienia między symulowanymi klientami gildii z atrapami API WoW. Sprawdzają też dziennik SavedVariables, program synchronizujący, lokalny serwer HTTP i bezpieczne ponawianie importów rankingu. Na Windows uruchamiają Windows PowerShell 5.1: sprawdzają zgodność walidatora z parserem bota, podmianę plików, backup, błędy pobierania/zapisu i oba updatery. Ten test jest pomijany na innych systemach. Testy wymagają połączeń do loopback, ale nie potrzebują prawdziwych tokenów, zewnętrznego GitHuba ani gry; pliki powstają w izolowanym katalogu tymczasowym.

Opcjonalne wdrożenie importu rankingu: [instrukcja administratora i gracza](docs/ranking-sync.md). Nowy bot zachowuje komentarz `HuntListaSyncLedger` w `Data.lua`; nie usuwaj go ani nie uruchamiaj starego bota zapisującego ten plik po uruchomieniu importu.

---

## Struktura repo

```
HuntLista/          ← addon do skopiowania do AddOns
  HuntLista.toc
  Core.lua
  Alerts.lua
  UI.lua
  Death.lua
  Data.lua
HuntListaBot/       ← bot Discord + push na GitHub
updater/            ← jednorazowy updater Windows
auto-updater/       ← auto updater z GUI (co X minut)
```

---

## Uwagi (WoW Forever)

- Nicki ze **spacją** (np. `Mega Chad`) — gra często zwraca tylko pierwsze słowo w API; addon stara się je uzupełniać z nameplate’ów i listy.
- Domyślnie alerty tylko na **przeciwną frakcję**. Do testów: `/hl test`.
- Po zmianie `Data.lua` zawsze `/reload` albo `/hl reload`.
- Czerwony komunikat Blizzarda o „blocked action” przy śmierci — kliknij **Ignore**; na listę i czaszkę nie wpływa.
- W `Death.lua` eventy wpinają się z lekkim opóźnieniem po logowaniu (omija błędy protected `RegisterEvent` na Forever).

---

**Repo:** [frethborn/HuntLista](https://github.com/frethborn/HuntLista)
