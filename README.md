# OpenCode 2 GitHub Automation

A scheduler and GitHub dispatcher in one package, built for **OpenCode 2**.

`@opencodebot` in an issue → acknowledgement and plan → implementation → verification → pull request.

The model chooses each new PR title from the issue and completed-work summary.
There is no fixed `Fix` prefix. The chosen title is saved before publication and
reused if publication needs a retry.

## Requirements

- OpenCode 2 with a working model. Tested with `0.0.0-beta-19398`.
- Node.js 22+, npm, and Git.
- GitHub authentication through `gh auth login`, or `GITHUB_TOKEN`/`GH_TOKEN`
  in the server environment.
- Permission to comment, push branches, and create PRs in the target repository.
- A target repository with a GitHub `origin`, an existing default-branch commit,
  and issues enabled.

The package is installed from source; publishing to npm is unnecessary.
`private: true` prevents accidental publication while still allowing `npm pack`.

## 1. Install the plugin globally

Run these steps on the machine that will run OpenCode 2. You do not need a target
project yet. `$HOME` expands to your user's absolute home directory.

1. Clone and build the plugin:

   ```bash
   git clone https://github.com/d3cker/opencode2-github-automation.git "$HOME/opencode2-github-automation"
   cd "$HOME/opencode2-github-automation"
   npm ci && npm run build
   ```

2. Register the plugin and its terminal UI:

   ```bash
   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/opencode-automation"
   printf 'export { default } from "%s";\n' "$HOME/opencode2-github-automation/dist/index.js" > "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/opencode-automation/index.js"
   printf 'export { default } from "%s";\n' "$HOME/opencode2-github-automation/dist/tui.js" > "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/opencode-automation/tui.js"
   ```

   Run this registration once; do not overwrite customized loaders.

3. Restart the service when sessions are idle, then reopen your OpenCode client:

   ```bash
   opencode2 service restart
   ```

Installed. No project is automated yet. Keep the plugin source directory:
OpenCode loads the compiled code from its `dist` folder.

## 2. Configure a project

Use an existing Git checkout with a GitHub `origin`. Replace
`/absolute/path/to/your-project` with its actual absolute path.
Authenticate first with `gh auth login` and `gh auth setup-git` if needed.

1. Enter the target repository and start the wizard:

   ```bash
   cd /absolute/path/to/your-project
   node "$HOME/opencode2-github-automation/dist/setup.js" init
   ```

   Each prompt shows a default in brackets. Press Enter to accept it or type
   another value. The wizard asks for model, trigger, signature, allowed authors,
   polling interval, automatic merging, merge method, and test command.
   Do not add `--local`.

   Defaults: the detected OpenCode model, `@opencodebot`, your GitHub login with
   `[OpenCode2]`, your GitHub login as the allowed author, 60 seconds, automatic
   merging enabled, squash, and detected tests (or `skip` if none are found).
   If no model can be detected from the running service, enter `provider/model`.
   Enter accepts detected tests; type `skip` to disable them. Complex test commands
   can be entered as JSON argument arrays, e.g. `["npm", "run", "test:unit"]`.

2. Review `/absolute/path/to/your-project/.opencode/automation.json`.
   To allow a colleague to request work, add their GitHub login to `authors`:

   ```json
   {
     "model": "local/deepseek",
     "signature": "YOUR_LOGIN[OpenCode2]",
     "authors": ["YOUR_LOGIN", "COLLEAGUE_LOGIN"],
     "autoMerge": {
       "enabled": true,
       "method": "squash"
     },
     "check": false
   }
   ```

   Use your actual model and usernames. Without `authors`, only the authenticated
   GitHub user can request work. Auto-merge also requires the approving user to
   have repository write access.

3. Restart the idle service and open the target project:

   ```bash
   opencode2 service restart
   opencode2 /absolute/path/to/your-project
   ```

Create an issue containing `@opencodebot`. The bot checks once a minute; `/bot`
shows progress. Existing matching issues may also be picked up.

**Code is global; configuration is per project.** Only repositories containing
`.opencode/automation.json` are activated. Run the wizard in another checkout to
add another project. Existing configuration files are never overwritten by `init`.

## 3. Update an existing installation

Run this on the machine with the global installation. Wait for active bot work
to finish first.

1. Download updates for the branch you currently use:

   ```bash
   cd "$HOME/opencode2-github-automation"
   git pull --ff-only
   ```

