# Bot workflow: from GitHub issue to merged PR

This document describes the current implementation, including waiting, retries,
follow-up rounds, and recovery. Mermaid nodes use the actual persisted phase
and status names where applicable. `done` means publication finished; it does
not mean the PR has merged. These diagrams describe the code on this branch;
features under `Unreleased` are available in a build of this branch and enter a
published package through the release process.

Read the diagrams together: sections 1–3 cover scheduling and admission, section 4
covers the saved main session, sections 5–7 cover helpers and publication, and
section 8 covers every recovery entry point. Model planning, subagents and review
happen inside `running`; they are not additional persisted phases.

## 1. Startup, ownership, and polling

```mermaid
flowchart TD
    Load[Load combined automation plugin] --> Owner{Primary Git checkout root?}
    Owner -->|No or outside Git| Inactive[Plugin stays inactive]
    Owner -->|Yes| Config[Use nonempty plugin options or read .opencode/automation.json]
    Config -->|No project config| Inactive
    Config --> Resolve[Validate settings and resolve GitHub auth, routes and defaults]
    Resolve --> GH[Acquire github lock and load queue.json]
    GH --> RPC[Register runtime bridge and dispatcher RPC]
    RPC --> Worker[Immediate worker tick, then every workerEverySeconds]
    RPC --> Scheduler[Start scheduler after GitHub setup succeeds]
    Scheduler --> State[Acquire scheduler lock, load scheduler.json and register RPC]
    State --> Clock[Immediate scheduler tick, then every second]
    Clock --> Due{Job due, unpaused and not already running?}
    Due -->|Yes| Scan[Invoke configured RPC, normally automation.github.scan]
    Scan --> Save[Persist result, failures and nextAt]
    Save --> Clock
    Due -->|No| Clock
    Worker --> Recover[Probe eligible stopped sessions and recover unpublished questions]
    Recover --> Round[Promote one done task with pending feedback to a new round]
    Round --> Select[Choose ready or retry_wait task, saved running session first]
    Select --> Candidate{Candidate exists?}
    Candidate -->|No| Merge[Check eligible merges]
    Candidate -->|Yes| TaskDue{Candidate nextAt elapsed?}
    TaskDue -->|No| Worker
    TaskDue -->|Yes| Dispatch[Advance saved phase]
    Dispatch --> Worker
    Merge --> Worker
    RPC -.-> Keepalive[Each component touches the same empty owner session every ten minutes]
    State -.-> Keepalive
    Keepalive --> PID{Registered service PID matches this process?}
    PID -->|Yes| Touch[Create or reuse maintenance session, then emit rename event]
    PID -->|No| Skip[Skip keepalive]
    Stop[Owner reload or shutdown] --> Cleanup[Stop timers and local waits, settle writes, dispose RPC, release locks]
    Cleanup --> Preserve[Preserve durable queue and healthy worktree execution]
    Preserve --> Load
```

- Easy configuration puts state under the shared Git directory at
  `opencode2-automation/`. Worker worktrees do not start another scheduler.
- Default discovery interval: **60 seconds**. Default worker interval:
  **5 seconds**. These are separate loops: pausing scheduled scans does not
  cancel accepted work or active sessions.
- A scan cannot overlap another scan in the same dispatcher. Only one worker
  invocation runs at a time; one scheduler job cannot overlap itself.
- Each component renews one empty owner maintenance session at startup and every
  ten minutes. Durable session events refresh OpenCode's inactivity timer; listing
  plugins does not. No model is prompted. A PID check prevents touching a different
  service. Requests do not overlap and have a 15-second deadline. Pausing issue
  scans does not pause keepalive. Standalone servers without a matching registered
  service skip it.
- State is schema-validated and saved through a temporary file, file sync, and
  rename. A corrupt state file fails to load rather than resetting the queue.
  Local locks prevent duplicate owners sharing this state directory; independent
  machines do not share ownership.
- Shutdown clears timers and aborts local SDK waits even if the adapter ignores
  cancellation. It settles local writes, bounds RPC disposal to five seconds per
  component, and attempts all cleanup steps before releasing ownership. A replacement
  waits up to 15 seconds for locks without removing them. Healthy worktree sessions
  continue; the next owner reconciles the saved session before verifying and publishing.


Sources: [index.ts](../src/index.ts), [easy.ts](../src/easy.ts),
[GitHub plugin](../src/plugins/github.ts),
[scheduler plugin](../src/plugins/scheduler.ts), [lifecycle.ts](../src/lifecycle.ts),
[dispatcher.ts — workOnce](../src/dispatcher.ts), [state.ts](../src/state.ts).

