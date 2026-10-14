import { createMCPClient, type MCPClient } from "@tanstack/ai-mcp";

const CONNECT_TIMEOUT_MS = 5_000;

export async function connectAtlassian(): Promise<MCPClient | null> {
  const url = process.env.ATLASSIAN_MCP_URL;

  if (!url) {
    return null;
  }

  const connecting = createMCPClient({
    transport: { type: "http", url },
    name: "chum-bucket",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("connection timed out")), CONNECT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([connecting, timeout]);
  } catch (error) {
    void connecting.then((client) => client.close()).catch(() => undefined);
    console.warn(
      `Atlassian MCP unavailable at ${url}: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
