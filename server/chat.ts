import {
  chat,
  chatParamsFromRequestBody,
  maxIterations,
  modelMessagesToUIMessages,
  toServerSentEventsResponse,
  type ChatMiddleware,
} from "@tanstack/ai";
import { deepinfra } from "@server/harness/provider";
import { openuiInstructions } from "@server/harness/prompts";
import { Hono } from "hono";
import { db } from "./db";
import { threadsTable } from "./db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getFigma } from "./harness/tools/get-figma";
import { edit, read, write } from "./harness/tools/fs";
import { resolveAtlassianConfig } from "./harness/tools/atlassian-policy";
import { openAtlassianTools, type AtlassianTools } from "./harness/tools/atlassian";

const localTools = [getFigma, read, write, edit];

const app = new Hono();

const updateChatMessage: ChatMiddleware = {
  name: "updateChatMessage",
  onFinish: async (context) => {
    const messages = modelMessagesToUIMessages([...context.messages]);
    const title =
      messages
        .find((message) => message.role === "user")
        ?.parts.filter((part) => part.type === "text")
        .map((part) => part.content)
        .join("")
        .slice(0, 10) || "新對話";
    await db
      .update(threadsTable)
      .set({ messages, title, updated_at: new Date() })
      .where(eq(threadsTable.id, context.threadId));
  },
};

app.get("/", async (c) => {
  const threadId = c.req.query("threadId");

  if (!z.uuid().safeParse(threadId).success) {
    return c.json({ error: "Invalid thread id" }, 400);
  }

  const [thread] = await db
    .select({ messages: threadsTable.messages })
    .from(threadsTable)
    .where(eq(threadsTable.id, threadId!));

  return thread ? c.json({ messages: thread.messages, activeRun: null }) : c.notFound();
});

app.post("/", async (c) => {
  const payload = await chatParamsFromRequestBody(await c.req.json());
  const request = c.req.raw.signal;
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  request.addEventListener("abort", abort, { once: true });

  async function* stream() {
    let remote: AtlassianTools | undefined;

    try {
      const config = resolveAtlassianConfig(process.env);
      remote = config ? await openAtlassianTools(config, abortController.signal) : undefined;
      yield* chat({
        adapter: deepinfra("deepseek-ai/DeepSeek-V4.1-Flash"),
        systemPrompts: [openuiInstructions()],
        messages: payload.messages,
        threadId: payload.threadId,
        runId: payload.runId,
        middleware: [updateChatMessage],
        tools: [...localTools, ...(remote?.tools ?? [])],
        agentLoopStrategy: maxIterations(8),
        abortController,
      });
    } finally {
      request.removeEventListener("abort", abort);
      await remote?.close();
    }
  }

  return toServerSentEventsResponse(stream(), { abortController });
});

export default app;
