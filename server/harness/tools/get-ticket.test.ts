import assert from "node:assert/strict";
import { test } from "node:test";
import { getTicket } from "./get-ticket";

test("get_ticket returns issue details, bounds comments, and handles failures", async () => {
  const originalFetch = globalThis.fetch;
  const names = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] as const;
  const originalEnv = names.map((name) => process.env[name]);
  Object.assign(process.env, {
    JIRA_BASE_URL: "https://jira.example.com/jira/",
    JIRA_EMAIL: "test@example.com",
    JIRA_API_TOKEN: "test-token",
  });
  const execute = async (ticket = " proj-123 ") => getTicket.execute!({ ticket });
  try {
    globalThis.fetch = async (url, init) => {
      const request = new URL(String(url));
      assert.equal(request.pathname, "/jira/rest/api/2/issue/PROJ-123");
      assert.ok(request.searchParams.get("fields")?.includes("description"));
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        `Basic ${Buffer.from("test@example.com:test-token").toString("base64")}`,
      );
      assert.ok(init?.signal);
      return Response.json({
        key: "PROJ-123",
        fields: {
          summary: "Fix checkout",
          description: "Details",
          status: { name: "Open" },
          comment: {
            total: 30,
            comments: Array.from({ length: 12 }, (_, i) => ({ body: String(i) })),
          },
        },
      });
    };
    assert.deepEqual(await execute(), {
      key: "PROJ-123",
      url: "https://jira.example.com/jira/browse/PROJ-123",
      summary: "Fix checkout",
      description: "Details",
      status: "Open",
      type: "",
      priority: "",
      assignee: "Unassigned",
      reporter: "",
      labels: [],
      created: "",
      updated: "",
      commentCount: 30,
      commentsTruncated: true,
      comments: Array.from({ length: 10 }, (_, i) => ({
        author: "Unknown",
        created: "",
        body: String(i + 2),
      })),
    });
    globalThis.fetch = async () =>
      Response.json({ key: "PROJ-123", fields: { description: null, assignee: null } });
    const empty = await execute();
    assert.ok(empty && typeof empty === "object");
    assert.equal(Reflect.get(empty, "commentsTruncated"), false);
    assert.deepEqual(Reflect.get(empty, "comments"), []);
    globalThis.fetch = async () => {
      throw new Error("Unexpected network request");
    };
    await assert.rejects(() => execute("../secrets"), /Expected a Jira issue key/);
    delete process.env.JIRA_API_TOKEN;
    await assert.rejects(() => execute(), /Missing JIRA/);
    process.env.JIRA_API_TOKEN = "test-token";
    for (const status of [401, 404, 429]) {
      globalThis.fetch = async () => new Response("secret response body", { status });
      await assert.rejects(() => execute(), new RegExp(String(status)));
    }
    globalThis.fetch = async () =>
      new Response("<html>", { headers: { "content-type": "text/html" } });
    await assert.rejects(() => execute(), /non-JSON/);
    globalThis.fetch = async () => Response.json({ unexpected: true });
    await assert.rejects(() => execute(), /fields/);
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = async (_, init) => {
      init?.signal?.throwIfAborted();
      throw new Error("Expected cancellation");
    };
    await assert.rejects(
      async () =>
        getTicket.execute!(
          { ticket: "PROJ-123" },
          {
            abortSignal: controller.signal,
            emitCustomEvent: () => {},
          },
        ),
      { name: "AbortError" },
    );
  } finally {
    globalThis.fetch = originalFetch;
    names.forEach((name, index) => {
      if (originalEnv[index] === undefined) {delete process.env[name];}
      else {process.env[name] = originalEnv[index];}
    });
  }
});
