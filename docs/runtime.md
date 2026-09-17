# Bot runtime

## Questions in GitHub

The first analysis returns a structured decision: proceed or ask a question.
Requests for proposals or a choice before implementation must ask and wait.
The dispatcher saves the decision and pending question before publishing a
single signed comment containing the proposals and question. It creates no
worktree or implementation session until an authorized reply resolves the choice.
Publishing proposals alone never authorizes implementation.

Replies to these initial questions return to analysis first. An unclear reply
causes another question; an invalid model response or a connection failure
retries without starting work. Once the choice is resolved, its dialogue is
passed to the implementation session and base-branch selection. Saved analyses
from older versions are reassessed before starting implementation; an upgrade
does not undo changes or PRs that have already been produced.

The bot uses `ask_issue` to post clarification questions with the configured
signature. Built-in question tools are redirected for bot sessions and their
native subagents; ordinary interactive sessions keep their usual question UI.
The task enters `waiting`, stops implementation, and does not publish a PR.
Other queued issues can proceed while it waits.

Reply in the same issue using an account in `authors`. The next scan accepts
the first authorized reply after the question, without requiring another mention.
Initial questions return to analysis; questions from an implementation session
resume that session. A native worker's question also resumes the main
agent, which can continue or delegate again with the answer. Other comments
remain queued as feedback. Edits to existing comments are not replies.

You and the bot may use the same GitHub account or different accounts. The
dispatcher excludes plugin messages by their `<!-- opencode2:... -->` markers,
not by excluding the posting account's login. GitHub Bot accounts and unauthorized
authors are also excluded. A regular comment from the shared account can answer
a question; the bot's own marked question, acknowledgement, or other post cannot.

