#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 || "${1:-}" == "--help" ]]; then
  echo 'Usage: bash scripts/install-local.sh /absolute/path/to/project [--model provider/model] [--skip-tests] [--trigger @d3ckerbot]'
  echo 'Builds and installs locally. Existing automation.json is preserved. Does not restart OpenCode.'
  exit 0
fi
plugin_source="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
project_target="$(cd "$1" && pwd -P)"
shift
for executable in node npm git; do
  command -v "$executable" >/dev/null || { echo "Missing dependency: $executable" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22+ required")'
project_root="$(git -C "$project_target" rev-parse --show-toplevel)"
[[ "$project_target" == "$(cd "$project_root" && pwd -P)" ]] || { echo 'Choose the root of the target Git checkout.' >&2; exit 1; }
[[ "$project_target" != "$plugin_source" ]] || { echo 'Choose the project the bot will work on, not the plugin source repository.' >&2; exit 1; }
git -C "$project_target" rev-parse --verify HEAD >/dev/null
if [[ -f "$project_target/.opencode/automation.json" && $# -gt 0 ]]; then
  echo 'Existing configuration found. Run without configuration flags to upgrade, or edit automation.json.' >&2
  exit 1
fi
package_stage="$(mktemp -d "${TMPDIR:-/tmp}/opencode2-package.XXXXXX")"
trap 'rm -rf "$package_stage"' EXIT
cd "$plugin_source"
npm ci
npm run build
npm pack --ignore-scripts --pack-destination "$package_stage"
package_archive=("$package_stage"/*.tgz)
# Exclude machine-specific installation from the target repository, without modifying its shared .gitignore.
exclude_file="$(git -C "$project_target" rev-parse --path-format=absolute --git-path info/exclude)"
node --input-type=module - "$exclude_file" <<'JS'
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const file = process.argv[2];
mkdirSync(dirname(file), {recursive: true});
let old = '';
try { old = readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const patterns = ['/.opencode/node_modules/', '/.opencode/package.json', '/.opencode/package-lock.json', '/.opencode/automation.json', '/.opencode/plugins/automation/'];
const missing = patterns.filter(p => !old.split(/\r?\n/).includes(p));
if (missing.length) appendFileSync(file, '\n# Local OpenCode 2 automation installation\n' + missing.join('\n') + '\n');
JS
npm install --prefix "$project_target/.opencode" "${package_archive[0]}" --ignore-scripts
cd "$project_target"
if [[ -f .opencode/automation.json ]]; then
  node .opencode/node_modules/opencode2-automation/dist/setup.js upgrade
else
  node .opencode/node_modules/opencode2-automation/dist/setup.js init --local "$@"
fi
printf '\nInstalled in: %s\nOpen the project in OpenCode 2. If its service is already running, restart it when no bot session is active.\n' "$project_target"
