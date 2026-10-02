import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { executeTool } from "./index";
import { writeJiraCommand } from "./write-jira-command";

const context = {
  toolCallId: "jira-comment-call",
  abortSignal: new AbortController().signal,
  emitCustomEvent: () => {
    throw new Error("Unexpected custom event");
  },
};

function mockJira(t: TestContext) {
  const originalFetch = globalThis.fetch;
  const names = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] as const;
  const originalEnv = names.map((name) => process.env[name]);
  Object.assign(process.env, {
    JIRA_BASE_URL: "https://jira.example.com/jira/",
    JIRA_EMAIL: "test@example.com",
    JIRA_API_TOKEN: "test-token",
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    names.forEach((name, index) => {
      if (originalEnv[index] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalEnv[index];
      }
    });
  });
}

function execute(input: unknown, executionContext = context) {
  return executeTool(
    {
      id: "jira-comment-call",
      name: "write_jira_command",
      arguments: JSON.stringify(input),
      input,
    },
    executionContext,
  );
}

test("write_jira_command posts one comment through executeTool and returns the created receipt", async (t) => {
  mockJira(t);
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(String(url), "https://jira.example.com/jira/rest/api/2/issue/PROJ-123/comment");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
      accept: "application/json",
      authorization: "Basic dGVzdEBleGFtcGxlLmNvbTp0ZXN0LXRva2Vu",
      "content-type": "application/json",
    });
    assert.equal(init?.body, '{"body":"  First line\\nSecond line\\n\\nLast line  "}');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    return Response.json(
      {
        id: "10042",
        body: "  First line\nSecond line\n\nLast line  ",
        author: { displayName: "Test User", emailAddress: "not returned" },
        created: "2026-07-16T08:30:00.000+0000",
        extra: "not returned",
      },
      { status: 201, headers: { "Content-Type": "APPLICATION/JSON; charset=utf-8" } },
    );
  };
  assert.deepEqual(
    await execute({ ticket: " proj-123 ", body: "  First line\nSecond line\n\nLast line  " }),
    {
      key: "PROJ-123",
      url: "https://jira.example.com/jira/browse/PROJ-123?focusedCommentId=10042",
      commentId: "10042",
      body: "  First line\nSecond line\n\nLast line  ",
      author: "Test User",
      created: "2026-07-16T08:30:00.000+0000",
    },
  );
  assert.equal(requests, 1);
});

test("write_jira_command direct execution normalizes keys, encodes comment IDs, and defaults missing metadata", async (t) => {
  mockJira(t);
  process.env.JIRA_BASE_URL = "http://jira.example.com/jira////";
  for (const author of [undefined, {}]) {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "http://jira.example.com/jira/rest/api/2/issue/AB_12-034/comment");
      assert.equal(init?.method, "POST");
      assert.equal(init?.body, '{"body":" Original text "}');
      return Response.json({ id: "42/# ?", body: "Stored comment", author }, { status: 201 });
    };
    assert.deepEqual(
      await writeJiraCommand.execute!({ ticket: " ab_12-034 ", body: " Original text " }),
      {
        key: "AB_12-034",
        url: "http://jira.example.com/jira/browse/AB_12-034?focusedCommentId=42%2F%23%20%3F",
        commentId: "42/# ?",
        body: "Stored comment",
        author: "Unknown",
        created: "",
      },
    );
  }
});

test("write_jira_command schema and both execution boundaries reject invalid keys and comment text", async (t) => {
  mockJira(t);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("Unexpected network request");
  };
  for (const input of [
    { ticket: "../secret", body: "Comment" },
    { ticket: "", body: "Comment" },
    { ticket: "PROJ-nope", body: "Comment" },
    { ticket: "PROJ-1/comment", body: "Comment" },
    { ticket: "PROJ-1", body: "" },
    { ticket: "PROJ-1", body: " \t\r\n " },
    { ticket: "PROJ-1", body: "x".repeat(32_768) },
    { ticket: "PROJ-1", body: ` ${"x".repeat(32_767)}` },
  ]) {
    assert.throws(() => writeJiraCommand.inputSchema.parse(input), z.ZodError);
    await assert.rejects(() => execute(input), z.ZodError);
    await assert.rejects(async () => writeJiraCommand.execute!(input), z.ZodError);
  }
  for (const input of [
    null,
    [],
    {},
    { ticket: "PROJ-1" },
    { body: "Comment" },
    { ticket: 1, body: "Comment" },
    { ticket: "PROJ-1", body: 1 },
    { ticket: "PROJ-1", body: null },
  ]) {
    assert.throws(() => writeJiraCommand.inputSchema.parse(input), z.ZodError);
    await assert.rejects(() => execute(input), z.ZodError);
  }
  assert.equal(requests, 0);
});

