import assert from "node:assert/strict";
import { test } from "node:test";
import { openAtlassianTools } from "../../../../server/harness/tools/atlassian";
import { readAtlassianConfiguration } from "../../../../server/harness/tools/atlassian-policy";
import {
  allTools,
  fakeToken,
  jiraSchema,
  mcpFixture,
  withMcpEnvironment,
} from "../../../fixtures/mcp-fixture";

const context = { toolCallId: "call-1", emitCustomEvent: () => undefined };

test("local mode opens no client and exposes no remote tools", async () => {
  await withMcpEnvironment(async () => {
    const remote = await openAtlassianTools(
      readAtlassianConfiguration(process.env),
      new AbortController().signal,
    );
    assert.deepEqual(remote.tools, []);
    await remote.close();
  }, false);
});

test("the client keeps only allowlisted native tools as lazy tools", async () => {
  await withMcpEnvironment(async () => {
    const remote = await openAtlassianTools(
      readAtlassianConfiguration(process.env),
      new AbortController().signal,
    );
    try {
      assert.deepEqual(
        remote.tools.map((tool) => tool.name),
        [
          "jira_get_issue",
          "jira_search",
          "confluence_get_page",
          "confluence_search",
          "confluence_get_comments",
        ],
      );
      assert.ok(remote.tools.every((tool) => tool.lazy === true));
      assert.deepEqual(remote.tools[0].inputSchema, jiraSchema);
    } finally {
      await remote.close();
    }
  });
});

test("a missing required tool stops initialization and closes the client", async () => {
  const fixture = mcpFixture({
    pages: [allTools.filter((tool) => tool.name !== "confluence_get_page")],
  });
  await withMcpEnvironment(
    async () => {
      await assert.rejects(
        openAtlassianTools(readAtlassianConfiguration(process.env), new AbortController().signal),
        /missing required tool confluence_get_page/,
      );
    },
    true,
    fixture,
  );
});

test("jira_get_issue always sends update_history false", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      const remote = await openAtlassianTools(
        readAtlassianConfiguration(process.env),
        new AbortController().signal,
      );
      try {
        const jira = remote.tools.find((tool) => tool.name === "jira_get_issue")!;
        await jira.execute!({ issue_key: "PROJ-1", update_history: true }, context);
        assert.equal(fixture.calls()[0].message.params?.arguments?.update_history, false);
      } finally {
        await remote.close();
      }
    },
    true,
    fixture,
  );
});

test("tool errors and results never expose the configured token", async () => {
  const fixture = mcpFixture({
    rules: [
      {
        method: "tools/call",
        name: "confluence_get_page",
        error: { code: -32000, message: `upstream rejected ${fakeToken}` },
      },
      {
        method: "tools/call",
        name: "jira_search",
        result: { content: [{ type: "text", text: `leaked ${fakeToken}` }] },
      },
    ],
  });
  await withMcpEnvironment(
    async () => {
      const remote = await openAtlassianTools(
        readAtlassianConfiguration(process.env),
        new AbortController().signal,
      );
      try {
        const page = remote.tools.find((tool) => tool.name === "confluence_get_page")!;
        const search = remote.tools.find((tool) => tool.name === "jira_search")!;
        await assert.rejects(
          async () => page.execute!({ page_id: "1" }, context),
          (error: Error) => {
            assert.doesNotMatch(error.message, new RegExp(fakeToken));
            assert.match(error.message, /Atlassian MCP tool failed/);
            return true;
          },
        );
        await assert.rejects(
          async () => search.execute!({ jql: "x" }, context),
          /configured Atlassian credentials/,
        );
      } finally {
        await remote.close();
      }
    },
    true,
    fixture,
  );
});

test("cancelling a tool call releases the pending request", async () => {
  const fixture = mcpFixture({
    rules: [{ method: "tools/call", name: "confluence_get_page", hang: true }],
  });
  await withMcpEnvironment(
    async () => {
      const remote = await openAtlassianTools(
        readAtlassianConfiguration(process.env),
        new AbortController().signal,
      );
      try {
        const page = remote.tools.find((tool) => tool.name === "confluence_get_page")!;
        const controller = new AbortController();
        const pending = page.execute!(
          { page_id: "1" },
          { ...context, abortSignal: controller.signal },
        );
        await fixture.waitFor("tools/call");
        controller.abort();
        await assert.rejects(Promise.resolve(pending), /cancelled or timed out/);
      } finally {
        await remote.close();
      }
    },
    true,
    fixture,
  );
});

test("aborting the chat signal closes the client", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      const controller = new AbortController();
      const remote = await openAtlassianTools(
        readAtlassianConfiguration(process.env),
        controller.signal,
      );
      controller.abort();
      await remote.close();
      await fixture.assertClosed();
    },
    true,
    fixture,
  );
});
