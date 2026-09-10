# Installation on another machine

Use the numbered [README installation, configuration, and update steps](../README.md).
They cover global installation before choosing a target repository, configuring
projects later, updating, removal, and keeping local configuration out of Git.

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

Continue with global registration in the README. The plugin source and the
repository the bot works on are separate directories. A global installation
remains inactive in projects without `.opencode/automation.json`.

The wizard displays editable defaults. Account defaults come from the authenticated
GitHub user, not the repository owner. The model default is queried from the running
OpenCode service; without it, the model is required. Command-line flags override
prompts. `--skip-tests` explicitly disables tests; Enter otherwise accepts the
shown test command or `skip`.

## Alternative project-local installation

For a project without a global installation:

```bash
bash "$HOME/opencode2-github-automation/scripts/install-local.sh" /absolute/path/to/your-project
```

The script builds an archive locally, installs it in `.opencode/node_modules`,
registers the server/UI loaders, and runs the wizard. Existing configuration and
queues are preserved on upgrades. Do not combine global and project-local copies.
No package is published to npm; `private: true` blocks accidental publication.

## Testing and migration

Use a separate test repository when testing on another machine. Independent
machines do not share queue ownership and can duplicate work on the same issues.
This installation procedure does not migrate sessions, queues, or worktrees.

Restart the service only when work is idle. Reopen clients after UI updates.
Do not change an active project's `origin` to switch repositories: clone another
project and configure it separately.
