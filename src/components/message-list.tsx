import {
  BuiltinActionType,
  createParser,
  Renderer,
  type ActionEvent,
  type ParseResult,
} from "@openuidev/react-lang";
import { MarkDownRenderer } from "@openuidev/react-ui";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { useMemo } from "react";
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

function actionMessage({ humanFriendlyMessage, params, formState }: ActionEvent): string {
  const context = typeof params.context === "string" ? params.context : "";
  const lines = [humanFriendlyMessage, context];

  if (formState && Object.keys(formState).length > 0) {
    lines.push(JSON.stringify(formState));
  }

  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))].join("\n\n");
}

function handleAction(event: ActionEvent, onSend?: (text: string) => void) {
  if (event.type === BuiltinActionType.OpenUrl) {
    const url = event.params.url;

    if (typeof url === "string" && url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }

    return;
  }

  if (event.type === BuiltinActionType.ContinueConversation) {
    const text = actionMessage(event);

    if (text) {
      onSend?.(text);
    }
  }
}

function AssistantMessage({
  text,
  isStreaming,
  onSend,
}: {
  text: string;
  isStreaming: boolean;
  onSend?: (text: string) => void;
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
        onAction={(event) => handleAction(event, onSend)}
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
  onSend?: (text: string) => void;
}) {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("");

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
              <AssistantMessage text={text} isStreaming={isStreaming} onSend={onSend} />
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
  onSend?: (text: string) => void;
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
