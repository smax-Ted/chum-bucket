import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { getFigma, parseFigmaTarget } from "./getFigma";

const FILE_KEY = "AbCdEf1234567890";
const originalFetch = globalThis.fetch;
const originalKey = process.env.FIGMA_API_KEY;
let requests: { url: string; token: string | null }[] = [];

function mockFetch(respond: (url: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, token: new Headers(init?.headers).get("X-Figma-Token") });
    return respond(url);
  }) as typeof fetch;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function run(args: Record<string, unknown>) {
  return getFigma.execute!(
    args as never,
    {
      toolCallId: "call-1",
      emitCustomEvent: () => undefined,
    } as never,
  ) as Promise<Record<string, any>>;
}

beforeEach(() => {
  requests = [];
  process.env.FIGMA_API_KEY = "figma-test-token";
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalKey === undefined) {
    delete process.env.FIGMA_API_KEY;
  } else {
    process.env.FIGMA_API_KEY = originalKey;
  }
});

test("parses file keys, /file/ and /design/ URLs, branches and node IDs", () => {
  assert.deepEqual(parseFigmaTarget(FILE_KEY), { fileKey: FILE_KEY, nodeId: null });
  assert.deepEqual(parseFigmaTarget(`https://www.figma.com/file/${FILE_KEY}/Name?node-id=1-2`), {
    fileKey: FILE_KEY,
    nodeId: "1:2",
  });
  assert.deepEqual(
    parseFigmaTarget(`https://www.figma.com/design/${FILE_KEY}/branch/BranchKey12345/Name`),
    { fileKey: "BranchKey12345", nodeId: null },
  );
  assert.deepEqual(
    parseFigmaTarget(`https://figma.com/design/${FILE_KEY}/Name?node-id=1-2`, "3-4"),
    { fileKey: FILE_KEY, nodeId: "3:4" },
  );
  assert.throws(() => parseFigmaTarget(`https://evil.com/file/${FILE_KEY}`), /figma\.com/);
  assert.throws(() => parseFigmaTarget(`https://www.figma.com/board/${FILE_KEY}`), /Invalid/);
  assert.throws(() => parseFigmaTarget("not a key"), /Invalid/);
  assert.throws(() => parseFigmaTarget(FILE_KEY, "abc"), /node ID/);
});

test("fetches a specific node, keeps text, size, layout and style, and drops hidden nodes", async () => {
  mockFetch(() =>
    json({
      name: "Design",
      lastModified: "2026-10-14T00:00:00Z",
      nodes: {
        "1:2": {
          document: {
            id: "1:2",
            name: "Card",
            type: "FRAME",
            absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 200 },
            layoutMode: "VERTICAL",
            itemSpacing: 8,
            fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
            children: [
              {
                id: "1:3",
                name: "Title",
                type: "TEXT",
                characters: "Hello",
                style: { fontFamily: "Inter", fontSize: 16 },
              },
              { id: "1:4", name: "Hidden", type: "RECTANGLE", visible: false },
            ],
          },
        },
      },
    }),
  );

  const result = await run({ target: `https://www.figma.com/design/${FILE_KEY}/X?node-id=1-2` });

  assert.equal(
    requests[0]?.url,
    `https://api.figma.com/v1/files/${FILE_KEY}/nodes?ids=1%3A2&depth=2`,
  );
  assert.equal(requests[0]?.token, "figma-test-token");
  assert.equal(result.truncated, false);
  assert.equal(result.depthLimited, false);
  assert.equal(result.document.size.width, 320);
  assert.equal(result.document.layout.layoutMode, "VERTICAL");
  assert.deepEqual(result.document.style.fills, [{ type: "SOLID", color: "#ff0000" }]);
  assert.equal(result.document.children.length, 1);
  assert.equal(result.document.children[0].text, "Hello");
  assert.equal(result.document.children[0].style.text.fontFamily, "Inter");
});

test("marks depth-limited results", async () => {
  mockFetch(() =>
    json({
      name: "Design",
      document: {
        id: "0:0",
        type: "DOCUMENT",
        children: [{ id: "0:1", name: "Page", type: "CANVAS" }],
      },
    }),
  );

  const result = await run({ target: FILE_KEY, depth: 1 });

  assert.equal(requests[0]?.url, `https://api.figma.com/v1/files/${FILE_KEY}?depth=1`);
  assert.equal(result.depthLimited, true);
  assert.equal(result.truncated, false);
});

test("returns a paged summary when the detail is too large", async () => {
  const children = Array.from({ length: 300 }, (_, index) => ({
    id: `2:${index}`,
    name: `Layer ${index} ${"x".repeat(100)}`,
    type: "RECTANGLE",
  }));
  mockFetch(() => json({ name: "Big", document: { id: "0:0", type: "DOCUMENT", children } }));

  const first = await run({ target: FILE_KEY });

  assert.equal(first.truncated, true);
  assert.equal(first.document, undefined);
  assert.equal(first.summary.total, 301);
  assert.equal(first.summary.nodes.length, 20);
  assert.equal(first.summary.nextOffset, 20);

  const last = await run({ target: FILE_KEY, offset: 300 });

  assert.equal(last.summary.nodes.length, 1);
  assert.equal(last.summary.nextOffset, null);
});

test("reports short errors without leaking the token or response body", async () => {
  delete process.env.FIGMA_API_KEY;
  await assert.rejects(run({ target: FILE_KEY }), /FIGMA_API_KEY/);

  process.env.FIGMA_API_KEY = "figma-test-token";
  mockFetch(() => new Response("secret body", { status: 403 }));
  await assert.rejects(run({ target: FILE_KEY }), (error: Error) => {
    assert.equal(error.message, "Figma API request failed (HTTP 403)");
    return true;
  });

  mockFetch(() => new Response("<html>", { status: 200 }));
  await assert.rejects(run({ target: FILE_KEY }), /non-JSON/);

  mockFetch(() => json({ nodes: { "9:9": null } }));
  await assert.rejects(run({ target: FILE_KEY, nodeId: "9:9" }), /not found/);

  await assert.rejects(run({ target: "https://example.com/file/abc" }), /figma\.com/);
  await assert.rejects(run({ target: FILE_KEY, depth: 11 }));
});
