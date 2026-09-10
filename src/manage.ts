import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { resolve } from "node:path";
import { GithubRpc, SchedulerRpc } from "./rpc.js";

const [command, directory, argument, flag] = process.argv.slice(2);
const commands = ["status", "scan", "run", "pause", "resume", "retry"];
if (!command || !commands.includes(command) || !directory || ["run", "pause", "resume", "retry"].includes(command) && !argument) {
  console.error("Usage: node dist/manage.js <status|scan|run|pause|resume|retry> <owner-directory> [job-id|issue-key] [--restart-session]");
  process.exitCode = 1;
} else {
  try {
    const endpoint = await Service.discover();
    if (!endpoint) throw new Error("No running OpenCode 2 service found");
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
    const github = client.rpc(GithubRpc), scheduler = client.rpc(SchedulerRpc);
    const request = { location: { directory: resolve(directory) }, signal: AbortSignal.timeout(130_000) };
    let result: unknown;
    switch (command) {
      case "status": result = { scheduler: await scheduler.status({}, request), issues: await github.status({}, request) }; break;
      case "scan": result = await github.scan({}, request); break;
      case "run": result = await scheduler.run({ id: argument! }, request); break;
      case "pause": case "resume": result = await scheduler.pause({ id: argument!, paused: command === "pause" }, request); break;
      case "retry": result = await github.retry({ key: argument!, restartSession: flag === "--restart-session" }, request); break;
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "OpenCode RPC request failed");
    process.exitCode = 1;
  }
}
