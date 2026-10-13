import { figmaLinkSchema, type FigmaLink, type Source } from "../../shared/testing";
const MAX_LINKS = 20;

const FIGMA_HOSTS = new Set(["figma.com", "www.figma.com"]);

export function figmaUrlTarget(target: string): { fileKey: string; nodeId: string | undefined } {
  const url = new URL(target);

  if (!FIGMA_HOSTS.has(url.hostname)) {
    throw new Error("Expected a Figma URL.");
  }

  const match = url.pathname.match(/^\/(?:file|design)\/([a-zA-Z0-9]+)(?:\/|$)/);

  if (!match) {
    throw new Error("Expected a Figma file or design URL.");
  }

  return {
    fileKey: url.pathname.match(/\/branch\/([a-zA-Z0-9]+)(?:\/|$)/)?.[1] ?? match[1]!,
    nodeId: url.searchParams.get("node-id") ?? undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readSource(nativeName: string, input: unknown): Source | null {
  if (!isRecord(input)) {
    return null;
  }

  if (nativeName === "jira_get_issue" && typeof input.issue_key === "string") {
    return { kind: "jira", issueKey: input.issue_key };
  }

  if (nativeName === "confluence_get_page" && typeof input.page_id === "string") {
    return { kind: "confluence", pageId: input.page_id };
  }

  return null;
}

export function jiraIssue(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    return null;
  }

  let issue: unknown = raw;

  if (typeof raw.result === "string") {
    try {
      issue = JSON.parse(raw.result);
    } catch {
      return null;
    }
  }

  return isRecord(issue) && typeof issue.key === "string" && issue.key.trim() ? issue : null;
}

function remoteLinkObject(item: unknown): Record<string, unknown> | null {
  return isRecord(item) && isRecord(item.object) ? item.object : null;
}

function figmaNodeId(raw: string | undefined): string | undefined {
  const nodeId = raw?.replace(/-/g, ":");

  return nodeId && /^\d+:\d+$/.test(nodeId) ? nodeId : undefined;
}

function figmaLink(item: unknown): FigmaLink | null {
  const object = remoteLinkObject(item);

  if (typeof object?.url !== "string") {
    return null;
  }

  try {
    const target = figmaUrlTarget(object.url);
    const nodeId = figmaNodeId(target.nodeId);
    const label = typeof object.title === "string" ? object.title.trim().slice(0, 256) : "";
    const link = figmaLinkSchema.safeParse({
      url: object.url,
      ...(label ? { label } : {}),
      fileKey: target.fileKey,
      ...(nodeId ? { nodeId } : {}),
    });

    return link.success ? link.data : null;
  } catch {
    return null;
  }
}

export function figmaLinks(raw: unknown): readonly FigmaLink[] {
  const remoteLinks = jiraIssue(raw)?.remote_links;

  if (!Array.isArray(remoteLinks)) {
    return [];
  }

  const links = new Map<string, FigmaLink>();

  for (const item of remoteLinks) {
    const link = figmaLink(item);

    if (link) {
      const key = `${link.fileKey}#${link.nodeId ?? ""}`;

      if (!links.has(key)) {
        links.set(key, link);
      }
    }
  }

  return [...links.values()].slice(0, MAX_LINKS);
}

export function withRemoteLinks(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const include = typeof input.include === "string" ? input.include.trim() : "";
  const covered = include.split(",").some((part) => ["all", "remote_links"].includes(part.trim()));

  if (covered) {
    return input;
  }

  return { ...input, include: include ? `${include},remote_links` : "remote_links" };
}

export function withPageMetadata(input: unknown): unknown {
  return isRecord(input) ? { ...input, include_metadata: true } : input;
}
