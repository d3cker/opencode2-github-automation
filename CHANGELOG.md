# Changelog

Release descriptions come from the exact version section committed with the tag.
Keep unreleased changes here, then move them into a `## MAJOR.MINOR.PATCH` section
before creating the release tag. Prerelease headings include the full version,
for example `## 0.7.0-beta.1`.

## Unreleased

### Fixed

- Generate release descriptions from the matching changelog section, so publishing
  a tag before its PR merges no longer produces notes about an earlier release.
- Show the latest published stable package's versioned download URL in the README
  and update it automatically after successful stable releases.

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
