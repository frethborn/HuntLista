# Wykrywanie zabójstw na Forever

Stan analizy: 14 listopada 2026, addon 1.3.9. Źródła klienta: Forever **1.60.1 (70938)**, commit `bebcb6bf309cf41b41bd74f8ca651e6a105b2676` w eksporcie kodu UI Blizzarda.

Aktualizacja 1.4.0: potwierdzone zabójstwa można także eksportować do [wspólnego rankingu przez program poza grą](ranking-sync.md). Wymaga to osobnej konfiguracji i włączenia; poniższa analiza dotyczy wykrywania zabójstw w kliencie.

## Co potwierdzają źródła

- [`PARTY_KILL(attackerGUID, targetGUID)`](https://github.com/Gethe/wow-ui-source/blob/bebcb6bf309cf41b41bd74f8ca651e6a105b2676/Interface/AddOns/Blizzard_APIDocumentationGenerated/UnitDocumentation.lua#L3724-L3733) jest osobnym zdarzeniem ramki. Nie wymaga odczytu combat logu. Payload może być ukryty przy ograniczeniu tożsamości jednostek (`SecretWhenUnitIdentityRestricted`).
- [`UnitTokenFromGUID`](https://github.com/Gethe/wow-ui-source/blob/bebcb6bf309cf41b41bd74f8ca651e6a105b2676/Interface/AddOns/Blizzard_APIDocumentationGenerated/UnitDocumentation.lua#L3295-L3310) pozwala znaleźć token ofiary, ale może zwrócić nil lub wartość ukrytą. Kod weryfikuje, czy `UnitGUID(token)` nadal odpowiada ofierze.
- [Kod nazw Camelot/Forever](https://github.com/Gethe/wow-ui-source/blob/bebcb6bf309cf41b41bd74f8ca651e6a105b2676/Interface/AddOns/Blizzard_FrameXMLUtil/Camelot/NameUtil.lua#L13-L19) łączy dwie wartości `UnitNameUnmodified`: imię i nazwisko. Nie używamy cache'u opartego na pierwszym słowie ani nie dopisujemy do nicku siódmej wartości `GetPlayerInfoByGUID`, którą [kod Blizzarda traktuje jako nazwę serwera](https://github.com/Gethe/wow-ui-source/blob/bebcb6bf309cf41b41bd74f8ca651e6a105b2676/Interface/AddOns/Blizzard_SharedXML/UnitUtil.lua#L21-L31).
- [`COMBAT_LOG_EVENT_UNFILTERED`](https://github.com/Gethe/wow-ui-source/blob/bebcb6bf309cf41b41bd74f8ca651e6a105b2676/Interface/AddOns/Blizzard_APIDocumentationGenerated/CombatLogDocumentation.lua#L129-L136) ma ograniczenia. Addon nie próbuje go rejestrować ani korzystać z `C_CombatLogSecure`.
- [Autor Killing Blow Forever](https://www.curseforge.com/wow/addons/killing-blow-forever-with-auto-guild-emblems) opisuje tę samą ścieżkę dla własnych/petowych zabójstw PvP i pomijanie ukrytych GUID-ów. To dodatkowe świadectwo autora, nie test HuntListy w grze.

Wniosek: istnieje publiczna ścieżka automatycznego rozpoznawania własnego śmiertelnego ciosu. Nie daje gwarancji wykrycia każdego zabójstwa w każdym trybie PvP. Sam wzrost honoru, śmierć targetu lub `UNIT_DIED` nie identyfikują zabójcy i nie są używane jako potwierdzenie.

## Zachowanie addona

1. `PARTY_KILL` musi wskazać GUID naszej postaci lub bieżącego peta jako zabójcę, a GUID gracza jako ofiarę.
2. Jawne imię i nazwisko ofiary muszą dokładnie pasować do pełnego wpisu na liście (bez rozróżniania wielkości liter). Przypadki niejednoznaczne są pomijane.
3. Jeśli token już zniknął, można użyć obserwacji dokładnie tego samego GUID-u z ostatnich 120 sekund. Cache jest wyłącznie w pamięci, maksymalnie 256 wpisów. Nie tworzy powiązań na podstawie podobieństwa nicków.
4. Ukryte GUID-y, tokeny i części nazw są odrzucane przed porównywaniem, formatowaniem i wyszukiwaniem. Przy ukrytej bieżącej nazwie/tokenie cache nie służy jako obejście.
5. Naliczany jest lokalny kill i wysyłane jest powiadomienie do członków gildii z addonem. Zdarzenie i tekst czatu korzystają ze wspólnej dotychczasowej deduplikacji 3 sekund. Ręczny `/hl kill` nie rozsyła powiadomienia. Wspólny ranking nadal wymaga `/hunt kill` na Discordzie.

## Walidacja bez gry

Testy Lua z atrapami API sprawdzają rzeczywiste wejście przez zarejestrowane zdarzenie: własny/petowy kill, cudzy zabójca, NPC, śmierć bez potwierdzenia, duplikaty, Unicode i nazwiska z łącznikiem, znikające i ponownie użyte tokeny, limit/wiek cache'u, ukryte dane, niedostępne API, blokadę rejestracji, przełączniki i ponowienie wysyłki. Cały addon jest sprawdzany parserem Lua 5.1.

Nie wykonano próby w żywym kliencie Forever. Testy z atrapami potwierdzają logikę obsługi, a nie dostarczanie zdarzeń przez konkretną instalację gry.

## Próba w grze

1. Zainstaluj cały addon 1.3.9 (w tym `KillDetection.lua` i `.toc`), uruchom ponownie grę. Drugi członek gildii powinien mieć addon z włączonymi powiadomieniami i być online.
2. Sprawdź `/hl status`: wersję, listę, `PARTY_KILL zarejestrowany` i gotowość komunikacji gildii. Zachowaj wartości liczników. Sprawdź `/hl kills` przed próbą.
3. Przy rzeczywistym PvP z graczem o pełnym nicku z listy zadaj śmiertelny cios sam lub petem. Oczekiwane: lokalny licznik +1, jeden lokalny alert i jeden alert u drugiego członka gildii. Samo uczestnictwo w zabójstwie nie wystarcza.
4. Ponownie sprawdź `/hl status`. Wzrost `zdarzenia` dowodzi otrzymania eventu; `naliczone z listy` oznacza naliczenie przez tę ścieżkę. `ukryte dane` albo `brak pelnego nicku` wyjaśniają pominięcie. `cudzy zabojca` oznacza zdarzenie grupowe nieprzypisane do Ciebie/peta.
5. Dla próby negatywnej obserwuj śmierć tej osoby zadaną przez innego członka grupy. Twój lokalny licznik nie powinien wzrosnąć. Samo testowe okno lub dźwięk nie potwierdzają wykrywania zabójstw.

Jeśli zdarzeń nie przybywa, do dalszej diagnozy potrzebne są wersja/build klienta (`/dump GetBuildInfo()`), kontekst PvP (otwarty świat/pole bitwy) i wynik `/hl status` przed oraz po próbie. Nie włączaj ograniczonego combat logu jako obejścia.
