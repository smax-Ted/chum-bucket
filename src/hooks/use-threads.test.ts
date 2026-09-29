import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createThread, terminalResult } from "./use-threads";

const threadId = "d08035f1-07df-49f3-b2d0-5cf5cb2b1e74";
const runId = "run-recovery-test";

test("creation is empty and never sends chat", async () => {
  const requests: unknown[] = [];
  const mocked = mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));

      return Response.json({ id: threadId, title: "新對話" });
    },
  );

  try {
    assert.deepEqual(await createThread(), { id: threadId, title: "新對話" });
    assert.deepEqual(requests, [{}]);
  } finally {
    mocked.mock.restore();
  }
});

test("only a matching durable terminal unlocks the current run", () => {
  assert.equal(terminalResult({ type: "RUN_FINISHED", runId }, runId), "succeeded");
  assert.equal(
    terminalResult({ type: "RUN_ERROR", metadata: { tanstack: { runId } } }, runId),
    "failed",
  );

  for (const event of [
    { type: "RUN_FINISHED", runId: "other" },
    { type: "RUN_ERROR" },
    { type: "RUN_FINISHED", runId, finishReason: "tool_calls" },
    { type: "RUN_FINISHED", runId, metadata: { tanstack: { finishReason: "tool_calls" } } },
    { type: "TEXT_MESSAGE_END", runId },
    null,
  ]) {
    assert.equal(terminalResult(event, runId), null);
  }
});