## 2. Discovery and routing

```mermaid
flowchart TD
    Scan[Scan each configured repository] --> PRs[Refresh tracked PRs not already marked merged]
    PRs --> Issues[List open issues and fetch missing tracked issues]
    Issues --> Skip{PR entry or closed untracked issue?}
    Skip -->|Yes| Ignore[Ignore entry]
    Skip -->|No| Comments[Read comments and filter authorized human comments without bot markers]
    Comments --> Tracked{Task already exists?}
    Tracked -->|Yes| Answer{Open issue with unanswered published question and eligible reply?}
    Answer -->|Yes| Accept[Save first eligible answer and any permission decision]
    Accept --> Ready[Only waiting status becomes ready]
    Ready --> Remaining[Remove answer from fresh and previously queued feedback]
    Answer -->|No| Feedback[Append remaining fresh comments to pendingFeedback]
    Remaining --> Feedback
    Feedback --> Cursor[Persist cursor from all observed comments and save queue]
    Cursor --> Gate{Task done?}
    Gate -->|Yes| Later[Next available worker pass may start a follow-up round]
    Gate -->|No| Retain[Keep feedback until current round publishes]
    Tracked -->|No| Body[Match body route only for an authorized issue author]
    Body --> Found{Body route found?}
    Found -->|Yes| Queue[Persist queued / ready with initial authorized feedback]
    Found -->|No| Route[Try authorized comments, keeping the last matching route]
    Route -->|Route found| Queue
    Route -->|No route| Ignore
    Body -->|Multiple matching tags| Block[Persist queued / blocked task]
    Route -->|Multiple matching tags| Block
```

Authorized comment filtering requires an author in the configured allowlist
(case-insensitive), a nonempty body, a non-`Bot` account type, and no
`<!-- opencode2:` marker. A human may use the same account as the bot: the login
itself is not excluded. Initial issue-body routing checks the issue author's
allowlist membership; the issue schema does not include an account-type check.

Routing tags are case-insensitive configured `@mentions`. If the issue body
selects a route, comments do not replace it. Otherwise the last matching
authorized comment encountered selects the route, unless matching throws for
multiple tags. An authorized comment can trigger work on another author's issue.

Each task is keyed by lowercase `owner/repository#issueNumber`. Its branch is
`automation/issue-N-DIGEST`, where `DIGEST` is the first 12 hex characters of the
SHA-256 of that key. Initial feedback contains the authorized comments already
seen. Later comments are tracked by increasing comment ID; edits do not create
new feedback. PR review comments do not drive implementation rounds.

Discovery and execution are separate: saving `pendingFeedback` does not itself
clear a blocked task or interrupt its current session. Only `done` tasks start a
new round. A session-stop block can first reconcile successful manual continuation
as described in section 8. A pending question consumes its first eligible reply
instead of also treating that reply as follow-up work. The comment cursor includes
all observed comments, while only authorized, unmarked comments become inputs.

Source: [dispatcher.ts — scanOnce](../src/dispatcher.ts),
[config.ts — matchRoute](../src/config.ts).

## 3. Main task lifecycle

```mermaid
flowchart TD
    Q[queued / ready] --> Guard[Re-fetch issue and validate route, authorization and follow-up PR]
    Guard --> A[analyzing: generate or reuse structured decision without tools]
    A --> Decision{Decision kind?}
    Decision -->|question| AQ[Persist proposals and question, publish one signed comment]
    AQ --> AW[analyzing / waiting]
    AW -->|Authorized reply| Dialogue[Save dialogue and invalidate prior decision]
    Dialogue --> Guard
    Decision -->|proceed| Ack[Publish or reconcile signed analysis acknowledgement]
    Ack --> C[commented with confirmed commentID]
    C --> Pinned{Base already pinned?}
    Pinned -->|No| Base[Interpret authorized branch discussion with main model]
    Base --> Choice{Valid unambiguous branch exists on origin?}
    Choice -->|No| BQ[Publish base question, commented / waiting]
    BQ -->|Authorized reply| Base
    Choice -->|Yes| Pin[Persist baseBranch]
    Pinned -->|Yes| Prepare[Validate repository and reuse saved worktree or create a new one]
    Pin --> Prepare
    Prepare --> R[running: save workspace, install runtime and execute saved session]
    R -->|Question| RW[running / waiting]
    RW -->|Authorized reply| R
    R -->|Timeout or unsuccessful final result| Stopped[running / blocked with sessionStopped]
    Stopped -->|Manual continuation succeeds and probe passes| R
    Stopped -->|Explicit restartworkflow| Recover[Persist recovery intent, rejoin the same session]
    Recover --> R
    R -->|Validated success, no unresolved question| V[verifying: configured checks and commit]
    V --> P[publishing: reconcile or create PR, push when required]
    V -->|Failed check or Git consistency guard| VB[verifying / blocked]
    VB -->|Operator retries saved stage| V
    P --> Done[pr_opened / done with PR and publishedAt]
    P -->|Publication failure| PB[Retain publishing phase and apply error policy]
    PB -->|Eligible retry| P
    Done -->|Pending authorized feedback| Round[Increment round, move feedback and reset per-round state]
    Round --> Q
```

