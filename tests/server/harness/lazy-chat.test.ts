import assert from "node:assert/strict";
import { test } from "node:test";
import { chat, maxIterations, type StreamChunk } from "@tanstack/ai";
import { localTools } from "../../../server/harness/tools";
import { openAtlassianTools } from "../../../server/harness/tools/atlassian";
import { readAtlassianConfiguration } from "../../../server/harness/tools/atlassian-policy";
import { mcpFixture, withMcpEnvironment } from "../../fixtures/mcp-fixture";

type Adapter = Parameters<typeof chat>[0]["adapter"];
type Step = { tool: string; input: Record<string, unknown> } | { text: string };
type Request = {
  tools: { name: string; description: string; inputSchema?: unknown }[];
  messages: unknown[];
};

function scriptedAdapter(steps: Step[]) {
  const requests: Request[] = [];
  let turn = 0;
  const adapter = {
    kind: "text",
    name: "scripted",
    model: "scripted",
    "~types": {},
    async *chatStream(options: { tools?: Request["tools"]; messages: unknown[] }) {
      requests.push({ tools: options.tools ?? [], messages: structuredClone(options.messages) });
      const step = steps[turn++];
      const base = { model: "scripted", timestamp: Date.now() };
      yield { ...base, type: "RUN_STARTED", runId: `run-${turn}`, threadId: "thread" };
      if ("tool" in step) {
        const id = `call-${turn}`;
        const args = JSON.stringify(step.input);
        yield {
          ...base,
          type: "TOOL_CALL_START",
          toolCallId: id,
          toolCallName: step.tool,
          toolName: step.tool,
          index: 0,
        };
        yield { ...base, type: "TOOL_CALL_ARGS", toolCallId: id, delta: args };
        yield {
          ...base,
          type: "TOOL_CALL_END",
          toolCallId: id,
          toolCallName: step.tool,
          toolName: step.tool,
          input: step.input,
        };
        yield {
          ...base,
          type: "RUN_FINISHED",
          runId: `run-${turn}`,
          threadId: "thread",
          finishReason: "tool_calls",
        };
        return;
      }
      yield { ...base, type: "TEXT_MESSAGE_START", messageId: `m-${turn}`, role: "assistant" };
      yield {
        ...base,
        type: "TEXT_MESSAGE_CONTENT",
        messageId: `m-${turn}`,
        delta: step.text,
        content: step.text,
      };
      yield { ...base, type: "TEXT_MESSAGE_END", messageId: `m-${turn}` };
      yield {
        ...base,
        type: "RUN_FINISHED",
        runId: `run-${turn}`,
        threadId: "thread",
        finishReason: "stop",
      };
    },
    async structuredOutput() {
      throw new Error("Unused");
    },
  };
  return { adapter: adapter as unknown as Adapter, requests };
}

type ChatMessages = Parameters<typeof chat>[0]["messages"];

async function runChat(steps: Step[], message: string, history: ChatMessages = []) {
  const { adapter, requests } = scriptedAdapter(steps);
  const controller = new AbortController();
  const remote = await openAtlassianTools(
    readAtlassianConfiguration(process.env),
    controller.signal,
  );
  const chunks: StreamChunk[] = [];
  try {
    for await (const chunk of chat({
      adapter,
      messages: [...history, { role: "user", content: message }],
      tools: [...localTools, ...remote.tools],
      agentLoopStrategy: maxIterations(8),
      abortController: controller,
    })) {
      chunks.push(chunk);
    }
  } finally {
    await remote.close();
  }
  return { requests, chunks };
}

const names = (request: Request) => request.tools.map((tool) => tool.name);
const toolResults = (chunks: StreamChunk[]) =>
  chunks.filter((chunk) => chunk.type === "TOOL_CALL_RESULT") as (StreamChunk & {
    toolCallId: string;
    content: string;
  })[];

test("discovery adds the native Jira schema on the next model turn before the call", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      const { requests, chunks } = await runChat(
        [
          { tool: "__lazy__tool__discovery__", input: { toolNames: ["jira_get_issue"] } },
          { tool: "jira_get_issue", input: { issue_key: "PROJ-1" } },
          { text: "PROJ-1 read" },
        ],
        "Read PROJ-1",
      );

      assert.equal(requests.length, 3);
      assert.deepEqual(names(requests[0]), [
        "get_figma",
        "read",
        "write",
        "edit",
        "__lazy__tool__discovery__",
      ]);
      const discovery = requests[0].tools.at(-1)!;
      for (const tool of ["jira_get_issue", "confluence_get_page", "confluence_search"]) {
        assert.match(discovery.description, new RegExp(tool));
      }
      assert.doesNotMatch(JSON.stringify(discovery), /issue_key/);

      assert.ok(names(requests[1]).includes("jira_get_issue"));
      assert.ok(!names(requests[1]).includes("confluence_get_page"));

      assert.equal(fixture.calls().length, 1);
      assert.equal(fixture.calls()[0].message.params?.arguments?.update_history, false);
      assert.match(JSON.stringify(requests[2].messages), /PROJ-1/);
      assert.ok(chunks.some((chunk) => chunk.type === "TEXT_MESSAGE_CONTENT"));
    },
    true,
    fixture,
  );
});

test("an undiscovered lazy tool is rejected without reaching the MCP server", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      const { chunks } = await runChat(
        [{ tool: "confluence_get_page", input: { page_id: "1" } }, { text: "done" }],
        "Read page 1",
      );
      const [result] = toolResults(chunks);
      assert.match(result.content, /must be discovered first/);
      assert.equal(fixture.calls().length, 0);
    },
    true,
    fixture,
  );
});

test("each chat run opens its own MCP session and discovery starts over", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      await runChat(
        [
          { tool: "__lazy__tool__discovery__", input: { toolNames: ["jira_get_issue"] } },
          { text: "discovered" },
        ],
        "first",
      );
      const { requests } = await runChat([{ text: "second" }], "second");
      assert.equal(fixture.sessions.length, 2);
      assert.ok(!names(requests[0]).includes("jira_get_issue"));
    },
    true,
    fixture,
  );
});

test("a later turn reuses discoveries recorded in the message history", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      const history: ChatMessages = [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "discovery-1",
              type: "function",
              function: {
                name: "__lazy__tool__discovery__",
                arguments: JSON.stringify({ toolNames: ["jira_get_issue"] }),
              },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "discovery-1",
          content: JSON.stringify({ tools: [{ name: "jira_get_issue" }] }),
        },
        { role: "assistant", content: "discovered" },
      ];
      const { requests } = await runChat(
        [{ tool: "jira_get_issue", input: { issue_key: "PROJ-2" } }, { text: "done" }],
        "second",
        history,
      );
      assert.ok(names(requests[0]).includes("jira_get_issue"));
      assert.equal(fixture.calls().length, 1);
    },
    true,
    fixture,
  );
});