When `autoApproveRepositoryFiles` is enabled for the repository, the runtime
approves eligible file-access requests within the checkout and assigned worktree,
including native subagents and later rounds. It still honors explicit denials and
does not grant shell permissions or tools to media helpers. A new session does not
need to repeat `/allow` for these eligible file requests. Existing unanswered
questions still require their explicit replies. See
[repository file approvals](configuration.md#repository-file-approvals).

For permission requests that still require a reply, use the exact `/allow QUESTION_ID` or `/deny QUESTION_ID`
shown in the question as your entire reply. Plain conversation does not grant
permission. The decision is scoped to the operation and resource set in the
current main session and its workers; explicit OpenCode deny rules still apply.
The bot never answers an approval request on your behalf.

The queue retains waiting questions and accepted replies across restarts.
After restarting the service, load the owner project again to resume polling.
No terminal UI is needed to answer in GitHub.

The automation owner must remain loaded while its worktree sessions run. In the
shared background service, keepalive runs at startup and every ten minutes,
independently of issue polling and its pause setting. It reuses one empty session
named `Automation owner keepalive` in the primary checkout. The session has no
messages, consumes no model tokens, and is not an issue task. Its durable rename
event refreshes OpenCode's activity timer; requests to list plugins do not.
Keepalive only targets a service whose PID matches the plugin process. Standalone
servers without a matching registered service do not receive this protection.

On owner reload, the dispatcher stops waiting locally and releases its lock without
interrupting a healthy worker. The next owner reconnects to the saved session ID,
checks its outcome, verifies the changes, and resumes publication. Explicit task
cancellation, unanswered questions, and session deadlines still interrupt workers.

If the plugin reports a held lock or a worker reports unavailable automation RPC,
inspect plugin details, logs, and queue state before retrying. Preserve the
worktree and queue; a failed session can still contain completed changes. Do not
remove an active lock or restart implementation just to recover publication.

## Tabs after PR closure

Each repository scan checks the state of tracked PRs independently of the
auto-merge setting and whether their issues are still open. A manual close,
manual merge, or automatic merge sends the closed PR state to connected TUIs.
Missed events are recovered by the TUI's activity polling, including on startup.

The TUI closes only tabs associated with that task's known main sessions and
media helpers. Busy tabs wait until idle. Closing a tab never deletes a session,
interrupts work, or removes a worktree. A tab reopened through `/bot` or history
is not repeatedly closed by later polls in the same TUI instance. Sessions from
new rounds are recorded in the queue; for older queues, cleanup can include only
the session IDs still present in saved state or observed by the current TUI.

## Base branches

Write your preference in the issue or an authorized comment in ordinary language:

```text
@opencodebot Add an export button. Please use branch release/next.
```

The configured main model interprets the intended base, including requests in
Polish and other languages it understands. No special command syntax is required.
For example, "work from develop" selects `develop`; "do not use develop; use
release/next instead" selects `release/next`. Clear later corrections take
precedence. Quoted messages and fenced code examples are excluded from selection.

`/base release/next` and `Base branch: release/next` remain optional shortcuts.
`baseBranch` in the JSON is the default when no preference is given; if omitted,
the GitHub default branch is used. A selected name must occur in authorized user
text and must exist on `origin`; the model cannot invent a replacement branch.

If the request is ambiguous, or the branch does not exist, the bot asks in the
issue after its initial acknowledgement. No worktree or coding session is created
until the base is resolved. Reply naturally (or with just the branch name) from
an account in `authors`. Questions and replies survive service restarts. An
unavailable Git connection or invalid model response causes a retry, never a
silent fallback to the default branch.

The dispatcher fetches that branch, creates a task branch/worktree from its
commit, and targets the same base in the PR. This choice stays pinned through
retries and follow-up work. Changing the JSON or posting `/base` after work has
started does not rebase existing changes. Use a new issue for another base.

## Model capabilities and media helpers

`capabilities` describes the primary model. `mediaModel` contains a helper's
`model` (`provider/model`) and its `capabilities`. Supported values are `text`,
`vision`, and `audio`; all configured models must support text output. These
declarations must match actual model support and do not configure a provider.

For an image/audio request, `inspect_media` sends the attachments and a focused
question to a separate read-only session. The helper receives no tools and
returns its findings to the coding session. The primary model is never switched.
If it already has the required capability, the helper can use that same model
in another session. Otherwise the configured media model is used.

Inputs can be HTTPS URLs or files inside the task worktree, including `file:`
URLs. Paths escaping that worktree are rejected. The provider/model must accept
the supplied media format. Private attachments must be accessible to OpenCode;
GitHub credentials are not forwarded to attachment URLs by this plugin.

If no configured model supports the requested input, the bot asks in the issue
for a configuration update or a text description/transcript. Existing configs
without capabilities are treated as text only, with no implicit helper. Reload
the idle service and owner project after adding a helper, then reply to continue.

## Markdown instructions

The package includes `prompts/bot.md`. It is read for analysis, task execution,
continuations, helpers, and PR-title generation. It is also injected into each
agent-loop system context, including the next request after compaction.

The bundled prompt scopes instructions to triage, base selection, implementation,
delegated workers, media helpers, and title generation. Within implementation,
it asks the agent to inspect the project, use relevant available workflows or
skills, plan nontrivial work, delegate useful independent subtasks, verify results,
and review the final diff. It also requires every affected description, example
and workflow diagram to be updated before finishing, with documentation changes
(or the reason none are needed) identified in the final report. Subagents and
planning tools must be available in the
OpenCode environment; the prompt does not install or enable them. Simple tasks
can stay lightweight, and unavailable delegation falls back to local work.

These steps guide the model inside the existing `running` phase. The executor
still performs its separate configured verification before publication. There
are no new persisted planning or review phases, and the dispatcher does not
enforce a review-completion gate. Writing "blocked" in a final summary does not
change task status; a need for user input must use `ask_issue`. Follow-up rounds
start a new main session on the existing worktree, so the prompt tells the agent
to inspect existing progress rather than assume the earlier session's plan is
already in context.

To append project instructions, create a Markdown file and set
`"systemPromptFile": ".opencode/bot.md"`. Relative paths resolve from the owner
checkout, not the worker branch. Absolute paths are also accepted. The file is
reread on every use; missing or empty configured files stop execution with an
error. The plugin never overwrites your file. Version it with the project, or
ignore it locally for machine-specific instructions.

## Follow progress and continue work

Starting a session shows a notification and opens a background tab when tabs
are enabled. In the owner project's TUI, use `/bot` to list tasks and open a
session, or `/restartworkflow` to select a task for recovery. Reopen TUI clients
after installing an update that adds or changes commands.

Closing or merging the PR automatically closes its known bot session tabs,
including earlier rounds and media helpers. This also works for manual GitHub
actions with `autoMerge` disabled. Closure is detected on the next repository
scan; connected TUIs also refresh every 10 seconds. Busy tabs wait until their
work finishes. Session history is preserved, and `/bot` can reopen a session.
Reopening it manually keeps it open for the current TUI instance. No additional
configuration is required.

A new comment from an authorized author on a tracked issue is saved as feedback.
After the current task reaches `done`, the next available worker pass starts a
new round: analysis and acknowledgement, implementation, checks, and a push to
the same open PR. The mention does not need to be repeated. Comments received
during execution, a pending question, or a blocked stage remain queued. Receiving
one does not itself clear the current block. A mention in an authorized comment
can also start work on an untracked issue.

Normal follow-up rounds reuse the worktree path saved in the queue, even if recovery
renamed its branch. Preparation, verification, and push validate that path as a
worktree root directly inside the managed worktree directory, attached to the
expected branch and repository. If the saved directory is missing, restore it
before retrying; the bot does not create a replacement or discard existing work.
After explicit round cancellation, a new round deliberately uses a fresh worktree
while preserving the old one; see [cancelling rounds](#cancelling-one-round-while-keeping-tracking).

Edits to existing comments and PR review comments are not supported. Closing the
issue or closing/merging the PR blocks further rounds.

Except for the host-wide `list` command described below, management commands run from the primary owner checkout of the target repository,
not from a bot worktree:

For source installations, replace `"$HOME/.local/bin/opencode2-automation"` with
`node "$HOME/opencode2-github-automation/dist/setup.js"`.

```bash
cd /absolute/path/to/your-project
"$HOME/.local/bin/opencode2-automation" status
"$HOME/.local/bin/opencode2-automation" scan
"$HOME/.local/bin/opencode2-automation" pause
"$HOME/.local/bin/opencode2-automation" resume
"$HOME/.local/bin/opencode2-automation" restartworkflow 'owner/repository#123'
```

Pausing stops scheduled scans; it does not cancel accepted tasks or active sessions.
Do not run independent bots on two machines against the same issues: they do not
share queue ownership across machines.

## Repository inventory

Run these commands from **any directory**, including outside Git:

```bash
opencode2-automation list
opencode2-automation list --json
opencode2-automation list --discover /absolute/path/to/projects
```

`list` reads this user's registry on this host. It never starts the service,
activates another owner, scans GitHub, retries tasks, or prompts a model. JSON
output contains `entries` and `warnings`. In the TUI, `/bot` → **Repositories**
shows the same inventory from the **connected server**, not the TUI client's
machine. Select a repository for details. This option remains available when
there are no tasks. It requires an updated, loaded owner plugin for the inventory
RPC; otherwise use the CLI on the server. Reopen the TUI after updating it.

Entries identify the GitHub repository, full checkout and owner paths, and the
last registered base branch. Before first activation an automatic branch may
say `auto (resolved on activation)`; task-specific base overrides are still shown
in task details. Advanced configurations with multiple repositories list each
configured repository, sharing the owner's scheduler information.

The report includes dispatcher activity, last scan attempt completion (which can
include failure), scheduler next-run timestamps, task counts and every open
blocked/failed/closing/cancelling issue key and saved error. Active counts use the actual
active task; scheduled work is separate. Closed local tracking and closed/merged
PR history do not inflate counts. A working dispatcher can have blocked tasks;
inspect the task counts as well as the owner status.

| Status | Meaning |
| --- | --- |
| `running` | Fresh dispatcher and scheduler snapshots; at least one polling job is unpaused. This does not promise that all tasks succeeded. |
| `paused` | Both snapshots are fresh and all scheduler jobs are paused. Accepted tasks can still execute. |
| `error` | A fresh dispatcher reports stopped/scan failure, a scheduler job has failures, or the standard configuration is invalid/unreadable. |
| `not-running` | No dispatcher snapshot yet, an explicit shutdown snapshot, or its process no longer exists. |
| `unavailable` | Missing, corrupt or stale component status, or an inaccessible directory. Do not infer idleness. |
| `missing` | A registered checkout/owner directory was removed or moved. |
| `unconfigured` | Its registered standard configuration file was removed. A previously loaded runtime may still be active until reloaded. |

Each component publishes a local snapshot every five seconds. A reading older
than 15 seconds is unavailable, even if its process still exists. Timestamps are
shown in UTC. Stopped/stale entries retain **historical** details; counts and next
run times in those snapshots are not live promises. Open the list again to refresh
it. Inventory errors do not reset queues or prevent bot execution.

`init` registers new projects. Loading an updated combined plugin imports its
existing standard configuration; the dispatcher also registers advanced
`repositories` options. To include older **inactive** standard configurations,
run `list --discover <root>`. Discovery only reads Git/config files and adds
registry metadata: no credentials, GitHub calls, or service activation are needed.
It examines the root plus six directory levels, at most 10,000 directories,
without following child symlinks or descending into hidden directories,
`node_modules`, `vendor`, `build`, or `dist`. Worktrees and subdirectories of a Git
checkout are excluded. Limits, unreadable folders and invalid configs are
reported. Choose a more specific root (including a hidden folder directly) when
needed. Advanced options require loading their owner once. This is an inventory
of registered/configured projects, not an exhaustive filesystem or other-user
scan.

Registration is per canonical owner path under
`$XDG_STATE_HOME/opencode2-automation/repositories`, defaulting to
`$HOME/.local/state/opencode2-automation/repositories`. CLI and service must use
the same user and state-home environment. Per-owner atomic files avoid lost
updates when different projects register concurrently. Aliases of one owner are
deduplicated; separate clones remain separate. Missing entries are retained so
the operator can see what disappeared. The registry never replaces the queue or
session database, and `list --discover` does not rewrite project configuration.

## Manage tasks from /bot

Run `/bot` in the owner project's TUI, choose an issue, then choose an action.
The same picker also offers **Repositories** for the host inventory:

- **Open session**: inspect its saved conversation, including a locally closed task.
- **Show details**: read the saved status, phase, error, branch, worktree, session,
  PR link and queued feedback. These are stored checkpoints, not a fresh GitHub lookup.
- **Close session tabs**: hide that task's idle tabs in this TUI only. Busy tabs
  remain open. Tracking and execution continue.
- **Restart workflow**: request the same guarded recovery as `/restartworkflow`.
- **Cancel current round**: stop the current round without publishing it. Preserve
  its session and worktree, then enter `watching` for new issue comments and PR
  state. Existing queued feedback remains eligible; only the current round is
  cancelled. **Retry cancelling round** retries an interruption failure.
- **Resume issue tracking**: available for a locally closed task. Validate that
  the issue and any known PR are open, stop any saved sessions again, then watch
  future comments. The stopped round and comments already present at this action's
  GitHub read are skipped. It does not replay work or immediately publish.
- **Stop and close task**: after confirmation, persist `closing`, interrupt known
  main, earlier-round and media sessions, wait for idleness and the task's in-flight
  worker operation, then persist `closed`. The menu offers **Retry closing task**
  while closure is pending.

Closing tracking works for queued, waiting, failed, blocked, running and published
work, even if its GitHub issue/PR or saved OpenCode session no longer exists.
It makes no GitHub close/delete request and preserves files, branches, worktrees,
commits, session history, pending questions and feedback. It does not publish
unfinished work. `closed` here means **local tracking ended**, not PR closure.
Closed tasks remain listed as history and their conversations can be reopened.

The closed record prevents rediscovery and later comments from restarting the
same issue. Recovery/retry cannot reopen tracking; use **Resume issue tracking**
explicitly to watch that issue again. Runtime question/helper admission is disabled once closure is requested.
Related idle tabs close once when the task becomes `closed`.

An already-started publication or automatic merge rejects closure with an explicit
message: wait for it to finish and try again. Other in-flight operations (such as
analysis, worktree preparation or checks) may finish locally before closure
completes, but cannot advance to publication. An already-submitted GitHub comment
may complete. Closing is not a rollback of earlier Git or GitHub effects.

Interruption errors keep the task in `closing` with a visible error, retried after
30 seconds or through **Retry closing task**. A restart resumes the saved closure
instead of restarting implementation. No success is reported while interruption
has failed or the task's worker operation is still pending. Missing sessions are
already stopped and do not block closure.

## Cancelling one round while keeping tracking

**Cancel current round** differs from closing the task and from hiding its tab.
It persists `cancelling` before interrupting sessions, waits for in-flight local
work and question posts, interrupts again, and enters `watching` only after that
finishes. Failures remain visible and retry after 30 seconds; an owner restart
resumes cancellation. Publication or merge already in flight rejects cancellation
because remote effects cannot be rolled back. A comment already being posted can
still appear in GitHub. Cancellation does not revert previously pushed commits.

The completed transition archives the round's session, worktree, question,
feedback, error, attempts and verification/report checkpoints. It clears the
current question, recovery request and live error, without deleting any files or
sessions. Late explicit `/allow ID` or `/deny ID` replies to archived permission
questions cannot restart the task. Other new authorized comments can request work.

The next round starts in a **new worktree and local branch** from the published
PR branch, or the pinned base when no PR exists. Archived worktrees remain intact,
including dirty files and local commits; their changes are not automatically
included. Publication still targets the original remote branch and PR. The bot
receives only the new round's feedback and instructions not to replay cancelled
scope. Normal later rounds reuse the new worktree. Details show the last preserved
worktree; full cancellation history is retained in the queue.

PR state monitoring continues while `watching`. Automatic merging uses only the
last saved published head, with normal approval checks. Legacy tasks without that
checkpoint still watch comments and PR state, but cannot auto-merge until another
round publishes successfully. No model runs while waiting for new feedback.

Equivalent owner-checkout commands:

```sh
opencode2-automation cancelround 'owner/repository#123'
opencode2-automation resumetracking 'owner/repository#123'
```

The sidebar shows **Watching issue — round cancelled** or **Tracking closed**.
Old failures appear under **Historical error** in `/bot` → **Show details**, not
as a live red error or failed-attempt count. Cancelling a round does not automatically
close the PR's tab; closing the tab remains an independent display action.

## Runtime status sidebar

The **BOT RUNTIME** section is appended to the existing right sidebar, preserving
OpenCode's context information. Open the TUI in the configured primary owner
checkout. Switching task tabs changes the task details while the scheduler and
dispatcher rows continue to describe that owner project.

The panel shows:

- Dispatcher activity: idle, reconciling state, executing a task's actual phase,
  checking merges, maintenance, or stopped. An active task key is shown separately.
- GitHub discovery: scanning, the time the last scan finished, and any scan error.
- Scheduler jobs: running, paused, next run time or retry delay, and errors.
  Pausing polling can coexist with an already-running scan or task.
- Queue counts: ready/retry-wait excluding the active task, waiting for replies, blocked/failed and published
  tasks, excluding closed/merged PRs and locally closed tracking. Scheduled does not mean a model is executing.
  Up to three attention rows identify blocked, failed, closing or cancelling issue keys and
  saved errors. Pending closures have a separate count; use `/bot` for the full list.
- Task details: issue, phase, round, observed main-session status, task/base branches,
  model, queued feedback, allocated media helper count for the current session,
  failed attempts, recovery request, PR state and any task/merge error.
- Separate freshness information for dispatcher and scheduler readings.

Task selection prefers the displayed session (including saved earlier-round and
helper IDs), then the dispatcher's active task, then an open waiting/blocked task,
then scheduled work, then the last known task. Main-session running/idle comes
from the TUI's session cache when that session is available; otherwise the panel
says `not observed`. Media counts do not claim that those helpers are running and
do not count native implementation subagents.

Read-only snapshots refresh on startup and every five seconds, with a four-second
request deadline and no overlapping refreshes. Countdown labels update locally
every second. No model is prompted and polling does not restart jobs or repair
queue state. A failed request retains the last successful snapshot with a stale
warning; readings older than 15 seconds are also marked stale. Dispatcher and
scheduler failures are independent, so a partial failure keeps the other component
visible. Initial/unavailable data is never presented as a healthy idle service.

Use `/botstatus` for a text report, including every known task and scheduler job,
when the sidebar is hidden or more detail is needed. The sidebar shows up to three
scheduler jobs and truncates long labels/errors. `/bot` manages task sessions;
`/restartworkflow` remains the separate explicit recovery action.

The TUI and owner plugin must both contain the monitor API. With an older server,
an unloaded/unconfigured owner, a direct worktree-only launch, or a failed RPC,
the panel reports unavailable status. Load the configured owner and update both
sides as needed; reopen TUI clients after installation. Monitoring uses the
connected OpenCode client, so it also works with a remote service when the correct
owner location and updated plugin are available there. Live worker/scan diagnostics
reset when the owner is recreated; task checkpoints and scheduler history remain
durable as before.

## PR descriptions

A formal GitHub **Approve** review applies to its exact commit even when submitted
before the bot finishes updating the PR description. Retrying publication does
not invalidate that review. A new commit needs a matching review, and dismissed
approvals or outstanding change requests are not accepted. Plain merge comments
still must follow the latest publication because they do not identify a commit.

After pushing a verified commit, GitHub may briefly show the previous commit in
the PR. If the remote branch already matches the verified commit, the bot waits
and automatically retries publication within its configured attempt limit. It
keeps the saved report and does not repeat implementation or a checkpointed push.
A changed remote branch or closed PR produces a separate blocking error. If the
propagation retries are exhausted, inspect the error and use `/restartworkflow`;
see [description recovery](advanced.md#pr-description-recovery).

The PR contains the agent's final completion summary from the successful session,
with Markdown preserved, followed by dispatcher verification, the issue reference,
session, round and verified commit. The initial issue acknowledgement is not a
completion report. Agent-reported tests remain in the summary; the dispatcher
lists only checks it actually ran. With no configured test command it explicitly
states that agent-reported tests were not independently rerun.

Follow-up rounds keep the original summary and replace a single **Latest update**
section after the new commit is pushed. The PR title stays unchanged. Reports are
saved before publication so a restart or lost GitHub response can reuse them.
If a legacy session is missing or has no successful final text, the description
states that its summary is unavailable.

Put manual PR notes outside the `opencode2:pr-body` HTML markers (visible when
editing the description). Edits inside that section or removal of the markers
block further description updates to protect your changes. Inspect the task error,
resolve the conflict and retry publication; see
[description recovery](advanced.md#pr-description-recovery). Installing an update
does not automatically rewrite already completed or closed PRs.

## Interrupted sessions and workflow recovery

If you manually continue a timed-out or interrupted bot session in the TUI,
the dispatcher detects its successful completion automatically. It rejoins the
saved execution phase, validates the session result, runs the configured checks,
and publishes the verified changes to the same branch and PR. Pending authorized
issue comments remain queued and start the next round after publication. This
also works after a service restart once the owner is loaded; opening a TUI is
not required. Only recognized session-stop checkpoints qualify for this automatic
recovery. Other failures retain their documented retry/inspection requirements.

Use `/restartworkflow` in the owner project's TUI and select the issue to recover
a stopped workflow. The equivalent terminal command is shown above. For a stopped
session, recovery waits for any current execution, then continues the previously
agreed task in that same session if it still needs work. For a verification or
publication failure, it retries that saved stage. It preserves the worktree,
branch, session history, pinned base, PR, and queued feedback. Repeated requests
while recovery is scheduled or running do not start duplicate work.

Recovery does not bypass failing checks, unresolved questions or permissions,
closed PRs, or uncertain prompt delivery. Answer pending questions in the issue.
If a check still fails, fix its cause and retry; the plugin will not publish an
unverified result. A service restart restores the saved state but does not clear
these blocks. To resume paused issue polling, use `resume` separately.

The CLI response `accepted: true` means recovery was queued, not that execution
or publication has finished. `accepted: false` means the task was not blocked or
failed and no duplicate recovery was created. Missing tasks, unresolved questions,
closed/merged PRs, missing routes, and unsafe running-session errors instead
produce an actionable error. A recovery request can be queued while another issue
is working, but it waits for a worker pass before execution.

Use `status` to distinguish `phase` (saved execution step) from `status` (whether
it may run). Active work is normally `phase: running`, `status: ready`; `done`
means publication completed, not that the PR merged. `pendingFeedback` contains
comments awaiting a later round. The TUI's `merged` and `pr_closed` phases are
presentation values derived from the saved PR state. For detailed selection,
checkpoint and retry rules, see [workflow section 8](bot-workflow.md#8-status-retries-and-recovery).

`retry` alone clears a block at the saved phase; it does not request a new model
continuation. `retry --restart-session` interrupts the old session and clears its
identity, so use it only after inspecting the session and uncertain prompt
results. `/restartworkflow` retains the session. Neither recovery command replaces
service startup or scheduler `resume`. The slash command belongs in OpenCode's
TUI, not in an issue comment.

While a closure is pending, the dispatcher does not start another worker pass.
An unrelated already-running task can finish; scanning continues for other tasks.
The monitor reports task maintenance until closure completes.
