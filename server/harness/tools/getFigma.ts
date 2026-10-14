import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

const FIGMA_API = "https://api.figma.com/v1";
const TIMEOUT_MS = 30_000;
const MAX_DETAIL_BYTES = 30_000;
const SUMMARY_PAGE_SIZE = 20;
const FILE_KEY = /^[A-Za-z0-9]{10,128}$/;
const NODE_ID = /^I?\d+:\d+(;\d+:\d+)*$/;
const CONTAINER_TYPES = new Set([
  "DOCUMENT",
  "CANVAS",
  "FRAME",
  "GROUP",
  "SECTION",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
  "BOOLEAN_OPERATION",
]);

const inputSchema = z.object({
  target: z
    .string()
    .min(1)
    .describe("Figma file URL (https://www.figma.com/file/... or /design/...) or a bare file key"),
  nodeId: z
    .string()
    .optional()
    .describe("Node ID such as 1:2 or 1-2. Overrides the node-id in the URL"),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(2)
    .describe("How many levels of children to fetch, 1-10"),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Start index for paging through the node summary when the result is truncated"),
});

type FigmaPaint = {
  type?: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a?: number };
  imageRef?: string;
};

type FigmaNode = {
  id: string;
  name?: string;
  type?: string;
  visible?: boolean;
  characters?: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  children?: FigmaNode[];
  [key: string]: unknown;
};

type SimplifiedPaint = { type?: string; color?: string; opacity?: number; imageRef?: string };

type SimplifiedNode = {
  id: string;
  name?: string;
  type?: string;
  text?: string;
  size?: { x: number; y: number; width: number; height: number };
  layout?: Record<string, unknown>;
  style?: Record<string, unknown>;
  children?: SimplifiedNode[];
};

type SummaryNode = { id: string; name?: string; type?: string; level: number };

const LAYOUT_KEYS = [
  "layoutMode",
  "layoutWrap",
  "itemSpacing",
  "counterAxisSpacing",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
  "layoutSizingHorizontal",
  "layoutSizingVertical",
  "layoutAlign",
  "layoutGrow",
  "layoutPositioning",
  "constraints",
  "clipsContent",
] as const;

const STYLE_KEYS = [
  "opacity",
  "blendMode",
  "cornerRadius",
  "rectangleCornerRadii",
  "strokeWeight",
  "strokeAlign",
  "effects",
  "styles",
] as const;

const TEXT_STYLE_KEYS = [
  "fontFamily",
  "fontWeight",
  "fontSize",
  "italic",
  "lineHeightPx",
  "letterSpacing",
  "textAlignHorizontal",
  "textAlignVertical",
  "textCase",
  "textDecoration",
] as const;

function toUrl(target: string) {
  try {
    return new URL(target);
  } catch {
    throw new Error("Invalid Figma URL or file key");
  }
}

function isFigmaHost(url: URL) {
  return (
    url.protocol === "https:" &&
    (url.hostname === "figma.com" || url.hostname.endsWith(".figma.com"))
  );
}

function parseFigmaUrl(target: string) {
  const url = toUrl(target);

  if (!isFigmaHost(url)) {
    throw new Error("Only figma.com URLs are allowed");
  }

  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] !== "file" && segments[0] !== "design") {
    throw new Error("Invalid Figma URL: expected /file/ or /design/");
  }

  const branchIndex = segments.indexOf("branch");
  const fileKey = segments[branchIndex >= 0 ? branchIndex + 1 : 1] ?? "";

  if (!FILE_KEY.test(fileKey)) {
    throw new Error("Invalid Figma file key");
  }

  return { fileKey, nodeId: url.searchParams.get("node-id") };
}

function normalizeNodeId(raw: string | null | undefined) {
  if (!raw) {
    return null;
  }

  const normalized = raw.replaceAll("-", ":");

  if (!NODE_ID.test(normalized)) {
    throw new Error("Invalid Figma node ID");
  }

  return normalized;
}

export function parseFigmaTarget(target: string, nodeId?: string) {
  const trimmed = target.trim();
  const parsed = FILE_KEY.test(trimmed)
    ? { fileKey: trimmed, nodeId: null }
    : parseFigmaUrl(trimmed);

  return { fileKey: parsed.fileKey, nodeId: normalizeNodeId(nodeId?.trim() || parsed.nodeId) };
}

function toHex(value: number) {
  return Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, "0");
}

function simplifyPaints(paints: unknown): SimplifiedPaint[] | undefined {
  if (!Array.isArray(paints)) {
    return undefined;
  }

  const visible = (paints as FigmaPaint[])
    .filter((paint) => paint.visible !== false)
    .map((paint) => ({
      type: paint.type,
      ...(paint.color
        ? {
            color: `#${toHex(paint.color.r)}${toHex(paint.color.g)}${toHex(paint.color.b)}${
              paint.color.a !== undefined && paint.color.a < 1 ? toHex(paint.color.a) : ""
            }`,
          }
        : {}),
      ...(paint.opacity !== undefined && paint.opacity < 1 ? { opacity: paint.opacity } : {}),
      ...(paint.imageRef ? { imageRef: paint.imageRef } : {}),
    }));

  return visible.length > 0 ? visible : undefined;
}