2. Install dependencies and rebuild:

   ```bash
   npm ci && npm run build
   ```

3. Reload the service:

   ```bash
   opencode2 service restart
   ```

Reopen the terminal client if the update changes the UI. Project configuration
and queues remain in place. Do not repeat global registration or run `init` again.

### Changes in this version

The default trigger is now `@opencodebot`. Existing explicit `trigger`, `signature`,
and `authors` settings are preserved. If an older configuration omitted `trigger`,
set it explicitly before upgrading to retain the old mention (for example,
`"trigger": "@your-existing-bot"`). The built-in merge phrases are now English;
custom phrases can still be configured in any language.

Existing global loader directories may be named `d3ckerbot`. Keep those loaders
when updating; do not register a second copy under `opencode-automation`. When
uninstalling, use the name of the directory you originally created.

### Switch to the feature branch for testing

Replace update step 1 with:

```bash
cd "$HOME/opencode2-github-automation"
git fetch origin
git switch codex/english-setup-defaults
git pull --ff-only
```

Then complete update steps 2 and 3. The approval and signature features described
below are available on this branch (`0.4.0-beta.2`).

## 4. Remove automation from one project

This disables the project configured through `init`; the global plugin remains
available for other projects. Wait for bot sessions to finish first.

1. Remove that project's configuration (confirm the deletion when prompted):

   ```bash
   rm -i /absolute/path/to/your-project/.opencode/automation.json
   ```

2. Restart the service:

   ```bash
   opencode2 service restart
   ```

3. Reopen the client. The bot no longer scans, starts work, or merges PRs for
   this project. Other configured projects continue working.

Removing the file alone does not stop an already-loaded worker; the restart
applies the change. Queue data, worktrees, branches, and GitHub issues/PRs are
preserved. Running `init` again re-enables the project and may resume its saved
queue. If configuration was instead supplied through plugin options in
`opencode.json`, remove those options or disable that plugin entry as well.

## 5. Uninstall the global plugin

For the global installation described above, wait for active work to finish.

1. Remove only this plugin's two global loaders:

   ```bash
   rm -i "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/opencode-automation/index.js" "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/opencode-automation/tui.js"
   ```

2. Restart the service:

   ```bash
   opencode2 service restart
   ```

3. Close and reopen OpenCode clients to unload the terminal UI.

The source checkout, project settings, and saved work remain on disk. Separate
project-local installations are unaffected; their loaders live under each
project's `.opencode/plugins/automation/` directory.

## Configuration files and Git branches

- `.opencode/automation.json` is a **file in the target checkout**, not in the
  plugin's source repository. Creating it does not automatically upload it.
- With the global installation, `init` does **not** add a Git ignore rule.
  An ordinary `git add .` can therefore stage it unless your repository already
  ignores it. The alternative `install-local.sh` installer does add local
  exclusions automatically.
- Keep machine-specific configuration untracked. From the target checkout,
  add a local ignore rule that is not itself committed:

  ```bash
  cd /absolute/path/to/your-project
  printf '\n/.opencode/automation.json\n' >> "$(git rev-parse --git-path info/exclude)"
  ```

- Check whether Git already tracks it:

  ```bash
  git ls-files -- .opencode/automation.json
  ```

  No output means it is untracked. If the path appears, ignoring it is not
  enough: use `git rm --cached -- .opencode/automation.json` and commit that
  removal to stop versioning it on the current branch. The local file stays.
- An untracked, ignored file normally stays in place during branch switches.
  If another branch tracks that same path, Git can replace it; keep a backup
  before switching to such branches. A tracked file follows branch contents
  and can change or disappear when you switch. OpenCode does not restore it.
  `git clean -fdx` also deletes ignored files.
- A separate clone or worktree does not automatically inherit an untracked
  configuration. The scheduler only activates in the primary checkout.
  Bot-created worktrees are used for implementation, without starting another
  scheduler. Queue data lives under the shared Git directory in
  `opencode2-automation/` and is not uploaded by Git push.

## Configuration

A minimal configuration is:

```json
{
  "model": "provider/model"
}
```

Use a model available in your own OpenCode 2 installation. Optional fields:

