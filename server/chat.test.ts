import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { db } from "./db";

process.env.MODEL_API_KEY = "offline-unused";
const { default: app } = await import("./chat");

test("chat hydration validates the URL and returns saved history without starting a run", async () => {
  const network = mock.method(globalThis, "fetch", async () => {
    throw new Error("Network disabled");
  });
  const messages = [{ id: "old", role: "user", parts: [{ type: "text", content: "舊訊息" }] }];
  let rows: unknown[] = [{ messages }];
  const select = mock.method(
    db,
    "select",
    () =>
      ({
        from: () => ({ where: async () => rows }),
      }) as unknown as ReturnType<typeof db.select>,
  );
  try {
    assert.equal((await app.request("/?threadId=invalid")).status, 400);
    const url = "/?threadId=d08035f1-07df-49f3-b2d0-5cf5cb2b1e74";
    assert.deepEqual(await (await app.request(url)).json(), { messages, activeRun: null });
    rows = [];
    assert.equal((await app.request(url)).status, 404);
  } finally {
    select.mock.restore();
    network.mock.restore();
  }
});
