# Advanced configuration

The [README](../README.md) covers the combined package and setup wizard. Use
`examples/advanced.opencode.jsonc` for custom schedules, multiple repositories,
or separately loaded scheduler and dispatcher components.

Both components use only the OpenCode **2** SDK, pinned to `0.0.0-beta-19398`:

- `automation.scheduler`: invokes configured RPC methods on an interval.
- `automation.github`: owns issue discovery, comments, isolated work, verification,
  PR publication, and approval-based merging.

## Setup

1. Run `npm ci` and `npm run check` in the source checkout.
2. Copy the advanced example into your owner project's OpenCode configuration.
   Replace absolute paths, repository names, authors, model, and check commands.
3. Configure GitHub authentication in the server environment and Git push
   authentication in the checkout. Reload the idle service.

Do not load duplicate copies through both explicit options and discovered local
loaders. The first scan includes existing matching open issues. The computer and
OpenCode service must be running for polling to work.

## Options

| Option | Purpose |
| --- | --- |
| `ownerDirectory` | Absolute path of the checkout that owns automation. Worker worktrees do not activate another scheduler. |
| `stateDirectory` | Shared location for queues, locks, and worktrees. Keep it consistent across components and restarts. |
| `repositories` | Repositories with existing local checkouts, default base branches, allowed authors, and checks. A natural-language request can override the base before work starts. |
| `allowedAuthors` | GitHub users authorized to request work and approve merging. Merging also requires repository write access. |
| `checks` | Arrays of executable arguments, e.g. `[["npm", "test"]]`. `[]` skips automated tests and reports that in the PR. No implicit shell. |
| `routes` | Maps full mentions to agents and models available in OpenCode. |
| `routes[tag].capabilities` | Main model capabilities: `text`, `vision`, `audio`; omitted means text only. |
| `routes[tag].mediaModel` | `{ model: { providerID, id }, capabilities: ["text", "vision"] }` for the media helper. |
| `systemPromptFile` | Markdown instructions appended to bundled `prompts/bot.md`; resolved from `ownerDirectory`. |
| `signature` | Message footer; defaults to the authenticated GitHub login followed by `[OpenCode2]`. |
| `autoMerge` | `enabled`, `method`, and exact approval `comments`; see README. |
| `workerEverySeconds` | Worker tick interval, default 5 seconds. |
| `sessionTimeoutSeconds` | Session wait deadline, default 3600 seconds. |
| `commandTimeoutSeconds` | Git/check command deadline, default 600 seconds. |
| `maxAttempts` | Stage retry limit, default 5. |
| `jobs[].everySeconds` | Scheduler polling interval. |
| `jobs[].rpcID`, `method`, `input` | RPC target; defaults to `automation.github`, `scan`, `{}`. |

Other plugins can expose idempotent RPC methods for custom scheduler jobs. A
transport timeout does not prove the server never executed a request.

The executor uses the configured OpenCode permissions. Interactive permission
requests are posted to the issue and suspend the task. An authorized author must
reply with the exact `/allow QUESTION_ID` or `/deny QUESTION_ID` command. Explicit
OpenCode deny rules remain. Install project dependencies before running it or
include suitable setup commands in your checks.

The executor installs an `automation.runtime` loader in each bot worktree before
creating its session. This enables question routing, the media tool, and system
context hooks even outside the owner's checkout. The loader imports the installed
plugin code and is excluded through Git's local `info/exclude`. Tracked or
customized files at that path cause an error instead of being replaced.

## Operations

Run management commands against the owner directory, even if the visible session
is attached to a worktree:

```bash
node dist/manage.js status /absolute/path/to/owner-project
node dist/manage.js scan /absolute/path/to/owner-project
node dist/manage.js run /absolute/path/to/owner-project github-issues
node dist/manage.js pause /absolute/path/to/owner-project github-issues
node dist/manage.js resume /absolute/path/to/owner-project github-issues
node dist/manage.js retry /absolute/path/to/owner-project 'owner/repository#123'
```

`pause` stops scheduled scans and manual scheduler runs. It does not cancel queued
work or active sessions; direct dispatcher `scan` still works.

`retry` resumes blocked or failed tasks. If a session failed or prompt delivery is
uncertain, inspect the session and worktree before explicitly starting a new one:

```bash
node dist/manage.js retry /absolute/path/to/owner-project 'owner/repository#123' --restart-session
```

This interrupts the previous session and reuses the worktree. It preserves code
and already-published acknowledgement comments. An issue edited after analysis
remains blocked for review. A new authorized comment after completion starts a
follow-up round and updates the same open PR.

## Persistence and reconciliation

The queue stores analysis, comment ID, session ID, phase, pinned base branch,
worktree, base commit, pending questions, replies, permission decisions, helper
IDs, check results, PR title, publication time, PR, and merge status. Writes are
atomic; heartbeat locks prevent multiple owners of the same state directory.

After a crash, allow 30 seconds for an abandoned lock to expire. Do not remove
active locks or queues. Publication reconciles existing comments and PRs after
uncertain network results. Uncertain initial prompt delivery is not automatically
resent. Issue replies and helper prompts use deterministic IDs for admission retries.
Merge requests pin the verified head SHA and reconcile an already-merged PR.

Only one issue executes at a time. Checks must succeed before publication. Push
uses the exact verified commit without force. Worktrees remain available for
inspection; automatic cleanup is not implemented.

## Limits

- One machine owns each repository's automation. Independent state directories
  do not coordinate with each other.
- Interval polling; no cron syntax or webhooks.
- New issue comments are supported; comment edits and inline PR review comments
  do not request implementation work. Formal PR approvals can authorize merging.
- GitHub.com user tokens; no Enterprise or GitHub App installation-token support.
- A worktree isolates project files but is not a sandbox for agent tools.
- Tests use real Git and the V2 SDK with mocked GitHub and model calls. External
  integration testing is still needed on your server and repository.

API references: [OpenCode 2 plugins](https://opencode.ai/v2/docs/build/plugins),
[GitHub issues](https://docs.github.com/en/rest/issues/issues),
[comments](https://docs.github.com/en/rest/issues/comments),
and [pull requests](https://docs.github.com/en/rest/pulls/pulls).
