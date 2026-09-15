# Architecture

The implementation targets OpenCode **2** exclusively. The combined package
loads a generic scheduler, a GitHub dispatcher, and a terminal UI component.

## Components

- **Scheduler:** durable interval jobs, pause/resume, backoff, and no overlapping
  invocation of the same job. Calls dispatcher RPC rather than GitHub directly.
- **Dispatcher:** discovers issues and authorized comments, persists the queue,
  coordinates execution, publishes PRs, and polls for merge approval.
- **Executor:** generates an acknowledgement, runs an OpenCode session in an
  isolated Git worktree, verifies changes, and pushes the verified commit.
- **Terminal UI:** subscribes to activity events and polls for missed updates.
  Opens background tabs, closes task tabs after PR closure while retaining
  session history, and exposes `/bot` and `/restartworkflow` task selectors.

## Workflow

1. Match a configured mention in an authorized issue or comment.
2. Generate an English problem summary and plan without editing code.
3. Publish a signed acknowledgement before starting implementation.
4. Create or reuse the task worktree and checkpoint the session identity before
   prompting the executor. The executor must not publish directly.
5. Verify changes, generate a descriptive PR title, push, and create the PR.
6. Process subsequent authorized issue comments as new rounds on the same branch.
7. Merge only after eligible approval of the published head, repository permission
   checks, and GitHub merge readiness checks. Post a signed acknowledgement.

A failure retains the current phase and retry state. A possibly running session
is reconciled before starting another issue. Unknown prompt delivery is blocked
for inspection. Stopped sessions completed manually are detected automatically and
rejoin verification/publication before queued feedback runs. Explicit workflow
recovery preserves checkpoints and continues the same session when needed. RPC events are ephemeral; they are not the durable queue.

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
The service PID must match the plugin process before any maintenance session is
created. Shutdown releases local SDK waits independently of adapter cancellation,
settles state writes, bounds RPC disposal, and releases locks. A healthy worktree
session continues and the replacement owner reconciles its saved identity.

See [advanced configuration](advanced.md) for retry commands, limits, and RPC
settings, and the [README](../README.md) for installation and user-facing behavior.