Before `queued`, `analyzing`, or `commented` work advances, the dispatcher checks
that the issue is still open. Follow-ups additionally require an open original
PR and still-authorized feedback authors. A changed issue title, body, or route
after saved analysis blocks progress. Removing configuration or leaving no
unambiguous route also blocks work. These guards are phase-specific; closing an
issue does not immediately cancel an already-running session.

Analysis has no tools and does not inspect code. It returns validated JSON:
`proceed` with an English understanding and plan, or `question` with proposals
and a clarification. Invalid output retries. Requests for proposals or a choice
before implementation must wait for a reply, then run analysis again. An unclear
reply can generate another question. Persisted older analyses without a decision
are reassessed before implementation.

Base selection follows the acknowledgement. It considers authorized issue text,
comments, and clarification dialogues, excluding quoted lines and fenced code.
The model must substantiate an explicit branch using text from those inputs.
A selected branch, including the configured default, is checked on `origin`; ambiguity or absence
produces a question. Invalid model output or Git connection failure retries.
No preference uses the configured base, which easy configuration defaults to the
GitHub default branch. Fetch still has to succeed during preparation. Once saved,
the base stays pinned across retries and rounds; later comments do not rebase work.

Preparation validates the checkout root, `origin` repository, and branch name.
A new worktree is created from the fetched base commit under
`stateDirectory/worktrees/BRANCH-WITH-SLASHES-REPLACED-BY-DASHES`.
For a saved `worktree`, preparation uses that exact path even if the branch was
renamed during recovery. Its canonical directory must be a direct child of the
managed worktree folder and the exact Git worktree root, with the expected branch
and shared Git directory. Its pinned `baseSha` is retained. A missing saved path,
or a branch already existing without its expected worktree, blocks work rather
than creating a replacement. The worker runtime is installed before execution.

Failures retain their current phase. A stopped `running` session can return to
that phase through automatic reconciliation or explicit workflow recovery; neither
path skips the session checks or jumps straight to `done`. Recovery of `verifying`
or `publishing` retries that saved stage. The full error and command rules are in
section 8.

Sources: [dispatcher.ts — workOnce, resolveAnalysis, resolveBase](../src/dispatcher.ts),
[executor.ts — analyze, selectBase, GitWorkspace.prepare](../src/executor.ts),
[branch.ts](../src/branch.ts).

## 4. Session execution and questions

```mermaid
sequenceDiagram
    participant D as Dispatcher / executor
    participant S as Saved OpenCode main session
    participant R as Worker runtime
    participant G as GitHub issue
    participant U as Authorized user / operator
    opt No saved session ID
        D->>D: Persist sessionID before contacting OpenCode
    end
    D->>S: Get session, create only on explicit not-found
    D->>D: Validate worktree location and save sessionReady
    opt Initial prompt not attempted
        D->>D: Persist promptAttempted
        D->>S: Implement agreed scope with task marker
    end
    opt Explicit recovery queued, continuation not attempted
        D->>S: Wait until current execution is idle
        D->>S: Read saved outcome
        alt Outcome is not succeeded
            D->>S: Confirm original task marker in context
            D->>D: Persist recovery.attempted before sending
            D->>S: Continue same task with recovery marker and deterministic message ID
        else Already succeeded
            Note over D,S: Do not send another continuation
        end
    end
    D->>S: Wait for completion
    opt Clarification or permission required
        S->>R: ask_issue / intercepted question / permission ask
        R->>D: Register against main task session
        D->>D: Persist pending question
        D->>G: Publish signed question with stable marker
        R-->>S: Stop work and finish turn
        D->>D: Preserve running phase, set waiting
        U->>G: Reply in the same issue
        D->>G: Scan reads eligible answer
        D->>D: Persist answer and set ready
        D->>S: Resume same session with deterministic answer message ID
        D->>S: Wait for completion
    end
    alt Owner is disposed
        Note over D,S: Release local wait without interrupting healthy execution
        Note over D: Replacement owner loads queue and rejoins saved session
    else Session deadline expires
        D->>S: Interrupt execution
        D->>D: Save running / blocked with sessionStopped
    else Wait completes
        D->>S: Read context and final outcome
        alt Valid task marker, admitted recovery marker if required, and successful final assistant
            D->>D: Clear recovery state and advance to verifying
        else Unsuccessful final outcome or assistant
            D->>D: Save session-stop block for later reconciliation
        else Missing marker or wrong location
            D->>D: Block for inspection, no automatic prompt replay
        end
    end
```

