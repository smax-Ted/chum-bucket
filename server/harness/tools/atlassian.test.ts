import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from "node:timers";
import type { ToolExecutionContext } from "@tanstack/ai";
import type { ModelCall } from "../model-turn";
import { withAtlassianScope } from "./atlassian";
import { read } from "./fs";
import { withRunTools, type RunTools } from "./index";
import {
  allTools,
  coreTools,
  fakeBaseUrl,
  fakeEmail,
  fakeToken,
  jiraSchema,
  mcpFixture,
  withMcpEnvironment,
} from "./mcp-fixture";

const context: ToolExecutionContext = {
  toolCallId: "test-call",
  emitCustomEvent: () => {
    throw new Error("Unexpected custom event");
  },
};
const call = (name: string, input: unknown = {}): ModelCall => ({
  id: "test-call",
  name,
  arguments: JSON.stringify(input),
  input,
});
const jiraCall = call("jira_get_issue", { issue_key: "TEST-1" });
const localNames = ["get_figma", "read", "write", "edit"];
const remoteNames = [
  "jira_get_issue",
  "jira_search",
  "confluence_get_page",
  "confluence_search",
  "confluence_get_comments",
];
const credentialForms = [
  ...new Set(
    [fakeToken, `${fakeEmail}:${fakeToken}`].flatMap((secret) => [
      secret,
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64url"),
      encodeURIComponent(secret),
    ]),
  ),
];
function safeError(pattern: RegExp) {
  return (error: Error) => {
    assert.match(error.message, pattern);
    assert.equal(error.cause, undefined);
    for (const secret of credentialForms) {
      assert.equal(error.message.includes(secret), false);
    }
    return true;
  };
}
async function withTemporaryDirectory(use: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "chum-atlassian-"));
  try {
    await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("unconfigured runs expose local tools and execute filesystem reads without HTTP requests", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network");
  });
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      process.env.CONFLUENCE_BASE_URL = "not-a-url";
      await withTemporaryDirectory(async (directory) => {
        const path = join(directory, "local.txt");
        await writeFile(path, "local data");
        await withRunTools(async (tools) => {
          assert.deepEqual(
            (await tools.getModelTools()).map((tool) => tool.name),
            localNames,
          );
          assert.deepEqual(await tools.executeTool(call("read", { path }), context), {
            content: [{ type: "text", text: "local data" }],
            details: undefined,
          });
          await assert.rejects(tools.executeTool(jiraCall, context), /^Error: Unknown tool$/);
        });
      });
      assert.equal(network.mock.callCount(), 0);
      assert.deepEqual(fixture.requests, []);
    },
    false,
    fixture,
  );
});

test("partial, malformed, and endpoint-only configuration fails closed before local or remote work", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      for (const [url, email, token] of [
        [fakeBaseUrl, "", ""],
        ["", fakeEmail, fakeToken],
        [fakeBaseUrl, fakeEmail, ""],
        [fakeBaseUrl, "invalid", fakeToken],
        [fakeBaseUrl, fakeEmail, `${fakeToken}\n`],
        ["http://offline.invalid", fakeEmail, fakeToken],
        [`https://${fakeEmail}:${fakeToken}@offline.invalid`, fakeEmail, fakeToken],
        [`${fakeBaseUrl}?token=${fakeToken}`, fakeEmail, fakeToken],
        [`${fakeBaseUrl}#${fakeToken}`, fakeEmail, fakeToken],
      ]) {
        process.env.JIRA_BASE_URL = url;
        process.env.JIRA_EMAIL = email;
        process.env.JIRA_API_TOKEN = token;
        process.env.ATLASSIAN_MCP_URL = fixture.url;
        await assert.rejects(
          withRunTools((tools) => tools.getModelTools()),
          safeError(/JIRA_/),
        );
        await assert.rejects(
          withRunTools((tools) => tools.executeTool(call("read", { path: "unused" }), context)),
          safeError(/JIRA_/),
        );
      }
      for (const endpoint of [
        "http://offline.invalid/mcp",
        `http://${fakeEmail}:${fakeToken}@127.0.0.1:8000/mcp`,
        "http://127.0.0.1:8000/mcp?token=unsafe",
        "http://127.0.0.1:8000/mcp#unsafe",
        " http://127.0.0.1:8000/mcp",
        "http://localhost:8000/mcp",
        "https://127.0.0.1:8000/mcp",
      ]) {
        process.env.JIRA_BASE_URL = fakeBaseUrl;
        process.env.JIRA_EMAIL = fakeEmail;
        process.env.JIRA_API_TOKEN = fakeToken;
        process.env.ATLASSIAN_MCP_URL = endpoint;
        await assert.rejects(
          withRunTools((tools) => tools.getModelTools()),
          safeError(/ATLASSIAN_MCP_URL/),
        );
      }
      process.env.JIRA_BASE_URL = "";
      process.env.JIRA_EMAIL = "";
      process.env.JIRA_API_TOKEN = "";
      process.env.ATLASSIAN_MCP_URL = fixture.url;
      await assert.rejects(
        withRunTools((tools) => tools.getModelTools()),
        safeError(/ATLASSIAN_MCP_URL/),
      );
      assert.deepEqual(fixture.requests, []);
    },
    true,
    fixture,
  );
});

