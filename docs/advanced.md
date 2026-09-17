# Advanced configuration

The [README](../README.md) covers the combined package and setup wizard. Use
`examples/advanced.opencode.jsonc` for custom schedules, multiple repositories,
or separately loaded scheduler and dispatcher components.

Both components use only the OpenCode **2** SDK, pinned to `2.0.6`:

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
| `checks` | Arrays of executable arguments, e.g. `[["npm", "test"]]`. `[]` skips dispatcher test commands; the PR distinguishes this from agent-reported tests. No implicit shell. |
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
node dist/manage.js restartworkflow /absolute/path/to/owner-project 'owner/repository#123'
```

`pause` stops scheduled scans and manual scheduler runs. It does not cancel queued
work or active sessions; direct dispatcher `scan` still works.

`retry` clears blocked or failed status at the saved phase and requires an idle
worker and maintenance loop. It does not append a continuation to an interrupted
session. Prefer `restartworkflow` to continue that same session. If prompt delivery
is uncertain, inspect the session and worktree before explicitly starting a new one:

```bash
node dist/manage.js retry /absolute/path/to/owner-project 'owner/repository#123' --restart-session
```

This interrupts the previous session and reuses the worktree. It preserves code
and already-published acknowledgement comments. An issue edited after analysis
still faces the phase-specific issue/route guards on its next execution. A new authorized comment after completion starts a
follow-up round and updates the same open PR.

`restartworkflow` (also available as `/restartworkflow` in the owner TUI) queues
recovery at the saved phase, without interrupting active execution or clearing
the session. An interrupted session receives one checkpointed continuation
request after it becomes idle; a completed session proceeds to verification.
The request survives owner restarts. Uncertain delivery blocks inspection rather
than replaying the continuation. Repeated requests while ready/running are no-ops.
The RPC method `automation.github.restartworkflow` accepts `{ key }` and returns
`{ accepted }`. A true result acknowledges queuing, not completed publication.
Known tasks not blocked/failed return false after the pending-question and closed-PR
guards. Missing tasks, unresolved questions, closed/merged PRs, absent routes,
and unrecognized running-session errors produce errors. Recovery does not run a
scan, resume a paused scheduler, or restart the service.
Unlike `retry`, recovery can be queued while a different task is working.

### Read-only runtime monitoring

`automation.github.monitor` accepts `{}` and returns the owner directory,
worker operation, optional active task key, scanning flag, last scan start/finish,
optional redacted scan error, and enriched activity snapshots. It does not trigger
work or write the queue. Worker operations are `idle`, `reconciling`, `executing`,
`merging`, `maintenance`, or `stopped`; these are live diagnostics, not task phases.
Scan finish means an attempt ended, including failed attempts; inspect `scanError`.
Timing resets when the dispatcher is recreated.

`automation.scheduler.status` supplies job `running`, `paused`, `nextAt`, failure
count, error and last start/finish. The sidebar and `/botstatus` combine these APIs.
Each poll has a four-second bound; failures retain marked stale data. The existing
`activity` RPC/events still drive tab notifications and their ten-second fallback.
Full task history remains available through `status`; see the
[runtime sidebar](runtime.md#runtime-status-sidebar) for display and selection rules.

### Host repository inventory

`opencode2-automation list [--json]` is independent of the current checkout and
service discovery. `automation.github.repositories` accepts `{}` and returns the
same `{ entries, warnings }` report on the connected server. The method reads
local registry/snapshot files and omits absent snapshot fields so inactive or
missing owners also produce valid JSON. It does not invoke RPC in other owner locations,
which could activate their plugins. `/bot` → **Repositories** consumes this API.

`init` and combined-plugin activation register standard configurations. Dispatcher
startup registers all advanced `repositories` entries under its canonical owner.
Dispatcher and scheduler write separate atomic snapshots every five seconds while
they hold their existing ownership locks, with PID, timestamp and shutdown state.
Disposal settles the last snapshot before releasing ownership. Readers verify
process existence and 15-second freshness; stale details remain historical.
Snapshot/registration errors are reported but do not abort execution or alter
queue state. The registry uses private files under `XDG_STATE_HOME` (default
`~/.local/state`), separate from Git-backed state; no GitHub token or model
credentials are stored there.

Use `list --discover /absolute/path/to/projects` to register older inactive
standard `.opencode/automation.json` configurations without loading owners.
Discovery has explicit filesystem/depth limits and does not import arbitrary
advanced plugin options. For statuses and migration details, see
[repository inventory](runtime.md#repository-inventory).

## Persistence and reconciliation

The queue stores analysis decisions and clarification dialogue, comment ID, session ID, phase, pinned base branch,
worktree, base commit, pending questions, replies, permission decisions, helper
IDs, session-stop classification, recovery request and admission checkpoint, check
results, PR title, publication time, PR, and merge status. Writes are
atomic; heartbeat locks prevent multiple owners of the same state directory.

After a crash, allow 30 seconds for an abandoned lock to expire. Do not remove
active locks or queues. Publication reconciles existing comments and PRs after
uncertain network results. Uncertain initial prompt delivery is not automatically
resent. Issue replies and helper prompts use deterministic IDs for admission retries.
Merge requests pin the verified head SHA and reconcile an already-merged PR.

The shared service evicts owner locations after roughly an hour without durable
session activity, even if plugin RPC or HTTP requests continue. Components use one
deterministically identified, empty maintenance session per owner directory and
rename it at startup and every ten minutes. Creation is idempotent, metadata and
location are checked before renaming, and no model is prompted. Requests have a
15-second deadline, never overlap, and require a matching service PID. Standalone
servers without a matching service registration skip this mechanism; use the
shared service for unattended automation.

SDK adapters may ignore AbortSignal. The executor therefore bounds its local SDK waits,
preserves healthy worker execution on owner disposal, and settles local state writes
before releasing ownership. A replacement waits up to 15 seconds for the retiring
owner's locks. RPC disposal has a five-second deadline per component; cleanup still
attempts every remaining step. No live lock is forcibly removed. A held-lock startup
error should be investigated via plugin details and server logs. Back up the queue,
worktree, and session database before recovery. Reconcile an already-published PR
and saved session instead of restarting implementation or deleting the worktree.

A blocked session stop is rechecked on worker passes (no more than once every
30 seconds after an unsuccessful probe, and only when a new worker pass can start). A matching saved session with a successful
final assistant response re-enters normal execution validation, checks, and
publication automatically, including legacy timeout/interruption checkpoints.
Failed checks, pending questions, and uncertain prompt delivery are not cleared.
Queued feedback is retained until publication completes. The stop itself never
automatically prompts the model; continue it manually or request workflow recovery.

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

## Ending task tracking

Use `/bot` → select issue → **Stop and close task**. The owner-scoped RPC is
`automation.github.close` with `{ "key": "owner/repository#123" }`, returning
`{ "accepted": true }` when durable closure is queued or `false` if already closed.
There is no corresponding setup CLI subcommand. This action does not require the
GitHub issue/PR or saved session to still exist. It never deletes local work.

The queue retains phase and history with statuses `closing` and `closed`,
`closeRequestedAt`, `closedAt`, and `closeError`. Interruption of all saved main,
earlier-round and media session IDs is bounded to 15 seconds per request; missing
sessions are ignored, other failures retry no sooner than 30 seconds. Closure
waits for the selected task's in-flight worker and question posts, then interrupts
again to cover a session creation that was already in flight. Checkpoint guards
prevent late results from publishing or reviving the task. Publication/merge
already in flight rejects admission, rather than promising to undo remote effects.

Pending closure is resumed on startup. Keep the queue and Git worktree backups
when upgrading: older plugin builds do not understand these two new statuses.
See [runtime management](runtime.md#manage-tasks-from-bot) for the UI and limits.

While a closure is pending, the dispatcher does not start another worker pass.
An unrelated already-running task can finish; scanning continues for other tasks.
The monitor reports task maintenance until closure completes.


## PR description recovery

Task state stores `completion` (final public text or an explicit unavailable
reason, session, round, then verified commit and checks), `initialCompletion`,
`publishedBody` (the last acknowledged managed section), and `pushedCommit` (the
successfully pushed verified SHA). New rounds clear the current completion and
push checkpoint while retaining the original report and published body.
Older verifying/publishing tasks recover missing
summaries from their saved sessions; this does not rerun the model. Missing or
empty successful reports are marked unavailable, while transient reads retry.
Already completed or closed tasks are not bulk rewritten on upgrade.

Publication reads the PR at the verified head and only replaces the managed HTML
marker region. Notes outside it are preserved. An exact known legacy body can be
replaced; unknown unmarked text is retained with the new section appended, since
it might contain manual edits. A later legacy round may not have enough saved
information to identify its old acknowledgement exactly.

After push, GitHub's PR head can temporarily lag behind its branch ref. Before
description reconciliation and again before PATCH, the plugin reads the remote
branch ref. If it matches the verified SHA but the PR head does not, publication
enters `retry_wait` and retries with the normal backoff, up to `maxAttempts`.
Retries reuse the saved report and verified commit, skipping a push already
recorded in `pushedCommit`, including after a restart. Exhausted retries become
`failed`; inspect the reported SHAs and use `/restartworkflow` after resolving the
problem. An unacknowledged push still uses normal non-force push reconciliation.

An edited/removed managed section, changed remote branch, closed follow-up PR, or oversized
body blocks at `publishing`. Preserve your notes outside the markers and restore
the previous managed section from `publishedBody` in the task checkpoint (or PR
edit history), then use the normal workflow retry. Do not delete the queue or
restart implementation just to retry a description update. If a PATCH succeeded
but its response was lost, matching desired content is accepted without another
write. Body, PR head and branch ref are reread before PATCH; edits after those reads cannot
be atomically excluded by this implementation.

Each rendered report is limited to 22,000 UTF-8 bytes with an explicit truncation
notice; full saved text remains in task state and the session. Dispatcher check
text is limited to 8,000 bytes. The complete description, including retained
notes and signature, must fit within the automation limit of 60,000 bytes or
publication blocks without dropping notes. Titles are not regenerated on updates.


## Round cancellation and resuming tracking

Owner RPC methods `automation.github.cancelround` and
`automation.github.resumetracking` accept `{ "key": "owner/repository#123" }`
and return `{ "accepted": true }` when cancellation is queued. A no-op returns
`false`; invalid transitions and publication/merge in flight throw an actionable
error. Matching CLI commands work from the configured owner checkout. See
[runtime semantics](runtime.md#cancelling-one-round-while-keeping-tracking).

Durable `cancellation` stores the request time and interruption error. Status
`cancelling` gates worker checkpoints, session prompts, runtime hooks, discovery
updates and publication; scans leave its cursor unchanged. A worker pass resumes
due cancellation after restart and retries failed interruption after 30 seconds.
It drains the selected worker and pending question posts before entering `watching`.
The queue keeps `cancelledRounds` with prior errors, questions, feedback, worktree,
session and verification/report snapshots. `controlVersion` increases on operator
transitions, so stale TUI events cannot undo explicit resumption.

Watching continues PR-state discovery and accepts new authorized issue comments.
`publishedHead` retains the successfully published SHA and merge-comment window time
across rounds; merge checks use it while watching. No saved published head means
no automatic merge until the next successful publication. Old round checkpoints
are not treated as a new successful publication. Explicit resumption validates
GitHub objects and advances the comment cursor to the observed backlog without
queuing it; failed validation leaves tracking closed.

The next round allocates `localBranch` and a new managed worktree, fetching the
existing remote PR head if applicable. The prior worktree and branch are never
reset, cleaned, deleted or force-pushed. Checks validate the new local branch;
push still targets the task's original remote `branch`. Normal publication and
verification guards apply, including ancestry of the pinned base. The archived
round is not replayed or published automatically. Existing queued feedback is
retained by cancellation, while resuming a closed task explicitly skips backlog.
