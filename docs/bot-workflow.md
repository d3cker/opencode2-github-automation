# Bot workflow: from GitHub issue to merged PR

This document describes the current implementation, including waiting, retries,
follow-up rounds, and recovery. Mermaid nodes use the actual persisted phase
and status names where applicable. `done` means publication finished; it does
not mean the PR has merged.

## 1. Startup, ownership, and polling

```mermaid
flowchart TD
    Load[OpenCode loads automation plugin] --> Owner{Primary Git checkout root?}
    Owner -->|No| Inactive[Plugin stays inactive]
    Owner -->|Yes| Config[Read explicit plugin options or .opencode/automation.json]
    Config -->|No project config| Inactive
    Config --> Resolve[Resolve repositories, authentication, routes, and defaults]
    Resolve --> GH[Start GitHub plugin; acquire github lock; load queue.json]
    GH --> RPC[Register dispatcher RPC and runtime bridge]
    RPC --> Worker[Immediate worker tick, then workerEverySeconds]
    GH --> Scheduler[Start scheduler; acquire scheduler lock; load scheduler.json]
    Scheduler --> Clock[Immediate tick, then every second]
    Clock --> Due{Job due and not paused or already running?}
    Due -->|Yes| ScanRPC[Call automation.github.scan through RPC]
    ScanRPC --> Save[Save job result and nextAt]
    Save --> Clock
    Due -->|No| Clock
    Worker --> Dispatch[Advance one eligible task or check merges]
    Dispatch --> Worker
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
[scheduler plugin](../src/plugins/scheduler.ts), [state.ts](../src/state.ts).

## 2. Discovery and routing

```mermaid
flowchart TD
    Scan[Scan each configured repository] --> PRs[Refresh tracked PR states, including closed issues]
    PRs --> Issues[List open issues; fetch tracked issues missing from that list]
    Issues --> IsPR{Entry is a pull request?}
    IsPR -->|Yes| Ignore[Ignore entry]
    IsPR -->|No| Comments[Read issue comments and filter authorized comments]
    Comments --> Tracked{Task already exists?}
    Tracked -->|Yes| Answer{Pending published question and eligible reply?}
    Answer -->|Yes| Accept[Save first eligible reply; waiting becomes ready]
    Answer -->|No| Feedback[Append fresh comments to pendingFeedback]
    Accept --> Feedback
    Feedback --> Cursor[Persist comment cursor and queue]
    Tracked -->|No| Open{Issue open?}
    Open -->|No| Ignore
    Open -->|Yes| Body[Match route in body if issue author is authorized]
    Body --> Found{Route found?}
    Found -->|No| CommentRoute[Look for a route in authorized comments]
    Found -->|Yes| Queue[Persist queued / ready task]
    CommentRoute -->|Route found| Queue
    CommentRoute -->|No route| Ignore
    Body -->|Multiple matching tags in one body| Block[Persist queued / blocked task]
    CommentRoute -->|Multiple matching tags in one comment| Block
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

Source: [dispatcher.ts — scanOnce](../src/dispatcher.ts),
[config.ts — matchRoute](../src/config.ts).

## 3. Main task lifecycle