- A saved `sessionID` is reused after transport failure. A network error when
  looking up a session never authorizes creating a duplicate. The initial prompt
  is sent only when `promptAttempted` is false.
- The implementation prompt instructs the agent to edit only its worktree and
  leave pushes, PR creation, comments, and branch changes to the dispatcher.
  These publication restrictions are prompt instructions; verification provides
  the subsequent Git consistency checks.
- Runtime context injects bundled bot instructions and optional project prompt
  instructions on each agent loop, including after compaction. A missing or empty
  configured prompt file fails execution.
- Within `running`, the bundled prompt guides project inspection, planning,
  use of available workflows and native subagents, implementation, verification,
  and final review. These are model instructions, not persisted dispatcher
  phases or enforced review gates. The executor's `verifying` phase remains
  separate. A prose blocker in the final summary does not set `blocked` status;
  user-input blockers must go through `ask_issue`.
- One unresolved question is retained at a time. Runtime hooks remove tools and
  reject non-question tool execution while a question is pending. Native subagent
  questions are attached to the main task; the reply resumes the main session.
- The first authorized comment after the published question is accepted without
  another mention. Other fresh comments remain feedback for a later round.
  Replies require the issue to be open. Question state survives restarts.
- Permission questions require the entire trimmed reply to be exactly
  `/allow QUESTION_ID` or `/deny QUESTION_ID`. The stored decision is scoped to
  the main session, action, and sorted resource set, including native workers.
  Until answered, the requested operation is denied. Explicit OpenCode deny
  rules are not overridden: the hook only handles permissions with effect `ask`.
- Replies to analysis questions rerun analysis; base replies rerun selection;
  implementation replies resume execution. Answer delivery is checkpointed and
  uses a deterministic message ID for retry reconciliation.
- A pending question prevents verification and PR publication. Waiting tasks
  release worker selection so other queued tasks can proceed.
- A session wait deadline attempts to interrupt the server session and records
  a `SessionStopped` block. A final outcome other than `succeeded`, a missing final
  assistant, an assistant error, or a finish other than `stop` also records a
  session stop. A successful manual continuation can be discovered automatically.
- Explicit workflow recovery waits for existing execution before deciding whether
  to send a continuation. It sends nothing if the saved outcome is already
  `succeeded`; normal final-message validation still applies. Otherwise it checks
  the original task marker, persists `recovery.attempted`, and sends the recovery
  marker with a deterministic message ID. A later retry never blindly resends
  that attempted prompt. Missing recovery evidence blocks for inspection.
- Wrong session location and uncertain original prompt delivery are ordinary
  `Blocked` errors, not session-stop eligibility. A pending question still prevents
  publication. Successful execution clears `sessionStopped` and `recovery` as the
  dispatcher advances to `verifying`.

Sources: [executor.ts — runSession](../src/executor.ts),
[runtime.ts](../src/runtime.ts), [prompt.ts](../src/prompt.ts),
[dispatcher.ts — workOnce, question, publishQuestion, restartWorkflow](../src/dispatcher.ts).

## 5. Optional media inspection

