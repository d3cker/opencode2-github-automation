import type { Plugin } from "@opencode/plugin/tui";
import { setupUI } from "./ui.js";

// Plugin.define is an identity function; the type-only import keeps Node packaging checks independent of the renderer.
export default { id: "automation.ui", setup: setupUI } satisfies Plugin.Definition;