test("HTTP initializes once, paginates, retains native schemas and executes native read arguments", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    () =>
      withRunTools(async (tools) => {
        const [definitions, concurrent] = await Promise.all([
          tools.getModelTools(),
          tools.getModelTools(),
        ]);
        assert.deepEqual(
          definitions.map((tool) => tool.name),
          [...localNames, ...remoteNames],
        );
        assert.deepEqual(concurrent, definitions);
        assert.deepEqual(
          definitions.find((tool) => tool.name === "jira_get_issue"),
          { name: "jira_get_issue", description: "Read an issue", inputSchema: jiraSchema },
        );
        assert.ok(
          definitions.every(
            (tool) => Object.keys(tool).join(",") === "name,description,inputSchema",
          ),
        );
        (definitions[0] as { name: string }).name = "changed";
        assert.equal((await tools.getModelTools())[0]!.name, "get_figma");
        assert.deepEqual(await tools.executeTool(jiraCall, context), { issue: "TEST-1" });
        assert.equal(
          await tools.executeTool(call("confluence_get_page", { page_id: "123" }), context),
          "Native tool result",
        );
        assert.equal(
          await tools.executeTool(call("confluence_get_comments", { page_id: "123" }), context),
          "Native tool result",
        );
        assert.deepEqual(
          fixture.calls().map((request) => request.message.params),
          [
            { name: "jira_get_issue", arguments: { issue_key: "TEST-1", update_history: false } },
            { name: "confluence_get_page", arguments: { page_id: "123" } },
            { name: "confluence_get_comments", arguments: { page_id: "123" } },
          ],
        );
      }),
    true,
    fixture,
  );
  assert.equal(fixture.sessions.length, 1);
  assert.deepEqual(
    fixture.requests
      .filter((request) => request.message.method === "tools/list")
      .map((request) => request.message.params?.cursor),
    [undefined, "1"],
  );
  for (const request of fixture.requests) {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.aborted, request.message.method === "sse");
  }
});

test("Jira credentials automatically expose Confluence and unrelated process overrides never change the snapshot", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    () =>
      withRunTools(async (tools) => {
        process.env.READ_ONLY_MODE = "false";
        process.env.ENABLED_TOOLS = "jira_delete_issue,jira_add_comment";
        process.env.TOOLSETS = "all";
        process.env.PYTHON_DOTENV_DISABLED = "0";
        process.env.UV_PYTHON = "/existing/python3.11";
        process.env.MODEL_API_KEY = "unrelated-model-secret";
        process.env.CONFLUENCE_API_TOKEN = "unrelated-confluence-secret";
        process.env.CONFLUENCE_BASE_URL = "https://unapproved.invalid/wiki";
        process.env.JIRA_URL = "https://unapproved.invalid";
        process.env.ATLASSIAN_OAUTH_STORE = "/obsolete/store.json";
        assert.deepEqual(
          (await tools.getModelTools()).map((tool) => tool.name),
          [...localNames, ...remoteNames],
        );
        assert.equal(
          await tools.executeTool(call("confluence_get_page", { page_id: "123" }), context),
          "Native tool result",
        );
      }),
    true,
    fixture,
  );
  assert.equal(fixture.sessions.length, 1);
});

