import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chat,
  DISCOVERY_TOOL_NAME,
  EventType,
  maxIterations,
  toolDefinition,
  type StreamChunk,
} from "@tanstack/ai";
import { z } from "zod";
import { openAtlassianTools } from "../../../server/harness/tools/atlassian";
import { resolveAtlassianConfig } from "../../../server/harness/tools/atlassian-policy";
import { fixtureTool, startMcpFixture } from "../../fixtures/mcp-fixture";

type Request = {
  tools: { name: string; description: string; inputSchema?: unknown }[];
  messages: { role: string; content: unknown; toolCalls?: unknown }[];
};

type Call = { id: string; name: string; input: Record<string, unknown> };
type Turn = (request: Request) => Call[] | string;

const localEcho = toolDefinition({
  name: "local_echo",
  description: "Local echo",
  inputSchema: z.object({ text: z.string() }),
}).server(async ({ text }) => ({ text }));

function configFor() {
  const config = resolveAtlassianConfig({
    JIRA_BASE_URL: "https://team.atlassian.net",
    JIRA_EMAIL: "dev@example.com",
    JIRA_API_TOKEN: "fake-token-abc",
    ATLASSIAN_MCP_URL: process.env.ATLASSIAN_MCP_URL,
  });
  assert.ok(config);
  return config;
}

function fakeAdapter(turns: Turn[], requests: Request[]) {
  return {
    kind: "text" as const,
    name: "fake",
    model: "fake",
    "~types": {},
    structuredOutput: async () => {
      throw new Error("Unexpected structured output");
    },
    chatStream: async function* (options: Request) {
      requests.push({ tools: options.tools ?? [], messages: options.messages });
      const outcome = turns[requests.length - 1]!(requests.at(-1)!);
      const base = { timestamp: Date.now(), threadId: "t", runId: "r" };
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId: `m${requests.length}`,
        role: "assistant",
        ...base,
      };
      if (typeof outcome === "string") {
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: `m${requests.length}`,
          delta: outcome,
          ...base,
        };
        yield { type: EventType.TEXT_MESSAGE_END, messageId: `m${requests.length}`, ...base };
        yield { type: EventType.RUN_FINISHED, finishReason: "stop", ...base };
        return;
      }
      for (const call of outcome) {
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId: call.id,
          toolCallName: call.name,
          ...base,
        };
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: call.id,
          delta: JSON.stringify(call.input),
          ...base,
        };
        yield { type: EventType.TOOL_CALL_END, toolCallId: call.id, input: call.input, ...base };
      }
      yield { type: EventType.RUN_FINISHED, finishReason: "tool_calls", ...base };
    },
  };
}

async function runChat(
  turns: Turn[],
  messages: unknown[] = [{ role: "user", content: "start" }],
  fixtureOptions: Parameters<typeof startMcpFixture>[0] = {},
) {
  const fixture = await startMcpFixture(fixtureOptions);
  const remote = await openAtlassianTools(configFor());
  const requests: Request[] = [];
  const chunks: StreamChunk[] = [];
  try {
    const stream = chat({
      adapter: fakeAdapter(turns, requests) as never,
      messages: messages as never,
      tools: [localEcho, ...remote.tools],
      agentLoopStrategy: maxIterations(8),
    });
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
  } finally {
    await remote.close();
    await fixture.close();
  }
  return { fixture, requests, chunks };
}

function toolResult(request: Request, id: string) {
  const message = request.messages.find(
    (candidate) =>
      candidate.role === "tool" && (candidate as { toolCallId?: string }).toolCallId === id,
  );
  return String(message?.content);
}

const names = (request: Request) => request.tools.map((tool) => tool.name);

test("discovery exposes names first, then the native schema, then the call reaches the server", async () => {
  const { fixture, requests } = await runChat([
    () => [{ id: "d1", name: DISCOVERY_TOOL_NAME, input: { toolNames: ["jira_get_issue"] } }],
    () => [{ id: "c1", name: "jira_get_issue", input: { issue_key: "A-1" } }],
    () => "done",
  ]);

  assert.deepEqual(names(requests[0]!).sort(), [DISCOVERY_TOOL_NAME, "local_echo"]);
  const discovery = requests[0]!.tools.find((tool) => tool.name === DISCOVERY_TOOL_NAME)!;
  for (const name of [
    "jira_get_issue",
    "jira_search",
    "confluence_get_page",
    "confluence_search",
    "confluence_get_comments",
  ]) {
    assert.ok(discovery.description.includes(name), name);
  }
  assert.ok(!JSON.stringify(requests[0]!.tools).includes("Native key field"));

  const discovered = requests[1]!.tools.find((tool) => tool.name === "jira_get_issue");
  assert.deepEqual(discovered?.inputSchema, fixtureTool("jira_get_issue").inputSchema);
  assert.ok(!names(requests[1]!).includes("jira_search"));

  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0]!.arguments, { issue_key: "A-1", update_history: false });
  assert.match(toolResult(requests[2]!, "c1"), /result:jira_get_issue/);
});

test("calling an undiscovered tool is refused without reaching the server", async () => {
  const { fixture, requests } = await runChat([
    () => [{ id: "c1", name: "jira_search", input: { issue_key: "A-1" } }],
    () => "done",
  ]);
  assert.match(toolResult(requests[1]!, "c1"), /must be discovered first/);
  assert.equal(fixture.calls.length, 0);
});

test("each chat run opens a new MCP session and starts undiscovered", async () => {
  const first = await runChat([
    () => [{ id: "d1", name: DISCOVERY_TOOL_NAME, input: { toolNames: ["jira_get_issue"] } }],
    () => "done",
  ]);
  const second = await runChat([() => "done"]);
  assert.equal(first.fixture.sessions.length, 1);
  assert.equal(second.fixture.sessions.length, 1);
  assert.notEqual(first.fixture.sessions[0], second.fixture.sessions[0]);
  assert.ok(names(first.requests[1]!).includes("jira_get_issue"));
  assert.ok(!names(second.requests[0]!).includes("jira_get_issue"));
});

test("history with a discovery call restores the tool on the first request", async () => {
  const { requests } = await runChat(
    [() => "done"],
    [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "d1",
            type: "function",
            function: { name: DISCOVERY_TOOL_NAME, arguments: '{"toolNames":["jira_get_issue"]}' },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "d1",
        content: JSON.stringify({ tools: [{ name: "jira_get_issue", description: "x" }] }),
      },
      { role: "assistant", content: "found it" },
      { role: "user", content: "next" },
    ],
  );
  assert.ok(names(requests[0]!).includes("jira_get_issue"));
  assert.ok(names(requests[0]!).includes(DISCOVERY_TOOL_NAME));
});