```mermaid
flowchart TD
    Q[queued / ready] --> Guard[Re-fetch issue; validate route, authorization, and follow-up PR]
    Guard --> A[analyzing: generate structured decision without tools]
    A --> Decision{Decision kind?}
    Decision -->|question| AQ[Persist proposals and question; publish one signed comment]
    AQ --> AW[analyzing / waiting]
    AW -->|Authorized issue reply| Dialogue[Save dialogue; clear previous decision]
    Dialogue --> Guard
    Decision -->|proceed| Ack[Publish or reconcile signed analysis acknowledgement]
    Ack --> C[commented: confirmed commentID]
    C --> Pinned{Base already pinned?}
    Pinned -->|No| Base[Interpret authorized branch discussion with main model]
    Base --> Choice{Unambiguous valid selection?}
    Choice -->|No or selected branch absent on origin| BQ[Publish base question; commented / waiting]
    BQ -->|Authorized reply| Base
    Choice -->|Yes| Pin[Persist baseBranch]
    Pinned -->|Yes| Prepare[Validate repository; create or reuse isolated worktree]
    Pin --> Prepare
    Prepare --> R[running: checkpoint workspace and execute OpenCode session]
    R -->|Question| RW[running / waiting]
    RW -->|Authorized reply| R
    R -->|Successful session with no pending question| V[verifying: checks and commit]
    V --> P[publishing: reconcile PR, title if needed, push and create PR]
    P --> Done[pr_opened / done: save PR and publishedAt]
    Done -->|New authorized issue feedback| Round[Increment round; queue feedback; reset per-round execution state]
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
An existing worktree must have the expected real path, branch, and shared Git
directory. A branch already existing without its expected worktree blocks work.
The worker runtime is installed before execution.

Sources: [dispatcher.ts — workOnce, resolveAnalysis, resolveBase](../src/dispatcher.ts),
[executor.ts — analyze, selectBase, GitWorkspace.prepare](../src/executor.ts),
[branch.ts](../src/branch.ts).

## 4. Session execution and questions

```mermaid
sequenceDiagram
    participant D as Dispatcher / executor
    participant S as OpenCode main session
    participant R as Worker runtime
    participant G as GitHub issue
    participant U as Authorized user
    D->>D: Save sessionID before session creation
    D->>S: Get session, create only on explicit not-found
    D->>D: Validate worktree location, save sessionReady
    D->>D: Save promptAttempted before sending initial prompt
    D->>S: Implement agreed scope in task worktree
    D->>S: Wait for completion
    opt Clarification or permission required
        S->>R: ask_issue / intercepted question / permission ask
        R->>D: Register question against main task session
        D->>D: Persist pending question
        D->>G: Publish signed question with stable marker
        R-->>S: Stop work and finish turn
        D->>D: Preserve running phase, set waiting status
        U->>G: Reply in the same issue
        D->>G: Next scan reads eligible reply
        D->>D: Persist answer, set ready
        D->>S: Resume same main session with deterministic answer message ID
        D->>S: Wait for completion
    end
    D->>S: Read context and final outcome
    D->>D: Confirm initial prompt marker and successful final assistant message
    D->>D: Advance to verifying
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
- A timed-out wait interrupts the server session and blocks for inspection.
  Uncertain initial prompt delivery, a wrong session location, or a final outcome
  other than `succeeded` with a non-error assistant `finish: stop` also blocks.

Sources: [executor.ts — runSession](../src/executor.ts),
[runtime.ts](../src/runtime.ts), [prompt.ts](../src/prompt.ts),
[dispatcher.ts — question, publishQuestion](../src/dispatcher.ts).

## 5. Optional media inspection

```mermaid
flowchart LR
    Call[Main session calls inspect_media] --> Cap{Main model supports requested input?}
    Cap -->|Yes| Main[Use same model in separate helper session]
    Cap -->|No| Other{Configured mediaModel supports input?}
    Other -->|Yes| Helper[Use configured helper model]
    Other -->|No| Ask[Ask in issue for configuration update or text description; wait]
    Main --> Files[Validate HTTPS URLs or files inside worktree]
    Helper --> Files
    Files --> Session[Persist helper ID; create or reuse read-only session]
    Session --> Result[Send attachments; wait; validate completed answer]
    Result --> Return[Return findings to main session; main model stays unchanged]
```

Only the active main bot session can delegate media. Helpers have no tools.
URLs cannot contain credentials; local paths are resolved and must remain inside
the worktree. GitHub credentials are not forwarded to media URLs. A helper uses
stable session and prompt IDs for a given call. Helper failures return errors;
a helper timeout attempts interruption.

Source: [runtime.ts — inspect_media](../src/runtime.ts).

## 6. Verification and publication

