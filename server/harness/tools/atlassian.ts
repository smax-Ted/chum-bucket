import {
  convertSchemaToJsonSchema,
  type JSONSchema,
  type ToolExecutionContext,
} from "@tanstack/ai";
import { createMCPClient, type MCPClient } from "@tanstack/ai-mcp";
import type { ModelCall } from "../model-turn";
import {
  atlassianTools,
  readAtlassianConfiguration,
  type AtlassianConfiguration,
} from "./atlassian-policy";

export type ModelTool = Readonly<{
  name: string;
  description: string;
  inputSchema: JSONSchema;
}>;
export type AtlassianCatalog = ReadonlyMap<string, ModelTool>;
export type LocalToolHandler = (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
export type AtlassianScope = Readonly<{
  getModelTools: (compose: (remote: AtlassianCatalog) => ModelTool[]) => Promise<ModelTool[]>;
  executeTool: (
    call: ModelCall,
    context: ToolExecutionContext,
    local: LocalToolHandler | undefined,
  ) => Promise<unknown>;
}>;

type RemoteRegistration = Readonly<{
  definition: ModelTool;
  handler: LocalToolHandler;
}>;
type RemoteCatalog = Readonly<{
  registrations: ReadonlyMap<string, RemoteRegistration>;
  close: () => Promise<void>;
}>;
type RemoteSession = Readonly<{
  controller: AbortController;
  deadlines: Set<AbortSignal>;
  catalog: Promise<RemoteCatalog>;
}>;

const MCP_TIMEOUT_MS = 60_000;

class ToolBoundaryError extends Error {}

type Deadline = Readonly<{ signal: AbortSignal; release: () => void }>;

function armedDeadline(deadlines: Set<AbortSignal>, ms: number): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  deadlines.add(controller.signal);
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      deadlines.delete(controller.signal);
    },
  };
}