```mermaid
flowchart TD
    Call[inspect_media request] --> MainTask{Owning main task has route and worktree?}
    MainTask -->|No| Error[Return tool error]
    MainTask -->|Yes| Cap{Main model supports requested vision or audio input?}
    Cap -->|Yes| Main[Select main model for a separate helper session]
    Cap -->|No| Other{Configured mediaModel supports input?}
    Other -->|Yes| Helper[Select configured helper model]
    Other -->|No| Ask[Post issue question for configuration or text description and wait]
    Main --> Files[Validate 1 to 8 HTTPS URLs or real files inside worktree]
    Helper --> Files
    Files -->|Invalid input| Error
    Files --> Guard{Task running with no unresolved question?}
    Guard -->|No| Error
    Guard -->|Yes| ID[Persist deterministic helper ID for main session and tool call]
    ID --> Session[Get saved helper or create only on explicit not-found]
    Session --> Prompt[Send deterministic attachment prompt, hooks disable all tools]
    Prompt --> Wait[Wait with session deadline]
    Wait -->|Timeout| Interrupt[Attempt helper interruption and return error]
    Wait -->|Other failure| Error
    Wait -->|Completed| Result{Succeeded outcome and non-error final assistant with finish stop?}
    Result -->|No| Error
    Result -->|Yes| Return[Return findings to main session, keep main model unchanged]
```

Only the owning main bot session can delegate media; the helper-registration
step also requires `running` with no unresolved question. Helpers have no tools.
URLs cannot contain credentials; local paths are resolved and must remain inside
the worktree. GitHub credentials are not forwarded to media URLs. A helper uses
stable session and prompt IDs for a given call. Helper failures return errors;
a helper timeout attempts interruption. Native implementation subagents are a
separate mechanism: they may use permitted tools, while their questions route back
to the main task through parent-session lookup. Neither kind of helper creates
another dispatcher round or publishes its own PR.

Source: [runtime.ts — inspect_media](../src/runtime.ts).

## 6. Verification and publication

```mermaid
flowchart TD
    Start[Validated session success or retry of verifying phase] --> Identity[Require saved workspace and base, exact managed root, branch and shared repository]
    Identity --> Base[Require baseSha ancestor of HEAD and no unresolved conflicts]
    Base --> Checks[Run configured checks sequentially, or none if list empty]
    Checks -->|Configured check fails| Block[blocked at saved phase, retain work]
    Checks -->|Pass| Diff[Recheck identity and git diff --check]
    Diff --> Stage[git add --all, check staged diff and record staged tree]
    Stage --> Commit[Commit staged changes if any]
    Commit --> Validate[Require committed tree matches, changes versus base and clean worktree]
    Identity -->|Explicit consistency guard fails| Block
    Base -->|Unresolved conflicts| Block
    Validate -->|Explicit consistency guard fails| Block
    Validate -->|Pass| Save[Persist checks and exact commit SHA, phase publishing]
    Retry[Retry saved publishing phase] --> Find
    Save --> Find[Find branch PR including closed PRs]
    Find --> Follow{Follow-up round?}
    Follow -->|Yes| Open{Existing PR open?}
    Open -->|No| Block
    Open -->|Yes| Push[Validate origin, workspace, saved HEAD and clean tree, push exact SHA]
    Follow -->|No| Exists{PR already exists?}
    Exists -->|Yes| Done[Record PR and publication time, pr_opened / done]
    Exists -->|No| Title[Generate title only if no saved prTitle]
    Title --> Issue{Issue still open?}
    Issue -->|No| Block
    Issue -->|Yes| PushNew[Validate origin and workspace, push exact verified SHA]
    PushNew --> Create[Create or reconcile signed PR against pinned base]
    Create --> Done
    Push --> Done
    Failure[Other command, model or transport error] --> Policy[Keep current phase and apply retry policy in section 8]
```

Resuming `running` validates the saved session first; retrying `verifying` runs
checks again. Retrying `publishing` uses the saved verified SHA and requires the
worktree still to match it, rather than rerunning checks implicitly. An already
pushed branch does not by itself make a task complete.

The configured checks are command argument arrays. A failing configured check
produces `blocked`. With no configured checks, only Git consistency checks run;
the PR explicitly states that automated tests were not run. Commit hooks changing
the recorded tree, a dirty worktree after commit, or no diff from the base block
publication. Other command failures use the general error policy below.

The PR body contains the analysis, `Closes #N`, checks, session ID, and verified
commit SHA. Push uses `COMMIT:refs/heads/TASK_BRANCH` without force. The first
publication reconciles an existing branch PR by recording it without another
push; follow-ups require an open PR and push the new verified commit. Follow-ups
do not regenerate the existing PR title or body.

Signed comments use stable `opencode2` markers; reconciliation looks for a marker
posted by the authenticated account. This covers analysis acknowledgements,
questions, and merge acknowledgements after a lost response.

