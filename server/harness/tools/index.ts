import { convertSchemaToJsonSchema, type Tool, type ToolExecutionContext } from "@tanstack/ai";
import type { ModelCall } from "../model-turn";
import { getFigma } from "./get-figma";
import { getTicket } from "./get-ticket";
import { readConfluence } from "./read-confluence";
import { writeJiraCommand } from "./write-jira-command";
import { read, write, edit } from "./fs";

type ToolRegistration = {
  definition: Pick<Tool, "name" | "description" | "inputSchema">;
  handler: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
};

const registrations: readonly ToolRegistration[] = [
  {
    definition: getFigma,
    handler: async (input, context) =>
      getFigma.execute!(getFigma.inputSchema.parse(input), context),
  },
  {
    definition: getTicket,
    handler: async (input, context) =>
      getTicket.execute!(getTicket.inputSchema.parse(input), context),
  },
  {
    definition: readConfluence,
    handler: async (input, context) =>
      readConfluence.execute!(readConfluence.inputSchema.parse(input), context),
  },
  {
    definition: writeJiraCommand,
    handler: async (input, context) =>
      writeJiraCommand.execute!(writeJiraCommand.inputSchema.parse(input), context),
  },
  {
    definition: read,
    handler: async (input, context) => read.execute!(input, context),
  },
  {
    definition: write,
    handler: async (input, context) => write.execute!(input, context),
  },
  {
    definition: edit,
    handler: async (input, context) => edit.execute!(input, context),
  },
];

export const modelTools = registrations.map(({ definition }) => ({
  name: definition.name,
  description: definition.description,
  inputSchema: convertSchemaToJsonSchema(definition.inputSchema),
}));

export async function executeTool(
  call: ModelCall,
  context: ToolExecutionContext,
): Promise<unknown> {
  const registration = registrations.find(({ definition }) => definition.name === call.name);
  if (!registration) {
    throw new Error("Unknown tool");
  }
  return registration.handler(call.input, context);
}