function guardCredentials(value: unknown, config: AtlassianConfiguration) {
  const secrets = config.mode === "http" ? config.secrets : [];
  const seen = new WeakSet<object>();
  function inspect(value: unknown) {
    if (typeof value === "string" && secrets.some((secret) => value.includes(secret))) {
      throw new ToolBoundaryError("Tool data contains configured Atlassian credentials");
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
      reject(new ToolBoundaryError("Atlassian MCP operation was cancelled or timed out"));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function openRemote(
  config: Extract<AtlassianConfiguration, { mode: "http" }>,
  controller: AbortController,
  deadlines: Set<AbortSignal>,
): Promise<RemoteCatalog> {
  const scopeFetch: typeof fetch = (input, init) => {
    const requestSignal = input instanceof Request ? input.signal : undefined;
    const signals = [
      controller.signal,
      ...deadlines,
      ...(requestSignal ? [requestSignal] : []),
      ...(init?.signal ? [init.signal] : []),
    ];
    return fetch(input, {
      ...init,
      signal: AbortSignal.any(signals),
      redirect: "error",
      credentials: "omit",
    });
  };
  const initDeadline = armedDeadline(deadlines, MCP_TIMEOUT_MS);
  let client: MCPClient | undefined;
  const close = async () => {
    const connected = client;
    client = undefined;
    await connected?.close().catch(() => undefined);
  };
  const onAbort = () => void close();
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    controller.signal.throwIfAborted();
    const connecting = createMCPClient({
      transport: { type: "http", url: config.endpoint, fetch: scopeFetch },
    }).then(async (connected) => {
      client = connected;
      if (controller.signal.aborted || initDeadline.signal.aborted) {
        await close();
      }
      return connected;
    });
    const signal = AbortSignal.any([controller.signal, initDeadline.signal]);
    const connected = await withAbort(connecting, signal);
    const discovered = await withAbort(connected.tools(), signal);
    guardCredentials(discovered, config);
    const entries = new Map<string, RemoteRegistration>();
    for (const [name, policy] of atlassianTools) {
      const tool = discovered.find((tool) => tool.metadata.mcp.serverToolName === name);
      if (!tool) {
        if (policy.required) {
          throw new ToolBoundaryError(`Atlassian MCP is missing required tool ${name}`);
        }
        continue;
      }
      if (tool.name !== name || entries.has(name) || typeof tool.execute !== "function") {
        throw new ToolBoundaryError("Atlassian MCP catalog is invalid");
      }
      const inputSchema = convertSchemaToJsonSchema(tool.inputSchema);
      if (!inputSchema) {
        throw new ToolBoundaryError("Tool schema is unavailable");
      }
      entries.set(name, {
        definition: { name: tool.name, description: tool.description, inputSchema },
        handler: async (input, context) => tool.execute!(input, context),
      });
    }
    return { registrations: entries, close };
  } catch (failure) {
    const cancelled = controller.signal.aborted || initDeadline.signal.aborted;
    if (cancelled) {
      controller.abort();
    }
    await close();
    guardCredentials(failure, config);
    if (cancelled) {
      throw new ToolBoundaryError("Atlassian MCP operation was cancelled or timed out");
    }
    if (failure instanceof ToolBoundaryError) {
      throw failure;
    }
    throw new ToolBoundaryError(
      "Atlassian MCP initialization failed; start the local service with pnpm mcp:atlassian, then check Jira credentials and site access",
    );
  } finally {
    initDeadline.release();
    controller.signal.removeEventListener("abort", onAbort);
  }
}

export async function withAtlassianScope<T>(
  use: (scope: AtlassianScope) => Promise<T>,
): Promise<T> {
  let configuration: Promise<AtlassianConfiguration> | undefined;
  let remote: RemoteSession | undefined;
  let closed = false;
  const getConfiguration = async () => {
    const config = await (configuration ??= Promise.resolve().then(() =>
      readAtlassianConfiguration(process.env),
    ));
    if (closed) {
      throw new ToolBoundaryError("Tool scope is closed");
    }
    return config;
  };
  const getRemote = (config: Extract<AtlassianConfiguration, { mode: "http" }>) => {
    if (closed) {
      throw new ToolBoundaryError("Tool scope is closed");
    }
    if (!remote) {
      const controller = new AbortController();
      const deadlines = new Set<AbortSignal>();
      const session: RemoteSession = {
        controller,
        deadlines,
        catalog: openRemote(config, controller, deadlines).catch((failure: unknown) => {
          if (remote === session) {
            remote = undefined;
          }
          throw failure;
        }),
      };
      remote = session;
    }
    return remote;
  };
  const retire = async (session: RemoteSession) => {
    if (remote === session) {
      remote = undefined;
    }
    session.controller.abort();
    const catalog = await session.catalog.catch(() => undefined);
    await catalog?.close();
  };
  try {
    return await use({
      async getModelTools(compose) {
        const config = await getConfiguration();
        const session = config.mode === "http" ? getRemote(config) : undefined;
        try {
          const catalog = await session?.catalog;
          const remoteDefinitions: AtlassianCatalog = new Map(
            [...(catalog?.registrations ?? [])].map(([name, entry]) => [name, entry.definition]),
          );
          const definitions = compose(remoteDefinitions);
          guardCredentials(definitions, config);
          return structuredClone(definitions);
        } catch (failure) {
          if (session) {
            await retire(session);
          }
          guardCredentials(failure, config);
          throw new Error(failure instanceof Error ? failure.message : "Tool composition failed");
        }
      },
      async executeTool(call, context, local) {
        const config = await getConfiguration();
        if (local) {
          try {
            const output = await local(call.input, context);
            guardCredentials(output, config);
            return output;
          } catch (failure) {
            guardCredentials(failure, config);
            throw new Error(failure instanceof Error ? failure.message : "Tool failed");
          }
        }
        if (!atlassianTools.has(call.name) || config.mode === "local") {
          throw new Error("Unknown tool");
        }
        if (context.abortSignal?.aborted) {
          throw new ToolBoundaryError("Atlassian MCP tool was cancelled");
        }
        const session = getRemote(config);
        const callDeadline = armedDeadline(session.deadlines, MCP_TIMEOUT_MS);
        const signal = AbortSignal.any([
          session.controller.signal,
          callDeadline.signal,
          ...(context.abortSignal ? [context.abortSignal] : []),
        ]);
        const onAbort = () => session.controller.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          const catalog = await withAbort(session.catalog, signal);
          const entry = catalog.registrations.get(call.name);
          if (!entry) {
            throw new ToolBoundaryError("Unknown tool");
          }
          const input =
            call.name === "jira_get_issue"
              ? { ...(call.input as Record<string, unknown>), update_history: false }
              : call.input;
          const output = await withAbort(
            entry.handler(input, { ...context, abortSignal: signal }),
            signal,
          );
          guardCredentials(output, config);
          return output;
        } catch (failure) {
          const cancelled = signal.aborted;
          await retire(session);
          guardCredentials(failure, config);
          if (context.abortSignal?.aborted) {
            throw new ToolBoundaryError("Atlassian MCP tool was cancelled");
          }
          if (failure instanceof ToolBoundaryError) {
            throw failure;
          }
          if (cancelled) {
            throw new ToolBoundaryError("Atlassian MCP operation was cancelled or timed out");
          }
          throw new ToolBoundaryError(
            "Atlassian MCP tool failed; check Jira credentials, site access, and native tool arguments",
          );
        } finally {
          callDeadline.release();
          signal.removeEventListener("abort", onAbort);
        }
      },
    });
  } finally {
    closed = true;
    if (remote) {
      await retire(remote).catch(() => undefined);
    }
  }
}