test("write tools, official aliases, generic tools and absent optional tools never dispatch", async () => {
  for (const pages of [[allTools], [coreTools]]) {
    const fixture = mcpFixture({ pages });
    await withMcpEnvironment(
      () =>
        withRunTools(async (tools) => {
          const definitions = await tools.getModelTools();
          for (const name of [
            "jira_add_comment",
            "jira_edit_comment",
            "jira_delete_issue",
            "confluence_add_comment",
            "getJiraIssue",
            "getAccessibleAtlassianResources",
            "addOrEditJiraIssueComment",
            "getConfluenceContent",
            "execute",
            "discovery",
            "search",
            "unknown",
            ...(pages[0] === coreTools ? ["jira_search", "confluence_search"] : []),
          ]) {
            assert.equal(
              definitions.some((tool) => tool.name === name),
              false,
            );
            await assert.rejects(tools.executeTool(call(name), context), /Unknown tool/);
          }
          assert.deepEqual(fixture.calls(), []);
        }),
      true,
      fixture,
    );
  }
});

test("required Jira and Confluence tools, duplicate names and malformed schemas fail closed", async () => {
  for (const { pages, pattern } of [
    {
      pages: coreTools.filter((tool) => tool.name !== "jira_get_issue"),
      pattern: /missing required tool jira_get_issue/,
    },
    {
      pages: coreTools.filter((tool) => tool.name !== "confluence_get_page"),
      pattern: /missing required tool confluence_get_page/,
    },
    { pages: [...coreTools, coreTools[0]!], pattern: /Atlassian MCP/ },
    { pages: [{ ...coreTools[0]!, inputSchema: { type: "invalid" } }], pattern: /Atlassian MCP/ },
  ]) {
    const fixture = mcpFixture({ pages: [pages] });
    await withMcpEnvironment(
      async () => {
        await assert.rejects(
          withRunTools((tools) => tools.getModelTools()),
          safeError(pattern),
        );
        assert.deepEqual(fixture.calls(), []);
      },
      true,
      fixture,
    );
  }
});

test("an unreachable local service fails with safe actionable setup guidance and no hosted fallback", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      process.env.ATLASSIAN_MCP_URL = "http://127.0.0.1:1/mcp";
      await assert.rejects(
        withRunTools((tools) => tools.getModelTools()),
        safeError(/pnpm mcp:atlassian/),
      );
      assert.deepEqual(fixture.requests, []);
    },
    true,
    fixture,
  );
});

test("initialization and catalog errors close the failed client and concurrent access recovers with a fresh session", async () => {
  for (const method of ["initialize", "tools/list"]) {
    const fixture = mcpFixture({
      rules: [
        {
          method,
          once: true,
          error: { code: -32000, message: "Authentication failed", data: { nested: fakeToken } },
        },
      ],
    });
    await withMcpEnvironment(
      () =>
        withRunTools(async (tools) => {
          const outcomes = await Promise.allSettled([tools.getModelTools(), tools.getModelTools()]);
          for (const outcome of outcomes) {
            assert.equal(outcome.status, "rejected");
            safeError(/configured Atlassian credentials/)(
              (outcome as PromiseRejectedResult).reason,
            );
          }
          assert.equal(fixture.sessions.length, 1);
          assert.deepEqual(
            (await tools.getModelTools()).map((tool) => tool.name),
            [...localNames, ...remoteNames],
          );
          assert.deepEqual(await tools.executeTool(jiraCall, context), { issue: "TEST-1" });
          assert.equal(fixture.sessions.length, 2);
        }),
      true,
      fixture,
    );
  }
});

