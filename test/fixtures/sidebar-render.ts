import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { Plugin } from "@opencode/plugin/tui";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { DEFAULT_THEME, resolveThemeDocument } from "@opencode/theme/tui";
import { migrateV1, resolveThemeDocument as resolveCurrentTheme } from "@opencode/theme-current/tui";
import { RuntimeSidebar } from "../../src/sidebar.js";
import type { RuntimeSnapshot } from "../../src/runtime-panel.js";
const legacyTheme = resolveThemeDocument(DEFAULT_THEME, "dark");
// Resolve through each real SDK instead of mocking its output token structure.
const currentTheme = resolveCurrentTheme(migrateV1({ theme: {
  primary: "#aabbcc",
  secondary: "#aabbcc",
  accent: "#aabbcc",
  error: "#aabbcc",
  warning: "#aabbcc",
  success: "#aabbcc",
  info: "#aabbcc",
  text: "#aabbcc",
  textMuted: "#aabbcc",
  background: "#aabbcc",
  backgroundPanel: "#aabbcc",
  backgroundElement: "#aabbcc",
  border: "#aabbcc",
  borderActive: "#aabbcc",
  borderSubtle: "#aabbcc",
  diffAdded: "#aabbcc",
  diffRemoved: "#aabbcc",
  diffContext: "#aabbcc",
  diffHunkHeader: "#aabbcc",
  diffHighlightAdded: "#aabbcc",
  diffHighlightRemoved: "#aabbcc",
  diffAddedBg: "#aabbcc",
  diffRemovedBg: "#aabbcc",
  diffContextBg: "#aabbcc",
  diffLineNumber: "#aabbcc",
  diffAddedLineNumberBg: "#aabbcc",
  diffRemovedLineNumberBg: "#aabbcc",
  markdownText: "#aabbcc",
  markdownHeading: "#aabbcc",
  markdownLink: "#aabbcc",
  markdownLinkText: "#aabbcc",
  markdownCode: "#aabbcc",
  markdownBlockQuote: "#aabbcc",
  markdownEmph: "#aabbcc",
  markdownStrong: "#aabbcc",
  markdownHorizontalRule: "#aabbcc",
  markdownListItem: "#aabbcc",
  markdownListEnumeration: "#aabbcc",
  markdownImage: "#aabbcc",
  markdownImageText: "#aabbcc",
  markdownCodeBlock: "#aabbcc",
  syntaxComment: "#aabbcc",
  syntaxKeyword: "#aabbcc",
  syntaxFunction: "#aabbcc",
  syntaxVariable: "#aabbcc",
  syntaxString: "#aabbcc",
  syntaxNumber: "#aabbcc",
  syntaxType: "#aabbcc",
  syntaxOperator: "#aabbcc",
  syntaxPunctuation: "#aabbcc",
 } }), "dark");
// OpenTUI may shut down the process after a render error. Never report success
// unless both complete render scenarios reached their final assertions.
let completed = 0;
process.on("exit", () => { if (completed !== 2) process.exitCode = 1; });
for (const theme of [legacyTheme, currentTheme]) {
  const snapshot: RuntimeSnapshot = { dispatcherAt: 10000, schedulerAt: 10000,
    dispatcher: { ownerDirectory: "/repo", worker: "executing", activeTask: "owner/repo#18", scanning: true,
      tasks: [{ key: "owner/repo#18", repo: "owner/repo", issueNumber: 18, round: 4, phase: "running", status: "ready", sessionReady: true, sessionID: "s", branch: "thirst-for-levels", baseBranch: "main", model: "deepseek/deepseek-v4", prNumber: 19, prState: "open", pendingFeedback: 1 }] },
    scheduler: [{ id: "github-issues", running: true, paused: false, nextAt: 12000, failures: 0 }],
  };
  const context = { theme, data: { session: { get: () => ({}), status: () => "running" } } } as unknown as Plugin.Context;
  const [state, setState] = createSignal<RuntimeSnapshot>({});
  const [sessionID, setSession] = createSignal("s");
  const view = await testRender(() => RuntimeSidebar({ context, snapshot: state, now: () => 10000, get sessionID() { return sessionID(); } }), { width: 36, height: 38 });
  try {
    await view.renderOnce();
    assert.match(view.captureCharFrame(), /Connecting to owner/);
    setState({ dispatcherError: "Unconfigured owner", schedulerError: "Unconfigured owner" });
    await view.renderOnce();
    assert.match(view.captureCharFrame(), /Dispatcher unavailable/);
    assert.match(view.captureCharFrame(), /Scheduler unavailable/);
    setState(snapshot);
    await view.renderOnce();
    const frame = view.captureCharFrame();
    assert.match(frame, /BOT RUNTIME/); assert.match(frame, /Session execution/);
    assert.match(frame, /Scheduler: Running/); assert.match(frame, /PR #19/); assert.match(frame, /\/botstatus/);
    await writeFile(process.env.PANEL_FRAME ?? "/tmp/opencode-sidebar-frame.txt", frame);
    setState({ ...snapshot, dispatcherError: "Disconnected", schedulerError: "Disconnected" });
    await view.renderOnce();
    assert.match(view.captureCharFrame(), /STALE \/ partial data/);
    setState({ ...snapshot, dispatcher: { ...snapshot.dispatcher!, tasks: [...snapshot.dispatcher!.tasks, { key: "owner/repo#22", repo: "owner/repo", issueNumber: 22, round: 1, status: "waiting", phase: "running", sessionID: "other", sessionReady: true, question: "permission" }] } });
    setSession("other"); await view.renderOnce();
    assert.match(view.captureCharFrame(), /Waiting for permission/);
    view.resize(28, 45); await view.renderOnce();
    assert.match(view.captureCharFrame(), /\/botstatus/);
    completed++;
    console.log("Native sidebar render: unconfigured, running, stale, session switch and narrow layout passed");
  } finally { view.renderer.destroy(); }

}
