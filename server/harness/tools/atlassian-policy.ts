export const DEFAULT_ATLASSIAN_MCP_URL = "http://127.0.0.1:8000/mcp";

export const ATLASSIAN_ALLOWED_TOOLS = [
  "jira_get_issue",
  "jira_search",
  "confluence_get_page",
  "confluence_search",
  "confluence_get_comments",
] as const;

export const ATLASSIAN_REQUIRED_TOOLS = ["jira_get_issue", "confluence_get_page"] as const;

export const ATLASSIAN_TOOLSETS = [
  "jira_issues",
  "confluence_pages",
  "confluence_comments",
] as const;

export type AtlassianConfig = {
  baseUrl: string;
  email: string;
  apiToken: string;
  endpoint: string;
};

type Environment = Record<string, string | undefined>;

const CREDENTIAL_KEYS = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const SITE_HOST = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/i;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

function read(env: Environment, key: string) {
  return env[key]?.trim() || undefined;
}

function parseUrl(value: string, label: string) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
}

function parseSite(value: string) {
  const url = parseUrl(value, "JIRA_BASE_URL");

  if (
    url.protocol !== "https:" ||
    !SITE_HOST.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "JIRA_BASE_URL must be https://your-site.atlassian.net without a path, query, or credentials.",
    );
  }

  return url.origin;
}

function parseEndpoint(value: string) {
  const url = parseUrl(value, "ATLASSIAN_MCP_URL");

  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "ATLASSIAN_MCP_URL must be an http loopback URL (127.0.0.1 or [::1]) without credentials, query, or fragment.",
    );
  }

  return url.href;
}

export function resolveAtlassianConfig(env: Environment): AtlassianConfig | undefined {
  const [baseUrl, email, apiToken] = CREDENTIAL_KEYS.map((key) => read(env, key));
  const endpoint = read(env, "ATLASSIAN_MCP_URL");

  if (!baseUrl && !email && !apiToken) {
    if (endpoint) {
      throw new Error("ATLASSIAN_MCP_URL requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN.");
    }

    return undefined;
  }

  if (!baseUrl || !email || !apiToken) {
    throw new Error(
      "Atlassian MCP requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN to be set together.",
    );
  }

  if (!EMAIL.test(email)) {
    throw new Error("JIRA_EMAIL must be an email address.");
  }

  return {
    baseUrl: parseSite(baseUrl),
    email,
    apiToken,
    endpoint: parseEndpoint(endpoint ?? DEFAULT_ATLASSIAN_MCP_URL),
  };
}
