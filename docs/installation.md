# Installation on another machine

Start with the [README](../README.md) for `.tgz` or source installation, updates,
project configuration, headless startup, and removal. This page covers details
and troubleshooting.

The README's package installation command contains the versioned GitHub asset URL
for the stable release promoted into that branch. After publication, automation
updates README on `release`; its PR carries the update into `main` when merged.
While that PR awaits review, `release` contains the newer download link. The
publisher also merges the released version and README into `devel` automatically,
without waiting for the main PR or creating another PR. For
upgrades, use that branch's current README rather than a copy from an old archive
or tag, and keep the same installation prefix. Prereleases do not replace the
stable link. Maintainer setup and retries are in [Release process](releases.md).

## Package registration

`npm install --global` runs the bundled `postinstall` script. It writes two small
loaders under the OpenCode config directory, pointing to the installed package's
server and TUI entrypoints. OpenCode discovers these without changes to
`opencode.json`. Config path precedence is `OPENCODE_CONFIG_DIR`, then
`$XDG_CONFIG_HOME/opencode`, then `$HOME/.config/opencode`.

Registration creates no project settings, asks no questions, and does not restart
OpenCode. Normal `npm ci` in a source checkout and project-local npm installs skip
global registration. Source installs register explicitly with `setup.js install`.

Updates reuse an existing recognized loader directory, including older names,
and repoint both loaders when changing between source and `.tgz` installations.
Customized files and duplicate registrations cause a clear error instead of being
overwritten. Back up and resolve the reported loaders, then rerun installation.
The installer does not modify other plugins or project configurations.

If npm was configured to skip lifecycle scripts, register manually after install:

```bash
"$HOME/.local/bin/opencode2-automation" install
```

Use the same command to repair registration after moving the installed package.
Keep the same npm prefix for updates. `npm uninstall` does not run an uninstall
hook; remove the OpenCode loaders first as described in the README.

## Prerequisites

- OpenCode **2**, with a working model. Tested SDK version: `0.0.0-beta-19398`.
- Node.js 22+, npm, Git, and Bash on macOS/Linux.
- GitHub authentication and permission to comment, push, create PRs, and merge.
- A target repository with issues enabled and at least one pushed commit.

Configure GitHub authentication if needed:

```bash
gh auth login
gh auth setup-git
gh auth status
```

Set `git config --global user.name` and `user.email` if Git has no author identity.
Model credentials and GitHub authentication are not copied with the plugin.

## Source checkout

```bash
git clone https://github.com/d3cker/opencode2-github-automation.git "$HOME/opencode2-github-automation"
cd "$HOME/opencode2-github-automation"
npm ci && npm run build
```

Run `node "$HOME/opencode2-github-automation/dist/setup.js" install`, then follow
the README's restart and project configuration steps. The plugin source and the
repository the bot works on are separate directories. A global installation
remains inactive in projects without `.opencode/automation.json`.

The wizard displays editable defaults. Account defaults come from the authenticated
GitHub user, not the repository owner. The model default is queried from the running
OpenCode service; without it, the model is required. Command-line flags override
prompts. `--skip-tests` explicitly disables tests; Enter otherwise accepts the
shown test command or `skip`.
The wizard also asks for model capabilities, a vision helper if the main model
lacks vision, and the base branch. Existing JSON files can be extended manually;
see [runtime settings](runtime.md).

## Alternative project-local installation

For a project without a global installation:

```bash
bash "$HOME/opencode2-github-automation/scripts/install-local.sh" /absolute/path/to/your-project
```

The script builds an archive locally, installs it in `.opencode/node_modules`,
registers the server/UI loaders, and runs the wizard. Existing configuration and
queues are preserved on upgrades. Do not combine global and project-local copies.
No package is published to npm; `private: true` blocks accidental publication.

## TUI rendering and source validation

The runtime sidebar uses the host's OpenTUI/Solid APIs and semantic theme tokens.
The package declares OpenTUI and Solid peer dependencies; server entrypoint imports
stay independent of renderer initialization. A sidebar update requires both the
owner plugin's monitor RPC and an updated/reopened TUI. An older or unavailable
owner is shown as unavailable rather than silently idle. The integration follows
the [OpenCode CLI plugin API](https://opencode.ai/v2/docs/build/plugins/cli/).

For development, `npm ci` installs pinned renderer, theme and Bun test dependencies.
`npm run check` includes `npm run test:tui`, which renders the actual sidebar using
Bun's native OpenTUI support and checks live updates, stale readings, tab selection
and a narrow layout. Bun is needed for this native renderer test, not for the
Node-based management CLI. Package validation still imports the server and TUI
entrypoints in an isolated Node installation without initializing a renderer.

## Testing and migration

Use a separate test repository when testing on another machine. Independent
machines do not share queue ownership and can duplicate work on the same issues.
This installation procedure does not migrate sessions, queues, or worktrees.

Back up shared automation state before an upgrade. Once round cancellation has
saved `cancelling` or `watching`, an older plugin that does not recognize those
statuses cannot read that queue. Do not downgrade against live newer state or
delete it to bypass validation; keep the newer plugin or restore a coordinated
backup while owners are stopped.

Restart the service only when work is idle. Then activate every configured owner
again as shown in the README. Reopen TUI clients after UI updates to register new
commands and action menus such as `/bot` task closure and `/restartworkflow`; merely reopening an old task tab does not
reload its client's command registrations. A service restart preserves queue
blocks and pending questions. Use [workflow recovery](runtime.md#interrupted-sessions-and-workflow-recovery)
for an execution stop instead of reinstalling or deleting state.
After upgrading, activated owners register themselves for
`opencode2-automation list`. Import older, currently inactive standard projects
with `opencode2-automation list --discover /absolute/path/to/projects`; this does
not activate them. Use the same user and `XDG_STATE_HOME` as the service. The TUI's
**Repositories** option reads the connected server registry. See
[repository inventory](runtime.md#repository-inventory) for discovery limits,
status freshness, and missing-directory behavior.

Do not change an active project's `origin` to switch repositories: clone another
project and configure it separately.
