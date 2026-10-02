import { z } from "zod";

export const ticketSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]*-\d+$/, "Expected a Jira issue key such as PROJ-123.");

export function jiraEnv() {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error("Missing JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN environment variables.");
  }

  const url = new URL(JIRA_BASE_URL);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "JIRA_BASE_URL must be an HTTP(S) base URL without credentials, query, or fragment.",
    );
  }

  return {
    baseUrl: url.href.replace(/\/+$/, ""),
    auth: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`,
  };
}
