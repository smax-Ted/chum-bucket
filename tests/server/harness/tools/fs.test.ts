import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { edit, read, write } from "../../../../server/harness/tools/fs";

const context = {
  toolCallId: "filesystem-call",
  abortSignal: new AbortController().signal,
  emitCustomEvent: () => {
    throw new Error("Unexpected custom event");
  },
};

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "chum-bucket-fs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function relativePath(...segments: string[]) {
  return relative(process.cwd(), join(...segments));
}

test("write, read, edit, and read again return matching content", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = relativePath(directory, "nested", "file.txt");
  assert.deepEqual(await write.execute!({ path, content: "before\nsame\n" }, context), {
    content: [{ type: "text", text: `Successfully wrote to ${path}` }],
    details: undefined,
  });
  assert.deepEqual(await read.execute!({ path }, context), {
    content: [{ type: "text", text: "before\nsame\n" }],
    details: undefined,
  });
  await edit.execute!({ path, edits: [{ oldText: "before", newText: "after" }] }, context);
  assert.equal(await readFile(path, "utf8"), "after\nsame\n");
  assert.deepEqual(await read.execute!({ path }, context), {
    content: [{ type: "text", text: "after\nsame\n" }],
    details: undefined,
  });
});

test("read starts at the 1-based offset", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = relativePath(directory, "lines.txt");
  await writeFile(path, "one\ntwo\nthree");
  assert.deepEqual(await read.execute!({ path, offset: 2, limit: 1 }, context), {
    content: [{ type: "text", text: "two\n\n[1 more lines in file. Use offset=3 to continue.]" }],
    details: undefined,
  });
});

test("rejected edits leave the file unchanged", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = relativePath(directory, "unchanged.txt");
  const original = "alpha\nrepeat\nrepeat\nomega\n";
  await writeFile(path, original);
  for (const { edits, error } of [
    { edits: [{ oldText: "missing", newText: "replacement" }], error: /Could not find/ },
    { edits: [{ oldText: "repeat", newText: "replacement" }], error: /2 occurrences/ },
    {
      edits: [
        { oldText: "alpha", newText: "changed" },
        { oldText: "alpha\nrepeat", newText: "overlap" },
      ],
      error: /overlap/,
    },
    {
      edits: [
        { oldText: "alpha", newText: "changed" },
        { oldText: "missing", newText: "replacement" },
      ],
      error: /Could not find/,
    },
  ]) {
    await assert.rejects(async () => edit.execute!({ path, edits }, context), error);
    assert.equal(await readFile(path, "utf8"), original);
  }
});

test("cancelled tools report Operation aborted and change nothing", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = relativePath(directory, "existing.txt");
  const newPath = relativePath(directory, "uncreated", "new.txt");
  await writeFile(path, "unchanged");
  const controller = new AbortController();
  controller.abort();
  const aborted = { ...context, abortSignal: controller.signal };
  await assert.rejects(async () => read.execute!({ path }, aborted), /Operation aborted/);
  await assert.rejects(
    async () => write.execute!({ path, content: "replacement" }, aborted),
    /Operation aborted/,
  );
  await assert.rejects(
    async () => write.execute!({ path: newPath, content: "new" }, aborted),
    /Operation aborted/,
  );
  await assert.rejects(
    async () =>
      edit.execute!({ path, edits: [{ oldText: "unchanged", newText: "changed" }] }, aborted),
    /Operation aborted/,
  );
  assert.equal(await readFile(path, "utf8"), "unchanged");
  await assert.rejects(access(dirname(newPath)), { code: "ENOENT" });
});

test("missing toolCallId fails before execution", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = relativePath(directory, "existing.txt");
  const newPath = relativePath(directory, "uncreated", "new.txt");
  await writeFile(path, "unchanged");
  const missingId = { abortSignal: context.abortSignal, emitCustomEvent: context.emitCustomEvent };
  await assert.rejects(async () => read.execute!({ path }, missingId), /Missing tool call ID/);
  await assert.rejects(
    async () => write.execute!({ path: newPath, content: "new" }, missingId),
    /Missing tool call ID/,
  );
  await assert.rejects(
    async () =>
      edit.execute!({ path, edits: [{ oldText: "unchanged", newText: "changed" }] }, missingId),
    /Missing tool call ID/,
  );
  assert.equal(await readFile(path, "utf8"), "unchanged");
  await assert.rejects(access(dirname(newPath)), { code: "ENOENT" });
});
