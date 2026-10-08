import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { extractWords } from "@/features/dictation/extract-words";
import { AgentMarkdown } from "../AgentMarkdown";
import { MarkdocMarkdown } from "../MarkdocMarkdown";

function mount(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

function expectRangesMatch(el: HTMLElement) {
  const { text, words } = extractWords(el);
  for (const w of words) if (w.range) expect(w.range.toString()).toBe(text.slice(w.start, w.end));
}

afterEach(() => {
  document.body.innerHTML = "";
});

const MARKDOWN = [
  "# Title",
  "",
  "Some **bold** text with `code`.",
  "",
  "- one",
  "- two",
  "",
  "| A | B |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "Math $x^2$ here.",
].join("\n");

describe("extraction from real renderer output", () => {
  it("handles react-markdown with GFM and KaTeX", () => {
    const el = mount(renderToStaticMarkup(<AgentMarkdown content={MARKDOWN} />));
    expect(extractWords(el).text).toBe(
      "Title. Some bold text with code. one. two. A B. 1 2. code block. Math equation here.",
    );
    expectRangesMatch(el);
  });

  it("handles Markdoc with citations and fences", () => {
    const source = ["# Title", "", "Fact {% citation id=1 /%} here.", "", "```js", "x", "```"].join("\n");
    const el = mount(renderToStaticMarkup(<MarkdocMarkdown content={source} />));
    expect(extractWords(el).text).toBe("Title. Fact here. code block.");
    expectRangesMatch(el);
  });
});
