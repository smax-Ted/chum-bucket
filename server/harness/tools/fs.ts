import { toolDefinition, type JSONSchema, type ToolExecutionContext } from "@tanstack/ai";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

type PiTool<TInput> = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, input: TInput, signal?: AbortSignal) => Promise<unknown>;
};

function wrapPiTool<TSchema extends z.ZodType>(tool: PiTool<z.infer<TSchema>>, schema: TSchema) {
  return toolDefinition({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as JSONSchema,
  }).server(async (args: unknown, context?: ToolExecutionContext) => {
    const input = schema.parse(args);

    if (!context?.toolCallId) {
      throw new Error(`${tool.name} requires a toolCallId`);
    }

    return tool.execute(context.toolCallId, input, context.abortSignal);
  });
}

const readInput = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
});

const writeInput = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const editInput = z.object({
  path: z.string().min(1),
  edits: z.array(z.object({ oldText: z.string(), newText: z.string() })).min(1),
});

export const read = wrapPiTool(createReadTool(process.cwd()), readInput);
export const write = wrapPiTool(createWriteTool(process.cwd()), writeInput);
export const edit = wrapPiTool(createEditTool(process.cwd()), editInput);