Sources: [executor.ts — GitWorkspace.verify, push, title](../src/executor.ts),
[dispatcher.ts — publishing](../src/dispatcher.ts),
[github.ts — ensureComment, ensurePull](../src/github.ts).

## 7. Feedback, merge approval, and tab closure

```mermaid
flowchart TD
    Pending[Authorized comment enters pendingFeedback] --> Done{Current task done?}
    Done -->|No| Keep[Retain comment while running, waiting or blocked]
    Keep --> Recovery[Session recovery and publication must finish first]
    Recovery --> Done
    Done -->|Yes| Round[Next worker pass starts one new round on saved branch and worktree]
    Round --> Guard[Require open issue, open original PR and authorized feedback, then analyze again]
    Idle[Worker has no eligible execution task] --> Eligible{Auto-merge enabled and done task eligible?}
    Eligible -->|No| Later[Wait for a later worker pass]
    Eligible -->|Yes| Since{publishedAt exists?}
    Since -->|No| Window[Record current time as fresh approval window]
    Window --> Later
    Since -->|Yes| Scan[Scan again before considering merge]
    Scan --> Fresh{Pending feedback or closed PR?}
    Fresh -->|Yes| Later
    Fresh -->|No| Detail[Read GitHub PR details]
    Detail --> Already{Already merged?}
    Already -->|Yes| Ack[Post or reconcile signed merge acknowledgement, persist merged and closed PR]
    Already -->|No| Head{Open, non-draft PR with saved verified head?}
    Head -->|No| Poll[Clear mergeError, set mergeNextAt at least 60 seconds later]
    Head -->|Yes| Review[Evaluate latest decisive reviews and exact approval comments]
    Review --> Author{No outstanding changes request and eligible approver has write, maintain or admin access?}
    Author -->|No| Poll
    Author -->|Yes| Ready{mergeable and mergeable_state clean?}
    Ready -->|No| Error[Record mergeError and delayed retry, preserve task status]
    Ready -->|Yes| Merge[Request GitHub merge with exact SHA and configured method]
    Merge -->|Merged| Ack
    Merge -->|Rejected or request fails| Error
    Poll --> Later
    Error --> Later
    Manual[Manual PR close or merge] --> Refresh[Repository scan refreshes tracked PR state]
    Ack --> UI[Activity events and TUI polling every 10 seconds]
    Refresh --> UI
    UI --> Busy{Associated tab busy?}
    Busy -->|Yes| Defer[Retry closure on a later snapshot]
    Busy -->|No| Tabs[Close known task and helper tabs once, preserve sessions and worktrees]
```

Merge eligibility requires `done`, a tracked nonclosed PR, a saved commit, no
merged flag, no pending feedback, and an elapsed `mergeNextAt`. Missing
`publishedAt` in an older queue starts a fresh approval window rather than using
historical approval. Merge checks run when the worker has no execution task to
advance, rather than immediately after every publication.

For each reviewer, the latest `APPROVED`, `CHANGES_REQUESTED`, or `DISMISSED`
review is decisive. Any outstanding changes request suppresses all approval
candidates, including comment approvals. An approval review must reference the
current verified SHA and have been submitted after `publishedAt`. An approval
comment must have been created after that time and match a configured phrase
as a whole message after case, whitespace, and trailing `.`/`!` normalization.
Bot comments and marked automation comments are excluded. Default phrases are
`/merge`, `lgtm, merge`, and `approved, merge`; default merge method is `squash`.
The permission check then requires an allowlisted candidate with repository write,
maintain, or admin access. GitHub still enforces merge requirements.

Every successful round updates `publishedAt`, so old approvals cannot authorize
the next published round. When the approval method returns false (for example,
no eligible approval or a mismatched head), the dispatcher clears `mergeError` and schedules another check
after 60 seconds. An approved PR that GitHub says is not ready, a rejected merge,
or a request failure records `mergeError`; error retries also respect GitHub timing.
An already-merged response can reconcile a previously lost merge response.

Follow-up rounds reset analysis, question, current session, session-stop/recovery
state, checks, and commit; they retain the branch, worktree, pinned base, and previous session reference.
Preparation reuses the saved worktree path rather than deriving a new path from
the branch name. A renamed branch can therefore retain its original directory.
Preparation, verification, and push all check the managed path, exact Git root,
branch, and shared repository. A missing checkpoint directory blocks the task
without creating a replacement worktree.
A follow-up creates a new main session, whereas an implementation-question reply
or workflow recovery retains the current one. Comments received while working,
waiting or blocked stay queued until publication of the current round completes.
Feedback after closure can still be queued, but the next round's guards block it.

