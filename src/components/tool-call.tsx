import type { ToolCallPart } from "@tanstack/ai";

const labels: Record<ToolCallPart["state"], string> = {
  "awaiting-input": "等待參數",
  "input-streaming": "接收參數中",
  "input-complete": "等待執行結果",
  "approval-requested": "等待核准",
  "approval-responded": "已回覆核准請求",
  complete: "已完成",
  error: "執行失敗",
};

export function ToolCall({ part }: { part: ToolCallPart }) {
  let args = part.arguments;
  try {
    args = JSON.stringify(JSON.parse(args), null, 2);
  } catch {}

  return (
    <details open className="min-w-0 rounded-lg border border-border bg-muted/30 p-3">
      <summary className="cursor-pointer break-all text-sm">
        <span className="font-mono">{part.name}</span>
        {" · "}
        <span role="status" className="text-muted-foreground">
          {labels[part.state]}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">傳入參數</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
          {args || "等待參數…"}
        </pre>
      </div>
    </details>
  );
}
