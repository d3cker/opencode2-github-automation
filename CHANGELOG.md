# Changelog

Release descriptions come from the exact version section committed with the tag.
Add feature changes under `Unreleased`; after a PR merges into `release`, automation
moves them into the new patch version's section. For a manual release, prepare
and commit the exact version section before creating its tag. Prerelease headings
include the full version, for example `## 0.7.0-beta.1`.

## Unreleased

## 0.6.3

### Fixed

- Generate release descriptions from the matching changelog section, so publishing
  a tag before its PR merges no longer produces notes about an earlier release.
- Show the latest published stable package's versioned download URL in the README
  on `release` after successful publication, then promote it to `main` through a PR.

### Release process

- Run full CI when feature PRs target `release`, including new commits to open PRs.
  Ordinary feature pushes no longer run CI or build packages.
- Publish an automatic patch after a PR merges into `release`, and support manual
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