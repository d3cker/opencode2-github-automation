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

## Workflow

1. Match a configured mention in an authorized issue or comment.
2. Generate a structured analysis without tools. Questions and proposals requiring
   a choice wait for an authorized reply before implementation can begin.
3. Publish a signed acknowledgement, resolve the base branch, and pin that choice.
4. Create or reuse the task worktree and checkpoint the session identity before
   prompting the executor. The executor must not publish directly.
5. Validate session success, verify changes, then push and create or reconcile the
   PR. Generate its title only if creating a PR without an already-saved title.
6. After publication, process queued authorized issue comments as new rounds on
   the same worktree and branch, with a new main session and the existing open PR.
7. Merge only after eligible approval of the published head, repository permission
   checks, and GitHub merge readiness checks. Post a signed acknowledgement.

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
The service PID must match the plugin process before any maintenance session is
created. Shutdown releases local SDK waits independently of adapter cancellation,
settles state writes, bounds RPC disposal, and releases locks. A healthy worktree
session continues and the replacement owner reconciles its saved identity.

See [advanced configuration](advanced.md) for retry commands, limits, and RPC
settings, and the [README](../README.md) for installation and user-facing behavior.