test("write_jira_command accepts exactly 32767 characters without trimming the body", async (t) => {
  mockJira(t);
  const body = ` ${"x".repeat(32_766)}`;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.body, JSON.stringify({ body }));
    return Response.json({ id: "10043", body: "Saved" }, { status: 201 });
  };
  assert.deepEqual(await execute({ ticket: "PROJ-123", body }), {
    key: "PROJ-123",
    url: "https://jira.example.com/jira/browse/PROJ-123?focusedCommentId=10043",
    commentId: "10043",
    body: "Saved",
    author: "Unknown",
    created: "",
  });
});

test("write_jira_command rejects missing configuration and invalid base URLs before a request", async (t) => {
  mockJira(t);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("Unexpected network request");
  };
  const expected = {
    name: "Error",
    message:
      "Jira configuration is missing or invalid. Check JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN.",
  };
  for (const name of ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] as const) {
    const value = process.env[name];
    delete process.env[name];
    await assert.rejects(() => execute({ ticket: "PROJ-123", body: "Comment" }), expected);
    process.env[name] = value;
  }
  for (const baseUrl of [
    "not a URL test-token",
    "file:///jira",
    "https://test@example.com:jira-token@jira.example.com/jira",
    "https://jira.example.com/jira?token=test-token",
    "https://jira.example.com/jira#test-token",
  ]) {
    process.env.JIRA_BASE_URL = baseUrl;
    await assert.rejects(() => execute({ ticket: "PROJ-123", body: "Comment" }), expected);
  }
  assert.equal(requests, 0);
});

test("write_jira_command sanitizes HTTP failures and never retries the POST", async (t) => {
  mockJira(t);
  for (const status of [400, 401, 403, 404, 429, 500]) {
    await t.test(`HTTP ${status}`, async () => {
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        return new Response("test@example.com test-token secret Jira response", {
          status,
          statusText: "secret test-token",
        });
      };
      await assert.rejects(() => execute({ ticket: "PROJ-123", body: "Comment" }), {
        name: "Error",
        message: `Jira comment request failed (HTTP ${status}). The comment may have been written; check Jira before retrying.`,
      });
      assert.equal(requests, 1);
    });
  }
});

