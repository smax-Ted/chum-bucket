import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

const TIMEOUT_MS = 15_000;
const COMMENT_LIMIT = 10;
const WANTED_FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "labels",
  "created",
  "updated",
  "comment",
].join(",");

const namedField = z.object({ name: z.string().optional() }).nullish();
const person = z.object({ displayName: z.string().optional() }).nullish();
const issueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().optional(),
    description: z.string().nullish(),
    status: namedField,
    issuetype: namedField,
    priority: namedField,
    assignee: person,
    reporter: person,
    labels: z.array(z.string()).optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    comment: z
      .object({
        total: z.number().int().nonnegative().optional(),
        comments: z
          .array(
            z.object({
              author: person,
              created: z.string().optional(),
              body: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  }),
});
const ticketSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]*-\d+$/, "Expected a Jira issue key such as PROJ-123.");

function jiraEnv() {
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

export const getTicket = toolDefinition({
  name: "get_ticket",
  description:
    "Read a Jira issue by key: summary, status, people, description, and up to 10 comments from the API's returned comment page. Comments may be incomplete and are not guaranteed to be the latest.",
  inputSchema: z.object({ ticket: ticketSchema.describe("Jira issue key, for example PROJ-123") }),
}).server(async ({ ticket }, context) => {
  const key = ticketSchema.parse(ticket);
  const { baseUrl, auth } = jiraEnv();
  const response = await fetch(
    `${baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${WANTED_FIELDS}`,
    {
      headers: { Authorization: auth, Accept: "application/json" },
      signal: AbortSignal.any([
        AbortSignal.timeout(TIMEOUT_MS),
        ...(context?.abortSignal ? [context.abortSignal] : []),
      ]),
    },
  );

  if (!response.ok)
    {throw new Error(`Jira request failed (${response.status} ${response.statusText}).`);}
  if (!response.headers.get("content-type")?.includes("json")) {
    throw new Error("Jira returned a non-JSON response.");
  }

  const issue = issueSchema.parse(await response.json());
  const fields = issue.fields;
  const allComments = fields.comment?.comments ?? [];
  const comments = allComments.slice(-COMMENT_LIMIT).map((comment) => ({
    author: comment.author?.displayName ?? "Unknown",
    created: comment.created ?? "",
    body: comment.body ?? "",
  }));
  const commentCount = fields.comment?.total ?? allComments.length;

  return {
    key: issue.key,
    url: `${baseUrl}/browse/${encodeURIComponent(issue.key)}`,
    summary: fields.summary ?? "",
    type: fields.issuetype?.name ?? "",
    status: fields.status?.name ?? "",
    priority: fields.priority?.name ?? "",
    assignee: fields.assignee?.displayName ?? "Unassigned",
    reporter: fields.reporter?.displayName ?? "",
    labels: fields.labels ?? [],
    created: fields.created ?? "",
    updated: fields.updated ?? "",
    description: fields.description ?? "",
    commentCount,
    commentsTruncated: commentCount > comments.length,
    comments,
  };
});
