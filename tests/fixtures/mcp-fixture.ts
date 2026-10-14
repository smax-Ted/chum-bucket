import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FixtureTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type FixtureCallResult = { text: string; isError?: boolean };

export type FixtureCall = {
  sessionId: string | undefined;
  name: string;
  arguments: Record<string, unknown>;
};

type Handler = (call: FixtureCall, signal: AbortSignal) => Promise<FixtureCallResult>;

export const fixtureToolNames = [
  "jira_get_issue",
  "jira_search",
  "confluence_get_page",
  "confluence_search",
  "confluence_get_comments",
  "jira_create_issue",
  "jira_delete_issue",
];

export function fixtureTool(name: string): FixtureTool {
  return {
    name,
    description: `Native ${name} description`,
    inputSchema: {
      type: "object",
      properties: {
        issue_key: { type: "string", description: "Native key field" },
        update_history: { type: "boolean", default: true },
      },
      required: ["issue_key"],
    },
  };
}

type FixtureOptions = {
  tools?: FixtureTool[];
  handler?: Handler;
  failRequests?: { status: number; body: string };
};

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body?: unknown, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

export async function startMcpFixture(options: FixtureOptions = {}) {
  const tools = options.tools ?? fixtureToolNames.map(fixtureTool);
  const handler: Handler =
    options.handler ??
    (async (call) => ({ text: `result:${call.name}:${JSON.stringify(call.arguments)}` }));
  const methods: string[] = [];
  const calls: FixtureCall[] = [];
  const sessions: string[] = [];
  const closedSessions: string[] = [];
  const listings: (string | undefined)[] = [];

  const server = createServer(async (request, response) => {
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    if (options.failRequests && request.method === "POST") {
      response.writeHead(options.failRequests.status, { "content-type": "text/plain" });
      response.end(options.failRequests.body);
      return;
    }
    if (request.method === "GET") {
      send(response, 405);
      return;
    }
    if (request.method === "DELETE") {
      if (sessionId) {
        closedSessions.push(sessionId);
      }
      send(response, 200);
      return;
    }
    const message = JSON.parse(await readBody(request)) as {
      id?: number | string;
      method: string;
      params?: Record<string, unknown>;
    };
    methods.push(message.method);
    if (message.id === undefined) {
      send(response, 202);
      return;
    }
    const reply = (result: unknown) =>
      send(response, 200, { jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize") {
      const created = randomUUID();
      sessions.push(created);
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": created,
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          },
        }),
      );
      return;
    }
    if (message.method === "tools/list") {
      listings.push(sessionId);
      reply({ tools });
      return;
    }
    if (message.method === "tools/call") {
      const call: FixtureCall = {
        sessionId,
        name: String(message.params?.name),
        arguments: (message.params?.arguments ?? {}) as Record<string, unknown>,
      };
      calls.push(call);
      const controller = new AbortController();
      response.on("close", () => controller.abort());
      try {
        const result = await handler(call, controller.signal);
        reply({ content: [{ type: "text", text: result.text }], isError: result.isError ?? false });
      } catch {
        if (!controller.signal.aborted) {
          send(response, 500, { error: "fixture failure" });
        }
      }
      return;
    }
    reply({});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/mcp`;
  const previous = process.env.ATLASSIAN_MCP_URL;
  process.env.ATLASSIAN_MCP_URL = url;

  return {
    url,
    methods,
    calls,
    sessions,
    closedSessions,
    listings,
    async close() {
      if (previous === undefined) {
        delete process.env.ATLASSIAN_MCP_URL;
      } else {
        process.env.ATLASSIAN_MCP_URL = previous;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