test("MCP isError is never a success and a failed invocation closes its client without automatic replay", async () => {
  const fixture = mcpFixture({
    rules: [
      {
        method: "tools/call",
        once: true,
        result: { isError: true, content: [{ type: "text", text: "Permission denied" }] },
      },
    ],
  });
  await withMcpEnvironment(
    () =>
      withRunTools(async (tools) => {
        await assert.rejects(
          tools.executeTool(jiraCall, context),
          safeError(/tool failed.*credentials.*site access/),
        );
        assert.equal(fixture.calls().length, 1);
        assert.deepEqual(await tools.executeTool(jiraCall, context), { issue: "TEST-1" });
        assert.equal(fixture.sessions.length, 2);
        assert.equal(fixture.calls().length, 2);
      }),
    true,
    fixture,
  );
});

test("terminated HTTP connections report safe failures and recover without resending an invocation", async () => {
  for (const method of ["initialize", "tools/call"]) {
    const fixture = mcpFixture({ rules: [{ method, once: true, destroy: true }] });
    await withMcpEnvironment(
      () =>
        withRunTools(async (tools) => {
          await assert.rejects(
            tools.executeTool(jiraCall, context),
            safeError(/Atlassian MCP.*failed/),
          );
          assert.equal(fixture.calls().length, method === "tools/call" ? 1 : 0);
          assert.deepEqual(await tools.executeTool(jiraCall, context), { issue: "TEST-1" });
          assert.equal(fixture.sessions.length, 2);
        }),
      true,
      fixture,
    );
  }
});

test("scope teardown during initialization aborts the in-flight request and preserves the primary callback failure", async () => {
  for (const method of ["initialize", "tools/list"]) {
    const fixture = mcpFixture({ rules: [{ method, hang: true }] });
    await withMcpEnvironment(
      async () => {
        let discovery: Promise<void> | undefined;
        await assert.rejects(
          withRunTools(async (tools) => {
            discovery = assert.rejects(tools.getModelTools(), /cancelled or timed out/);
            await fixture.waitFor(method);
            throw new Error("Primary callback failure");
          }),
          /^Error: Primary callback failure$/,
        );
        await discovery;
        await fixture.assertClosed();
        assert.ok(
          fixture.requests.some((request) => request.message.method === method && request.aborted),
        );
      },
      true,
      fixture,
    );
  }
});

test("unawaited discovery cannot start a client after scope teardown", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      let discovery: Promise<void> | undefined;
      assert.equal(
        await withRunTools(async (tools) => {
          discovery = assert.rejects(
            tools.getModelTools(),
            /scope is closed|cancelled or timed out/,
          );
          return "completed";
        }),
        "completed",
      );
      await discovery;
      await fixture.assertClosed();
      assert.deepEqual(fixture.requests, []);
    },
    true,
    fixture,
  );
});

test("retained tools reject local and remote work after teardown without contacting the service", async () => {
  for (const configured of [false, true]) {
    const fixture = mcpFixture();
    await withMcpEnvironment(
      async () => {
        let retained: RunTools | undefined;
        await withRunTools(async (tools) => {
          retained = tools;
        });
        assert.ok(retained);
        await assert.rejects(retained.getModelTools(), /^Error: Tool scope is closed$/);
        await assert.rejects(
          retained.executeTool(jiraCall, context),
          /^Error: Tool scope is closed$/,
        );
        await assert.rejects(
          retained.executeTool(call("read", { path: "unused" }), context),
          /^Error: Tool scope is closed$/,
        );
        assert.deepEqual(fixture.requests, []);
      },
      configured,
      fixture,
    );
  }
});

test("cancellation before the first HTTP request reaches the service sends nothing", async (t) => {
  const fixture = mcpFixture();
  const realFetch = globalThis.fetch;
  const gate = Promise.withResolvers<void>();
  let attempted: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    attempted = init?.signal ?? undefined;
    return gate.promise.then(() => realFetch(input, init));
  });
  await withMcpEnvironment(
    async () => {
      const controller = new AbortController();
      const invocation = withRunTools((tools) =>
        tools.executeTool(jiraCall, { ...context, abortSignal: controller.signal }),
      );
      for (let attempt = 0; attempt < 500 && !attempted; attempt++) {
        await delay(1);
      }
      assert.ok(attempted, "Client never attempted a request");
      controller.abort();
      gate.resolve();
      await assert.rejects(invocation, /cancelled/);
      assert.deepEqual(fixture.requests, []);
    },
    true,
    fixture,
  );
});

