import type { ToolExecutionContext } from "@tanstack/ai";
import { createMCPClient, type McpServerTool } from "@tanstack/ai-mcp";
import {
  ATLASSIAN_ALLOWED_TOOLS,
  ATLASSIAN_REQUIRED_TOOLS,
  type AtlassianConfig,
} from "./atlassian-policy";

const INIT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
const MAX_ERROR_CHARS = 500;
const REDACTED = "[redacted]";

export type AtlassianTools = {
  tools: McpServerTool[];
  close: () => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function knownSecrets(config: AtlassianConfig) {
  const basic = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");

  return [basic, config.apiToken];
}

function createRedactor(secrets: string[]) {
  function redact<T>(value: T): T {
    if (typeof value === "string") {
      return secrets.reduce(
        (text, secret) => text.split(secret).join(REDACTED),
        value as string,
      ) as T;
    }

    if (Array.isArray(value)) {
      return value.map(redact) as T;
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, redact(entry)]),
      ) as T;
    }

    return value;
  }

  return redact;
}

function abortMessage(signal: AbortSignal) {
  return signal.reason instanceof Error && signal.reason.name === "TimeoutError"
    ? "Atlassian request timed out."
    : "Atlassian request was cancelled.";
}

function settleWithin(promise: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function createGuardedFetch(session: AbortSignal, outer?: AbortSignal) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const signals = [session];

    if (init?.signal) {
      signals.push(init.signal);
    }

    if (outer) {
      signals.push(outer);
    }

    if ((init?.method ?? "GET").toUpperCase() !== "GET") {
      signals.push(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    }

    const response = await fetch(input, {
      ...init,
      signal: AbortSignal.any(signals),
    });

    if (response.ok) {
      return response;
    }

    await response.body?.cancel();

    return new Response(JSON.stringify({ error: "Atlassian MCP request failed." }), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
}

function guardTool(
  tool: McpServerTool,
  session: AbortSignal,
  redact: <T>(value: T) => T,
): McpServerTool {
  const execute = tool.execute;

  if (!execute) {
    throw new Error(`Atlassian tool ${tool.metadata.mcp.serverToolName} has no execute handler.`);
  }

  const forceNoHistory = tool.metadata.mcp.serverToolName === "jira_get_issue";

  return {
    ...tool,
    description: redact(tool.description),
    inputSchema: redact(tool.inputSchema),
    execute: async (args: unknown, context?: ToolExecutionContext) => {
      const signal = AbortSignal.any([
        session,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(context?.abortSignal ? [context.abortSignal] : []),
      ]);
      const input = forceNoHistory
        ? { ...(isRecord(args) ? args : {}), update_history: false }
        : args;

      try {
        return redact(
          await execute(input, {
            emitCustomEvent: () => {
              throw new Error("Tool custom events are not supported");
            },
            ...context,
            abortSignal: signal,
          }),
        );
      } catch (failure) {
        if (signal.aborted) {
          throw new Error(abortMessage(signal));
        }

        const message = failure instanceof Error ? failure.message : "";
        throw new Error(
          message.startsWith("MCP tool ")
            ? redact(message).slice(0, MAX_ERROR_CHARS)
            : "Atlassian request failed.",
        );
      }
    },
  };
}

export async function openAtlassianTools(
  config: AtlassianConfig,
  signal?: AbortSignal,
): Promise<AtlassianTools> {
  const redact = createRedactor(knownSecrets(config));
  const session = new AbortController();
  let client: Awaited<ReturnType<typeof createMCPClient>> | undefined;
  let closing: Promise<void> | undefined;

  function close() {
    closing ??= (async () => {
      session.abort();

      if (client) {
        await settleWithin(
          client.close().catch(() => undefined),
          CLOSE_TIMEOUT_MS,
        );
      }
    })();

    return closing;
  }

  const initTimer = setTimeout(
    () => session.abort(new DOMException("Atlassian initialization timed out.", "TimeoutError")),
    INIT_TIMEOUT_MS,
  );

  try {
    signal?.throwIfAborted();
    client = await createMCPClient({
      transport: {
        type: "http",
        url: config.endpoint,
        fetch: createGuardedFetch(session.signal, signal),
      },
    });
    const discovered = await client.tools({ lazy: true });
    const allowed = new Set<string>(ATLASSIAN_ALLOWED_TOOLS);
    const tools = discovered.filter((tool) => allowed.has(tool.metadata.mcp.serverToolName));
    const names = tools.map((tool) => tool.metadata.mcp.serverToolName);

    if (new Set(names).size !== names.length) {
      throw new Error("Atlassian MCP returned duplicate tool names.");
    }

    for (const required of ATLASSIAN_REQUIRED_TOOLS) {
      if (!names.includes(required)) {
        throw new Error(`Atlassian MCP is missing required tool ${required}.`);
      }
    }

    return {
      tools: tools.map((tool) => guardTool(tool, session.signal, redact)),
      close,
    };
  } catch (failure) {
    await close();

    if (signal?.aborted) {
      throw new Error("Atlassian request was cancelled.");
    }

    if (session.signal.reason instanceof Error && session.signal.reason.name === "TimeoutError") {
      throw new Error("Atlassian initialization timed out.");
    }

    const message = failure instanceof Error ? failure.message : "";
    throw new Error(
      message.startsWith("Atlassian ")
        ? message
        : `Atlassian MCP is unavailable at ${config.endpoint}. Start it with pnpm mcp:atlassian.`,
    );
  } finally {
    clearTimeout(initTimer);
  }
}
