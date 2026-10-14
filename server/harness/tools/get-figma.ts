import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

const DETAIL_BYTE_LIMIT = 30_000;
const SUMMARY_PAGE_SIZE = 20;
const REQUEST_TIMEOUT_MS = 30_000;
const ALLOWED_HOSTS = new Set(["figma.com", "www.figma.com"]);

const KEEP_KEYS = new Set([
  "id",
  "name",
  "type",
  "characters",
  "style",
  "absoluteBoundingBox",
  "layoutMode",
  "layoutWrap",
  "layoutSizingHorizontal",
  "layoutSizingVertical",
  "layoutAlign",
  "layoutGrow",
  "layoutPositioning",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "itemSpacing",
  "counterAxisSpacing",
  "fills",
  "strokes",
  "strokeWeight",
  "effects",
  "cornerRadius",
  "rectangleCornerRadii",
  "opacity",
  "clipsContent",
  "componentId",
]);

const figmaNodeSchema: z.ZodType<FigmaNode> = z.lazy(() =>
  z
    .object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      visible: z.boolean().optional(),
      children: z.array(figmaNodeSchema).optional(),
    })
    .passthrough(),
);

type FigmaNode = {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  [key: string]: unknown;
};

type NodeSummary = { id: string; name: string; type: string };

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function parseFigmaUrl(raw: string): { fileKey: string; nodeId?: string } {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error("Expected a Figma URL.");
  }

  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error("Expected a Figma URL.");
  }

  const fileMatch = url.pathname.match(/^\/(?:file|design)\/([a-zA-Z0-9]+)(?:\/|$)/);

  if (!fileMatch) {
    throw new Error("Expected a Figma file or design URL.");
  }

  const branchMatch = url.pathname.match(/\/branch\/([a-zA-Z0-9]+)(?:\/|$)/);

  return {
    fileKey: branchMatch?.[1] ?? fileMatch[1],
    nodeId: url.searchParams.get("node-id") ?? undefined,
  };
}

function normalizeNodeId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/-/g, ":");

  if (!/^\d+:\d+$/.test(normalized)) {
    throw new Error("Invalid Figma node ID.");
  }

  return normalized;
}

function resolveTarget(target: string, nodeIdOverride?: string) {
  const trimmed = target.trim();
  let fileKey = trimmed;
  let nodeId = nodeIdOverride;

  if (isHttpUrl(trimmed)) {
    const parsed = parseFigmaUrl(trimmed);
    fileKey = parsed.fileKey;
    nodeId ??= parsed.nodeId;
  }

  if (!/^[a-zA-Z0-9]+$/.test(fileKey)) {
    throw new Error("Invalid Figma file key.");
  }

  return { fileKey, nodeId: normalizeNodeId(nodeId) };
}

function slimNode(node: FigmaNode): Record<string, unknown> {
  const slim: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (KEEP_KEYS.has(key)) {
      slim[key] = value;
    }
  }

  if (node.children) {
    slim.children = node.children.filter((child) => child.visible !== false).map(slimNode);
  }

  return slim;
}

function walkVisibleSummaries(root: FigmaNode): NodeSummary[] {
  const out: NodeSummary[] = [];

  const visit = (node: FigmaNode) => {
    if (node.visible === false) {
      return;
    }

    out.push({ id: node.id, name: node.name.slice(0, 200), type: node.type });
    node.children?.forEach(visit);
  };

  visit(root);

  return out;
}

function buildPayload(root: FigmaNode, fileKey: string, depth: number, offset: number) {
  const detail = {
    fileKey,
    depth,
    depthLimited: true as const,
    truncated: false as const,
    nodes: root.visible === false ? [] : [slimNode(root)],
  };

  if (Buffer.byteLength(JSON.stringify(detail)) <= DETAIL_BYTE_LIMIT) {
    return detail;
  }

  const summaries = walkVisibleSummaries(root);
  const page = summaries.slice(offset, offset + SUMMARY_PAGE_SIZE);
  const nextOffset =
    offset + SUMMARY_PAGE_SIZE < summaries.length ? offset + SUMMARY_PAGE_SIZE : null;

  return {
    fileKey,
    depth,
    depthLimited: true as const,
    truncated: true as const,
    nodes: page,
    nextOffset,
    totalNodes: summaries.length,
    nextAction:
      "Request a specific nodeId with a smaller depth, or use nextOffset to browse more nodes.",
  };
}

function fileEndpoint(fileKey: string, nodeId: string | undefined, depth: number): string {
  const params = new URLSearchParams({ depth: String(depth) });

  if (nodeId) {
    params.set("ids", nodeId);
  }

  const suffix = nodeId ? "/nodes" : "";

  return `https://api.figma.com/v1/files/${fileKey}${suffix}?${params}`;
}

function requestSignal(abortSignal?: AbortSignal): AbortSignal {
  return AbortSignal.any([
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(abortSignal ? [abortSignal] : []),
  ]);
}

function pickDocument(
  body: { document?: unknown; nodes?: Record<string, { document?: unknown } | null | undefined> },
  nodeId: string | undefined,
): unknown {
  if (!nodeId) {
    return body.document;
  }

  return body.nodes?.[nodeId]?.document;
}

export const getFigma = toolDefinition({
  name: "get_figma",
  description:
    "Read Figma design data by URL or file key. Start without a node ID to discover frames, then request a specific node. Oversized results return a paginated node summary instead of design details.",
  inputSchema: z.object({
    target: z.string().trim().min(1).max(2048),
    nodeId: z.string().trim().min(1).optional(),
    depth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2)
      .describe(
        "API depth limit; returned children may be incomplete. Request a node directly for more detail.",
      ),
    offset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Pagination offset for oversized result summaries."),
  }),
}).server(async ({ target, nodeId, depth = 2, offset = 0 }, context) => {
  const apiKey = process.env.FIGMA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing FIGMA_API_KEY environment variable.");
  }

  const { fileKey, nodeId: resolvedNodeId } = resolveTarget(target, nodeId);
  const response = await fetch(fileEndpoint(fileKey, resolvedNodeId, depth), {
    headers: { "X-Figma-Token": apiKey },
    signal: requestSignal(context?.abortSignal),
  });

  if (!response.ok) {
    throw new Error(`Figma request failed (${response.status} ${response.statusText}).`);
  }

  if (!response.headers.get("content-type")?.includes("json")) {
    throw new Error("Figma returned a non-JSON response.");
  }

  const document = pickDocument(await response.json(), resolvedNodeId);

  if (!document) {
    throw new Error("Figma node was not found.");
  }

  return buildPayload(figmaNodeSchema.parse(document), fileKey, depth, offset);
});