| Field | Purpose |
| --- | --- |
| `trigger` | Mention that starts work; defaults to `@opencodebot`. |
| `everySeconds` | Polling interval; defaults to 60 seconds. |
| `check` | Test command as an argument array, such as `["npm", "test"]`; `false` skips tests. |
| `authors` | GitHub usernames allowed to request work and authorize merging (merge also requires repository write access). |
| `signature` | Signature appended to every posted comment and PR description; defaults to `your-github-login[OpenCode2]`. |
| `autoMerge` | Automatic merge settings: `enabled` (default `true`), `method` (default `squash`), and exact approval `comments`. |

When tests are skipped, the PR explicitly reports that automated tests were not
run. Git consistency checks and the requirement for an actual change remain.
Restart the service while idle after changing configuration.

For noninteractive setup, use `--yes` to accept defaults for omitted options.
Provide the model and a test command (or explicitly skip tests):

```bash
cd /absolute/path/to/your-project
node "$HOME/opencode2-github-automation/dist/setup.js" init --model provider/model --skip-tests --yes
```

## Automatic merge and message signatures

Example project configuration:

```json
{
  "model": "provider/model",
  "check": false,
  "signature": "YOUR_LOGIN[OpenCode2]",
  "autoMerge": {
    "enabled": true,
    "method": "squash",
    "comments": ["/merge", "lgtm, merge", "approved, merge"]
  }
}
```

For a PR created by this bot, either approve the current published commit using
GitHub's **Approve** review, or post one of the configured full-message phrases
in the PR conversation. Matching ignores case, repeated whitespace, and final
periods/exclamation marks. Arbitrary positive prose, quoted commands, negations,
and inline code review comments are not interpreted as merge instructions.

The approving account must be in `authors` (by default, the authenticated user)
and have write, maintain, or admin permission on the repository. GitHub does not
allow authors to approve their own PRs; use a configured comment in that case.
Outstanding change requests block merge. The PR must be open, non-draft, and
reported as clean and mergeable by GitHub. The merge request includes the exact
verified head SHA; a changed branch cannot be merged using an older approval.
The bot does not request a protection bypass. Configure required checks and review
rules on GitHub for your repository's policy.

Approvals must be newer than the bot's latest publication. On upgrade, old tasks
start watching for new approvals; historical approvals do not cause a merge.
Pending issue feedback is processed before attempting a merge. Merge failures
are retried at intervals of at least 60 seconds and appear as `mergeError` in
`status` and in `/bot`. Successful merges receive a signed PR comment.

Signatures are appended to issue comments, PR descriptions, and merge
acknowledgements. They identify the message in its text; GitHub still attributes
posts to the account authenticated by your token. Existing posts are not rewritten.
Set `"autoMerge": { "enabled": false }` to disable automatic merging.

## Follow progress and continue work

Starting a session shows a notification and opens a background tab when tabs
are enabled. Use `/bot` to list tasks and open a session.

A new comment from an authorized author on a tracked issue starts another round:
acknowledgement, implementation, and a push to the same open PR. The mention does
not need to be repeated. Comments received during execution wait for the next
round. A mention in an authorized comment can also start work on an untracked issue.

Edits to existing comments and PR review comments are not supported. Closing the
issue or closing/merging the PR blocks further rounds.

Management commands run from the target repository:

```bash
cd /absolute/path/to/your-project
node "$HOME/opencode2-github-automation/dist/setup.js" status
node "$HOME/opencode2-github-automation/dist/setup.js" scan
node "$HOME/opencode2-github-automation/dist/setup.js" pause
node "$HOME/opencode2-github-automation/dist/setup.js" resume
```

Pausing stops scheduled scans; it does not cancel accepted tasks or active sessions.
Do not run independent bots on two machines against the same issues: they do not
share queue ownership across machines.

## Alternative: install only in one project

If you have not installed the plugin globally, the local installer builds,
packs, and installs it inside a target checkout:

```bash
bash "$HOME/opencode2-github-automation/scripts/install-local.sh" /absolute/path/to/your-project
```

It prompts for configuration on first installation and preserves existing settings
on upgrades. It does not restart OpenCode. Use either global or project-local
installation; do not enable both for the same project.

## Development

```bash
npm ci
npm run check
npm pack
```

`npm run check` runs type checking, tests, and a build. `npm pack` produces a local
installation archive. Build artifacts, dependencies, and local credentials are
excluded from the source repository.

Additional documentation:

- [Moving the source and installing on another machine](docs/installation.md)
- [Advanced configuration, retries, permissions, and separate plugins](docs/advanced.md)