test("write_jira_command rejects non-JSON and malformed JSON without leaking Jira data or retrying", async (t) => {
  mockJira(t);
  for (const { name, response, message } of [
    {
      name: "HTML response",
      response: () =>
        new Response("test-token", { status: 201, headers: { "Content-Type": "text/html" } }),
      message:
        "Jira returned a non-JSON response. The comment may have been written; check Jira before retrying.",
    },
    {
      name: "valid JSON with a non-JSON content type",
      response: () =>
        Response.json(
          { id: "1", body: "test-token" },
          { status: 201, headers: { "Content-Type": "text/plain" } },
        ),
      message:
        "Jira returned a non-JSON response. The comment may have been written; check Jira before retrying.",
    },
    {
      name: "content type containing json without a JSON media type",
      response: () =>
        Response.json(
          { id: "1", body: "test-token" },
          { status: 201, headers: { "Content-Type": "application/notjson" } },
        ),
      message:
        "Jira returned a non-JSON response. The comment may have been written; check Jira before retrying.",
    },
    {
      name: "missing content type",
      response: () => new Response(null, { status: 201 }),
      message:
        "Jira returned a non-JSON response. The comment may have been written; check Jira before retrying.",
    },
    {
      name: "invalid JSON",
      response: () =>
        new Response('{"body":"test-token"', {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      message:
        "Jira returned an invalid comment response. The comment may have been written; check Jira before retrying.",
    },
  ]) {
    await t.test(name, async () => {
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        return response();
      };
      await assert.rejects(() => execute({ ticket: "PROJ-123", body: "Comment" }), {
        name: "Error",
        message,
      });
      assert.equal(requests, 1);
    });
  }
});

test("write_jira_command rejects malformed created comment shapes without leaking Jira data or retrying", async (t) => {
  mockJira(t);
  for (const { name, data } of [
    { name: "null comment", data: null },
    { name: "array comment", data: [] },
    { name: "missing id", data: { body: "test-token" } },
    { name: "empty id", data: { id: "", body: "test-token" } },
    { name: "non-string id", data: { id: 1, body: "test-token" } },
    { name: "missing body", data: { id: "1" } },
    { name: "non-string body", data: { id: "1", body: 1 } },
    { name: "invalid author", data: { id: "1", body: "test-token", author: "test-token" } },
    {
      name: "invalid display name",
      data: { id: "1", body: "test-token", author: { displayName: 1 } },
    },
    { name: "invalid created date", data: { id: "1", body: "test-token", created: 1 } },
  ]) {
    await t.test(name, async () => {
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        return Response.json(data, { status: 201 });
      };
      await assert.rejects(() => execute({ ticket: "PROJ-123", body: "Comment" }), {
        name: "Error",
        message:
          "Jira returned an invalid comment response. The comment may have been written; check Jira before retrying.",
      });
      assert.equal(requests, 1);
    });
  }
});

test("write_jira_command rejects an already aborted signal without sending a POST or leaking its reason", async (t) => {
  mockJira(t);
  const controller = new AbortController();
  controller.abort(new Error("test-token secret cancellation reason"));
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("Unexpected network request");
  };
  await assert.rejects(
    () =>
      execute(
        { ticket: "PROJ-123", body: "Comment" },
        { ...context, abortSignal: controller.signal },
      ),
    {
      name: "Error",
      message:
        "Jira comment request failed. The comment may have been written; check Jira before retrying.",
    },
  );
  assert.equal(requests, 0);
});

test("write_jira_command combines the 15000ms timeout with caller cancellation and never retries", async (t) => {
  mockJira(t);
  for (const source of ["caller", "timeout"]) {
    await t.test(source, async (subtest) => {
      const caller = new AbortController();
      const timeout = new AbortController();
      subtest.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
        assert.equal(milliseconds, 15_000);
        return timeout.signal;
      });
      const started = Promise.withResolvers<void>();
      let requests = 0;
      globalThis.fetch = async (_url, init) => {
        requests++;
        assert.ok(init?.signal);
        const signal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          started.resolve();
        });
      };
      const result = execute(
        { ticket: "PROJ-123", body: "Comment" },
        { ...context, abortSignal: caller.signal },
      );
      await started.promise;
      (source === "caller" ? caller : timeout).abort(new Error("test-token secret abort reason"));
      await assert.rejects(result, {
        name: "Error",
        message:
          "Jira comment request failed. The comment may have been written; check Jira before retrying.",
      });
      assert.equal(requests, 1);
    });
  }
});

test("write_jira_command rejects redirect failures without replaying the POST or exposing the target", async (t) => {
  mockJira(t);
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    throw new TypeError("Redirect to https://test@example.com:test-token@other.example.com");
  };
  await assert.rejects(() => execute({ ticket: "PROJ-123", body: "Comment" }), {
    name: "Error",
    message:
      "Jira comment request failed. The comment may have been written; check Jira before retrying.",
  });
  assert.equal(requests, 1);
});

test("write_jira_command sanitizes transport failures and never retries the POST", async (t) => {
  mockJira(t);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("https://test@example.com:test-token@jira.example.com secret network details");
  };
  await assert.rejects(
    async () => writeJiraCommand.execute!({ ticket: "PROJ-123", body: "Comment" }, context),
    {
      name: "Error",
      message:
        "Jira comment request failed. The comment may have been written; check Jira before retrying.",
    },
  );
  assert.equal(requests, 1);
});
