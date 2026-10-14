import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { test } from "node:test";
import { buildLaunchSpec, launch } from "../../../../scripts/mcp-atlassian";

const complete = {
  JIRA_BASE_URL: "https://team.atlassian.net/",
  JIRA_EMAIL: "dev@example.com",
  JIRA_API_TOKEN: "fake-token",
  PATH: "/bin",
  MODEL_API_KEY: "must-not-leak",
  DATABASE_URL: "must-not-leak",
  UV_CACHE_DIR: "/cache",
};

test("launch spec pins the service and maps credentials into the environment only", () => {
  const spec = buildLaunchSpec(complete);
  assert.equal(spec.command, "uvx");
  assert.deepEqual(spec.args, [
    "--from",
    "mcp-atlassian==0.23.1",
    "mcp-atlassian",
    "--transport",
    "streamable-http",
    "--host",
    "127.0.0.1",
    "--port",
    "8000",
    "--path",
    "/mcp",
    "--read-only",
    "--enabled-tools",
    "jira_get_issue,jira_search,confluence_get_page,confluence_search,confluence_get_comments",
  ]);
  assert.ok(!spec.args.join(" ").includes("fake-token"));
  assert.deepEqual(spec.env, {
    PATH: "/bin",
    UV_CACHE_DIR: "/cache",
    JIRA_URL: "https://team.atlassian.net",
    JIRA_USERNAME: "dev@example.com",
    JIRA_API_TOKEN: "fake-token",
    CONFLUENCE_URL: "https://team.atlassian.net/wiki",
    CONFLUENCE_USERNAME: "dev@example.com",
    CONFLUENCE_API_TOKEN: "fake-token",
    ALLOW_GLOBAL_CRED_FALLBACK: "true",
    TOOLSETS: "jira_issues,confluence_pages,confluence_comments",
    PYTHON_DOTENV_DISABLED: "1",
  });
});

test("launch spec rejects missing or invalid configuration", () => {
  assert.throws(() => buildLaunchSpec({}), /required to start/);
  assert.throws(() => buildLaunchSpec({ ...complete, JIRA_BASE_URL: "https://evil.com" }));
  assert.throws(() => buildLaunchSpec({ ...complete, JIRA_EMAIL: "" }), /together/);
});

test("launch reports a startup failure without leaking credentials", async () => {
  const handle = launch({ command: "definitely-not-a-command-xyz", args: [], env: {} });
  await assert.rejects(handle.exited, (failure: Error) => /Failed to start/.test(failure.message));
});

function isListening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

test("stopping the launcher ends the child and releases its port", async () => {
  const probe = spawn(
    process.execPath,
    [
      "-e",
      "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port));setInterval(()=>{},1000)",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const port = await new Promise<number>((resolve) =>
    probe.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))),
  );
  probe.kill();
  await new Promise((resolve) => probe.once("exit", resolve));

  const handle = launch({
    command: process.execPath,
    args: [
      "-e",
      `require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1000)`,
    ],
    env: {},
  });
  for (let attempt = 0; attempt < 50 && !(await isListening(port)); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await isListening(port), true);
  await handle.stop();
  await handle.exited;
  assert.equal(await isListening(port), false);
});
