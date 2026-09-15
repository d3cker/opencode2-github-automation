# Changelog

Release descriptions come from the exact version section committed with the tag.
Add feature changes under `Unreleased`; after a `devel` PR merges into `release`, automation
moves them into the new patch version's section. For a manual release, prepare
and commit the exact version section before creating its tag. Prerelease headings
include the full version, for example `## 0.7.0-beta.1`.

## Unreleased

### Documentation

- Align all eight bot workflow diagrams and runtime/recovery references with the
  implementation, including owner lifecycle, feedback queuing, session recovery,
  verification gates, merge polling and TUI commands.
- Require documentation and affected diagrams to be updated with each relevant
  implementation change in repository and bundled bot instructions.

### Fixed

- Reconcile timed-out or interrupted sessions completed manually after a blocked
  task or service restart. Verify and publish through the dispatcher, then process
  queued issue feedback on the same branch and PR, including legacy checkpoints.

### Added

- `/restartworkflow` and the matching CLI/RPC command resume a stopped task from
  its saved stage, preserving worktrees, sessions, PRs, and feedback. Checkpoint
  continuation requests across restarts without bypassing checks or permissions.

### Changed

- Collect feature PRs on `devel` without publishing a release. Run CI on PRs to
  `devel` and `release`, and publish automatic patches only after a same-repository
  `devel` to `release` PR is merged.
- After stable publication and README update, automatically merge the published
  release head into `devel` without a synchronization PR. Preserve new development
  commits, retry concurrent updates, and fail safely on conflicts or denied pushes.

## 0.6.5

### Fixed

- Reuse the saved worktree path when resuming recovered tasks or processing PR
  feedback, including after a branch rename. Preserve existing changes and the
  pinned base while validating the managed directory, Git root, branch, and
  repository before preparation, verification, and publication. A missing saved
  worktree blocks recovery instead of creating a replacement.

## 0.6.4

### Fixed

- Prevent hourly owner eviction using durable activity on one empty maintenance
  session. The previous plugin-list heartbeat did not refresh OpenCode's session
  inactivity timer. Keepalive never prompts a model or modifies a work session.
- Bound SDK waits independently of adapters that ignore AbortSignal, allowing
  shutdown to release locks without interrupting a healthy worktree session.
  A replacement dispatcher reconciles the saved session before publication.
- Wait briefly for a retiring owner's locks, bound RPC disposal, and reject
  queued checkpoint writes after shutdown to prevent failed plugin reloads.

## 0.6.3

### Fixed

- Generate release descriptions from the matching changelog section, so publishing
  a tag before its PR merges no longer produces notes about an earlier release.
- Show the latest published stable package's versioned download URL in the README
  on `release` after successful publication, then promote it to `main` through a PR.

### Release process

- Run full CI when feature PRs target `release`, including new commits to open PRs.
  Ordinary feature pushes no longer run CI or build packages.
- Publish an automatic patch after a `devel` PR merges into `release`, and support manual
  version tags on that branch without a second version bump.
- Recover interrupted publication without moving tags or republishing completed
  packages. Commit README on `release` before opening or updating its PR to `main`.
- Keep `main` changes behind PR merges and verify that promotion contains the
  published package's code and updated download links.

## 0.6.2

### Fixed

- Keep the automation owner service active with a heartbeat during long-running
  worker sessions, preserving dispatcher access for task completion and PR publication.
- Verify the owner process before sending heartbeat requests and prevent overlapping
  requests with a bounded timeout.
- Attempt every cleanup step during shutdown, releasing scheduler and dispatcher
  locks even when another cleanup fails, so the plugin can start again.

### Validation and documentation

- Add regression coverage for owner heartbeats and shutdown cleanup failures.
- Document owner lifetime, lock cleanup, and recovery behavior.

## 0.6.1

### Documentation

- Add detailed bot workflow diagrams and a documentation map in `AGENTS.md`.
- Expand bundled bot instructions for planning, delegation, verification, and
  handing publication back to the dispatcher.
- Add the README banner showing an OpenCode2 agent executing a task.