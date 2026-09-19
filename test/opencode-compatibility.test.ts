import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { touchOwner } from "../src/lifecycle.js";
import { GithubRpc } from "../src/rpc.js";

test("OpenCode 2.0.6 discovery, owner keepalive, RPC and interruption use the current HTTP contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc2-compatibility-"));
  const calls: { method: string; path: string; query: string; body: Record<string, unknown> }[] = [];
  let pid = process.pid;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ method: request.method!, path: url.pathname, query: url.search, body });
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== "Basic " + Buffer.from("opencode:fixture-password").toString("base64")) {
      response.writeHead(401).end("{}"); return;
    }
    if (url.pathname === "/api/info") {
      response.end(JSON.stringify({ version: "2.0.6", pid, urls: [], paths: { tmp: directory } })); return;
    }
    if (url.pathname === "/api/session" && request.method === "POST") { response.end(JSON.stringify({ data: body })); return; }
    if (url.pathname.startsWith("/api/session/") && request.method === "PATCH") { response.writeHead(204).end(); return; }
    if (url.pathname.endsWith("/interrupt")) { response.end(JSON.stringify({ interrupted: true })); return; }
    if (url.pathname === "/api/rpc/automation.github/status") { response.end(JSON.stringify({ output: [] })); return; }
    response.writeHead(404).end("{}");
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const file = join(directory, "service.json");
    await writeFile(file, JSON.stringify({ version: "2.0.6", pid, url: `http://127.0.0.1:${address.port}`, password: "fixture-password" }));
    const endpoint = await Service.discover({ file }); assert.ok(endpoint);
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
    assert.equal(await touchOwner("/owner", new AbortController().signal, async () => client), true);
    const created = calls.find(c => c.method === "POST" && c.path === "/api/session")!;
    assert.deepEqual(created.body.location, { directory: "/owner" });
    assert.deepEqual(created.body.metadata, { automation: "owner-keepalive" });
    assert.ok(calls.some(c => c.method === "PATCH" && c.path === `/api/session/${created.body.id}` && c.body.title === "Automation owner keepalive"));
    assert.deepEqual(await client.rpc(GithubRpc).status({}, { location: { directory: "/owner" } }), []);
    const rpc = calls.find(c => c.path === "/api/rpc/automation.github/status")!;
    assert.deepEqual(rpc.body, { input: {} });
    assert.equal(new URLSearchParams(rpc.query).get("location[directory]"), "/owner");
    await client.session.interrupt({ sessionID: "ses_fixture", resume: false });
    assert.equal(new URLSearchParams(calls.at(-1)!.query).get("resume"), "false");
    assert.deepEqual(calls.at(-1)?.body, {});
    assert.ok(calls.every(c => !c.path.includes("health") && !c.path.includes("prompt")));
    pid++;
    assert.equal(await Service.discover({ file }), undefined, "A registration for another PID must not be trusted");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
