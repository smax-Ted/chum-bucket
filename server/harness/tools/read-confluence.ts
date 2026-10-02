import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import { jiraEnv } from "./jira";

const TIMEOUT_MS = 15_000;
const MAX_CHARACTERS = 20_000;
const PAGE_ID = /^[1-9]\d*$/;
const TINY_TOKEN = /^[A-Za-z0-9_-]{1,11}$/;
const TARGET_ERROR =
  "Expected a positive Confluence Cloud page ID or a supported page URL on the configured /wiki base.";
const inputSchema = z.object({
  target: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .describe(
      "Positive page ID or a Confluence Cloud page URL, including /wiki/x/TOKEN, on the JIRA_BASE_URL site.",
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .nullish()
    .describe("HTML character offset. Omit or use null for 0; use nextOffset for the next chunk."),
});
const pageSchema = z.object({
  id: z.string().regex(PAGE_ID),
  title: z.string(),
  status: z.string(),
  spaceId: z.string(),
  version: z.object({ number: z.number().int(), createdAt: z.string().optional() }),
  body: z.object({ view: z.object({ value: z.string() }) }),
});

function confluenceEnv() {
  try {
    const { baseUrl, auth } = jiraEnv();
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.includes("?") ||
      url.href.includes("#") ||
      !["", "/wiki"].includes(path)
    ) {
      throw new Error();
    }
    return { baseUrl: `${url.origin}/wiki`, auth };
  } catch {
    throw new Error(
      "Confluence Cloud configuration is missing or invalid. Check JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN. Use an HTTP(S) site root or /wiki base without credentials, query, or fragment. Data Center and scoped-token gateways are not supported.",
    );
  }
}

function decodeTinyPageId(token: string) {
  if (!TINY_TOKEN.test(token)) {
    throw new Error(TARGET_ERROR);
  }
  const standard = token.replaceAll("-", "/").replaceAll("_", "+").padEnd(11, "A") + "=";
  const bytes = Buffer.from(standard, "base64");
  if (bytes.length !== 8) {
    throw new Error(TARGET_ERROR);
  }
  const id = bytes.readBigUInt64LE();
  const canonical = bytes
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/A+$/, "")
    .replaceAll("/", "-")
    .replaceAll("+", "_");
  if (id === 0n || id > (1n << 63n) - 1n || canonical !== token) {
    throw new Error(TARGET_ERROR);
  }
  return id.toString();
}

function parsePageId(target: string, baseUrl: string) {
  if (PAGE_ID.test(target)) {
    return target;
  }
  let url: URL;
  let decodedPath: string;
  try {
    url = new URL(target);
    decodedPath = decodeURIComponent(target.split(/[?#]/)[0]);
  } catch {
    throw new Error(TARGET_ERROR);
  }
  const base = new URL(baseUrl);
  if (
    !/^https?:\/\//i.test(target) ||
    /[\u0000-\u001f\u007f\\]/.test(target) ||
    decodedPath.includes("\\") ||
    /(?:^|\/)\.\.?(?:\/|$)/.test(decodedPath) ||
    url.username ||
    url.password ||
    url.origin !== base.origin ||
    !url.pathname.startsWith(`${base.pathname}/`)
  ) {
    throw new Error(TARGET_ERROR);
  }
  const path = url.pathname.slice(base.pathname.length);
  const match =
    path.match(/^\/spaces\/[^/]+\/pages\/([1-9]\d*)(?:\/[^/]+)?\/?$/) ??
    path.match(/^\/pages\/([1-9]\d*)\/?$/);
  if (match) {
    return match[1];
  }
  const tiny = path.match(/^\/x\/([^/]+)\/?$/);
  if (tiny) {
    return decodeTinyPageId(tiny[1]);
  }
  const ids = url.searchParams.getAll("pageId");
  if (path === "/pages/viewpage.action" && ids.length === 1 && PAGE_ID.test(ids[0])) {
    return ids[0];
  }
  throw new Error(TARGET_ERROR);
}

function requestError(signal: AbortSignal, timeout: AbortSignal) {
  if (signal.aborted) {
    const timedOut = timeout.aborted && signal.reason === timeout.reason;
    return new DOMException(
      timedOut ? "Confluence Cloud request timed out." : "Confluence Cloud request cancelled.",
      timedOut ? "TimeoutError" : "AbortError",
    );
  }
  return new Error("Confluence Cloud request failed.");
}

export const readConfluence = toolDefinition({
  name: "read_confluence",
  description:
    "Read one Confluence Cloud page by positive numeric ID or a configured-site /wiki/spaces/SPACE/pages/ID/title, /wiki/pages/ID, /wiki/pages/viewpage.action?pageId=ID, or canonical /wiki/x/TOKEN URL. Returns unchanged rendered HTML in chunks of up to 20000 characters; call again with nextOffset until it is null. Uses only shared JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN configuration. Confluence Cloud only; no temporary /wiki/l share links, redirect resolution, Data Center, scoped-token gateway, search, writes, comments, or attachment downloads.",
  inputSchema,
}).server(async (input, context) => {
  const { target, offset: requestedOffset } = inputSchema.parse(input);
  const offset = requestedOffset ?? 0;
  const { baseUrl, auth } = confluenceEnv();
  const id = parsePageId(target, baseUrl);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = AbortSignal.any([timeout, ...(context?.abortSignal ? [context.abortSignal] : [])]);
  let response: Response;
  try {
    signal.throwIfAborted();
    response = await fetch(`${baseUrl}/api/v2/pages/${id}?body-format=view`, {
      method: "GET",
      redirect: "error",
      headers: { Authorization: auth, Accept: "application/json", "User-Agent": "chum-bucket" },
      signal,
    });
    signal.throwIfAborted();
  } catch {
    throw requestError(signal, timeout);
  }
  if (!response.ok) {
    throw new Error(`Confluence Cloud request failed (HTTP ${response.status}).`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0].trim();
  if (!contentType || !/^application\/(?:[\w.+-]+\+)?json$/i.test(contentType)) {
    throw new Error("Confluence Cloud returned a non-JSON response.");
  }
  let page: z.infer<typeof pageSchema>;
  try {
    page = pageSchema.parse(await response.json());
    signal.throwIfAborted();
  } catch {
    if (signal.aborted) {
      throw requestError(signal, timeout);
    }
    throw new Error("Confluence Cloud returned an invalid page response.");
  }
  if (page.id !== id) {
    throw new Error("Confluence Cloud returned a different page ID.");
  }
  const totalCharacters = page.body.view.value.length;
  if (offset > totalCharacters) {
    throw new Error("Confluence HTML offset exceeds the document length.");
  }
  const body = page.body.view.value.slice(offset, offset + MAX_CHARACTERS);
  const end = offset + body.length;
  return {
    id: page.id,
    title: page.title,
    url: `${baseUrl}/pages/viewpage.action?pageId=${id}`,
    spaceId: page.spaceId,
    status: page.status,
    version: page.version,
    bodyFormat: "html",
    body,
    offset,
    totalCharacters,
    truncated: body.length < totalCharacters,
    nextOffset: end < totalCharacters ? end : null,
  };
});