test("pre-cancelled calls never contact the service", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    () =>
      withRunTools(async (tools) => {
        await assert.rejects(
          tools.executeTool(jiraCall, { ...context, abortSignal: AbortSignal.abort() }),
          /cancelled/,
        );
        assert.deepEqual(fixture.requests, []);
      }),
    true,
    fixture,
  );
});

for (const method of ["initialize", "tools/list", "tools/call"]) {
  test(`cancellation during ${method} aborts the in-flight HTTP request and permits later recovery`, async () => {
    const fixture = mcpFixture({
      rules: [{ method, once: true, hang: true }],
    });
    await withMcpEnvironment(
      () =>
        withRunTools(async (tools) => {
          const controller = new AbortController();
          const invocation = tools.executeTool(jiraCall, {
            ...context,
            abortSignal: controller.signal,
          });
          const rejected = assert.rejects(invocation, safeError(/cancelled/));
          await fixture.waitFor(method);
          controller.abort();
          await rejected;
          await fixture.assertClosed();
          assert.ok(
            fixture.requests.some(
              (request) => request.message.method === method && request.aborted,
            ),
          );
          assert.deepEqual(await tools.executeTool(jiraCall, context), { issue: "TEST-1" });
          assert.equal(fixture.sessions.length, 2);
        }),
      true,
      fixture,
    );
  });

  test(`internal deadline bounds ${method} and aborts the in-flight HTTP request`, async (t) => {
    const armed = new Map<NodeJS.Timeout, () => void>();
    t.mock.method(
      globalThis,
      "setTimeout",
      (callback: () => void, ms?: number, ...args: unknown[]) => {
        if (ms === 60_000) {
          const handle = nodeSetTimeout(() => {}, 0);
          armed.set(handle, callback);
          return handle;
        }
        return nodeSetTimeout(callback, ms, ...args);
      },
    );
    t.mock.method(globalThis, "clearTimeout", (handle?: NodeJS.Timeout) => {
      if (handle) {
        armed.delete(handle);
      }
      return nodeClearTimeout(handle);
    });
    const fixture = mcpFixture({ rules: [{ method, hang: true }] });
    await withMcpEnvironment(
      async () => {
        const rejected = assert.rejects(
          withRunTools((tools) =>
            method === "tools/call" ? tools.executeTool(jiraCall, context) : tools.getModelTools(),
          ),
          safeError(/cancelled or timed out/),
        );
        await fixture.waitFor(method);
        assert.ok(armed.size > 0);
        for (const trigger of armed.values()) {
          trigger();
        }
        await rejected;
        await fixture.assertClosed();
        assert.ok(
          fixture.requests.some((request) => request.message.method === method && request.aborted),
        );
      },
      true,
      fixture,
    );
  });
}

test("cleared deadlines cannot abort a long-lived session after successful initialization and calls", async (t) => {
  const armed = new Set<unknown>();
  const cleared = new Set<unknown>();
  t.mock.method(
    globalThis,
    "setTimeout",
    (callback: () => void, ms?: number, ...args: unknown[]) => {
      const handle = nodeSetTimeout(callback, ms, ...args);
      if (ms === 60_000) {
        armed.add(handle);
      }
      return handle;
    },
  );
  t.mock.method(globalThis, "clearTimeout", (handle?: NodeJS.Timeout) => {
    if (handle) {
      cleared.add(handle);
    }
    return nodeClearTimeout(handle);
  });
  const fixture = mcpFixture();
  await withMcpEnvironment(
    () =>
      withRunTools(async (tools) => {
        await tools.getModelTools();
        assert.deepEqual(await tools.executeTool(jiraCall, context), { issue: "TEST-1" });
        assert.ok(armed.size >= 2);
        assert.deepEqual(
          [...armed].filter((handle) => !cleared.has(handle)),
          [],
        );
        assert.deepEqual(await tools.executeTool(jiraCall, context), { issue: "TEST-1" });
        assert.equal(fixture.sessions.length, 1);
        assert.equal(fixture.requests.filter((request) => request.aborted).length, 0);
      }),
    true,
    fixture,
  );
});

