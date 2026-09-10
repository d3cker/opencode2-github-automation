# Zaawansowana konfiguracja osobnych komponentów

Zwykła instalacja jednej paczki i konfigurator są opisane w głównym README.
Poniższy wariant jest przeznaczony dla własnych harmonogramów, kilku repozytoriów
i osobnego ładowania schedulera oraz dispatchera.

Dwa pluginy w jednym projekcie TypeScript:

- **Scheduler** (`automation.scheduler`) wywołuje skonfigurowane RPC w interwałach.
- **GitHub dispatcher** (`automation.github`) prowadzi issue przez analizę,
  komentarz, poprawkę w worktree, sprawdzenia projektu i pull request.

Wyłącznie API V2: `@opencode/plugin`, `Plugin.define`, `ctx.rpc` oraz konfiguracja
`plugins`. SDK i klient są przypięte do `0.0.0-beta-19398`. Nie używamy API V1.

## Uruchomienie

1. Zainstaluj Node.js 22 lub nowszy i działający OpenCode 2 z kompatybilnym API beta.
2. W tym katalogu wykonaj:

   ```sh
   npm ci
   npm run check
   ```

3. Skopiuj zawartość `examples/advanced.opencode.jsonc` do konfiguracji projektu,
   z którego będzie działać automatyzacja. Uzupełnij wszystkie ścieżki,
   repozytoria, autorów, agenta, model i komendy sprawdzające.
4. Ustaw `GITHUB_TOKEN` w środowisku **procesu serwera OpenCode 2**. Token
   użytkownika musi mieć dostęp do wskazanego repozytorium oraz uprawnienia
   Issues i Pull requests do odczytu/zapisu. W MVP używamy tokenu użytkownika
   (np. fine-grained PAT), ponieważ autor komentarza jest uzgadniany przez `/user`.
5. Skonfiguruj Git w istniejącym checkoutcie: `origin` wskazujący to repozytorium
   GitHuba, `user.name`, `user.email` i działające uwierzytelnienie do push.
   Push korzysta z konfiguracji Git/SSH/credential helpera; token REST nie jest
   przekazywany do procesu Git. Nie umieszczaj tokenu w URL remote.
6. Uruchom projekt w OpenCode 2 albo przeładuj usługę poleceniem
   `opencode2 service restart`. Upewnij się, że uruchomiona usługa otrzymała token.

To lokalne pluginy ładowane z dwóch skompilowanych plików, a nie opublikowane
pakiety npm. Zmiany w tym repo wymagają ponownego `npm run build` i przeładowania.
Nie dodawaj równolegle kopii tych samych pluginów do `.opencode/plugins`.

Pierwszy skan startuje automatycznie. Obejmuje również istniejące otwarte issues
z pasującym znacznikiem. Automatyzacja działa tylko przy uruchomionym serwerze.

## Konfiguracja

Pełny przykład w repozytorium źródłowym: `examples/advanced.opencode.jsonc`.

| Opcja | Znaczenie |
| --- | --- |
| `ownerDirectory` | Absolutna ścieżka projektu będącego właścicielem automatyzacji. Pozostałe instancje pluginu, w tym worktree wykonawcy, pozostają nieaktywne. |
| `stateDirectory` | Prywatny katalog na kolejkę, blokady i worktree. Wskaż ten sam katalog w obu pluginach; nie zmieniaj go przy wznowieniu. |
| `repositories` | Lista repozytoriów z istniejącym checkoutem, branchem bazowym, autorami i komendami sprawdzającymi. |
| `allowedAuthors` | Loginy autorów issues, które wolno podejmować. Lista jest obowiązkowa. |
| `checks` | Lista komend w postaci tablic argumentów, np. `["npm", "test"]`. `[]` pomija testy; PR zawiera informację o ich pominięciu. Każda skonfigurowana komenda musi zakończyć się kodem 0. Shell nie jest dodawany automatycznie. |
| `routes` | Mapowanie znacznika na agenta i model dostępny w Twojej instalacji. |
| `workerEverySeconds` | Jak często dispatcher sprawdza kolejkę; domyślnie 5. |
| `sessionTimeoutSeconds` | Maksymalny czas pojedynczego oczekiwania na sesję; domyślnie 3600. |
| `commandTimeoutSeconds` | Limit pojedynczej komendy Git lub sprawdzającej; domyślnie 600. |
| `maxAttempts` | Maksymalna liczba prób danego etapu po błędach; domyślnie 5. |
| `jobs[].everySeconds` | Interwał zadania schedulera. |
| `jobs[].rpcID`, `method`, `input` | Docelowe RPC, jego metoda i argumenty JSON. Domyślnie `automation.github`, `scan`, `{}`. |

Scheduler jest ogólny: inny plugin może udostępnić własne RPC i być wywoływany
przez kolejne zadanie. Metoda powinna być idempotentna; timeout transportu nie
gwarantuje, że serwer nie wykonał wywołania.

Wykonawca musi mieć skonfigurowane w OpenCode uprawnienia odpowiednie do pracy
nad repozytorium. Plugin nie zatwierdza automatycznie pytań o uprawnienia.
Brakujące zależności projektu można zainstalować jako pierwszą komendę `checks`
albo zgodnie z instrukcjami repozytorium podczas sesji.

## Obsługa

Polecenia korzystają z klienta V2 i wykrywają już działającą lokalną usługę.
Podawaj katalog `ownerDirectory`, nawet jeśli bieżąca sesja jest w worktree.