PR-state scanning is independent of auto-merge and issue openness. The TUI
subscribes to activity and polls every 10 seconds, including recovery on startup.
It opens background task tabs when enabled and exposes `/bot` for session access
and `/restartworkflow` for operator recovery in the owner project. Commands use
owner-scoped RPC; they are not GitHub comment commands. Activity phases `merged`
and `pr_closed` are display values, not new persisted execution phases.
Closure cleanup includes known earlier-round sessions and media helpers. Busy
tabs wait until idle; cleanup does not delete sessions, interrupt work, or remove
worktrees. A manually reopened tab is not repeatedly closed in the same TUI instance.

Sources: [dispatcher.ts — workOnce, mergeOnce, scanOnce](../src/dispatcher.ts),
[approval.ts](../src/approval.ts), [github.ts — mergeApproved](../src/github.ts),
[ui.ts](../src/ui.ts), [activity.ts](../src/activity.ts).

## 8. Status, retries, and recovery

Phase records **where** execution stopped. Status records **whether** it may run.
An error normally preserves the phase so retry continues from its checkpoint.

| Status | Meaning and next action |
| --- | --- |
| `ready` | Eligible for worker selection when due. |
| `waiting` | Awaiting an issue answer; no implementation or publication while unresolved. |
| `retry_wait` | Transient failure; automatic retry after `nextAt`. |
| `blocked` | Explicit `Blocked` error or GitHub HTTP 401, 404, or 422; requires inspection/retry, except a stopped session completed manually is reconciled automatically. |
| `failed` | Other errors reached `maxAttempts`; operator recovery/retry required unless the checkpoint also qualifies as a stopped-session recovery candidate. |
| `done` | PR publication/reconciliation completed; feedback and merge monitoring remain possible. |

```mermaid
flowchart TD
    Work[Execute saved phase] --> Result{Result?}
    Result -->|WaitingForAnswer| Wait[waiting, or ready if answer already arrived]
    Result -->|SessionStopped| Stop[running / blocked, sessionStopped true]
    Result -->|Other Blocked or GitHub 401, 404, 422| Block[blocked at saved phase]
    Result -->|Other failure below attempt limit| Retry[retry_wait at saved phase]
    Retry -->|nextAt elapsed| Work
    Result -->|Other failure at limit| Fail[failed at saved phase]
    Stop --> Probe[On available worker pass, probe due saved session without unresolved question]
    Legacy[Recognized legacy timeout or outcome block] --> Probe
    Probe --> Complete{Matching location and task marker, succeeded outcome and valid final assistant?}
    Complete -->|Yes| Rejoin[ready at running, run full session validation again]
    Rejoin --> Work
    Complete -->|No or probe fails| Retain[Retain block and feedback, probe no sooner than 30 seconds later]
    Retain --> Probe
    Command[Operator uses restartworkflow] --> Guards{Known task, no unresolved question and no closed or merged PR?}
    Guards -->|No| Reject[Return actionable error, preserve checkpoint]
    Guards -->|Yes| Eligible{Status blocked or failed?}
    Eligible -->|No| Noop[accepted false, do not duplicate scheduled or completed work]
    Eligible -->|Yes| Safe{Route exists, and running phase is a recognized session stop?}
    Safe -->|No| Reject
    Safe -->|Yes| Recover[Persist recovery ID for running phase, clear error and attempts, ready at saved phase]
    Recover --> Work
    Block --> Manual[Operator uses retry while worker and maintenance idle]
    Stop --> Manual
    Fail --> Manual
    Manual --> Restart{restartSession requested?}
    Restart -->|No| Reset[Clear error and attempts, ready at saved phase]
    Restart -->|Yes| Cancel[Interrupt old session, clear sessionID and promptAttempted]
    Cancel --> Earlier[Return to commented if commentID exists, otherwise queued]
    Earlier --> Reset
    Reset --> Work
```

- Task backoff is `min(3600, 5 * 2^attempts)` seconds, with the incremented
  attempt count: the first retry is after 10 seconds. GitHub retry headers can
  extend it. Default maximum attempts: 5. Successful phase transitions reset
  attempts, so the limit is not a lifetime cap across all phases.