```mermaid
flowchart TD
    Start[Session completed] --> Identity[Check expected worktree, branch, and shared repository]
    Identity --> Base[Require baseSha ancestor of HEAD and no unresolved conflicts]
    Base --> Checks[Run configured repository checks sequentially]
    Checks --> Diff[Recheck worktree identity; git diff --check]
    Diff --> Stage[git add --all; check staged diff; record staged tree]
    Stage --> Commit[Commit staged changes if any]
    Commit --> Validate[Require committed tree equals recorded tree, changes versus base, and clean worktree]
    Validate --> Save[Save checks and exact commit SHA; phase publishing]
    Save --> Find[Find existing PR for task branch, including closed PRs]
    Find --> Follow{Follow-up round?}
    Follow -->|Yes| Open{Existing PR open?}
    Open -->|No| Block[Block; retain changes in worktree]
    Open -->|Yes| Push[Validate origin and worktree; require saved HEAD and clean tree; push exact SHA]
    Follow -->|No| Exists{PR already exists?}
    Exists -->|Yes| Done[Save PR and publication time; pr_opened / done]
    Exists -->|No| Title[Generate and persist descriptive English PR title]
    Title --> Issue[Require issue still open]
    Issue --> PushNew[Validate origin and worktree; push exact verified SHA]
    PushNew --> Create[Create or reconcile signed PR targeting pinned base]
    Create --> Done
    Push --> Done
```

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
    Done[pr_opened / done] --> Feedback{Pending issue feedback?}
    Feedback -->|Yes| Round[Next worker pass starts new round on same branch and worktree]
    Round --> Guard[Require open issue and open original PR; analyze and acknowledge again]
    Feedback -->|No| Idle{No eligible execution task selected?}
    Idle -->|No| Later[Wait for a later worker pass]
    Idle -->|Yes| Enabled{Auto-merge enabled and task eligible?}
    Enabled -->|No| Later
    Enabled -->|Yes| Scan[Scan again before considering merge]
    Scan --> Fresh{New feedback or closed PR?}
    Fresh -->|Yes| Later
    Fresh -->|No| Head[Require open non-draft PR with published commit as current head]
    Head --> Review[Evaluate latest decisive reviews and configured approval comments]
    Review --> Changes{Any outstanding changes-requested review?}
    Changes -->|Yes| Later
    Changes -->|No| Author{Eligible approver in allowlist with write, maintain, or admin permission?}
    Author -->|No| Later
    Author -->|Yes| Ready{mergeable and mergeable_state clean?}
    Ready -->|No| Retry[Record mergeError; retry no sooner than 60 seconds]
    Ready -->|Yes| Merge[Request GitHub merge with exact SHA and configured method]
    Merge --> Ack[Post signed merged acknowledgement; persist merged and closed PR]
    Manual[Manual PR close or merge] --> Poll[Next repository scan refreshes PR state]
    Ack --> UI[TUI receives activity or recovers it by polling]
    Poll --> UI
    UI --> Tabs[Close known task and helper tabs when idle; preserve session history]
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
the next published round. A false merge result schedules another check after
60 seconds; errors also respect GitHub retry timing. An already-merged response
can reconcile a previously lost merge response.

Follow-up rounds reset analysis, question, current session, checks, and commit;
they retain the branch, worktree, pinned base, and previous session reference.
They create a new main session, whereas an implementation-question reply resumes
the current one. Comments received while working stay queued for a later round.
Feedback after closure can still be queued, but the next round's guards block it.

PR-state scanning is independent of auto-merge and issue openness. The TUI
subscribes to activity and polls every 10 seconds, including recovery on startup.
It opens background task tabs when enabled and exposes `/bot` for session access.
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
| `blocked` | Explicit `Blocked` error or GitHub HTTP 401, 404, or 422; requires inspection and manual retry. |
| `failed` | Other errors reached `maxAttempts`; manual retry required. |
| `done` | PR publication/reconciliation completed; feedback and merge monitoring remain possible. |

```mermaid
flowchart LR
    Work[Current phase] --> Error{Result?}
    Error -->|WaitingForAnswer| Wait[waiting, or ready if answer already arrived]
    Error -->|Blocked or GitHub 401 / 404 / 422| Block[blocked]
    Error -->|Other failure below attempt limit| Retry[retry_wait; preserve phase]
    Retry -->|nextAt elapsed| Work
    Error -->|Other failure at attempt limit| Fail[failed]
    Block --> Manual[Manual retry while worker idle]
    Fail --> Manual
    Manual --> Restart{restartSession requested?}
    Restart -->|No| Reset[Clear error and attempts; ready at saved phase]
    Restart -->|Yes| Cancel[Interrupt old session; clear session ID and prompt flag]
    Cancel --> Earlier[Return to commented if acknowledgement exists, otherwise queued]
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
- Merge errors use `mergeError` and `mergeNextAt`; they do not turn a published
  task into an implementation failure.
- Reloading the owner project after restart restores polling from durable state.
  Activity events are notifications, not the durable queue.

Sources: [dispatcher.ts — workOnce, retryOnce](../src/dispatcher.ts),
[scheduler.ts](../src/scheduler.ts), [state.ts](../src/state.ts).
