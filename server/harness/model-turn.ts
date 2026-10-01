import { isDeepStrictEqual } from "node:util";
import {
  EventType,
  StreamProcessor,
  normalizeStreamChunk,
  uiMessagesToWire,
  type StreamChunk,
  type UIMessage,
  type AdapterYieldChunk,
} from "@tanstack/ai";

export type ModelCall = { id: string; name: string; arguments: string; input: unknown };
export type Turn = {
  messages: UIMessage[];
  calls: ModelCall[];
};
type ModelStream = {
  messages: UIMessage[];
  stream: AsyncIterable<AdapterYieldChunk>;
  append: (event: StreamChunk) => Promise<void>;
};
type ToolCallEnd = Extract<StreamChunk, { type: "TOOL_CALL_END" }>;

export function snapshot(messages: UIMessage[]): StreamChunk {
  return { type: EventType.MESSAGES_SNAPSHOT, messages: uiMessagesToWire(messages) };
}

function canonicalToolInput(
  call: Pick<ModelCall, "name" | "arguments">,
  event: ToolCallEnd,
): unknown {
  const parsed: unknown = JSON.parse(call.arguments);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid tool arguments");
  }
  const adjusted = { ...parsed } as Record<string, unknown>;
  if (call.name === "get_figma") {
    for (const key of ["nodeId", "depth", "offset"]) {
      if (adjusted[key] === null) {
        delete adjusted[key];
      }
    }
  }
  const declared =
    event.input !== undefined
      ? event.input
      : (event.metadata as { tanstack?: { input?: unknown } } | undefined)?.tanstack?.input;
  if (!isDeepStrictEqual(adjusted, declared)) {
    throw new Error("Tool input disagrees with arguments");
  }
  return declared;
}

export async function streamModelTurn(input: ModelStream): Promise<Turn> {
  const processor = new StreamProcessor({ initialMessages: structuredClone(input.messages) });
  async function* checkedStream(): AsyncGenerator<StreamChunk> {
    let finished = false;
    for await (const yielded of input.stream) {
      for (const event of normalizeStreamChunk(yielded)) {
        if (event.type === "RUN_ERROR") {
          throw new Error(event.message);
        }
        if (finished) {
          throw new Error("Provider emitted content after completion");
        }
        if (event.type === "RUN_STARTED") {
          continue;
        }
        if (event.type === "RUN_FINISHED") {
          if (
            [...processor.getState().toolCalls.values()].some(
              (call) => call.state !== "input-complete",
            )
          ) {
            throw new Error("Incomplete model turn");
          }
          finished = true;
          yield event;
          continue;
        }
        if (event.type === "TOOL_CALL_RESULT") {
          throw new Error("Provider tool results are not supported");
        }
        if (
          event.type === "TOOL_CALL_START" &&
          processor.getState().toolCalls.has(event.toolCallId)
        ) {
          throw new Error("Duplicate tool call");
        }
        if (event.type === "TOOL_CALL_ARGS" || event.type === "TOOL_CALL_END") {
          const call = processor.getState().toolCalls.get(event.toolCallId);
          if (!call || call.state === "input-complete") {
            throw new Error("Invalid tool lifecycle");
          }
          if (event.type === "TOOL_CALL_END") {
            canonicalToolInput(call, event);
          }
        }
        await input.append(event);
        yield event;
      }
    }
    if (!finished) {
      throw new Error("Incomplete model turn");
    }
  }
  const result = await processor.process(checkedStream());
  const state = processor.getState();
  const output: Turn = {
    messages: processor.getMessages(),
    calls: (result.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      input: state.toolCalls.get(call.id)!.parsedArguments,
    })),
  };
  return JSON.parse(JSON.stringify(output)) as Turn;
}
