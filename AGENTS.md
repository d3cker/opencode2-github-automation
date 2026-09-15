# Repository instructions

Use English for all user-facing prompts, UI labels, errors, generated bot messages, examples, and documentation. Do not hard-code a personal account in defaults.

Never push commits directly to `main` or modify its files through GitHub APIs.
All changes reach `main` by merging a PR from `release`. Feature PRs target
`devel`. Only a reviewed `devel` → `release` PR starts automatic publication.
Version and post-publication README commits belong on `release`; after a stable
publication, automation merges that published head back into `devel` without a
PR or force push. Never reset development work to match release.

## Project context

This repository implements issue-to-PR automation for OpenCode **2**: a scheduler,
GitHub dispatcher, executor using isolated Git worktrees, worker runtime, and
terminal UI. The plugin source checkout and the target repository where the bot
works are separate concepts. Project configuration belongs to the target
checkout; durable automation state lives under its shared Git directory.

## Documentation map

Read the documents relevant to the task before changing behavior. Start with
[README.md](README.md) for the product overview, standard installation and update
steps, project setup, headless operation, and removal.

| Document | What to find there | When to use it |
| --- | --- | --- |
| [docs/architecture.md](docs/architecture.md) | Component responsibilities, a short issue-to-PR overview, configuration ownership, scheduler ownership, and shared state. | Start here to understand how the system is divided before locating implementation code. |
| [docs/bot-workflow.md](docs/bot-workflow.md) | Eight Mermaid diagrams and detailed implementation notes: startup and polling; discovery and routing; task phases; sessions and questions; media helpers; verification and publication; feedback, merging, and tab closure; status, retries, and recovery. Includes links to the source for each area. | Use for exact execution order, state transitions, checkpoint behavior, failure paths, and tracing a bot task from issue to merged PR. |
| [docs/configuration.md](docs/configuration.md) | The standard `.opencode/automation.json` format, defaults, setup flags, configuration tracking across Git branches, authors, triggers, checks, base branches, model capabilities, media helpers, custom prompts, signatures, and auto-merge settings. | Use when adding or changing user-facing configuration, defaults, or setup examples. |
| [docs/runtime.md](docs/runtime.md) | User-visible behavior while the bot runs: GitHub questions and permission replies, branch selection, media inputs, prompt loading, follow-up comments, session tabs, and routine management commands. | Use when changing issue conversations, session continuation, runtime tools, or TUI behavior. |
| [docs/advanced.md](docs/advanced.md) | Separate scheduler/dispatcher setup, multiple repositories, custom RPC jobs, full options, timeouts, management and retry commands, persistence, reconciliation, locks, and known limits. | Use for low-level configuration, operational troubleshooting, recovery, or ownership/concurrency changes. |
| [docs/installation.md](docs/installation.md) | Loader registration, config-directory precedence, prerequisites, source installation, project-local installation, upgrade conflicts, testing on another machine, and migration limits. | Use when working on packaging, installers, registration, upgrades, or deployment troubleshooting. |
| [docs/releases.md](docs/releases.md) | Feature-to-devel and devel-to-release PR checks, automatic patch versions, manual npm version/tag releases, exact changelog notes, publication recovery, README commits on release, automatic release-to-devel synchronization, and promotion PRs into protected main. | Use for CI triggers, versioning, packaging, GitHub Release publication, branch permissions, or recovery after a failed release. |

For common investigations:

- **Why did the bot wait, retry, or block?** Read workflow sections 3, 4, and 8;
  use the advanced operations section for recovery commands.
- **Why did the bot choose this branch or model?** Read the configuration
  reference, runtime base-branch/media sections, and workflow sections 3 and 5.
- **Why was a PR published, updated, or merged?** Read workflow sections 6 and 7
  and the configuration reference's automatic-merge rules.
- **Why did a session tab open or close?** Read the runtime tab sections and
  workflow section 7.
- **Why is polling inactive or duplicated?** Read architecture ownership,
  workflow section 1, and installation registration details.

For release changes, read `docs/releases.md`, `CHANGELOG.md`, and the workflows
under `.github/workflows/`. `scripts/release-pipeline.mjs` handles automatic and
manual releases, retry state, and promotion. `scripts/release-notes.mjs` extracts
the exact tagged changelog section; `scripts/update-release-readme.mjs` renders
the installation block without making remote writes. Keep its markers intact.

## From documentation to source

- `src/index.ts` loads the combined plugin; `src/plugins/` contains the scheduler
  and GitHub plugin entrypoints. `src/easy.ts` resolves standard project settings;
  `src/config.ts` defines the configuration schemas and route matching.
- `src/dispatcher.ts` owns discovery, the durable task lifecycle, questions,
  feedback rounds, publication coordination, retries, and merge polling.
  `src/scheduler.ts` owns interval jobs; `src/state.ts` owns persistence and locks.
- `src/executor.ts` owns analysis, base selection, worktrees, session execution,
  verification, and pushing. `src/analysis.ts` and `src/branch.ts` validate model
  decisions. `src/github.ts` implements GitHub calls; `src/approval.ts` evaluates
  approval candidates.
- `src/runtime.ts`, `src/worker.ts`, and `src/bridge.ts` implement worker hooks,
  runtime installation, and communication with the owner. `src/prompt.ts` loads
  instructions; `prompts/bot.md` contains the bundled bot instructions.
- `src/tui.ts`, `src/ui.ts`, and `src/activity.ts` implement terminal integration
  and task activity. `src/rpc.ts` defines RPC contracts; `src/manage.ts` exposes
  management operations.
- `src/setup.ts`, `src/wizard.ts`, `src/install.ts`, and `scripts/` cover setup and
  installation. `examples/` contains configuration examples; `test/` contains
  automated tests. `package.json` defines build and validation commands.

## Keeping documentation accurate

Treat the implementation as the source of truth for current behavior. If code
and documentation disagree, inspect the relevant code and tests and make the
discrepancy explicit rather than assuming the documented behavior is implemented.
When changing behavior, update the relevant reference page and any affected
workflow diagrams. Keep the architecture page concise; put detailed execution
paths in `docs/bot-workflow.md` and user-facing runtime guidance in `docs/runtime.md`.

Validate changed Mermaid diagrams with a Mermaid parser when available; checking
Markdown fences alone does not validate diagram syntax. Avoid literal semicolons
in sequence-diagram message labels because they can be parsed as statement
separators. For documentation-only changes, check links and formatting; application
tests are not needed unless executable behavior also changes.
