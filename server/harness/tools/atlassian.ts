import type { ServerTool, ToolExecutionContext } from "@tanstack/ai";
import { createMCPClient, type MCPClient } from "@tanstack/ai-mcp";
import { atlassianTools, type AtlassianConfiguration } from "./atlassian-policy";

export type AtlassianTools = Readonly<{
  tools: ServerTool[];
  close: () => Promise<void>;
}>;

const TOOL_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;

class AtlassianBoundaryError extends Error {}

function assertNoSecrets(value: unknown, secrets: readonly string[]) {
  const visited = new WeakSet<object>();

  const walk = (node: unknown) => {
    if (typeof node === "string" && secrets.some((secret) => node.includes(secret))) {
      throw new AtlassianBoundaryError("Tool data contains configured Atlassian credentials");
    }

    if (!node || typeof node !== "object" || visited.has(node)) {
      return;
    }

    visited.add(node);

    for (const key of Object.getOwnPropertyNames(node)) {
      walk(key);
      walk((node as Record<string, unknown>)[key]);
    }
  };

  walk(value);
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const fail = () =>
      reject(new AtlassianBoundaryError("Atlassian MCP operation was cancelled or timed out"));

    if (signal.aborted) {
      fail();

      return;
    }

    signal.addEventListener("abort", fail, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", fail));
  });
}

async function closeClient(client: MCPClient): Promise<void> {
  try {
    await raceAbort(client.close(), AbortSignal.timeout(CLOSE_TIMEOUT_MS));
  } catch {
    return;
  }
}

function pickAllowedTools(catalog: readonly ServerTool[]): ServerTool[] {
  const picked: ServerTool[] = [];

  for (const [name, policy] of atlassianTools) {
    const matches = catalog.filter((tool) => tool.metadata?.mcp?.serverToolName === name);

    if (matches.length === 0) {
      if (policy.required) {
        throw new AtlassianBoundaryError(`Atlassian MCP is missing required tool ${name}`);
      }

      continue;
    }

    const [tool] = matches;

    if (matches.length > 1 || tool.name !== name || typeof tool.execute !== "function") {
      throw new AtlassianBoundaryError("Atlassian MCP catalog is invalid");
    }

    picked.push(tool);
  }

  return picked;
}

function wrapTool(
  tool: ServerTool,
  secrets: readonly string[],
  sessionSignal: AbortSignal,
): ServerTool {
  const run = tool.execute!;

  return {
    ...tool,
    execute: async (input: unknown, context?: ToolExecutionContext) => {
      const signal = AbortSignal.any([
        sessionSignal,
        AbortSignal.timeout(TOOL_TIMEOUT_MS),
        ...(context?.abortSignal ? [context.abortSignal] : []),
      ]);
      const args =
        tool.name === "jira_get_issue"
          ? { ...(input as Record<string, unknown>), update_history: false }
          : input;

      try {
        const output = await raceAbort(
          Promise.resolve(run(args, context && { ...context, abortSignal: signal })),
          signal,
        );
        assertNoSecrets(output, secrets);

        return output;
      } catch (error) {
        if (error instanceof AtlassianBoundaryError) {
          throw error;
        }

        throw new AtlassianBoundaryError(
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
  const forwardAbort = () => session.abort();
  signal.addEventListener("abort", forwardAbort, { once: true });

  const safeFetch: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.any([session.signal, ...(init?.signal ? [init.signal] : [])]),
      redirect: "error",
      credentials: "omit",
    });

  const initSignal = AbortSignal.any([session.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS)]);
  let client: MCPClient | undefined;

  const close = async () => {
    signal.removeEventListener("abort", forwardAbort);
    session.abort();
    const active = client;
    client = undefined;

    if (active) {
      await closeClient(active);
    }
  };

  try {
    const connecting = createMCPClient({
      transport: { type: "http", url: config.endpoint, fetch: safeFetch },
    });
    connecting.then(
      (connected) => {
        client = connected;

        if (session.signal.aborted) {
          void closeClient(connected);
        }
      },
      () => undefined,
    );

    const connected = await raceAbort(connecting, initSignal);
    const catalog = await raceAbort(connected.tools({ lazy: true }), initSignal);
    assertNoSecrets(catalog, config.secrets);

    return {
      tools: pickAllowedTools(catalog).map((tool) =>
        wrapTool(tool, config.secrets, session.signal),
      ),
      close,
    };
  } catch (error) {
    await close();

    if (error instanceof AtlassianBoundaryError) {
      throw error;
    }

    throw new AtlassianBoundaryError(
      "Atlassian MCP initialization failed; start the local service with pnpm mcp:atlassian, then check Jira credentials and site access",
    );
  }
}
