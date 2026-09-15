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

For permission requests, use the exact `/allow QUESTION_ID` or `/deny QUESTION_ID`
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

Follow-up rounds reuse the worktree path saved in the queue, even if recovery
renamed its branch. Preparation, verification, and push validate that path as a
worktree root directly inside the managed worktree directory, attached to the
expected branch and repository. If the saved directory is missing, restore it
before retrying; the bot does not create a replacement or discard existing work.

Edits to existing comments and PR review comments are not supported. Closing the
issue or closing/merging the PR blocks further rounds.

Management commands run from the primary owner checkout of the target repository,
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
  tasks, excluding closed/merged PRs. Scheduled does not mean a model is executing.
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
scheduler jobs and truncates long labels/errors. `/bot` opens task sessions;
`/restartworkflow` remains the separate explicit recovery action.

The TUI and owner plugin must both contain the monitor API. With an older server,
an unloaded/unconfigured owner, a direct worktree-only launch, or a failed RPC,
the panel reports unavailable status. Load the configured owner and update both
sides as needed; reopen TUI clients after installation. Monitoring uses the
connected OpenCode client, so it also works with a remote service when the correct
owner location and updated plugin are available there. Live worker/scan diagnostics
reset when the owner is recreated; task checkpoints and scheduler history remain
durable as before.

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
