# Przeniesienie na drugą maszynę

Plugin działa z **OpenCode 2**. Sprawdzona wersja: `0.0.0-beta-19398`.
Instalacja wymaga Node.js 22+, npm, Git oraz GitHub CLI (`gh`) lub tokenu
`GITHUB_TOKEN`/`GH_TOKEN`. Poniższe komendy są dla macOS/Linux z Bash.
Model musi być skonfigurowany i działać w OpenCode 2 na drugiej maszynie.
Ustawienia modelu i logowanie nie przenoszą się razem z kodem pluginu.

## 1. Wypchnij źródła z obecnej maszyny

Utwórz na GitHubie puste repozytorium **opencode2-plugin** na koncie `d3cker`.
Nie dodawaj podczas tworzenia README, .gitignore ani licencji. Może być prywatne.
Następnie:

```bash
cd /Users/bartek/Documents/ChatGPT/opencode2-plugin
git add .gitignore README.md docs examples scripts src test package.json package-lock.json tsconfig.json tsconfig.test.json
git diff --cached --stat
git commit -m "Add OpenCode 2 issue automation plugin"
git remote add origin https://github.com/d3cker/opencode2-plugin.git
git push -u origin main
```

Jeżeli wybrałeś inną nazwę lub konto, zmień adres repozytorium w komendach.
Obecny lokalny katalog pluginu nie ma ustawionego `origin`. Jeżeli dodasz go
wcześniej, pomiń `git remote add`.
Do repo trafiają źródła i lockfile. `node_modules`, `dist`, archiwa, pliki `.env`
i lokalna konfiguracja OpenCode są ignorowane. Paczka ma `private: true`,
co blokuje przypadkowe `npm publish`; lokalne pakowanie nadal działa.

## 2. Przygotuj drugą maszynę

Sprawdź zainstalowane narzędzia:

```bash
node --version
npm --version
git --version
gh --version
opencode2 --version
```

Zaloguj GitHub CLI i skonfiguruj Git do klonowania/push przez HTTPS:

```bash
gh auth login
gh auth setup-git
gh auth status
```

Konto musi mieć możliwość dodawania komentarzy, pushowania branchy i tworzenia
PR-ów w docelowym repozytorium. Ustaw też tożsamość Git, jeśli jej nie masz:

```bash
git config --global user.name "Twoja nazwa"
git config --global user.email "Twoj adres email lub GitHub noreply"
```

## 3. Sklonuj dwa repozytoria

`$HOME` rozwija się do pełnej ścieżki katalogu użytkownika na drugiej maszynie
(np. `/Users/bartek` lub `/home/bartek`). Nie zależymy od nazwy użytkownika.
Katalog `opencode2-plugin` zawiera narzędzie; `bot-project` to projekt, w którym
bot ma wykonywać pracę. W drugiej komendzie `git clone` podaj repo projektu.

```bash
mkdir -p "$HOME/opencode-work"
git clone https://github.com/d3cker/opencode2-plugin.git "$HOME/opencode-work/opencode2-plugin"
git clone https://github.com/TWOJE_KONTO/TWOJ_PROJEKT.git "$HOME/opencode-work/bot-project"
```

Repo projektu musi mieć przynajmniej jeden commit wypchnięty na GitHub,
ustawiony `origin` i włączone issues. Zainstaluj również zależności projektu,
których będzie potrzebował model do pracy i uruchamiania testów.

**Na początek użyj osobnego repo testowego.** Plugin nie koordynuje dwóch
maszyn: uruchomienie obu na tych samych issues może powielić pracę. Ta procedura
instaluje nowego bota; nie migruje kolejki, sesji ani istniejących worktree.

## 4. Zainstaluj plugin jedną komendą

```bash
bash "$HOME/opencode-work/opencode2-plugin/scripts/install-local.sh" "$HOME/opencode-work/bot-project"
```

Skrypt instaluje zależności pluginu, buduje go, pakuje i instaluje w projekcie.
Następnie pyta o identyfikator modelu OpenCode 2 (`provider/model`). Podaj model
z tej maszyny. Jeżeli zapyta o testy: wpisz komendę testów projektu lub naciśnij
Enter, aby pominąć testy. Można też od razu użyć `--skip-tests`.
Nic nie jest publikowane w npm ani wysyłane na GitHub przez instalator.

Skrypt dodaje lokalne pliki instalacji do `.git/info/exclude` projektu,
aby nie trafiały przypadkiem do commitów. Nie ukrywa plików już śledzonych
przez Git. Konfiguracja pojawi się tutaj:

```text
$HOME/opencode-work/bot-project/.opencode/automation.json
```

Przykład (model zastąp swoim):

```json
{
  "model": "provider/model",
  "check": false,
  "trigger": "@d3ckerbot"
}
```

`check: false` pomija testy. Możesz ustawić np. `"check": ["npm", "test"]`.
Domyślny trigger to `@d3ckerbot`. Pole `authors`, np. `["d3cker", "kolega"]`,
pozwala wskazać autorów uprawnionych do zlecania pracy; bez tego pola bot
przyjmuje zadania zalogowanego użytkownika GitHuba.

## 5. Uruchom i sprawdź

Jeśli serwis OpenCode już działa, po instalacji przeładuj go, gdy nie wykonuje
pracy. Restart dotyczy wspólnego serwisu i może przerwać aktywne sesje:

```bash
opencode2 service restart
```

Otwórz projekt:

```bash
opencode2 "$HOME/opencode-work/bot-project"
```

Utwórz issue w repo projektu, opisz małą zmianę i dopisz `@d3ckerbot`.
Skan odbywa się co minutę i obejmuje również istniejące pasujące issues.
Najpierw dostaniesz komentarz z planem, potem ruszy sesja, a na końcu powstanie
PR. W OpenCode wpisz `/bot`, aby podejrzeć zadanie. Start sesji daje
powiadomienie i kartę w tle, jeśli masz włączone karty.

Nowy komentarz uprawnionego autora w obsługiwanym issue uruchamia kolejną
rundę i aktualizuje ten sam otwarty PR; nie wymaga kolejnej wzmianki.
Review PR-a i edycje istniejących komentarzy nie są obsługiwane.
Po zamknięciu issue albo zamknięciu/scaleniu PR-a dalsza runda jest blokowana.

Stan z drugiego terminala:

```bash
cd "$HOME/opencode-work/bot-project"
node "$HOME/opencode-work/bot-project/.opencode/node_modules/opencode2-automation/dist/setup.js" status
```

## Aktualizacje i zmiana projektu

Po wypchnięciu kolejnych zmian do repo pluginu:

```bash
git -C "$HOME/opencode-work/opencode2-plugin" pull --ff-only
bash "$HOME/opencode-work/opencode2-plugin/scripts/install-local.sh" "$HOME/opencode-work/bot-project"
```

Istniejący `automation.json` i kolejka są zachowywane. Przeładuj serwis,
gdy jest bezczynny, i ponownie otwórz klienta, jeśli aktualizacja dotyczy interfejsu.

Możesz instalować plugin w dowolnym kolejnym projekcie: sklonuj go do nowego
katalogu i podaj ten katalog instalatorowi. Nie zmieniaj `origin` już działającego
bota, aby przełączyć projekt — jego dotychczasowa kolejka należy do poprzedniego repo.
