import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export function AgentMarkdown({ content }: { content: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
      {content}
    </Markdown>
  );
}