- Scheduler failures use a separate backoff: 5, 10, 20 seconds, and so on, capped
  at one hour. Successful scans return to the configured scan interval.
- A resumable `running` task with a saved session takes priority over other work.
  If its retry time is still in the future, the worker waits rather than starting
  another issue that could overlap an unreconciled session.
- A waiting question whose POST response was lost is republished/reconciled by
  its marker. Failures in that recovery path retry after 60 seconds.
- `retry` accepts only blocked or failed tasks and is rejected while the worker
  or maintenance is busy. `restartSession` does not delete the worktree or changes;
  it restarts session execution from the appropriate earlier phase.
- Automatic probes select only `running` tasks with a saved session, status
  `blocked` or `failed`, a recognized session stop, elapsed `nextAt`, and no
  unresolved question. Probes run when the worker can begin another pass, not
  concurrently with an already-running worker invocation. An unsuccessful probe
  delays the next one by at least 30 seconds. Successful saved sessions re-enter
  `running` validation, then configured checks and publication. This recognizes legacy
  timeout/outcome errors as well as the persisted `sessionStopped` classification.
  It never infers success from a clean worktree or an already-pushed commit.
- `/restartworkflow` queues a durable recovery request for a stopped task without
  resetting its phase, worktree, branch, PR, or feedback. It can be queued while
  another task works. For a stopped execution, the executor waits for idleness,
  verifies the original task marker, and sends a checkpointed continuation only
  if still incomplete. A lost response never replays that prompt blindly. Admission
  does not interrupt active sessions; normal session deadlines still apply.
  Unresolved questions and unsafe errors remain blocked. A missing task, pending question, or closed/merged PR produces an error
  before the status check. Other statuses return `accepted: false`; this means no
  recovery was queued, not that a running session was stopped. Eligible tasks need
  a route, and `running` additionally needs a recognized session-stop checkpoint.
- Merge errors use `mergeError` and `mergeNextAt`; they do not turn a published
  task into an implementation failure.
- Reloading the owner project after restart restores polling from durable state.
  Activity events are notifications, not the durable queue.

Sources: [dispatcher.ts — workOnce, restartWorkflow, retryOnce](../src/dispatcher.ts),
[scheduler.ts](../src/scheduler.ts), [state.ts](../src/state.ts).

### Recovery commands and checkpoints

Run CLI commands from the primary owner checkout, not a task worktree.
`restartworkflow` changes dispatcher state; it does not restart the OpenCode
service, resume a paused scheduler, or perform a scan itself.

| Action | Saved phase and session | Effect |
| --- | --- | --- |
| Continue a stopped session in the TUI | Same session, `running` phase | Once successful and recognized by the probe, normal session validation, checks and publication resume automatically. |
| `/restartworkflow`, then select an issue | Same phase, session, worktree, branch and PR | Queue recovery for an eligible blocked/failed task. A stopped session may receive one continuation; verification/publication retries its saved stage. |
| `opencode2-automation restartworkflow 'owner/repository#123'` | Same as the TUI command | Calls `automation.github.restartworkflow` with `{ key }`, returning `{ accepted }`. |
| `opencode2-automation retry 'owner/repository#123'` | Same saved phase and session | Clear blocked/failed status while worker and maintenance are idle; it does not send a continuation merely because a session was stopped. |
| `opencode2-automation retry 'owner/repository#123' --restart-session` | Earlier phase, new session identity on execution | Interrupt the old session and clear its ID and initial-prompt flag; preserve the worktree. Use after inspecting uncertain delivery, not as a routine publication shortcut. |
| `opencode2-automation resume` | No task checkpoint reset | Unpause the scheduler; accepted task execution has its own loop. |
| Restart service, then activate the owner | Reload durable state | Restore polling and worker selection; preserve unresolved questions and nonrecoverable blocks. |

The queue stores `sessionStopped` to distinguish execution stops from other
blocks. `recovery.id` identifies an explicit continuation request and
`recovery.attempted` records the decision to send it before calling OpenCode.
Both are cleared after successful execution and when the next feedback round
starts. Worktree, branch, pinned base, session history and queued comments remain
separate durable checkpoints. A failed test is never treated as session success.

Regression evidence: [core.test.ts](../test/core.test.ts),
[executor.test.ts](../test/executor.test.ts), [runtime.test.ts](../test/runtime.test.ts),
[lifecycle.test.ts](../test/lifecycle.test.ts), [ui.test.ts](../test/ui.test.ts).