```sh
node dist/manage.js status /absolute/path/to/owner-project
node dist/manage.js scan /absolute/path/to/owner-project
node dist/manage.js run /absolute/path/to/owner-project github-issues
node dist/manage.js pause /absolute/path/to/owner-project github-issues
node dist/manage.js resume /absolute/path/to/owner-project github-issues
node dist/manage.js retry /absolute/path/to/owner-project 'owner/repository#123'
```

`pause` zatrzymuje przyszłe skany tego zadania schedulera, również ręczne `run`.
Nie zatrzymuje już zapisanej kolejki dispatchera ani aktywnej sesji.
Bezpośrednie `scan` działa niezależnie od pauzy schedulera.

`retry` przyjmuje tylko zadania `blocked` lub `failed` i wznawia ich etap.
Jeśli sesja zawiodła lub dostarczenie promptu jest niepewne, najpierw obejrzyj
jej stan i worktree, a następnie możesz jawnie wybrać nową sesję:

```sh
node dist/manage.js retry /absolute/path/to/owner-project 'owner/repository#123' --restart-session
```

Ta opcja przerywa starą sesję i wykorzystuje istniejący worktree z jego zmianami.
Nie usuwa kodu ani nie publikuje drugiego komentarza. Jeśli treść issue zmieniła
się po analizie, zadanie pozostaje zablokowane: MVP nie regeneruje automatycznie
opublikowanego planu. Nowy komentarz uprawnionego autora automatycznie rozpoczyna kolejną rundę zakończonego zadania i aktualizuje ten sam otwarty PR.

## Przebieg i wznowienia

Znacznik rozpoznajemy w **body issue lub komentarzu uprawnionego autora**, bez rozróżniania wielkości liter.
`@d3ckerbot-extra` ani adres e-mail nie pasują do `@d3ckerbot`. Kilka różnych
pasujących tras blokuje zadanie. PR-y zwracane przez API issues są pomijane.

```text
queued → analyzing → commented → running → verifying → publishing → pr_opened
```

Analiza generuje opis na podstawie zgłoszenia, bez narzędzi i bez zmian w kodzie.
Komentarz zawiera opis problemu, proponowaną pracę i plan weryfikacji; zaznacza,
że kod nie został jeszcze zbadany. Dopiero potwierdzony komentarz pozwala
utworzyć worktree i wysłać prompt wykonawczy.

Stan jest zapisywany atomowo do JSON. Zapamiętujemy analizę, ID komentarza,
sesję, etap, branch, worktree, bazowy commit, wynik sprawdzeń i PR.
Po timeoutach publikacji sprawdzamy istniejący komentarz/PR przed ponowną próbą.
Prompt z niepewnym wynikiem nie jest automatycznie wysyłany drugi raz.
Sesja musi zakończyć się sukcesem; następnie dispatcher sam wykonuje `checks`,
sprawdza diff, tworzy commit i wykonuje push bez force.

Jednocześnie wykonujemy jedno issue. Kolejka z błędem sieci podczas pracy sesji
najpierw uzgadnia jej stan, zanim rozpocznie następne issue. Błędy przechodzą
w backoff, a brak poprawki, nieudane sprawdzenia lub niejednoznaczny wynik
wymagają interwencji. Wyniki oraz komunikaty błędów odczytasz przez `status`.

Blokady mają heartbeat i czas wygaśnięcia 30 sekund. Po gwałtownym zakończeniu
procesu odczekaj ten czas przed ponownym załadowaniem pluginu. Nie kasuj aktywnej
blokady ani kolejki. Worktree i branche pozostają po zakończeniu do przeglądu;
MVP nie sprząta ich automatycznie.

## Granice MVP

- Jeden właściciel automatyzacji dla danego zestawu repozytoriów, na jednym
  komputerze. Wspólny `stateDirectory` zapobiega podwójnemu procesowi; niezależne
  katalogi stanu lub komputery nie zapewniają wspólnej koordynacji.
- Polling interwałowy issues i nowych komentarzy, bez crona i webhooków.
  Edycje komentarzy i review PR-ów nie uruchamiają pracy. Po zamknięciu lub
  scaleniu PR-a kolejna runda jest blokowana.
- GitHub.com i token użytkownika; bez GitHub Enterprise i tokenów instalacji App.
- Worktree izoluje pliki projektu, ale nie jest sandboxem dla narzędzi agenta.
  Autorzy issues i uprawnienia wykonawcy muszą być świadomie skonfigurowani.
- Auto-merge wymaga akceptacji uprawnionego autora dla aktualnej publikacji; szczegóły i konfiguracja są w README. PR powstaje tylko przy rzeczywistej zmianie i
  przejściu skonfigurowanych sprawdzeń.
- Testy lokalne używają rzeczywistego Git i SDK V2 oraz atrap GitHub API i sesji.
  Nie zastępują testu integracyjnego z Twoim serwerem, modelem i repozytorium.

Źródła API: [pluginy V2](https://opencode.ai/v2/docs/build/plugins),
[RPC V2](https://opencode.ai/v2/docs/build/plugins/rpc/),
[klient V2](https://opencode.ai/v2/docs/build/client),
[GitHub issues](https://docs.github.com/en/rest/issues/issues),
[komentarze](https://docs.github.com/en/rest/issues/comments),
[pull requesty](https://docs.github.com/en/rest/pulls/pulls).