function pick(node: FigmaNode, keys: readonly string[]) {
  const picked: Record<string, unknown> = {};

  for (const key of keys) {
    if (node[key] !== undefined && node[key] !== null) {
      picked[key] = node[key];
    }
  }

  return Object.keys(picked).length > 0 ? picked : undefined;
}

function compact(record: Record<string, unknown>) {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function simplifyStyle(node: FigmaNode) {
  const textStyle =
    node.style && typeof node.style === "object"
      ? pick(node.style as FigmaNode, TEXT_STYLE_KEYS)
      : undefined;

  return compact({
    ...pick(node, STYLE_KEYS),
    fills: simplifyPaints(node.fills),
    strokes: simplifyPaints(node.strokes),
    text: textStyle,
  });
}

function simplifyChildren(node: FigmaNode, state: { depthLimited: boolean }) {
  if (!Array.isArray(node.children)) {
    state.depthLimited ||= Boolean(node.type && CONTAINER_TYPES.has(node.type));
    return undefined;
  }

  const children = node.children
    .filter((child) => child.visible !== false)
    .map((child) => simplifyNode(child, state));

  return children.length > 0 ? children : undefined;
}

function simplifyNode(node: FigmaNode, state: { depthLimited: boolean }): SimplifiedNode {
  return compact({
    id: node.id,
    name: node.name,
    type: node.type,
    text: typeof node.characters === "string" ? node.characters : undefined,
    size: node.absoluteBoundingBox ?? undefined,
    layout: pick(node, LAYOUT_KEYS),
    style: simplifyStyle(node),
    children: simplifyChildren(node, state),
  }) as SimplifiedNode;
}

function flatten(node: SimplifiedNode, level = 0, out: SummaryNode[] = []) {
  out.push({ id: node.id, name: node.name, type: node.type, level });

  for (const child of node.children ?? []) {
    flatten(child, level + 1, out);
  }

  return out;
}

async function requestFigma(path: string, token: string, signal: AbortSignal) {
  const response = await fetch(`${FIGMA_API}${path}`, {
    headers: { "X-Figma-Token": token },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Figma API request failed (HTTP ${response.status})`);
  }

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error("Figma API returned a non-JSON response");
  }
}

type FigmaRequest = { fileKey: string; depth: number; token: string; signal: AbortSignal };

type FetchedRoot = { name: unknown; lastModified: unknown; root: FigmaNode };

function requestSignal(abortSignal?: AbortSignal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);

  return abortSignal ? AbortSignal.any([timeout, abortSignal]) : timeout;
}

async function fetchNode(request: FigmaRequest, nodeId: string): Promise<FetchedRoot> {
  const data = await requestFigma(
    `/files/${request.fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=${request.depth}`,
    request.token,
    request.signal,
  );
  const nodes = data.nodes as Record<string, { document?: FigmaNode } | null> | undefined;
  const root = nodes?.[nodeId]?.document;

  if (!root) {
    throw new Error("Figma node not found");
  }

  return { name: data.name, lastModified: data.lastModified, root };
}

async function fetchFile(request: FigmaRequest): Promise<FetchedRoot> {
  const data = await requestFigma(
    `/files/${request.fileKey}?depth=${request.depth}`,
    request.token,
    request.signal,
  );

  if (!data.document) {
    throw new Error("Figma file has no document");
  }

  return { name: data.name, lastModified: data.lastModified, root: data.document as FigmaNode };
}

function stringOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function paginate(document: SimplifiedNode, offset: number) {
  const nodes = flatten(document);
  const end = offset + SUMMARY_PAGE_SIZE;

  return {
    total: nodes.length,
    offset,
    nextOffset: end < nodes.length ? end : null,
    nodes: nodes.slice(offset, end),
  };
}

export const getFigma = toolDefinition({
  name: "get_figma",
  description:
    "Read a Figma file or a specific node (frame, component, layer) using the server's Figma token. " +
    "Returns node IDs, names, text, sizes, auto-layout and styles, with hidden nodes removed. " +
    "If the result is too large it returns a paged node summary instead (truncated: true); " +
    "call again with a specific nodeId to see details, or with nextOffset to page the summary. " +
    "depthLimited: true means some children were not fetched; raise depth or query a child node.",
  inputSchema,
}).server(async (args, context) => {
  const input = inputSchema.parse(args);
  const token = process.env.FIGMA_API_KEY;

  if (!token) {
    throw new Error("FIGMA_API_KEY is not configured");
  }

  const { fileKey, nodeId } = parseFigmaTarget(input.target, input.nodeId);
  const request = {
    fileKey,
    depth: input.depth,
    token,
    signal: requestSignal(context?.abortSignal),
  };
  const fetched = nodeId ? await fetchNode(request, nodeId) : await fetchFile(request);
  const state = { depthLimited: false };
  const document = simplifyNode(fetched.root, state);
  const base = {
    fileKey,
    fileName: stringOrNull(fetched.name),
    lastModified: stringOrNull(fetched.lastModified),
    nodeId,
    depth: input.depth,
    depthLimited: state.depthLimited,
  };
  const detailed = { ...base, truncated: false, document };

  if (Buffer.byteLength(JSON.stringify(detailed)) <= MAX_DETAIL_BYTES) {
    return detailed;
  }

  return { ...base, truncated: true, summary: paginate(document, input.offset) };
});
