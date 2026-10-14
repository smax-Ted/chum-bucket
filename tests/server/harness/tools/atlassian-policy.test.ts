import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ATLASSIAN_MCP_URL,
  resolveAtlassianConfig,
} from "../../../../server/harness/tools/atlassian-policy";

const complete = {
  JIRA_BASE_URL: "https://team.atlassian.net",
  JIRA_EMAIL: "dev@example.com",
  JIRA_API_TOKEN: "fake-token",
};

test("empty configuration keeps only local tools", () => {
  assert.equal(resolveAtlassianConfig({}), undefined);
  assert.equal(
    resolveAtlassianConfig({ JIRA_BASE_URL: "", JIRA_EMAIL: " ", JIRA_API_TOKEN: "" }),
    undefined,
  );
});

test("complete configuration resolves with the default loopback endpoint", () => {
  assert.deepEqual(resolveAtlassianConfig(complete), {
    baseUrl: "https://team.atlassian.net",
    email: "dev@example.com",
    apiToken: "fake-token",
    endpoint: DEFAULT_ATLASSIAN_MCP_URL,
  });
  assert.equal(
    resolveAtlassianConfig({ ...complete, JIRA_BASE_URL: "https://team.atlassian.net/" })?.baseUrl,
    "https://team.atlassian.net",
  );
  assert.equal(
    resolveAtlassianConfig({ ...complete, ATLASSIAN_MCP_URL: "http://[::1]:9000/mcp" })?.endpoint,
    "http://[::1]:9000/mcp",
  );
});

test("partial configuration is rejected", () => {
  for (const key of Object.keys(complete)) {
    const { [key]: _omitted, ...partial } = complete as Record<string, string>;
    assert.throws(() => resolveAtlassianConfig(partial), /together/);
  }
  assert.throws(
    () => resolveAtlassianConfig({ ATLASSIAN_MCP_URL: DEFAULT_ATLASSIAN_MCP_URL }),
    /requires JIRA_BASE_URL/,
  );
});

test("invalid sites are rejected", () => {
  for (const site of [
    "http://team.atlassian.net",
    "https://team.atlassian.net/wiki",
    "https://team.atlassian.net/?a=1",
    "https://user:pass@team.atlassian.net",
    "https://team.atlassian.net:8443",
    "https://example.com",
    "https://team.atlassian.net.evil.com",
    "not a url",
  ]) {
    assert.throws(() => resolveAtlassianConfig({ ...complete, JIRA_BASE_URL: site }), site);
  }
  assert.throws(
    () => resolveAtlassianConfig({ ...complete, JIRA_EMAIL: "not-an-email" }),
    /JIRA_EMAIL/,
  );
});

test("invalid endpoints are rejected", () => {
  for (const endpoint of [
    "https://127.0.0.1:8000/mcp",
    "http://localhost:8000/mcp",
    "http://192.168.1.5:8000/mcp",
    "http://example.com/mcp",
    "http://user:pass@127.0.0.1:8000/mcp",
    "http://127.0.0.1:8000/mcp?x=1",
    "http://127.0.0.1:8000/mcp#frag",
    "nonsense",
  ]) {
    assert.throws(
      () => resolveAtlassianConfig({ ...complete, ATLASSIAN_MCP_URL: endpoint }),
      endpoint,
    );
  }
});