test("scope cleanup on success and primary callback failure leaves no in-flight requests", async () => {
  for (const failure of [false, true]) {
    const fixture = mcpFixture();
    await withMcpEnvironment(
      async () => {
        const result = withRunTools(async (tools) => {
          await tools.getModelTools();
          if (failure) {
            throw new Error("Primary callback failure");
          }
          return "completed";
        });
        if (failure) {
          await assert.rejects(result, /^Error: Primary callback failure$/);
        } else {
          assert.equal(await result, "completed");
        }
        await fixture.assertClosed();
      },
      true,
      fixture,
    );
  }
});

test("concurrent scopes own independent HTTP sessions", async () => {
  const ready = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  const fixture = mcpFixture({
    rules: [
      {
        method: "tools/call",
        arguments: { issue_key: "FAIL-1" },
        result: { isError: true, content: [{ type: "text", text: "Expired session" }] },
      },
    ],
  });
  await withMcpEnvironment(
    () =>
      Promise.all([
        withRunTools(async (tools) => {
          await tools.getModelTools();
          await ready.promise;
          await assert.rejects(
            tools.executeTool(call("jira_get_issue", { issue_key: "FAIL-1" }), context),
            /tool failed/,
          );
          failed.resolve();
        }),
        withRunTools(async (tools) => {
          await tools.getModelTools();
          ready.resolve();
          await failed.promise;
          assert.deepEqual(await tools.executeTool(jiraCall, context), { issue: "TEST-1" });
        }),
      ]),
    true,
    fixture,
  );
  assert.equal(fixture.sessions.length, 2);
  assert.notEqual(fixture.calls()[0]!.session, fixture.calls()[1]!.session);
});

test("Jira and Confluence user emails matching the login remain readable in structured and text results", async () => {
  const cases = [
    {
      request: jiraCall,
      output: {
        issue: "TEST-1",
        fields: {
          summary: "Issue assigned to the configured user",
          status: { name: "Open" },
          assignee: { displayName: "Test User", emailAddress: fakeEmail },
          reporter: { displayName: "Test User", emailAddress: fakeEmail },
        },
      },
    },
    {
      request: call("confluence_get_page", { page_id: "123" }),
      output: { id: "123", title: "Test page", author: { email: fakeEmail } },
    },
  ];
  for (const structured of [true, false]) {
    const fixture = mcpFixture({
      pages: [
        allTools.map((tool) => ({
          ...tool,
          outputSchema: structured ? { type: "object" } : undefined,
        })),
      ],
      rules: cases.map(({ request, output }) => ({
        method: "tools/call",
        name: request.name,
        result: structured
          ? { content: [], structuredContent: output }
          : { content: [{ type: "text", text: JSON.stringify(output) }] },
      })),
    });
    await withMcpEnvironment(
      () =>
        withRunTools(async (tools) => {
          for (const { request, output } of cases) {
            assert.deepEqual(
              await tools.executeTool(request, context),
              structured ? output : JSON.stringify(output),
            );
          }
        }),
      true,
      fixture,
    );
  }
});

test("credential forms in catalog descriptions and schemas, including forbidden tools, fail closed", async () => {
  for (const secret of credentialForms) {
    for (const location of ["description", "schema", "forbidden"]) {
      const tools = allTools.map((tool) =>
        tool.name === (location === "forbidden" ? "jira_delete_issue" : "jira_get_issue")
          ? {
              ...tool,
              ...(location === "schema"
                ? {
                    inputSchema: {
                      ...tool.inputSchema,
                      properties: { [secret]: { type: "string" } },
                    },
                  }
                : { description: secret }),
            }
          : tool,
      );
      const fixture = mcpFixture({ pages: [tools] });
      await withMcpEnvironment(
        async () => {
          await assert.rejects(
            withRunTools((tools) => tools.getModelTools()),
            safeError(/configured Atlassian credentials/),
          );
          assert.deepEqual(fixture.calls(), []);
        },
        true,
        fixture,
      );
    }
  }
});

