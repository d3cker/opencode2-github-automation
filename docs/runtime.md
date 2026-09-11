# Bot runtime

## Questions in GitHub

The bot uses `ask_issue` to post clarification questions with the configured
signature. Built-in question tools are redirected for bot sessions and their
native subagents; ordinary interactive sessions keep their usual question UI.
The task enters `waiting`, stops implementation, and does not publish a PR.
Other queued issues can proceed while it waits.

Reply in the same issue using an account in `authors`. The next scan delivers
the first authorized reply after the question to the main session, without
requiring another mention. A native worker's question also resumes the main
agent, which can continue or delegate again with the answer. Other comments
remain queued as feedback. Edits to existing comments are not replies.

For permission requests, use the exact `/allow QUESTION_ID` or `/deny QUESTION_ID`
shown in the question as your entire reply. Plain conversation does not grant
permission. The decision is scoped to the operation and resource set in the
current main session and its workers; explicit OpenCode deny rules still apply.
The bot never answers an approval request on your behalf.

The queue retains waiting questions and accepted replies across restarts.
After restarting the service, load the owner project again to resume polling.
No terminal UI is needed to answer in GitHub.

## Base branches

Set `"baseBranch": "develop"` in the project JSON, or put a directive in the
issue body or an authorized comment included when work is accepted:

```text
@opencodebot Add an export button.
/base release/next
```

`Base branch: release/next` on its own line also works. The last explicit
directive wins over the project setting; without either, the GitHub default
branch is used. Arbitrary prose and quoted directives are not branch commands.
The branch must exist on `origin`; a missing branch fails without falling back.

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

To append project instructions, create a Markdown file and set
`"systemPromptFile": ".opencode/bot.md"`. Relative paths resolve from the owner
checkout, not the worker branch. Absolute paths are also accepted. The file is
reread on every use; missing or empty configured files stop execution with an
error. The plugin never overwrites your file. Version it with the project, or
ignore it locally for machine-specific instructions.
