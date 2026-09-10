# OpenCode 2 Automation

Jedna paczka: scheduler + GitHub dispatcher.

`@d3ckerbot` w issue → komentarz z planem → poprawka → testy → PR.

## Instalacja z repozytorium

**OpenCode 2**, Node.js 22+, npm i Git. Sprawdzona wersja OpenCode:
`0.0.0-beta-19398`. Model i dostęp do GitHuba muszą działać na danej maszynie.

Po sklonowaniu źródeł i docelowego projektu wystarczy:

```bash
bash /absolute/path/to/opencode2-plugin/scripts/install-local.sh /absolute/path/to/project
```

Instalator buduje lokalną paczkę i dodaje plugin serwera oraz interfejsu do
projektu. Pyta o model; Enter przy pytaniu o testy pozwala je pominąć.
Przy aktualizacji zachowuje istniejącą konfigurację. Nie restartuje serwisu.

**[Pełna instrukcja: wypchnięcie źródeł i instalacja na drugiej maszynie](docs/installation.md)**

Nie trzeba publikować paczki w npm. Repozytorium zawiera źródła i lockfile;
archiwum instalacyjne powstaje lokalnie. `private: true` blokuje `npm publish`.

Tytuł każdego nowego PR-a dobiera model po zakończeniu pracy, na podstawie
zgłoszenia i podsumowania wykonanej zmiany. Nie ma stałego prefiksu `Fix`.
Tytuł jest zapisywany przed publikacją i zachowywany przy ponowieniu próby.

## Podgląd pracy i kolejne komentarze

Gdy sesja startuje, w otwartym OpenCode 2 pojawia się powiadomienie i karta
w tle. Komenda `/bot` pokazuje zadania i pozwala otworzyć sesję. Jeśli karty
są wyłączone, sesję nadal otworzysz przez `/bot`.

Nowy komentarz uprawnionego autora w obsługiwanym issue uruchamia kolejną
rundę: odpowiedź z planem, poprawka i push do tego samego otwartego PR-a.
Nie trzeba ponawiać wzmianki. Komentarze podczas pracy czekają na następną
rundę. Wzmianka w komentarzu może też rozpocząć obsługę nowego issue.
Edycje komentarzy i komentarze w review PR-a nie są obsługiwane.
Zamknięty lub scalony PR blokuje dalszą rundę.

Przy aktualizacji starszej lokalnej instalacji zainstaluj nową paczkę i wykonaj:

```sh
./.opencode/node_modules/.bin/opencode2-automation upgrade
opencode2 service restart
```

`upgrade` dodaje interfejs i zachowuje konfigurację. Otwórz ponownie klienta
OpenCode 2, aby załadować nowy komponent interfejsu.

## Inny projekt lub model

Jeśli nie można wykryć testów, konfigurator zapyta o komendę. **Enter pomija
testy** i zapisuje `check: false`. Możesz też przekazać `--skip-tests`, aby
pominąć pytanie. PR wyraźnie informuje wtedy, że testy nie zostały uruchomione;
sprawdzenia spójności Git i wymaganie rzeczywistej poprawki pozostają aktywne.
Możesz również
skonfigurować projekt bez pytań:

```sh
opencode2-automation init --model provider/model --check pytest
```

Opcjonalne ustawienia w `.opencode/automation.json`: `trigger`, `everySeconds`,
`check` (tablica argumentów komendy) i `authors` (loginy GitHuba).
Domyślny znacznik to `@d3ckerbot`. Zmienisz go, dodając np.
`"trigger": "@mojbot"` do tego pliku i restartując serwis.
Konfigurator nie nadpisuje istniejącego pliku.

Po instalacji dostępne są także `opencode2-automation status`, `scan`, `pause`
i `resume`, uruchamiane w katalogu repozytorium. Pauza zatrzymuje nowe skany;
przyjęte już zadania pozostają w kolejce.

Szczegóły kolejki, retry, uprawnień, ograniczeń i osobnego użycia obu pluginów:
[dokumentacja zaawansowana](docs/advanced.md).

## Dla autora paczki

```sh
npm ci
npm run check
npm pack
```

`npm pack` kompiluje źródła i tworzy archiwum instalacyjne. Publikacja do npm
jest zablokowana przez `private: true`. Plugin używa wyłącznie SDK OpenCode 2; wymaga Node.js 22+.
