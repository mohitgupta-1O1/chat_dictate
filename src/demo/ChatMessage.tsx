"use client";

import { useRef } from "react";
import { DictationToolbar, useDictation } from "@/features/dictation";
import { AgentMarkdown } from "./AgentMarkdown";
import { MarkdocMarkdown } from "./MarkdocMarkdown";
import type { DemoMessage } from "./messages";

export function ChatMessage({ message, isComplete = true }: { message: DemoMessage; isComplete?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const dictation = useDictation(ref, { isComplete });

  return (
    <article className="chat-message">
      <header className="chat-message-meta">Assistant · {message.renderer}</header>
      <div ref={ref} className="chat-message-body">
        {message.renderer === "markdoc" ? (
          <MarkdocMarkdown content={message.content} />
        ) : (
          <AgentMarkdown content={message.content} />
        )}
      </div>
      <DictationToolbar dictation={dictation} showVoicePicker />
    </article>
  );
}
