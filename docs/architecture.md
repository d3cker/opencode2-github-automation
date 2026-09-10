# Scheduler i GitHub dispatcher dla OpenCode 2

Historyczny projekt architektury. Implementacja MVP już istnieje;
aktualna konfiguracja, zakres i ograniczenia są opisane w ../README.md.

## Platforma

Budujemy wyłącznie dla **OpenCode 2**. API: `@opencode/plugin`,
`Plugin.define({ id, setup })`, konfiguracja `plugins` i `ctx.options`.
Komunikacja między pluginami przez `Rpc.define`, `ctx.rpc.register` i `ctx.rpc`.
Cleanup z `setup` zatrzymuje timery i pracowników. `ctx.storage` przechowuje
trwałe dane pluginu. Nie zakładamy, że operacje storage zapewniają transakcje
lub atomowe blokady. Zdarzenia RPC są ulotne, więc nie stanowią kolejki zadań.

Źródła:
- https://opencode.ai/v2/docs/plugins/
- https://opencode.ai/v2/docs/build/plugins
- https://opencode.ai/v2/docs/build/plugins/rpc/

## Podział

### `opencode2-scheduler`

Ogólny mechanizm cyklicznego wykonywania zadań. Odpowiada za interwał,
uruchomienie ręczne, pauzę, retry z backoffem, brak nakładających się wywołań
i zapis wyniku ostatniego uruchomienia. Nie interpretuje issues ani modeli.

Na MVP interwał, np. 60 sekund. Cron i webhooki można dodać później.
Scheduler działa, kiedy uruchomiony jest serwer OpenCode 2; nie budzi
wyłączonego komputera ani zatrzymanej usługi.

### `opencode2-github-dispatcher`

Odpowiada za odczyt issues, rozpoznanie znacznika, kolejkę pracy, analizę,
komentarz, uruchomienie sesji wykonawczej, weryfikację wyniku i utworzenie PR-a.
Udostępnia schedulerowi RPC `scan`. Wywołanie skanu kończy się po zapisaniu
znalezionych zadań; nie czeka na ukończenie wszystkich fixów.

Dispatcher ma wewnętrzny adapter wykonawcy: `analyze`, `start`, `status`,
`cancel`. Początkowo korzysta z sesji OpenCode 2. Jeśli dispatcher jest już
osobnym istniejącym pluginem, adapter ma korzystać z jego kontraktu zamiast
powielać implementację. Wtedy całe rozwiązanie będzie miało trzy pluginy.

Nie wydzielamy teraz trzeciego pluginu tylko do wywołań GitHub API.

## Przebieg issue

1. Scheduler wywołuje `scan` dla skonfigurowanego repozytorium.
2. Dispatcher pobiera otwarte issues z paginacją i pomija pull requesty.
3. Pasujący znacznik w treści issue, np. `@deepseek`, wybiera profil wykonawcy.
4. Dispatcher zapisuje zadanie z kluczem `repozytorium + numer issue`.
5. Analiza przygotowuje opis problemu, zakres i plan sprawdzenia poprawki.
   Może czytać kod, ale nie modyfikuje projektu.
6. Dispatcher publikuje ten opis jako komentarz i potwierdza jego zapis.
7. Dopiero wtedy uruchamia pracę nad poprawką w osobnym worktree i branchu.
8. Wykonawca zmienia kod i uruchamia odpowiednie sprawdzenia projektu.
9. Dispatcher weryfikuje wynik, publikuje branch i tworzy PR z odniesieniem
   `Closes #<numer>`, opisem zmiany oraz wynikami sprawdzeń.

Jeśli analiza, komentarz, poprawka lub sprawdzenia zawiodą, zadanie zachowuje
stan błędu albo blokady. PR wymaga rzeczywistej poprawki; nie tworzymy pustego
PR-a wyłącznie po to, by zakończyć proces.

## Trwałość i wznowienia

Proponowane stany:

`queued → analyzing → commented → running → verifying → publishing → pr_opened`

Dodatkowo: `retry_wait`, `blocked`, `failed`, `cancelled`.

- Zapisujemy ID komentarza, sesji, branch, worktree, PR, etap i liczbę prób.
- Komentarz zawiera deterministyczny ukryty znacznik. Po niepewnym wyniku
  publikacji sprawdzamy GitHub przed ponownym wysłaniem.
- Przed tworzeniem PR-a sprawdzamy, czy istnieje już PR dla brancha zadania.
- Restart odtwarza kolejkę i uzgadnia stan sesji oraz GitHuba, zanim wznowi pracę.
- Ponowny skan lub edycja issue nie uruchamiają drugiego fixa. Powtórzenie
  zakończonego zadania wymaga jawnego retry z nową generacją zadania.
- Na MVP jeden właściciel automatyzacji dla repozytorium i jedno aktywne issue.
  Nie uruchamiamy automatycznie kolejnych schedulerów w roboczych worktree.
  Wiele procesów wymaga osobnego mechanizmu atomowej koordynacji.
- Brak dostępnego RPC dispatchera oznacza retry skanu, nie utratę zadania.

## Proponowana konfiguracja MVP

Nazwy pakietów i poniższy schemat opcji są projektowane, jeszcze niedostępne.

```json
{
  "plugins": [
    {
      "package": "opencode2-github-dispatcher",
      "options": {
        "repositories": ["owner/repository"],
        "tokenEnv": "GITHUB_TOKEN",
        "routes": {
          "@deepseek": {
            "agent": "build",
            "model": { "providerID": "<provider>", "id": "<model>" }
          }
        },
        "maxConcurrentIssues": 1
      }
    },
    {
      "package": "opencode2-scheduler",
      "options": {
        "jobs": [
          {
            "id": "github-issues",
            "everySeconds": 60,
            "handler": "github.scan"
          }
        ]
      }
    }
  ]
}
```

`github.scan` będzie zarejestrowanym adapterem handlera używającym RPC.
Znacznik jest aliasem konfiguracyjnym, a nie nazwą modelu przekazywaną wprost.
Identyfikatory providera i modelu trzeba dobrać z instalacji użytkownika.
MVP dopasowuje pełny znacznik bez rozróżniania wielkości liter, tylko w body
issue. Kilka różnych pasujących tras oznacza blokadę wymagającą wyboru.
Obsługę wyzwalania z komentarzy można dodać osobno.

Repozytoria i osoby uprawnione do uruchamiania pracy muszą mieć jawną politykę
w konfiguracji. Treść issue jest danymi wejściowymi, nie może zmieniać tych
ustawień ani poświadczeń. Token nie jest zapisywany w opcjach i logach.

## Kolejność implementacji

1. Kontrakty RPC i typy stanów; scheduler z ręcznym uruchomieniem i fake handlerem.
2. Skan GitHuba, routing, deduplikacja i trwała kolejka.
3. Analiza oraz potwierdzona publikacja komentarza przed startem wykonawcy.
4. Adapter sesji OpenCode 2, izolacja repozytorium i weryfikacja zmian.
5. Publikowanie PR-ów, uzgadnianie niepewnych wyników i wznowienia.

Najważniejsze testy: brak startu fixa po błędzie komentarza, brak duplikatów
po restarcie, timeout po skutecznej publikacji komentarza/PR-a, nakładające się
skany, routing znacznika, paginacja, izolacja katalogów i obsługa błędów sesji.
