export type Environment = Readonly<Record<string, string | undefined>>;

export type AtlassianToolPolicy = Readonly<{ required: boolean }>;

export const atlassianTools: ReadonlyMap<string, AtlassianToolPolicy> = new Map([
  ["jira_get_issue", { required: true }],
  ["jira_search", { required: false }],
  ["confluence_get_page", { required: true }],
  ["confluence_search", { required: false }],
  ["confluence_get_comments", { required: false }],
]);

export const atlassianToolNames: readonly string[] = [...atlassianTools.keys()];

export const defaultAtlassianEndpoint = "http://127.0.0.1:8000/mcp";

export type AtlassianConfiguration =
  | Readonly<{ mode: "local" }>
  | Readonly<{
      mode: "http";
      endpoint: string;
      serviceEnvironment: Readonly<Record<string, string>>;
      secrets: readonly string[];
    }>;

function reject(message: string): never {
  throw new Error(message);
}

function parseJiraBaseUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return reject("JIRA_BASE_URL must be an HTTPS URL without credentials, query, or fragment");
  }

  if (
    value !== value.trim() ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return reject("JIRA_BASE_URL must be an HTTPS URL without credentials, query, or fragment");
  }

  return url;
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]"]);

function parseEndpoint(value: string): string {
  const url = URL.parse(value);
  const ok =
    url !== null &&
    !/\s/.test(value) &&
    url.protocol === "http:" &&
    LOOPBACK.has(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash;

  if (!ok) {
    return reject(
      "ATLASSIAN_MCP_URL must be a loopback HTTP URL without credentials, query, or fragment",
    );
  }

  return value;
}

function credentialVariants(email: string, token: string): readonly string[] {
  return [
    ...new Set(
      [token, `${email}:${token}`].flatMap((secret) => [
        secret,
        Buffer.from(secret).toString("base64"),
        Buffer.from(secret).toString("base64url"),
        encodeURIComponent(secret),
      ]),
    ),
  ];
}

export function readAtlassianConfiguration(env: Environment): AtlassianConfiguration {
  const baseUrl = env.JIRA_BASE_URL ?? "";
  const email = env.JIRA_EMAIL ?? "";
  const token = env.JIRA_API_TOKEN ?? "";
  const mcpUrl = env.ATLASSIAN_MCP_URL ?? "";
  const filled = [baseUrl, email, token].filter(Boolean).length;

  if (filled === 0) {
    if (mcpUrl) {
      return reject("ATLASSIAN_MCP_URL requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN");
    }

    return { mode: "local" };
  }

  if (filled !== 3) {
    return reject("Configure JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN together");
  }

  const jira = parseJiraBaseUrl(baseUrl);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[\x21-\x7e]+$/.test(token)) {
    return reject("JIRA_EMAIL or JIRA_API_TOKEN is invalid; check backend configuration");
  }

  return {
    mode: "http",
    endpoint: mcpUrl ? parseEndpoint(mcpUrl) : defaultAtlassianEndpoint,
    serviceEnvironment: {
      JIRA_URL: jira.href.replace(/\/+$/, ""),
      JIRA_USERNAME: email,
      JIRA_API_TOKEN: token,
      CONFLUENCE_URL: new URL("/wiki", jira).href,
      CONFLUENCE_USERNAME: email,
      CONFLUENCE_API_TOKEN: token,
      READ_ONLY_MODE: "true",
      PYTHON_DOTENV_DISABLED: "1",
      ALLOW_GLOBAL_CRED_FALLBACK: "true",
      TOOLSETS: "jira_issues,confluence_pages,confluence_comments",
      ENABLED_TOOLS: atlassianToolNames.join(","),
    },
    secrets: credentialVariants(email, token),
  };
}
