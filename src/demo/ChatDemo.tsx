"use client";

import { useEffect, useState } from "react";
import { ChatMessage } from "./ChatMessage";
import { DEMO_MESSAGES, STREAMING_MESSAGE } from "./messages";

// Simulates a response that streams in, so the disabled-until-complete state is visible.
function useStreamedText(full: string): string {
  const [text, setText] = useState("");
  useEffect(() => {
    const parts = full.split(/(\s+)/);
    let count = 0;
    const timer = setInterval(() => {
      count += 2;
      setText(parts.slice(0, count).join(""));
      if (count >= parts.length) clearInterval(timer);
    }, 30);
    return () => clearInterval(timer);
  }, [full]);
  return text;
}

export function ChatDemo() {
  const streamed = useStreamedText(STREAMING_MESSAGE.content);
  const isComplete = streamed.length >= STREAMING_MESSAGE.content.length;

  return (
    <div className="chat-scroll">
      <div className="chat-user">Explain compound interest.</div>
      <ChatMessage message={DEMO_MESSAGES[0]} />
      <div className="chat-user">Summarise the report.</div>
      <ChatMessage message={DEMO_MESSAGES[1]} />
      <div className="chat-user">Give me a long answer.</div>
      <ChatMessage message={{ ...STREAMING_MESSAGE, content: streamed }} isComplete={isComplete} />
    </div>
  );
}
