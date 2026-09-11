import { fileURLToPath } from "node:url";

// Source npm ci and project-local installs must not change global registration.
// dist is already included in the tarball; consumers do not need TypeScript.
if (process.env.npm_config_global === "true") {
  try {
    const { installGlobalEntrypoints } = await import("../dist/install.js");
    const directory = await installGlobalEntrypoints(fileURLToPath(new URL("..", import.meta.url)));
    console.log(`Registered OpenCode 2 automation and TUI in ${directory}. Run opencode2-automation init in a project when ready. Restart the OpenCode 2 service when its sessions are idle.`);
  } catch (error) {
    console.error(`OpenCode 2 registration failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    process.exitCode = 1;
  }
}
