import type { ServerTool, ToolExecutionContext } from "@tanstack/ai";
import { createMCPClient, type MCPClient } from "@tanstack/ai-mcp";
import { atlassianTools, type AtlassianConfiguration } from "./atlassian-policy";

export type AtlassianTools = Readonly<{
  tools: ServerTool[];
  close: () => Promise<void>;
}>;

const MCP_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;

class AtlassianToolError extends Error {}

function guardCredentials(value: unknown, secrets: readonly string[]) {
  const seen = new WeakSet<object>();

  function inspect(value: unknown) {
    if (typeof value === "string" && secrets.some((secret) => value.includes(secret))) {
      throw new AtlassianToolError("Tool data contains configured Atlassian credentials");
    }

    if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);

      for (const key of Object.getOwnPropertyNames(value)) {
        inspect(key);
        inspect((value as Record<string, unknown>)[key]);
      }
    }
  }

  inspect(value);
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(new AtlassianToolError("Atlassian MCP operation was cancelled or timed out"));

    if (signal.aborted) {
      onAbort();

      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function boundedClose(client: MCPClient): Promise<void> {
  return withAbort(client.close(), AbortSignal.timeout(CLOSE_TIMEOUT_MS)).catch(() => undefined);
}

function selectTools(discovered: readonly ServerTool[]): ServerTool[] {
  const selected: ServerTool[] = [];

  for (const [name, policy] of atlassianTools) {
    const matches = discovered.filter((tool) => tool.metadata?.mcp?.serverToolName === name);

    if (matches.length === 0) {
      if (policy.required) {
        throw new AtlassianToolError(`Atlassian MCP is missing required tool ${name}`);
      }

      continue;
    }

    const [tool] = matches;

    if (matches.length > 1 || tool.name !== name || typeof tool.execute !== "function") {
      throw new AtlassianToolError("Atlassian MCP catalog is invalid");
    }

    selected.push(tool);
  }

  return selected;
}

function guardedTool(
  tool: ServerTool,
  secrets: readonly string[],
  sessionSignal: AbortSignal,
): ServerTool {
  const execute = tool.execute!;

  return {
    ...tool,
    execute: async (input: unknown, context?: ToolExecutionContext) => {
      const signal = AbortSignal.any([
        sessionSignal,
        AbortSignal.timeout(MCP_TIMEOUT_MS),
        ...(context?.abortSignal ? [context.abortSignal] : []),
      ]);
      const args =
        tool.name === "jira_get_issue"
          ? { ...(input as Record<string, unknown>), update_history: false }
          : input;

      try {
        const output = await withAbort(
          Promise.resolve(execute(args, context && { ...context, abortSignal: signal })),
          signal,
        );
        guardCredentials(output, secrets);

        return output;
      } catch (failure) {
        if (failure instanceof AtlassianToolError) {
          throw failure;
        }

        throw new AtlassianToolError(
          "Atlassian MCP tool failed; check Jira credentials, site access, and native tool arguments",
        );
      }
    },
  };
}

export async function openAtlassianTools(
  config: AtlassianConfiguration,
  signal: AbortSignal,
): Promise<AtlassianTools> {
  if (config.mode === "local") {
    return { tools: [], close: async () => undefined };
  }

  const session = new AbortController();
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const scopedFetch: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.any([session.signal, ...(init?.signal ? [init.signal] : [])]),
      redirect: "error",
      credentials: "omit",
    });
  const initSignal = AbortSignal.any([session.signal, AbortSignal.timeout(MCP_TIMEOUT_MS)]);
  let client: MCPClient | undefined;

  const close = async () => {
    signal.removeEventListener("abort", onAbort);
    session.abort();
    const connected = client;
    client = undefined;

    if (connected) {
      await boundedClose(connected);
    }
  };

  try {
    const connecting = createMCPClient({
      transport: { type: "http", url: config.endpoint, fetch: scopedFetch },
    });
    connecting.then(
      (connected) => {
        client = connected;

        if (session.signal.aborted) {
          void boundedClose(connected);
        }
      },
      () => undefined,
    );
    const connected = await withAbort(connecting, initSignal);
    const discovered = await withAbort(connected.tools({ lazy: true }), initSignal);
    guardCredentials(discovered, config.secrets);
    const tools = selectTools(discovered).map((tool) =>
      guardedTool(tool, config.secrets, session.signal),
    );

    return { tools, close };
  } catch (failure) {
    await close();

    if (failure instanceof AtlassianToolError) {
      throw failure;
    }

    throw new AtlassianToolError(
      "Atlassian MCP initialization failed; start the local service with pnpm mcp:atlassian, then check Jira credentials and site access",
    );
  }
}
