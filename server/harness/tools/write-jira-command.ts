import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import { jiraEnv, ticketSchema } from "./jira";

const TIMEOUT_MS = 15_000;
const RETRY_WARNING = "The comment may have been written; check Jira before retrying.";
const inputSchema = z.object({
  ticket: ticketSchema.describe("Jira issue key, for example PROJ-123"),
  body: z
    .string()
    .max(32_767, "Jira comment body must be at most 32767 characters.")
    .refine((body) => body.trim().length > 0, "Jira comment body must not be blank.")
    .describe("Comment text. Must not be blank and must be at most 32767 characters."),
});
const commentSchema = z.object({
  id: z.string().min(1),
  body: z.string(),
  author: z.object({ displayName: z.string().optional() }).optional(),
  created: z.string().optional(),
});

export const writeJiraCommand = toolDefinition({
  name: "write_jira_command",
  description:
    "Adds one comment to a Jira issue. Ambiguous failures may have written it; check Jira before retrying.",
  inputSchema,
}).server(async (input, context) => {
  const { ticket: key, body } = inputSchema.parse(input);
  let configuration: ReturnType<typeof jiraEnv>;
  try {
    configuration = jiraEnv();
  } catch {
    throw new Error(
      "Jira configuration is missing or invalid. Check JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN.",
    );
  }
  const { baseUrl, auth } = configuration;
  const signal = AbortSignal.any([
    AbortSignal.timeout(TIMEOUT_MS),
    ...(context?.abortSignal ? [context.abortSignal] : []),
  ]);
  let response: Response;
  try {
    signal.throwIfAborted();
    response = await fetch(`${baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: auth,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
      signal,
    });
  } catch {
    throw new Error(`Jira comment request failed. ${RETRY_WARNING}`);
  }
  if (!response.ok) {
    throw new Error(`Jira comment request failed (HTTP ${response.status}). ${RETRY_WARNING}`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0].trim();
  if (!contentType || !/^application\/(?:[\w.+-]+\+)?json$/i.test(contentType)) {
    throw new Error(`Jira returned a non-JSON response. ${RETRY_WARNING}`);
  }
  let comment: z.infer<typeof commentSchema>;
  try {
    comment = commentSchema.parse(await response.json());
  } catch {
    throw new Error(`Jira returned an invalid comment response. ${RETRY_WARNING}`);
  }
  return {
    key,
    url: `${baseUrl}/browse/${encodeURIComponent(key)}?focusedCommentId=${encodeURIComponent(comment.id)}`,
    commentId: comment.id,
    body: comment.body,
    author: comment.author?.displayName ?? "Unknown",
    created: comment.created ?? "",
  };
});
