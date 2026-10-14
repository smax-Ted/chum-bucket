import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { z } from "zod";
import { getFigma } from "../../../../server/harness/tools/get-figma";

const resultSchema = z.looseObject({
  fileKey: z.string(),
  depth: z.number(),
  depthLimited: z.boolean(),
  truncated: z.boolean(),
  nodes: z.array(z.record(z.string(), z.unknown())),
  nextOffset: z.number().nullable().optional(),
  totalNodes: z.number().optional(),
});

type Input = { target: string; nodeId?: string; depth?: number; offset?: number };

async function execute(input: Input) {
  return resultSchema.parse(await getFigma.execute!({ depth: 2, offset: 0, ...input }));
}

function nodesResponse(id: string, document: unknown) {
  return Response.json({ nodes: { [id]: { document } } });
}

function largeDocument(count: number) {
  return {
    id: "1:2",
    name: "Large",
    type: "FRAME",
    children: Array.from({ length: count }, (_, i) => ({
      id: `2:${i}`,
      name: "界".repeat(1000),
      type: "TEXT",
      characters: "x".repeat(2000),
    })),
  };
}

describe("get_figma", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FIGMA_API_KEY;
  let requests: URL[] = [];

  beforeEach(() => {
    process.env.FIGMA_API_KEY = "test-key";
    requests = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.FIGMA_API_KEY;
    } else {
      process.env.FIGMA_API_KEY = originalKey;
    }
  });

  function mockFetch(handler: (url: URL, init?: RequestInit) => Response) {
    globalThis.fetch = async (url, init) => {
      const request = new URL(String(url));
      requests.push(request);
      return handler(request, init);
    };
  }

  describe("target parsing", () => {
    test("converts node-id from a design URL and requests the nodes endpoint", async () => {
      mockFetch((_url, init) => {
        assert.ok(init?.signal);
        assert.equal(new Headers(init.headers).get("X-Figma-Token"), "test-key");
        return nodesResponse("1:2", { id: "1:2", name: "Frame", type: "FRAME", children: [] });
      });
      const result = await execute({
        target: "https://www.figma.com/design/abc/Test?node-id=1-2",
      });
      assert.equal(requests[0].origin, "https://api.figma.com");
      assert.equal(requests[0].pathname, "/v1/files/abc/nodes");
      assert.equal(requests[0].searchParams.get("ids"), "1:2");
      assert.equal(requests[0].searchParams.get("depth"), "2");
      assert.equal(result.fileKey, "abc");
    });

    test("accepts a /file/ URL", async () => {
      mockFetch(() => Response.json({ document: { id: "0:0", name: "Doc", type: "DOCUMENT" } }));
      const result = await execute({ target: "https://figma.com/file/abc/Test" });
      assert.equal(requests[0].pathname, "/v1/files/abc");
      assert.equal(requests[0].searchParams.has("ids"), false);
      assert.equal(result.nodes[0].id, "0:0");
    });

    test("accepts a bare file key", async () => {
      mockFetch(() => Response.json({ document: { id: "0:0", name: "Doc", type: "DOCUMENT" } }));
      await execute({ target: "abc123" });
      assert.equal(requests[0].pathname, "/v1/files/abc123");
    });

    test("uses the branch key when the URL contains a branch", async () => {
      mockFetch(() => Response.json({ document: { id: "0:0", name: "Doc", type: "DOCUMENT" } }));
      const result = await execute({
        target: "https://www.figma.com/design/main1/branch/br2/Test",
      });
      assert.equal(requests[0].pathname, "/v1/files/br2");
      assert.equal(result.fileKey, "br2");
    });

    test("nodeId overrides the URL node-id and normalizes dashes", async () => {
      mockFetch(() =>
        nodesResponse("3:4", { id: "3:4", name: "Other", type: "FRAME", children: [] }),
      );
      await execute({ target: "https://www.figma.com/design/abc/Test?node-id=1-2", nodeId: "3-4" });
      assert.equal(requests[0].searchParams.get("ids"), "3:4");
    });

    test("passes depth to the API", async () => {
      mockFetch(() => Response.json({ document: { id: "0:0", name: "Doc", type: "DOCUMENT" } }));
      await execute({ target: "abc", depth: 5 });
      assert.equal(requests[0].searchParams.get("depth"), "5");
    });
  });

  describe("input schema", () => {
    const schema = getFigma.inputSchema as z.ZodType;

    test("applies defaults", () => {
      assert.deepEqual(schema.parse({ target: "abc" }), { target: "abc", depth: 2, offset: 0 });
    });

    test("rejects out-of-range depth and offset", () => {
      assert.equal(schema.safeParse({ target: "abc", depth: 0 }).success, false);
      assert.equal(schema.safeParse({ target: "abc", depth: 11 }).success, false);
      assert.equal(schema.safeParse({ target: "abc", depth: 1.5 }).success, false);
      assert.equal(schema.safeParse({ target: "abc", offset: -1 }).success, false);
      assert.equal(schema.safeParse({ target: "abc", offset: 1.5 }).success, false);
    });
  });

  describe("node filtering", () => {
    test("removes hidden nodes and unlisted fields while keeping layout and style", async () => {
      mockFetch(() =>
        nodesResponse("1:2", {
          id: "1:2",
          name: "Frame",
          type: "FRAME",
          unused: "discard",
          layoutMode: "HORIZONTAL",
          absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 20 },
          fills: [{ type: "SOLID" }],
          children: [
            { id: "1:3", name: "Text", type: "TEXT", characters: "Hello", style: { fontSize: 12 } },
            {
              id: "1:4",
              name: "Hidden",
              type: "FRAME",
              visible: false,
              children: [{ id: "1:5", name: "Inner", type: "TEXT" }],
            },
          ],
        }),
      );
      const result = await execute({ target: "abc", nodeId: "1:2" });
      assert.deepEqual(result.nodes, [
        {
          id: "1:2",
          name: "Frame",
          type: "FRAME",
          layoutMode: "HORIZONTAL",
          absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 20 },
          fills: [{ type: "SOLID" }],
          children: [
            { id: "1:3", name: "Text", type: "TEXT", characters: "Hello", style: { fontSize: 12 } },
          ],
        },
      ]);
    });

    test("returns no nodes when the root is hidden", async () => {
      mockFetch(() =>
        nodesResponse("1:2", { id: "1:2", name: "Hidden", type: "FRAME", visible: false }),
      );
      const result = await execute({ target: "abc", nodeId: "1:2" });
      assert.deepEqual(result.nodes, []);
      assert.equal(result.depthLimited, false);
    });
  });

  describe("depth limit flag", () => {
    test("is true when a container at the depth limit has no children", async () => {
      mockFetch(() =>
        nodesResponse("1:2", {
          id: "1:2",
          name: "Root",
          type: "FRAME",
          children: [{ id: "1:3", name: "Child", type: "FRAME" }],
        }),
      );
      const result = await execute({ target: "abc", nodeId: "1:2", depth: 1 });
      assert.equal(result.depthLimited, true);
      assert.equal(result.truncated, false);
    });

    test("is false when the tree is fully returned", async () => {
      mockFetch(() =>
        nodesResponse("1:2", {
          id: "1:2",
          name: "Root",
          type: "FRAME",
          children: [{ id: "1:3", name: "Text", type: "TEXT", characters: "a" }],
        }),
      );
      const result = await execute({ target: "abc", nodeId: "1:2", depth: 1 });
      assert.equal(result.depthLimited, false);
    });
  });

  describe("oversized results", () => {
    test("returns a first page of 20 summaries with nextOffset", async () => {
      mockFetch(() => nodesResponse("1:2", largeDocument(25)));
      const result = await execute({ target: "abc", nodeId: "1:2" });
      assert.equal(result.truncated, true);
      assert.equal(result.nodes.length, 20);
      assert.equal(result.nextOffset, 20);
      assert.equal(result.totalNodes, 26);
      assert.deepEqual(Object.keys(result.nodes[0]).toSorted(), ["id", "name", "type"]);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 30_000);
    });

    test("returns the remaining summaries on the next page with null nextOffset", async () => {
      mockFetch(() => nodesResponse("1:2", largeDocument(25)));
      const result = await execute({ target: "abc", nodeId: "1:2", offset: 20 });
      assert.equal(result.truncated, true);
      assert.equal(result.nodes.length, 6);
      assert.equal(result.nextOffset, null);
    });

    test("excludes hidden nodes from the summary total", async () => {
      const document = largeDocument(25);
      document.children[0] = { ...document.children[0], visible: false } as never;
      mockFetch(() => nodesResponse("1:2", document));
      const result = await execute({ target: "abc", nodeId: "1:2" });
      assert.equal(result.totalNodes, 25);
    });

    test("keeps truncated false below the byte limit", async () => {
      mockFetch(() => nodesResponse("1:2", largeDocument(2)));
      const result = await execute({ target: "abc", nodeId: "1:2" });
      assert.equal(result.truncated, false);
      assert.equal(result.nextOffset, undefined);
    });
  });

  describe("errors", () => {
    test("rejects when FIGMA_API_KEY is missing", async () => {
      delete process.env.FIGMA_API_KEY;
      await assert.rejects(() => execute({ target: "abc" }), /FIGMA_API_KEY/);
    });

    test("rejects non-figma.com URLs without calling fetch", async () => {
      mockFetch(() => Response.json({}));
      await assert.rejects(() => execute({ target: "https://evil.test/design/abc" }), /Figma URL/);
      await assert.rejects(
        () => execute({ target: "https://figma.com.evil.test/design/abc" }),
        /Figma URL/,
      );
      assert.equal(requests.length, 0);
    });

    test("rejects unsupported Figma URL paths", async () => {
      mockFetch(() => Response.json({}));
      await assert.rejects(
        () => execute({ target: "https://www.figma.com/board/abc" }),
        /file or design/,
      );
    });

    test("rejects invalid file keys and node IDs", async () => {
      mockFetch(() => Response.json({}));
      await assert.rejects(() => execute({ target: "abc/../x" }), /file key/);
      await assert.rejects(() => execute({ target: "abc", nodeId: "nope" }), /node ID/);
      assert.equal(requests.length, 0);
    });

    test("reports only the HTTP status without leaking key or body", async () => {
      mockFetch(() => new Response("secret-body test-key", { status: 403 }));
      await assert.rejects(
        () => execute({ target: "abc" }),
        (error: Error) => {
          assert.match(error.message, /403/);
          assert.doesNotMatch(error.message, /secret-body|test-key/);
          return true;
        },
      );
    });

    test("rejects non-JSON responses", async () => {
      mockFetch(() => new Response("<html>", { headers: { "content-type": "text/html" } }));
      await assert.rejects(() => execute({ target: "abc" }), /non-JSON/);
    });

    test("rejects JSON content type with an invalid body", async () => {
      mockFetch(() => new Response("{oops", { headers: { "content-type": "application/json" } }));
      await assert.rejects(() => execute({ target: "abc" }), /non-JSON/);
    });

    test("rejects when the node is not found", async () => {
      mockFetch(() => Response.json({ nodes: { "1:2": null } }));
      await assert.rejects(() => execute({ target: "abc", nodeId: "1:2" }), /not found/);
    });
  });
});
