import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

const FIGMA_API = "https://api.figma.com/v1";

type Color = { r: number; g: number; b: number; a: number };

type Paint = {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: Color;
  imageRef?: string;
};

type FigmaNode = {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  cornerRadius?: number;
  opacity?: number;
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  characters?: string;
  style?: {
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number;
    lineHeightPx?: number;
    letterSpacing?: number;
    textAlignHorizontal?: string;
  };
  componentId?: string;
};

type SimplifiedNode = {
  id: string;
  name: string;
  type: string;
  size?: { width: number; height: number };
  layout?: {
    mode: string;
    gap?: number;
    padding?: [number, number, number, number];
    mainAxis?: string;
    crossAxis?: string;
  };
  cornerRadius?: number;
  opacity?: number;
  fills?: string[];
  strokes?: { colors: string[]; weight?: number };
  text?: string;
  font?: FigmaNode["style"];
  componentId?: string;
  children?: SimplifiedNode[];
};

const toHex = (value: number) =>
  Math.round(value * 255)
    .toString(16)
    .padStart(2, "0");

function paintToString(paint: Paint): string {
  if (paint.type === "SOLID" && paint.color) {
    const { r, g, b, a } = paint.color;
    const alpha = a * (paint.opacity ?? 1);

    return `#${toHex(r)}${toHex(g)}${toHex(b)}${alpha < 1 ? toHex(alpha) : ""}`;
  }

  if (paint.type === "IMAGE") {
    return `image(${paint.imageRef ?? ""})`;
  }

  return paint.type.toLowerCase();
}

function paintsToStrings(paints?: Paint[]): string[] {
  return (paints ?? []).filter((paint) => paint.visible !== false).map(paintToString);
}

function layoutOf(node: FigmaNode): SimplifiedNode["layout"] {
  if (!node.layoutMode || node.layoutMode === "NONE") {
    return undefined;
  }

  return {
    mode: node.layoutMode,
    gap: node.itemSpacing,
    padding: [
      node.paddingTop ?? 0,
      node.paddingRight ?? 0,
      node.paddingBottom ?? 0,
      node.paddingLeft ?? 0,
    ],
    mainAxis: node.primaryAxisAlignItems,
    crossAxis: node.counterAxisAlignItems,
  };
}

function simplify(node: FigmaNode): SimplifiedNode {
  const box = node.absoluteBoundingBox;
  const fills = paintsToStrings(node.fills);
  const strokes = paintsToStrings(node.strokes);
  const children = node.children?.filter((child) => child.visible !== false);

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    ...(box && { size: { width: Math.round(box.width), height: Math.round(box.height) } }),
    layout: layoutOf(node),
    ...(node.cornerRadius && { cornerRadius: node.cornerRadius }),
    ...(node.opacity !== undefined && node.opacity < 1 && { opacity: node.opacity }),
    ...(fills.length > 0 && { fills }),
    ...(strokes.length > 0 && { strokes: { colors: strokes, weight: node.strokeWeight } }),
    ...(node.characters !== undefined && { text: node.characters, font: node.style }),
    ...(node.componentId && { componentId: node.componentId }),
    ...(children?.length && { children: children.map(simplify) }),
  };
}

function parseFigmaUrl(url: string): { fileKey: string; nodeId?: string } {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const kindIndex = segments.findIndex((segment) =>
    ["design", "file", "proto", "board", "make"].includes(segment),
  );
  const fileKey =
    segments[kindIndex + 2] === "branch" ? segments[kindIndex + 3] : segments[kindIndex + 1];

  if (kindIndex === -1 || !fileKey) {
    throw new Error(`無法從網址解析 Figma file key：${url}`);
  }

  const nodeId = parsed.searchParams.get("node-id")?.replaceAll("-", ":");

  return { fileKey, ...(nodeId && { nodeId }) };
}

async function figmaFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const token = process.env.FIGMA_API_KEY;

  if (!token) {
    throw new Error("尚未設定 FIGMA_API_KEY");
  }

  const response = await fetch(`${FIGMA_API}${path}?${new URLSearchParams(params)}`, {
    headers: { "X-Figma-Token": token },
  });

  if (!response.ok) {
    throw new Error(`Figma API ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as T;
}

export const getFigma = toolDefinition({
  name: "get_figma",
  description:
    "讀取 Figma 檔案或節點的設計結構（圖層樹、尺寸、Auto Layout、顏色、文字與字型）。傳入 Figma 網址；網址帶 node-id 時只回傳該節點，否則回傳檔案的頁面與頂層 frame 概覽。可選擇一併取得該節點的 PNG 預覽圖網址。",
  inputSchema: z.object({
    url: z
      .url()
      .describe(
        "Figma 檔案或節點網址，例如 https://www.figma.com/design/<fileKey>/<name>?node-id=1-2",
      ),
    depth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("要往下展開的圖層深度，預設節點為 4、整個檔案為 2"),
    includeImage: z.boolean().optional().describe("是否一併回傳節點的 PNG 預覽圖網址"),
  }),
}).server(async ({ url, depth, includeImage }) => {
  const { fileKey, nodeId } = parseFigmaUrl(url);

  if (!nodeId) {
    const file = await figmaFetch<{ name: string; lastModified: string; document: FigmaNode }>(
      `/files/${fileKey}`,
      { depth: String(depth ?? 2) },
    );

    return {
      fileKey,
      name: file.name,
      lastModified: file.lastModified,
      document: simplify(file.document),
    };
  }

  const [nodes, images] = await Promise.all([
    figmaFetch<{
      name: string;
      lastModified: string;
      nodes: Record<string, { document: FigmaNode } | null>;
    }>(`/files/${fileKey}/nodes`, { ids: nodeId, depth: String(depth ?? 4) }),
    includeImage
      ? figmaFetch<{ images: Record<string, string | null> }>(`/images/${fileKey}`, {
          ids: nodeId,
          format: "png",
          scale: "2",
        })
      : undefined,
  ]);

  const node = nodes.nodes[nodeId];

  if (!node) {
    throw new Error(`在檔案 ${fileKey} 中找不到節點 ${nodeId}`);
  }

  return {
    fileKey,
    nodeId,
    name: nodes.name,
    lastModified: nodes.lastModified,
    document: simplify(node.document),
    ...(images?.images[nodeId] && { imageUrl: images.images[nodeId] }),
  };
});
