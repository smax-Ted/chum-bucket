import assert from "node:assert/strict";
import { test } from "node:test";
import { openAtlassianTools } from "../../../../server/harness/tools/atlassian";
import {
  resolveAtlassianConfig,
  type AtlassianConfig,
} from "../../../../server/harness/tools/atlassian-policy";
import { fixtureTool, fixtureToolNames, startMcpFixture } from "../../../fixtures/mcp-fixture";

const token = "fake-token-abc";
const basic = Buffer.from(`dev@example.com:${token}`).toString("base64");

function configFor(): AtlassianConfig {
  const config = resolveAtlassianConfig({
    JIRA_BASE_URL: "https://team.atlassian.net",
    JIRA_EMAIL: "dev@example.com",
    JIRA_API_TOKEN: token,
    ATLASSIAN_MCP_URL: process.env.ATLASSIAN_MCP_URL,
  });
  assert.ok(config);
  return config;
}

function find<T extends { name: string }>(tools: T[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, name);
  return tool;
}

async function run<T extends { execute?: (...args: never[]) => unknown }>(
  tool: T,
  input: unknown,
  abortSignal?: AbortSignal,
) {
  return (tool.execute as (input: unknown, context: unknown) => Promise<unknown>)(input, {
    abortSignal,
  });
}

test("only allowlisted tools are exposed, lazily, with native names and schemas", async () => {
  const fixture = await startMcpFixture();
  const remote = await openAtlassianTools(configFor());
  try {
    assert.deepEqual(remote.tools.map((tool) => tool.name).sort(), [
      "confluence_get_comments",
      "confluence_get_page",
      "confluence_search",
      "jira_get_issue",
      "jira_search",
    ]);
    assert.ok(remote.tools.every((tool) => tool.lazy === true));
    for (const tool of remote.tools) {
      const native = fixtureTool(tool.name);
      assert.equal(tool.description, native.description);
      assert.deepEqual(tool.inputSchema, native.inputSchema);
      assert.equal(tool.metadata?.mcp.serverToolName, tool.name);
    }
    assert.ok(fixtureToolNames.includes("jira_create_issue"));
    assert.ok(!remote.tools.some((tool) => tool.name === "jira_create_issue"));
    assert.deepEqual(fixture.methods.slice(0, 3), [
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test("jira_get_issue never updates view history while other tools pass through", async () => {
  const fixture = await startMcpFixture();
  const remote = await openAtlassianTools(configFor());
  try {
    await run(find(remote.tools, "jira_get_issue"), { issue_key: "A-1", update_history: true });
    await run(find(remote.tools, "jira_get_issue"), { issue_key: "A-2" });
    await run(find(remote.tools, "jira_search"), { issue_key: "A-3" });
    assert.deepEqual(
      fixture.calls.map((call) => [call.name, call.arguments]),
      [
        ["jira_get_issue", { issue_key: "A-1", update_history: false }],
        ["jira_get_issue", { issue_key: "A-2", update_history: false }],
        ["jira_search", { issue_key: "A-3" }],
      ],
    );
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test("known credentials never appear in definitions, results, or errors", async () => {
  const leaky = fixtureToolNames.map((name) => ({
    ...fixtureTool(name),
    description: `Authorization: Basic ${basic} token ${token}`,
  }));
  const fixture = await startMcpFixture({
    tools: leaky,
    handler: async (call) =>
      call.name === "jira_search"
        ? { text: `denied for ${token} / ${basic}`, isError: true }
        : { text: `Basic ${basic} ${token}` },
  });
  const remote = await openAtlassianTools(configFor());
  try {
    const serialized = JSON.stringify(remote.tools.map(({ execute: _e, ...rest }) => rest));
    assert.ok(!serialized.includes(token) && !serialized.includes(basic));
    const result = await run(find(remote.tools, "jira_get_issue"), { issue_key: "A-1" });
    assert.ok(!JSON.stringify(result).includes(token));
    assert.ok(!JSON.stringify(result).includes(basic));
    await assert.rejects(
      run(find(remote.tools, "jira_search"), { issue_key: "A-1" }),
      (failure) => {
        const message = (failure as Error).message;
        assert.match(message, /denied for \[redacted\]/);
        assert.ok(!message.includes(token) && !message.includes(basic));
        return true;
      },
    );
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test("raw HTTP error bodies are replaced with safe messages", async () => {
  const fixture = await startMcpFixture({
    failRequests: { status: 500, body: `upstream says ${token} ${basic}` },
  });
  try {
    await assert.rejects(openAtlassianTools(configFor()), (failure) => {
      const message = (failure as Error).message;
      assert.match(message, /Atlassian MCP is unavailable/);
      assert.ok(!message.includes(token) && !message.includes(basic));
      return true;
    });
  } finally {
    await fixture.close();
  }
});

test("missing required tools stop initialization and close the client", async () => {
  const fixture = await startMcpFixture({
    tools: fixtureToolNames.filter((name) => name !== "confluence_get_page").map(fixtureTool),
  });
  try {
    await assert.rejects(
      openAtlassianTools(configFor()),
      /missing required tool confluence_get_page/,
    );
    assert.equal(fixture.sessions.length, 1);
  } finally {
    await fixture.close();
  }
});

test("duplicate tool names stop initialization", async () => {
  const fixture = await startMcpFixture({
    tools: [...fixtureToolNames.map(fixtureTool), fixtureTool("jira_get_issue")],
  });
  try {
    await assert.rejects(openAtlassianTools(configFor()));
  } finally {
    await fixture.close();
  }
});

test("an unreachable endpoint fails once without trying another endpoint", async () => {
  const fixture = await startMcpFixture();
  const config = configFor();
  await fixture.close();
  await assert.rejects(openAtlassianTools(config), /Atlassian MCP is unavailable/);
  assert.equal(fixture.methods.length, 0);
});

test("an already aborted signal stops initialization before any request", async () => {
  const fixture = await startMcpFixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(openAtlassianTools(configFor(), controller.signal), /cancelled/);
    assert.equal(fixture.methods.length, 0);
  } finally {
    await fixture.close();
  }
});

test("cancelling a tool call reports cancellation and reaches the server", async () => {
  let serverSignal: AbortSignal | undefined;
  const fixture = await startMcpFixture({
    handler: (_call, signal) => {
      serverSignal = signal;
      return new Promise(() => undefined);
    },
  });
  const remote = await openAtlassianTools(configFor());
  try {
    const controller = new AbortController();
    const pending = run(
      find(remote.tools, "jira_get_issue"),
      { issue_key: "A-1" },
      controller.signal,
    );
    while (!serverSignal) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    for (
      let attempt = 0;
      attempt < 50 && !fixture.methods.includes("notifications/cancelled");
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(fixture.methods.includes("notifications/cancelled"));
  } finally {
    await remote.close();
    await fixture.close();
  }
});

test("close is idempotent and aborts in-flight and later calls", async () => {
  let started = false;
  const fixture = await startMcpFixture({
    handler: () => {
      started = true;
      return new Promise(() => undefined);
    },
  });
  const remote = await openAtlassianTools(configFor());
  try {
    const pending = run(find(remote.tools, "jira_get_issue"), { issue_key: "A-1" });
    while (!started) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await remote.close();
    await remote.close();
    await assert.rejects(pending, /cancelled/);
    const before = fixture.calls.length;
    await assert.rejects(run(find(remote.tools, "jira_search"), { issue_key: "A-1" }), /cancelled/);
    assert.equal(fixture.calls.length, before);
  } finally {
    await fixture.close();
  }
});