test("credential forms in remote output, keys and MCP errors never escape to callers", async () => {
  for (const secret of credentialForms) {
    for (const location of ["output", "text", "key", "error", "cause"]) {
      const request =
        location === "text" ? call("confluence_get_page", { page_id: "123" }) : jiraCall;
      const fixture = mcpFixture({
        rules: [
          {
            method: "tools/call",
            ...(location === "cause"
              ? { error: { code: -32000, message: "Outer failure", data: { nested: secret } } }
              : {
                  result:
                    location === "error" || location === "text"
                      ? {
                          isError: location === "error",
                          content: [{ type: "text", text: `${fakeEmail}: ${secret}` }],
                        }
                      : {
                          content: [],
                          structuredContent:
                            location === "key"
                              ? { issue: "TEST-1", [secret]: "unsafe" }
                              : { issue: secret, reporter: { emailAddress: fakeEmail } },
                        },
                }),
          },
        ],
      });
      await withMcpEnvironment(
        async () => {
          await assert.rejects(
            withRunTools((tools) => tools.executeTool(request, context)),
            safeError(/configured Atlassian credentials/),
          );
          await fixture.assertClosed();
        },
        true,
        fixture,
      );
    }
  }
});

test("local filesystem results and Error causes cannot reveal snapshot credentials without contacting the service", async (t) => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () =>
      withTemporaryDirectory(async (directory) => {
        const path = join(directory, "private.txt");
        for (const secret of credentialForms) {
          await writeFile(path, secret);
          await assert.rejects(
            withRunTools((tools) => tools.executeTool(call("read", { path }), context)),
            safeError(/configured Atlassian credentials/),
          );
        }
        const handler = t.mock.method(
          read as typeof read & { execute: NonNullable<typeof read.execute> },
          "execute",
          async () => {
            throw new Error("Outer failure", { cause: new Error(fakeToken) });
          },
        );
        await assert.rejects(
          withRunTools((tools) => tools.executeTool(call("read", { path }), context)),
          safeError(/configured Atlassian credentials/),
        );
        handler.mock.restore();
      }),
    true,
    fixture,
  );
  assert.deepEqual(fixture.requests, []);
});

test("composition failures and composed definitions cannot expose credentials", async () => {
  for (const failure of [false, true]) {
    const fixture = mcpFixture();
    await withMcpEnvironment(
      async () => {
        await assert.rejects(
          withAtlassianScope((scope) =>
            scope.getModelTools(() => {
              if (failure) {
                throw new Error("Outer failure", { cause: new Error(fakeToken) });
              }
              return [{ name: "unsafe", description: fakeToken, inputSchema: { type: "object" } }];
            }),
          ),
          safeError(/configured Atlassian credentials/),
        );
        await fixture.assertClosed();
      },
      true,
      fixture,
    );
  }
});

test("configuration and credential guards remain a single snapshot when process env changes", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    () =>
      withRunTools(async (tools) => {
        await tools.getModelTools();
        process.env.JIRA_BASE_URL = "https://changed.atlassian.net";
        process.env.JIRA_EMAIL = "changed@example.invalid";
        process.env.JIRA_API_TOKEN = "changed-api-token";
        assert.deepEqual(await tools.executeTool(jiraCall, context), { issue: "TEST-1" });
        await withTemporaryDirectory(async (directory) => {
          const path = join(directory, "snapshot.txt");
          await writeFile(path, fakeToken);
          await assert.rejects(
            tools.executeTool(call("read", { path }), context),
            safeError(/configured Atlassian credentials/),
          );
        });
        assert.equal(fixture.sessions.length, 1);
      }),
    true,
    fixture,
  );
});

test("jira_get_issue never updates view history, including omitted or explicitly true model input", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    () =>
      withRunTools(async (tools) => {
        for (const update_history of [undefined, true, false]) {
          const input = {
            issue_key: "TEST-1",
            include: "comments",
            comment_limit: 25,
            ...(update_history === undefined ? {} : { update_history }),
          };
          assert.deepEqual(await tools.executeTool(call("jira_get_issue", input), context), {
            issue: "TEST-1",
          });
          assert.deepEqual(fixture.calls().at(-1)!.message.params?.arguments, {
            issue_key: "TEST-1",
            include: "comments",
            comment_limit: 25,
            update_history: false,
          });
          assert.equal(input.update_history, update_history);
        }
      }),
    true,
    fixture,
  );
});
