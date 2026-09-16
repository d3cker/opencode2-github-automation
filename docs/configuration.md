# Configuration reference

For source installations, replace `"$HOME/.local/bin/opencode2-automation"`
with `node "$HOME/opencode2-github-automation/dist/setup.js"` in the commands below.

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
| `baseBranch` | Base for new worktrees and PRs; defaults to the GitHub default branch. |
| `capabilities` | Main model support: `text`, `vision`, `audio`; defaults to `["text"]`. |
| `mediaModel` | Separate helper model and its capabilities; example below. |
| `systemPromptFile` | Optional Markdown instructions appended to the bundled bot prompt; path relative to the primary checkout, or absolute. |
| `trigger` | Mention that starts work; defaults to `@opencodebot`. |
| `everySeconds` | Polling interval; defaults to 60 seconds. |
| `check` | Test command as an argument array, such as `["npm", "test"]`; `false` skips tests. If omitted, detect a package test script and its package manager; fail setup if no test command is found. |
| `authors` | GitHub usernames allowed to request work and authorize merging (merge also requires repository write access). |
| `signature` | Signature appended to every posted comment and PR description; defaults to `your-github-login[OpenCode2]`. |
| `autoMerge` | Automatic merge settings: `enabled` (default `true`), `method` (default `squash`), and exact approval `comments`. |

When tests are skipped, the PR explicitly reports that automated tests were not
run. Git consistency checks and the requirement for an actual change remain.
Restart the service while idle after changing configuration, then activate each
owner project again. Recovery commands do not reload configuration or reset a
pinned base. Session/command deadlines and worker retry limits are advanced
`GithubOptions`, not fields accepted by the strict easy JSON schema above; see
[advanced options](advanced.md#options).

For noninteractive setup, use `--yes` to accept defaults for omitted options.
Provide the model and a test command (or explicitly skip tests):

```bash
cd /absolute/path/to/your-project
"$HOME/.local/bin/opencode2-automation" init --model provider/model --skip-tests --yes
```

Optional flags: `--base-branch develop`, `--capabilities text`,
`--media-model provider/vision-model`, `--media-capabilities text,vision`,
`--system-prompt .opencode/bot.md`. With `--yes`, supply a helper explicitly
if you want media support with a text-only main model.

## Questions, branches, media, and bot instructions

- **Questions:** reply in the issue as an account in `authors`; no repeated
  mention is needed. The bot enters `waiting` and resumes after the next scan.
  Questions in the first analysis block worktree and session creation. Unclear
  replies prompt another question. You may use the same account as the bot;
  its marked comments are excluded from replies.
  Permission questions require the exact `/allow QUESTION_ID` or
  `/deny QUESTION_ID` shown in the comment. Explicit OpenCode deny rules remain.
- **Base branch:** write naturally, such as "use branch develop" or "work from
  release/next", in the issue or an authorized comment. The configured model
  interprets the request, including languages such as Polish. Unclear or missing
  branches trigger a question in the issue before work starts. `baseBranch` is
  only the default; `/base` remains an optional shortcut. Existing tasks keep
  their pinned base.
- **Media:** declare actual model capabilities and a helper if needed:

  ```json
  {
    "model": "provider/text-model",
    "capabilities": ["text"],
    "mediaModel": {
      "model": "provider/vision-model",
      "capabilities": ["text", "vision"]
    }
  }
  ```

  Add these fields to your existing JSON using your installed model IDs. The
  helper analyzes attachments in a separate session; the main model stays
  unchanged. Add `audio` if the helper also accepts audio files.
- **Instructions:** [prompts/bot.md](../prompts/bot.md) is bundled and always loaded.
  For project-specific instructions, create `.opencode/bot.md` in the primary
  checkout and set `"systemPromptFile": ".opencode/bot.md"`. It is appended
  to the baseline and reread on each use, including from worker branches.

See [runtime behavior and examples](runtime.md) for reply handling, branch
selection, supported media inputs, and prompt persistence.

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


## Repository inventory registration

`init` and owner activation register the configured checkout for
`opencode2-automation list` and `/bot` → **Repositories**. No new project setting
is required. The registry stores last-resolved repository/base-branch metadata
and timestamped component snapshots under the user's state directory; it does
not replace `.opencode/automation.json` or the shared Git queue. Changes to default
branches are reflected when the owner is activated again. See
[repository inventory](runtime.md#repository-inventory) to import older inactive
configurations and distinguish configured projects from running bots.
