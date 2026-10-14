import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";
import { edit, read, write } from "./fs";

let dir: string;
let callIndex = 0;

function context(signal?: AbortSignal) {
  callIndex += 1;
  return {
    toolCallId: `call-${callIndex}`,
    abortSignal: signal,
    emitCustomEvent: () => undefined,
  } as never;
}

function call(tool: typeof read, args: Record<string, unknown>, ctx: unknown = context()) {
  return tool.execute!(args as never, ctx as never) as Promise<{
    content: { type: string; text?: string }[];
    details?: unknown;
  }>;
}

function text(result: { content: { type: string; text?: string }[] }) {
  return result.content.map((part) => part.text ?? "").join("");
}

function target(name: string) {
  return relative(process.cwd(), join(dir, name));
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "chum-fs-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("write, read, edit and read again round-trip the content", async () => {
  const path = target("nested/note.txt");

  await call(write, { path, content: "alpha\nbeta\ngamma\n" });
  assert.equal(await readFile(join(dir, "nested/note.txt"), "utf8"), "alpha\nbeta\ngamma\n");

  assert.match(text(await call(read, { path })), /alpha\nbeta\ngamma/);
  assert.match(text(await call(read, { path, offset: 2, limit: 1 })), /beta/);

  const edited = await call(edit, { path, edits: [{ oldText: "beta", newText: "BETA" }] });

  assert.ok(edited.details);
  assert.equal(await readFile(join(dir, "nested/note.txt"), "utf8"), "alpha\nBETA\ngamma\n");
  assert.match(text(await call(read, { path })), /alpha\nBETA\ngamma/);
});

test("a failing edit leaves the file untouched", async () => {
  const file = join(dir, "same.txt");
  const path = target("same.txt");
  await writeFile(file, "one\ntwo\ntwo\n");

  await assert.rejects(call(edit, { path, edits: [{ oldText: "missing", newText: "x" }] }));
  await assert.rejects(call(edit, { path, edits: [{ oldText: "two", newText: "x" }] }));
  await assert.rejects(
    call(edit, {
      path,
      edits: [
        { oldText: "one\ntwo", newText: "a" },
        { oldText: "two\ntwo", newText: "b" },
      ],
    }),
  );

  assert.equal(await readFile(file, "utf8"), "one\ntwo\ntwo\n");
});

test("an aborted signal stops all three tools without touching disk", async () => {
  const file = join(dir, "keep.txt");
  await writeFile(file, "original\n");
  const signal = AbortSignal.abort();

  await assert.rejects(call(read, { path: target("keep.txt") }, context(signal)), {
    message: "Operation aborted",
  });
  await assert.rejects(
    call(write, { path: target("aborted/new.txt"), content: "x" }, context(signal)),
    { message: "Operation aborted" },
  );
  await assert.rejects(
    call(
      edit,
      { path: target("keep.txt"), edits: [{ oldText: "original", newText: "changed" }] },
      context(signal),
    ),
    { message: "Operation aborted" },
  );

  assert.equal(await readFile(file, "utf8"), "original\n");
  assert.equal(existsSync(join(dir, "aborted")), false);
});

test("tools fail before running when toolCallId is missing", async () => {
  const noId = { emitCustomEvent: () => undefined };

  await assert.rejects(
    call(write, { path: target("no-id/file.txt"), content: "x" }, noId),
    /toolCallId/,
  );
  await assert.rejects(call(read, { path: target("keep.txt") }, noId), /toolCallId/);
  await assert.rejects(
    call(edit, { path: target("keep.txt"), edits: [{ oldText: "a", newText: "b" }] }, noId),
    /toolCallId/,
  );

  assert.equal(existsSync(join(dir, "no-id")), false);
});
