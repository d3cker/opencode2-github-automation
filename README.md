# OpenCode 2 GitHub Automation

A scheduler and GitHub dispatcher in one package, built for **OpenCode 2**.

`@d3ckerbot` in an issue → acknowledgement and plan → implementation → verification → pull request.

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

## Global installation: configure projects later

On macOS or Linux with Bash, clone and build the plugin:

```bash
git clone https://github.com/d3cker/opencode2-github-automation.git "$HOME/opencode2-github-automation"
cd "$HOME/opencode2-github-automation"
npm ci
npm run build
```

Add the server and terminal UI entrypoints to OpenCode's global plugin directory:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/d3ckerbot"
printf 'export { default } from "%s";\n' "$HOME/opencode2-github-automation/dist/index.js" > "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/d3ckerbot/index.js"
printf 'export { default } from "%s";\n' "$HOME/opencode2-github-automation/dist/tui.js" > "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/d3ckerbot/tui.js"
```

These commands create loader files; do not overwrite them if you have customized
existing loaders at those paths. Keep the source directory in place: the global
installation imports its compiled files directly.

If OpenCode's service is running, restart it when sessions are idle:

```bash
opencode2 service restart
```

Reopen the terminal client to load the UI component. The scheduler remains
inactive in projects without `.opencode/automation.json`.

## Configure a project after global installation

Run the wizard from the root of the repository the bot should work on.
Replace the example target path with your checkout's absolute path:

```bash
cd /absolute/path/to/your-project
node "$HOME/opencode2-github-automation/dist/setup.js" init
```

Use `init` without `--local` for the global installation. The wizard asks for
an OpenCode 2 model identifier (`provider/model`), detects the GitHub repository,
default branch, authenticated account, and supported project test command.
If it asks for a test command, press Enter to skip tests.

The wizard creates `.opencode/automation.json` and never overwrites an existing
configuration. After configuration, restart an already-running service when it
is idle and reopen the project:

```bash
opencode2 service restart
opencode2 /absolute/path/to/your-project
```

Create an issue containing `@d3ckerbot`. Polling runs once a minute and also
considers existing matching issues. By default, only the authenticated GitHub
user can request work.

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
| `trigger` | Mention that starts work; defaults to `@d3ckerbot`. |
| `everySeconds` | Polling interval; defaults to 60 seconds. |
| `check` | Test command as an argument array, such as `["npm", "test"]`; `false` skips tests. |
| `authors` | GitHub usernames allowed to request work. |

When tests are skipped, the PR explicitly reports that automated tests were not
run. Git consistency checks and the requirement for an actual change remain.
Restart the service while idle after changing configuration.

For noninteractive setup:

```bash
cd /absolute/path/to/your-project
node "$HOME/opencode2-github-automation/dist/setup.js" init --model provider/model --skip-tests
```

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

## Updating a global installation

```bash
git -C "$HOME/opencode2-github-automation" pull --ff-only
cd "$HOME/opencode2-github-automation"
npm ci
npm run build
```

Restart the service while idle. Reopen terminal clients after UI changes.
Project settings and queues are preserved.

## Development

```bash
npm ci
npm run check
npm pack
```

`npm run check` runs type checking, tests, and a build. `npm pack` produces a local
installation archive. Build artifacts, dependencies, and local credentials are
excluded from the source repository.

Additional documentation (currently in Polish):
- [Moving the source and installing on another machine](docs/installation.md)
- [Advanced configuration, retries, permissions, and separate plugins](docs/advanced.md)
