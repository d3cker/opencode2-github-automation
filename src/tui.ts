import type { Plugin } from "@opencode/plugin/tui";
import { setupUI } from "./ui.js";

// Plugin.define is an identity function; the type-only import keeps Node packaging checks independent of the renderer.
export default { id: "automation.ui", async setup(context) {
  // Only a real TUI needs the host's renderer and Solid instance. Server/package
  // discovery can import this entrypoint without initializing renderer peers.
  const { setupSidebar } = await import("./sidebar.js");
  const stopUI = setupUI(context);
  try {
    const stopSidebar = setupSidebar(context);
    return () => { try { stopSidebar?.(); } finally { stopUI?.(); } };
  } catch (error) { stopUI?.(); throw error; }
} } satisfies Plugin.Definition;
