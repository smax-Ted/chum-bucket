import {
  BuiltinActionType,
  createParser,
  Renderer,
  type ActionEvent,
  type ParseResult,
} from "@openuidev/react-lang";
import { MarkDownRenderer } from "@openuidev/react-ui";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { useCallback, useMemo } from "react";
import remarkGfm from "remark-gfm";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent, MessageGroup, MessageHeader } from "@/components/ui/message";
import { type ChatMessage } from "./types";
import { ToolCall } from "./tool-call";

const assistantReplyParser = createParser(openuiLibrary.toJSONSchema(), openuiLibrary.root);
const openuiStart = /^\s*\$?[A-Za-z_]\w*\s*=(?!=)/;
const markdownOptions = { remarkPlugins: [remarkGfm] };

export function parseAssistantReply(text: string): ParseResult {
  return assistantReplyParser.parse(text);
}

function formFieldLines(state: Record<string, unknown>): string[] {
  const lines: string[] = [];

  for (const [key, field] of Object.entries(state)) {
    if (field && typeof field === "object" && "value" in field) {
      const value = (field as { value: unknown }).value;

      if (value !== undefined && value !== null && value !== "") {
        lines.push(`${key}: ${String(value)}`);
      }

      continue;
    }

    if (field && typeof field === "object" && !Array.isArray(field)) {
      for (const line of formFieldLines(field as Record<string, unknown>)) {
        lines.push(line);
      }
    }
  }

  return lines;
}

function actionMessage(event: ActionEvent): string {
  const parts: string[] = [];
  const label = event.humanFriendlyMessage.trim();

  if (label) {
    parts.push(label);
  }

  const context = event.params?.context;

  if (typeof context === "string" && context.trim()) {
    parts.push(context.trim());
  }

  if (event.formName && event.formState) {
    parts.push(...formFieldLines(event.formState));
  }

  return parts.join("\n");
}

function AssistantMessage({
  text,
  isStreaming,
  onAction,
}: {
  text: string;
  isStreaming: boolean;
  onAction?: (event: ActionEvent) => void;
}) {
  const result = useMemo(
    () => (isStreaming ? null : parseAssistantReply(text)),
    [text, isStreaming],
  );
  const errors = result?.meta.errors ?? [];

  if (!openuiStart.test(text) || result?.root === null) {
    return (
      <Bubble variant="muted" align="start">
        <BubbleContent>
          <MarkDownRenderer textMarkdown={text} options={markdownOptions} />
        </BubbleContent>
      </Bubble>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {errors.length > 0 ? (
        <p className="text-xs text-destructive">
          部分元件無法解析：
          {[...new Set(errors.map((error) => error.component))].join("、")}
        </p>
      ) : null}
      <Renderer
        response={text}
        library={openuiLibrary}
        isStreaming={isStreaming}
        onAction={onAction}
      />
    </div>
  );
}

function ChatMessageRow({
  message,
  agent,
  isStreaming,
  onSend,
}: {
  message: ChatMessage;
  agent: string;
  isStreaming: boolean;
  onSend?: (text: string) => void | Promise<unknown>;
}) {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("");

  const handleAction = useCallback(
    (event: ActionEvent) => {
      if (event.type === BuiltinActionType.ContinueConversation) {
        const payload = actionMessage(event);

        if (payload && onSend) {
          void onSend(payload);
        }

        return;
      }

      if (event.type === BuiltinActionType.OpenUrl) {
        const url = event.params?.url;

        if (typeof url === "string") {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      }
    },
    [onSend],
  );

  if (message.role === "system") {
    return (
      <Marker variant="separator">
        <MarkerContent>{text}</MarkerContent>
      </Marker>
    );
  }

  const align = message.role === "user" ? "end" : "start";
  const header = message.metadata?.fromSummary
    ? "摘要"
    : message.role === "assistant"
      ? agent
      : null;

  return (
    <Message align={align}>
      <MessageContent>
        {header ? <MessageHeader>{header}</MessageHeader> : null}
        {message.role === "assistant" ? (
          <div className="flex min-w-0 flex-col gap-2">
            {message.parts.map((part) =>
              part.type === "tool-call" ? <ToolCall key={part.id} part={part} /> : null,
            )}
            {text.trim() !== "" ? (
              <AssistantMessage text={text} isStreaming={isStreaming} onAction={handleAction} />
            ) : null}
          </div>
        ) : (
          <Bubble variant="default" align={align}>
            <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
          </Bubble>
        )}
      </MessageContent>
    </Message>
  );
}

export function MessageList({
  messages,
  agent,
  isStreaming = false,
  onSend,
}: {
  messages: ChatMessage[];
  agent: string;
  isStreaming?: boolean;
  onSend?: (text: string) => void | Promise<unknown>;
}) {
  const streamingId = isStreaming ? messages.at(-1)?.id : undefined;

  return (
    <MessageGroup className="gap-4">
      {messages.map((message) => (
        <ChatMessageRow
          key={message.id}
          message={message}
          agent={agent}
          isStreaming={message.id === streamingId && message.role === "assistant"}
          onSend={onSend}
        />
      ))}
    </MessageGroup>
  );
}
