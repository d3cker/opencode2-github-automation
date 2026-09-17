# Architecture

The implementation targets OpenCode **2** exclusively. The combined package
loads a generic scheduler, a GitHub dispatcher, and a terminal UI component.

## Components

- **Scheduler:** durable interval jobs, pause/resume, backoff, and no overlapping
  invocation of the same job. Calls dispatcher RPC rather than GitHub directly.
- **Dispatcher:** discovers issues and authorized comments, persists the queue,
  coordinates execution and recovery, publishes PRs, and polls for merge approval.
- **Executor:** generates an acknowledgement, runs an OpenCode session in an
  isolated Git worktree, verifies changes, and pushes the verified commit.
- **Terminal UI:** subscribes to activity events and polls for missed updates.
  Opens background tabs, closes task tabs after PR closure while retaining
  session history, and exposes `/bot` and `/restartworkflow` task selectors.
  A read-only runtime sidebar and `/botstatus` combine live dispatcher diagnostics,
  scheduler state and task snapshots, marking stale or unavailable data.
- **Repository inventory:** `init` and owner activation register configured
  checkouts in a per-user host registry. Dispatcher and scheduler publish separate
  local status snapshots every five seconds. CLI `list` reads these without
  activating owners; `/bot` → **Repositories** reads the connected server's same
  registry through `automation.github.repositories`. Missing/stale data is explicit;
  discovery can import inactive standard configs without starting automation.

## Workflow

1. Match a configured mention in an authorized issue or comment.
2. Generate a structured analysis without tools. Questions and proposals requiring
   a choice wait for an authorized reply before implementation can begin.
3. Publish a signed acknowledgement, resolve the base branch, and pin that choice.
4. Create or reuse the task worktree and checkpoint the session identity before
   prompting the executor. The executor must not publish directly.
5. Validate session success and save the final public completion report. Verify
   changes, bind the report to the verified commit, then push and create or reconcile
   the PR with that report and separate dispatcher checks. Generate its title only
   if creating a PR without an already-saved title.
   Checkpoint successful pushes. Retry a lagging PR head only while the remote
   branch matches the verified commit; block actual branch changes or closure.
6. After publication, process queued authorized issue comments as new rounds on
   the same worktree and branch, with a new main session and the existing open PR.
   After cancellation, use a fresh local branch/worktree from the published head,
   preserving the abandoned worktree and the remote PR branch.
   Keep the original PR report and update its Latest update section after pushing;
   preserve manual notes outside the managed description.
7. Merge only after eligible approval of the published head, repository permission
   checks, and GitHub merge readiness checks. Post a signed acknowledgement.
   Formal reviews are bound to the exact commit and survive later description
   recovery; unbound merge comments must follow the latest publication.

A failure retains the current phase and retry state. An eligible `running` task
with a saved session takes priority over other ready tasks. Unknown prompt
delivery is blocked for inspection. Stopped sessions completed manually are detected automatically and
rejoin verification/publication before queued feedback runs. Explicit workflow
recovery preserves checkpoints and continues the same session when needed. It does
not resume a paused scheduler or clear pending questions and failing checks. RPC
events are ephemeral; they are not the durable queue. See the eight
[workflow diagrams](bot-workflow.md) for exact sequencing and guards.

## Configuration and ownership

The easy setup writes a per-project `.opencode/automation.json`. Global plugin
loaders remain inactive in projects without configuration. Account defaults come
from GitHub authentication, while the wizard queries OpenCode for a model default.
User-configured values are preserved rather than replaced during upgrades.

The primary checkout owns scheduling. Worker worktrees do not start additional
schedulers. A shared Git-directory state folder holds the queue and locks; separate
machines require separate test repositories to avoid duplicate execution.

In the shared background service, each scheduler/dispatcher component renews one
empty maintenance session in the owner location at startup and every ten minutes.
OpenCode counts durable session events as activity; polling plugin APIs alone
does not prevent its hourly inactivity eviction. No model is prompted by keepalive.
The service is discovered through `/api/info`; `server.info` must report the plugin
process PID before any maintenance session is created. `session.update` refreshes
its title without prompting a model. Shutdown releases local SDK waits independently of adapter cancellation,
settles state writes, bounds RPC disposal, and releases locks. A healthy worktree
session continues and the replacement owner reconciles its saved identity.

See [advanced configuration](advanced.md) for retry commands, limits, and RPC
settings, and the [README](../README.md) for installation and user-facing behavior.

Runtime monitoring is observational: `automation.github.monitor` exposes the
owner's current worker operation, active task, scan timing/error, and enriched
activity snapshots. Scheduler status retains its existing RPC. The TUI polls both
independently every five seconds through the connected client; it does not infer
worker activity from queue status alone. These live diagnostics do not add durable
workflow phases or replace the existing ownership keepalive.

Operator task closure is a durable dispatcher operation: `/bot` sends the owner
`automation.github.close`, which records `closing` before interruption and later
`closed`. Closed records remain as history and prevent rediscovery; scans, runtime
hooks, feedback execution and merge monitoring exclude them. Session/worktree
data is retained. See [task management](runtime.md#manage-tasks-from-bot) for
in-flight operation limits and the distinction from closing a TUI tab.


Round cancellation uses `automation.github.cancelround`: persist `cancelling`,
drain execution, archive the current round, then `watching`. Discovery continues
and future feedback starts a new session in an isolated worktree. Only a saved
published head can authorize auto-merge while watching. Explicit
`automation.github.resumetracking` restores a closed task for future comments,
skipping its abandoned round and closed-period backlog after validating GitHub
objects. Both operations preserve work; neither closes the GitHub PR or issue.
