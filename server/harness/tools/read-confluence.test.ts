import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { z } from "zod";
import { executeTool, modelTools } from "./index";
import { readConfluence } from "./read-confluence";

const HTML =
  ' \n<p>指南 🌊</p><table><tr><th>連結</th><td><a href="/wiki/pages/42?a=1&amp;b=2">資料</a></td></tr></table>\n';
const CONFIG_ERROR =
  "Confluence Cloud configuration is missing or invalid. Check JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN. Use an HTTP(S) site root or /wiki base without credentials, query, or fragment. Data Center and scoped-token gateways are not supported.";
const TARGET_ERROR =
  "Expected a positive Confluence Cloud page ID or a supported page URL on the configured /wiki base.";
const context = {
  toolCallId: "confluence-read-call",
  abortSignal: new AbortController().signal,
  emitCustomEvent: () => {
    throw new Error("Unexpected custom event");
  },
};
const chunkSchema = z.object({
  body: z.string(),
  offset: z.number(),
  totalCharacters: z.number(),
  truncated: z.boolean(),
  nextOffset: z.number().nullable(),
});

function mockConfluence(t: TestContext) {
  const originalFetch = globalThis.fetch;
  const names = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] as const;
  const originalEnv = names.map((name) => process.env[name]);
  Object.assign(process.env, {
    JIRA_BASE_URL: "https://site.example.com/",
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

function page(body = HTML, id = "12345") {
  return {
    id,
    title: "Operations guide",
    status: "current",
    spaceId: "678",
    version: { number: 7, createdAt: "2026-07-16T08:30:00.000Z", authorId: "not returned" },
    body: { view: { value: body, representation: "view" } },
    createdAt: "2026-01-01T00:00:00.000Z",
    _links: {
      base: "https://other.example.com",
      webui: "https://test@example.com:test-token@other.example.com/untrusted",
    },
    extra: "not returned",
  };
}

function execute(input: unknown, executionContext = context) {
  return executeTool(
    {
      id: "confluence-read-call",
      name: "read_confluence",
      arguments: JSON.stringify(input) ?? "",
      input,
    },
    executionContext,
  );
}

describe("read_confluence", { concurrency: false }, () => {
  test("emits a model JSON schema and reads unchanged HTML through the public registry", async (t) => {
    mockConfluence(t);
    const modelTool = modelTools.find((tool) => tool.name === "read_confluence");
    assert.ok(modelTool);
    assert.equal(modelTool.name, "read_confluence");
    assert.equal("execute" in modelTool, false);
    assert.match(modelTool.description, /Confluence Cloud only/);
    assert.match(modelTool.description, /rendered HTML/);
    assert.match(modelTool.description, /nextOffset/);
    assert.match(modelTool.description, /JIRA_BASE_URL \/ JIRA_EMAIL \/ JIRA_API_TOKEN/);
    assert.match(modelTool.description, /\/wiki\/x\/TOKEN/);
    const targetDescription = modelTool.inputSchema?.properties?.target?.description;
    assert.ok(targetDescription);
    assert.match(targetDescription, /\/wiki\/x\/TOKEN/);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(modelTool.inputSchema, (key, value) =>
          key === "description" ? undefined : value,
        ),
      ),
      {
        type: "object",
        properties: {
          target: { type: "string", minLength: 1, maxLength: 2048 },
          offset: {
            anyOf: [{ type: "integer", minimum: 0, maximum: 9007199254740991 }, { type: "null" }],
          },
        },
        required: ["target"],
      },
    );
    let requests = 0;
    globalThis.fetch = async (url, init) => {
      requests++;
      assert.equal(
        String(url),
        "https://site.example.com/wiki/api/v2/pages/12345?body-format=view",
      );
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
        accept: "application/json",
        authorization: "Basic dGVzdEBleGFtcGxlLmNvbTp0ZXN0LXRva2Vu",
        "user-agent": "chum-bucket",
      });
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      assert.equal(init?.body, undefined);
      return Response.json(page());
    };
    assert.deepEqual(await execute({ target: " 12345 ", offset: null }), {
      id: "12345",
      title: "Operations guide",
      url: "https://site.example.com/wiki/pages/viewpage.action?pageId=12345",
      spaceId: "678",
      status: "current",
      version: { number: 7, createdAt: "2026-07-16T08:30:00.000Z" },
      bodyFormat: "html",
      body: ' \n<p>指南 🌊</p><table><tr><th>連結</th><td><a href="/wiki/pages/42?a=1&amp;b=2">資料</a></td></tr></table>\n',
      offset: 0,
      totalCharacters: 102,
      truncated: false,
      nextOffset: null,
    });
    assert.equal(requests, 1);
  });

  test("direct execution preserves IDs larger than MAX_SAFE_INTEGER as exact strings", async (t) => {
    mockConfluence(t);
    globalThis.fetch = async (url) => {
      assert.equal(
        String(url),
        "https://site.example.com/wiki/api/v2/pages/90071992547409931234567890?body-format=view",
      );
      return Response.json(page("<p>Exact ID</p>", "90071992547409931234567890"));
    };
    assert.deepEqual(await readConfluence.execute!({ target: " 90071992547409931234567890 " }), {
      id: "90071992547409931234567890",
      title: "Operations guide",
      url: "https://site.example.com/wiki/pages/viewpage.action?pageId=90071992547409931234567890",
      spaceId: "678",
      status: "current",
      version: { number: 7, createdAt: "2026-07-16T08:30:00.000Z" },
      bodyFormat: "html",
      body: "<p>Exact ID</p>",
      offset: 0,
      totalCharacters: 15,
      truncated: false,
      nextOffset: null,
    });
  });

  test("accepts canonical, legacy, and modern page URLs without fetching them", async (t) => {
    mockConfluence(t);
    for (const target of [
      "https://site.example.com/wiki/spaces/ENG/pages/12345/Operations+guide",
      "https://site.example.com/wiki/spaces/ENG/pages/12345",
      "https://site.example.com/wiki/spaces/ENG/pages/12345/",
      "https://site.example.com/wiki/spaces/ENG/pages/12345/操作手冊?ref=share#section",
      "https://site.example.com/wiki/pages/viewpage.action?pageId=12345",
      "https://site.example.com/wiki/pages/viewpage.action?ref=share&pageId=12345#section",
      "https://site.example.com/wiki/pages/12345",
      "https://site.example.com/wiki/pages/12345/",
      " https://site.example.com/wiki/pages/12345 ",
      "https://site.example.com/wiki/spaces/ENG/pages/90071992547409931234567890/Guide",
      "https://site.example.com/wiki/pages/viewpage.action?pageId=90071992547409931234567890",
    ]) {
      await t.test(target, async () => {
        const id = target.includes("90071992547409931234567890")
          ? "90071992547409931234567890"
          : "12345";
        globalThis.fetch = async (url) => {
          assert.equal(
            String(url),
            `https://site.example.com/wiki/api/v2/pages/${id}?body-format=view`,
          );
          return Response.json(page("", id));
        };
        const result = z
          .object({
            id: z.string(),
            url: z.string(),
            body: z.string(),
            totalCharacters: z.number(),
          })
          .parse(await execute({ target }));
        assert.deepEqual(result, {
          id,
          url: `https://site.example.com/wiki/pages/viewpage.action?pageId=${id}`,
          body: "",
          totalCharacters: 0,
        });
        assert.deepEqual(
          z
            .object({
              id: z.string(),
              url: z.string(),
              body: z.string(),
              totalCharacters: z.number(),
            })
            .parse(await readConfluence.execute!({ target })),
          {
            id,
            url: `https://site.example.com/wiki/pages/viewpage.action?pageId=${id}`,
            body: "",
            totalCharacters: 0,
          },
        );
      });
    }
  });

  test("reads CQBoG as page 409468937 through the public registry and direct execution", async (t) => {
    mockConfluence(t);
    process.env.JIRA_BASE_URL = "https://hismax-jira.atlassian.net/";
    let requests = 0;
    globalThis.fetch = async (url, init) => {
      requests++;
      assert.equal(
        String(url),
        "https://hismax-jira.atlassian.net/wiki/api/v2/pages/409468937?body-format=view",
      );
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Basic dGVzdEBleGFtcGxlLmNvbTp0ZXN0LXRva2Vu",
      );
      return Response.json(page("<p>Tiny page</p>", "409468937"));
    };
    const input = { target: "https://hismax-jira.atlassian.net/wiki/x/CQBoG" };
    for (const result of [await execute(input), await readConfluence.execute!(input)]) {
      assert.deepEqual(result, {
        id: "409468937",
        title: "Operations guide",
        url: "https://hismax-jira.atlassian.net/wiki/pages/viewpage.action?pageId=409468937",
        spaceId: "678",
        status: "current",
        version: { number: 7, createdAt: "2026-07-16T08:30:00.000Z" },
        bodyFormat: "html",
        body: "<p>Tiny page</p>",
        offset: 0,
        totalCharacters: 16,
        truncated: false,
        nextOffset: null,
      });
    }
    assert.equal(requests, 2);
  });

  test("decodes canonical tiny links to exact little-endian page IDs", async (t) => {
    mockConfluence(t);
    for (const { token, id } of [
      { token: "ZIAB", id: "98404" },
      { token: "0-TJU", id: "1355412691" },
      { token: "_w", id: "251" },
      { token: "-w", id: "255" },
      { token: "AQAAAAAAI", id: "9007199254740993" },
      { token: "CAcGBQQDAgE", id: "72623859790382856" },
      { token: "---------38", id: "9223372036854775807" },
      { token: "Q", id: "64" },
      { token: "AQ", id: "1" },
    ]) {
      await t.test(token, async () => {
        let requests = 0;
        globalThis.fetch = async (url) => {
          requests++;
          assert.equal(
            String(url),
            `https://site.example.com/wiki/api/v2/pages/${id}?body-format=view`,
          );
          return Response.json(page("<p>Exact ID</p>", id));
        };
        const input = { target: `https://site.example.com/wiki/x/${token}` };
        for (const result of [await execute(input), await readConfluence.execute!(input)]) {
          assert.deepEqual(
            z
              .object({
                id: z.string(),
                url: z.string(),
                body: z.string(),
                totalCharacters: z.number(),
              })
              .parse(result),
            {
              id,
              url: `https://site.example.com/wiki/pages/viewpage.action?pageId=${id}`,
              body: "<p>Exact ID</p>",
              totalCharacters: 15,
            },
          );
        }
        assert.equal(requests, 2);
      });
    }
  });

  test("accepts tiny-link query, fragment, whitespace, and one trailing slash without changing the ID", async (t) => {
    mockConfluence(t);
    for (const target of [
      "https://site.example.com/wiki/x/CQBoG/",
      "https://site.example.com/wiki/x/CQBoG?ref=share&pageId=12345",
      "https://site.example.com/wiki/x/CQBoG#section",
      "https://site.example.com/wiki/x/CQBoG/?ref=share&pageId=12345#section",
      " https://site.example.com/wiki/x/CQBoG ",
    ]) {
      await t.test(target, async () => {
        let requests = 0;
        globalThis.fetch = async (url) => {
          requests++;
          assert.equal(
            String(url),
            "https://site.example.com/wiki/api/v2/pages/409468937?body-format=view",
          );
          return Response.json(page("", "409468937"));
        };
        for (const result of [
          await execute({ target }),
          await readConfluence.execute!({ target }),
        ]) {
          assert.deepEqual(
            z.object({ id: z.string(), url: z.string(), body: z.string() }).parse(result),
            {
              id: "409468937",
              url: "https://site.example.com/wiki/pages/viewpage.action?pageId=409468937",
              body: "",
            },
          );
        }
        assert.equal(requests, 2);
      });
    }
  });

  test("rejects noncanonical, invalid, out-of-range, and untrusted tiny links before any request", async (t) => {
    mockConfluence(t);
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw new Error("Unexpected network request");
    };
    for (const target of [
      "https://site.example.com/wiki/x/A",
      "https://site.example.com/wiki/x/AAAAAAAAAAA",
      "https://site.example.com/wiki/x/CQBoGA",
      "https://site.example.com/wiki/x/CQBoGAAAAAA",
      "https://site.example.com/wiki/x/CQBoG=",
      "https://site.example.com/wiki/x/CQBoGAAAAAAA",
      "https://site.example.com/wiki/x/CQBoG+",
      "https://site.example.com/wiki/x/CQBoG!",
      "https://site.example.com/wiki/x/CQBoG.",
      "https://site.example.com/wiki/x/0/TJU",
      "https://site.example.com/wiki/x/%43QBoG",
      "https://site.example.com/wiki/x/CQBoG%3D",
      "https://site.example.com/wiki/x/%5Fw",
      "https://site.example.com/wiki/x/%2Fw",
      "https://site.example.com/wiki/x/%zz",
      "https://site.example.com/wiki/x/AQAAAAAAAAB",
      "https://site.example.com/wiki/x/---------39",
      "https://site.example.com/wiki/x/---------3_",
      "https://site.example.com/wiki/x/AAAAAAAAAI",
      "https://site.example.com/wiki/x/----------8",
      "https://site.example.com/wiki/x",
      "https://site.example.com/wiki/x/",
      "https://site.example.com/wiki/x/CQBoG/extra",
      "https://site.example.com/wiki/x/CQBoG//",
      "https://other.example.com/wiki/x/CQBoG",
      "http://site.example.com/wiki/x/CQBoG",
      "https://site.example.com:8443/wiki/x/CQBoG",
      "https://site.example.com.evil.test/wiki/x/CQBoG",
      "https://test@example.com:test-token@site.example.com/wiki/x/CQBoG",
      "https://test@example.com@site.example.com/wiki/x/CQBoG",
      "https://site.example.com/x/CQBoG",
      "https://site.example.com/wiki-other/x/CQBoG",
      "https://site.example.com/other/../wiki/x/CQBoG",
    ]) {
      await t.test(target, async () => {
        const expected = { name: "Error", message: TARGET_ERROR };
        await assert.rejects(() => execute({ target }), expected);
        await assert.rejects(async () => readConfluence.execute!({ target }), expected);
      });
    }
    assert.equal(requests, 0);
  });

  test("normalizes the Jira site root or /wiki base with trailing slashes", async (t) => {
    mockConfluence(t);
    for (const { jira, base } of [
      {
        jira: "https://site.example.com",
        base: "https://site.example.com/wiki",
      },
      {
        jira: "https://site.example.com////",
        base: "https://site.example.com/wiki",
      },
      {
        jira: "https://site.example.com/wiki/",
        base: "https://site.example.com/wiki",
      },
      {
        jira: "https://site.example.com/wiki////",
        base: "https://site.example.com/wiki",
      },
      {
        jira: "http://site.example.com:8080/",
        base: "http://site.example.com:8080/wiki",
      },
    ]) {
      await t.test(jira, async () => {
        process.env.JIRA_BASE_URL = jira;
        globalThis.fetch = async (url, init) => {
          assert.equal(String(url), `${base}/api/v2/pages/12345?body-format=view`);
          assert.equal(
            new Headers(init?.headers).get("Authorization"),
            "Basic dGVzdEBleGFtcGxlLmNvbTp0ZXN0LXRva2Vu",
          );
          return Response.json(page(""));
        };
        const result = z
          .object({ url: z.string(), offset: z.number(), body: z.string() })
          .parse(await execute({ target: `${base}/pages/12345` }));
        assert.deepEqual(result, {
          url: `${base}/pages/viewpage.action?pageId=12345`,
          offset: 0,
          body: "",
        });
      });
    }
  });

  test("preserves empty documents and permits absent documented version timestamps", async (t) => {
    mockConfluence(t);
    globalThis.fetch = async () => Response.json({ ...page(""), version: { number: 1 } });
    assert.deepEqual(await readConfluence.execute!({ target: "12345", offset: null }), {
      id: "12345",
      title: "Operations guide",
      url: "https://site.example.com/wiki/pages/viewpage.action?pageId=12345",
      spaceId: "678",
      status: "current",
      version: { number: 1 },
      bodyFormat: "html",
      body: "",
      offset: 0,
      totalCharacters: 0,
      truncated: false,
      nextOffset: null,
    });
    await assert.rejects(() => execute({ target: "12345", offset: 1 }), {
      name: "Error",
      message: "Confluence HTML offset exceeds the document length.",
    });
  });

  test("returns a complete 20000-character body and paginates the first extra character", async (t) => {
    mockConfluence(t);
    globalThis.fetch = async () => Response.json(page("x".repeat(20_000)));
    assert.deepEqual(chunkSchema.parse(await execute({ target: "12345" })), {
      body: "x".repeat(20_000),
      offset: 0,
      totalCharacters: 20_000,
      truncated: false,
      nextOffset: null,
    });
    globalThis.fetch = async () => Response.json(page(`${"x".repeat(20_000)}終`));
    assert.deepEqual(chunkSchema.parse(await execute({ target: "12345" })), {
      body: "x".repeat(20_000),
      offset: 0,
      totalCharacters: 20_001,
      truncated: true,
      nextOffset: 20_000,
    });
    assert.deepEqual(chunkSchema.parse(await execute({ target: "12345", offset: 20_000 })), {
      body: "終",
      offset: 20_000,
      totalCharacters: 20_001,
      truncated: true,
      nextOffset: null,
    });
  });

  test("nextOffset reconstructs all HTML exactly even across a Unicode surrogate boundary", async (t) => {
    mockConfluence(t);
    const body = `${"a".repeat(19_999)}🌊${"b".repeat(20_001)}終`;
    globalThis.fetch = async () => Response.json(page(body));
    const chunks: string[] = [];
    let offset: number | null = 0;
    for (const expected of [
      {
        body: `${"a".repeat(19_999)}\ud83c`,
        offset: 0,
        totalCharacters: 40_003,
        truncated: true,
        nextOffset: 20_000,
      },
      {
        body: `\udf0a${"b".repeat(19_999)}`,
        offset: 20_000,
        totalCharacters: 40_003,
        truncated: true,
        nextOffset: 40_000,
      },
      { body: "bb終", offset: 40_000, totalCharacters: 40_003, truncated: true, nextOffset: null },
    ]) {
      const chunk = chunkSchema.parse(
        JSON.parse(JSON.stringify(await execute({ target: "12345", offset }))),
      );
      assert.deepEqual(chunk, expected);
      chunks.push(chunk.body);
      offset = chunk.nextOffset;
    }
    assert.equal(chunks.join(""), `${"a".repeat(19_999)}🌊${"b".repeat(20_001)}終`);
    assert.equal(offset, null);
    assert.deepEqual(chunkSchema.parse(await execute({ target: "12345", offset: 40_003 })), {
      body: "",
      offset: 40_003,
      totalCharacters: 40_003,
      truncated: true,
      nextOffset: null,
    });
    await assert.rejects(() => execute({ target: "12345", offset: 40_004 }), {
      name: "Error",
      message: "Confluence HTML offset exceeds the document length.",
    });
  });

  test("offsets return exact HTML slices and reject invalid input before any request", async (t) => {
    mockConfluence(t);
    globalThis.fetch = async () => Response.json(page("<p>Text</p>"));
    assert.deepEqual(
      chunkSchema.parse(await readConfluence.execute!({ target: "12345", offset: 3 })),
      {
        body: "Text</p>",
        offset: 3,
        totalCharacters: 11,
        truncated: true,
        nextOffset: null,
      },
    );
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw new Error("Unexpected network request");
    };
    for (const input of [
      undefined,
      null,
      [],
      {},
      { target: null },
      { target: 12345 },
      { target: "" },
      { target: " \t\n " },
      { target: "1".repeat(2049) },
      { target: "12345", offset: -1 },
      { target: "12345", offset: 1.5 },
      { target: "12345", offset: "0" },
      { target: "12345", offset: NaN },
      { target: "12345", offset: Infinity },
      { target: "12345", offset: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await assert.rejects(() => execute(input), z.ZodError);
    }
    for (const target of ["", " \t\n ", "1".repeat(2049)]) {
      await assert.rejects(async () => readConfluence.execute!({ target }), z.ZodError);
    }
    for (const offset of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(
        async () => readConfluence.execute!({ target: "12345", offset }),
        z.ZodError,
      );
    }
    assert.equal(requests, 0);
  });

  test("rejects foreign, credentialed, unsupported, invalid-ID, and traversal targets before fetch", async (t) => {
    mockConfluence(t);
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw new Error("Unexpected network request");
    };
    for (const target of [
      "0",
      "-1",
      "1.5",
      "1e3",
      "012345",
      "abc",
      "../12345",
      "https://other.example.com/wiki/pages/12345",
      "http://site.example.com/wiki/pages/12345",
      "https://site.example.com:8443/wiki/pages/12345",
      "https://site.example.com.evil.test/wiki/pages/12345",
      "https://test@example.com:test-token@site.example.com/wiki/pages/12345",
      "https://test@example.com@site.example.com/wiki/pages/12345",
      "ftp://site.example.com/wiki/pages/12345",
      "/wiki/pages/12345",
      "https://site.example.com/pages/12345",
      "https://site.example.com/wiki-other/pages/12345",
      "https://site.example.com/wiki/api/v2/pages/12345",
      "https://site.example.com/wiki/display/ENG/Guide",
      "https://site.example.com/wiki/l/abc",
      "https://site.example.com/wiki/l/cp/abc",
      "https://site.example.com/wiki/pages/0",
      "https://site.example.com/wiki/pages/-1",
      "https://site.example.com/wiki/pages/12.5",
      "https://site.example.com/wiki/pages/%31%32%33%34%35",
      "https://site.example.com/wiki/spaces/ENG/pages/0/Guide",
      "https://site.example.com/wiki/spaces/ENG/pages/12345/Guide/extra",
      "https://site.example.com/wiki/spaces//pages/12345/Guide",
      "https://site.example.com/wiki/pages/viewpage.action",
      "https://site.example.com/wiki/pages/viewpage.action?pageId=0",
      "https://site.example.com/wiki/pages/viewpage.action?pageId=12345&pageId=54321",
      "https://site.example.com/wiki/pages/viewpage.action?pageId=12345%2Fsecret",
      "https://site.example.com/wiki/elsewhere?pageId=12345",
      "https://site.example.com/other/../wiki/pages/12345",
      "https://site.example.com/wiki/spaces/ENG/pages/12345/..",
      "https://site.example.com/wiki/spaces/ENG/pages/12345/%2e%2e",
      "https://site.example.com/wiki/spaces/ENG/pages/12345/Guide%2f..",
      "https://site.example.com/wiki/spaces/ENG/pages/12345/%2e",
      "https://site.example.com/wiki/spaces/ENG/pages/12345/%zz",
      "https://site.example.com/wiki\\pages\\12345",
      "https://site.example.com/wiki/pages/12\n345",
    ]) {
      await t.test(target, async () => {
        const expected = { name: "Error", message: TARGET_ERROR };
        await assert.rejects(() => execute({ target }), expected);
        await assert.rejects(async () => readConfluence.execute!({ target }), expected);
      });
    }
    assert.equal(requests, 0);
  });

  test("rejects missing shared credentials and invalid configuration without leaking values", async (t) => {
    mockConfluence(t);
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw new Error("Unexpected network request");
    };
    const expected = { name: "Error", message: CONFIG_ERROR };
    for (const name of ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] as const) {
      const original = process.env[name];
      delete process.env[name];
      await assert.rejects(() => execute({ target: "12345" }), expected);
      await assert.rejects(async () => readConfluence.execute!({ target: "12345" }), expected);
      process.env[name] = original;
    }
    for (const value of [
      "not a URL test-token",
      " ",
      "file:///wiki",
      "ftp://site.example.com/wiki",
      "https://test@example.com:test-token@site.example.com/wiki",
      "https://site.example.com/wiki?token=test-token",
      "https://site.example.com/wiki#test-token",
      "https://site.example.com/wiki?",
      "https://site.example.com/wiki#",
      "https://site.example.com/jira",
      "https://site.example.com/confluence",
      "https://api.atlassian.com/ex/confluence/cloud-id",
    ]) {
      await t.test(value, async () => {
        process.env.JIRA_BASE_URL = value;
        await assert.rejects(() => execute({ target: "12345" }), expected);
        await assert.rejects(async () => readConfluence.execute!({ target: "12345" }), expected);
      });
    }
    assert.equal(requests, 0);
  });

  test("reports numeric HTTP failures without status text, response bodies, or retries", async (t) => {
    mockConfluence(t);
    for (const status of [401, 403, 404, 429, 500, 302]) {
      await t.test(`HTTP ${status}`, async () => {
        let requests = 0;
        globalThis.fetch = async () => {
          requests++;
          return new Response("test-token secret response body", {
            status,
            statusText: "secret test-token",
            headers: { Location: "https://other.example.com/test-token" },
          });
        };
        await assert.rejects(() => execute({ target: "12345" }), {
          name: "Error",
          message: `Confluence Cloud request failed (HTTP ${status}).`,
        });
        assert.equal(requests, 1);
      });
    }
  });

  test("accepts only application/json and application subtypes with the +json suffix", async (t) => {
    mockConfluence(t);
    for (const contentType of [
      "APPLICATION/JSON; charset=utf-8",
      "application/problem+json",
      "application/vnd.atlassian.page+json",
    ]) {
      globalThis.fetch = async () =>
        Response.json(page(""), { headers: { "Content-Type": contentType } });
      assert.deepEqual(chunkSchema.parse(await execute({ target: "12345" })), {
        body: "",
        offset: 0,
        totalCharacters: 0,
        truncated: false,
        nextOffset: null,
      });
    }
    for (const contentType of [
      undefined,
      "text/html",
      "text/plain",
      "text/json",
      "application/notjson",
      "application/jsonp",
      "application/json, text/html",
      "application/+json",
    ]) {
      await t.test(contentType ?? "missing content type", async () => {
        globalThis.fetch = async () =>
          contentType === undefined
            ? new Response(null)
            : new Response("test-token", { headers: { "Content-Type": contentType } });
        await assert.rejects(() => execute({ target: "12345" }), {
          name: "Error",
          message: "Confluence Cloud returned a non-JSON response.",
        });
      });
    }
  });

  test("sanitizes malformed JSON and rejects missing or invalid selected page fields", async (t) => {
    mockConfluence(t);
    const expected = {
      name: "Error",
      message: "Confluence Cloud returned an invalid page response.",
    };
    globalThis.fetch = async () =>
      new Response('{"title":"test-token"', { headers: { "Content-Type": "application/json" } });
    await assert.rejects(() => execute({ target: "12345" }), expected);
    for (const { name, data } of [
      { name: "null page", data: null },
      { name: "array page", data: [] },
      { name: "missing id", data: { ...page(), id: undefined } },
      { name: "numeric id", data: { ...page(), id: 12345 } },
      { name: "zero id", data: { ...page(), id: "0" } },
      { name: "missing title", data: { ...page(), title: undefined } },
      { name: "invalid title", data: { ...page(), title: 1 } },
      { name: "missing status", data: { ...page(), status: undefined } },
      { name: "invalid status", data: { ...page(), status: null } },
      { name: "missing space id", data: { ...page(), spaceId: undefined } },
      { name: "numeric space id", data: { ...page(), spaceId: 678 } },
      { name: "missing version", data: { ...page(), version: undefined } },
      { name: "missing version number", data: { ...page(), version: { createdAt: "test-token" } } },
      { name: "invalid version number", data: { ...page(), version: { number: "test-token" } } },
      { name: "fractional version number", data: { ...page(), version: { number: 1.5 } } },
      { name: "invalid timestamp", data: { ...page(), version: { number: 1, createdAt: null } } },
      { name: "missing body", data: { ...page(), body: undefined } },
      { name: "missing view body", data: { ...page(), body: {} } },
      { name: "storage only", data: { ...page(), body: { storage: { value: "test-token" } } } },
      { name: "null view body", data: { ...page(), body: { view: null } } },
      { name: "missing view value", data: { ...page(), body: { view: {} } } },
      { name: "invalid view value", data: { ...page(), body: { view: { value: 123 } } } },
    ]) {
      await t.test(name, async () => {
        globalThis.fetch = async () => Response.json(data);
        await assert.rejects(() => execute({ target: "12345" }), expected);
      });
    }
  });

  test("rejects a mismatched response ID without exposing the returned ID", async (t) => {
    mockConfluence(t);
    globalThis.fetch = async () => Response.json(page("test-token", "90071992547409931234567891"));
    await assert.rejects(() => execute({ target: "90071992547409931234567890" }), {
      name: "Error",
      message: "Confluence Cloud returned a different page ID.",
    });
  });

  test("checks already aborted callers before fetch and replaces their private abort reasons", async (t) => {
    mockConfluence(t);
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw new Error("Unexpected network request");
    };
    for (const reason of [
      new Error("test-token secret abort reason"),
      new DOMException("test-token", "TimeoutError"),
    ]) {
      const caller = new AbortController();
      caller.abort(reason);
      const executionContext = { ...context, abortSignal: caller.signal };
      const expected = { name: "AbortError", message: "Confluence Cloud request cancelled." };
      await assert.rejects(() => execute({ target: "12345" }, executionContext), expected);
      await assert.rejects(
        async () => readConfluence.execute!({ target: "12345" }, executionContext),
        expected,
      );
    }
    assert.equal(requests, 0);
  });

  test("combines a 15000ms timeout with in-flight cancellation and preserves the first abort source", async (t) => {
    mockConfluence(t);
    for (const source of ["caller", "timeout"] as const) {
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
        const result = execute({ target: "12345" }, { ...context, abortSignal: caller.signal });
        await started.promise;
        const first = source === "caller" ? caller : timeout;
        const second = source === "caller" ? timeout : caller;
        first.abort(new Error("test-token private first abort"));
        second.abort(new Error("test-token private second abort"));
        await assert.rejects(result, {
          name: source === "caller" ? "AbortError" : "TimeoutError",
          message:
            source === "caller"
              ? "Confluence Cloud request cancelled."
              : "Confluence Cloud request timed out.",
        });
        assert.equal(requests, 1);
      });
    }
  });

  test("cancellation while consuming the JSON body remains a sanitized AbortError", async (t) => {
    mockConfluence(t);
    const caller = new AbortController();
    const started = Promise.withResolvers<void>();
    globalThis.fetch = async (_url, init) => {
      assert.ok(init?.signal);
      const signal = init.signal;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
        pull() {
          started.resolve();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "application/json" } });
    };
    const result = execute({ target: "12345" }, { ...context, abortSignal: caller.signal });
    await started.promise;
    caller.abort(new Error("test-token private body abort"));
    await assert.rejects(result, {
      name: "AbortError",
      message: "Confluence Cloud request cancelled.",
    });
  });

  test("sanitizes network and redirect errors without following targets or retrying", async (t) => {
    mockConfluence(t);
    for (const error of [
      new Error("https://test@example.com:test-token@site.example.com private network details"),
      new TypeError("Redirect to https://test@example.com:test-token@other.example.com"),
    ]) {
      let requests = 0;
      globalThis.fetch = async (_url, init) => {
        requests++;
        assert.equal(init?.redirect, "error");
        throw error;
      };
      await assert.rejects(async () => readConfluence.execute!({ target: "12345" }), {
        name: "Error",
        message: "Confluence Cloud request failed.",
      });
      assert.equal(requests, 1);
    }
  });
});
