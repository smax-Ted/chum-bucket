import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { toolDefinition, type ToolExecutionContext } from "@tanstack/ai";
import { z } from "zod";

const cwd = process.cwd();
const piRead = createReadTool(cwd);
const piWrite = createWriteTool(cwd);
const piEdit = createEditTool(cwd);

const readArgs = z.object({
  path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

const writeArgs = z.object({
  path: z.string(),
  content: z.string(),
});

const editArgs = z.object({
  path: z.string(),
  edits: z.array(z.object({ oldText: z.string(), newText: z.string() })),
});

function toolCallId(context?: ToolExecutionContext): string {
  if (!context?.toolCallId) {
    throw new Error("Missing tool call ID");
  }

  return context.toolCallId;
}

export const read = toolDefinition({
  name: piRead.name,
  description: piRead.description,
  inputSchema: piRead.parameters,
}).server(async (input, context) =>
  piRead.execute(toolCallId(context), readArgs.parse(input), context?.abortSignal),
);

export const write = toolDefinition({
  name: piWrite.name,
  description: piWrite.description,
  inputSchema: piWrite.parameters,
}).server(async (input, context) =>
  piWrite.execute(toolCallId(context), writeArgs.parse(input), context?.abortSignal),
);

export const edit = toolDefinition({
  name: piEdit.name,
  description: piEdit.description,
  inputSchema: piEdit.parameters,
}).server(async (input, context) =>
  piEdit.execute(toolCallId(context), editArgs.parse(input), context?.abortSignal),
);
