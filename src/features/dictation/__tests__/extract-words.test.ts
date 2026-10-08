import { afterEach, describe, expect, it } from "vitest";
import { extractWords, wordIndexAtOffset, wordIndexAtPoint, type ExtractedText } from "../extract-words";

function mount(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

const spoken = (r: ExtractedText) => r.words.map((w) => r.text.slice(w.start, w.end));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("extractWords", () => {
  it("returns empty text for an empty container", () => {
    expect(extractWords(mount(""))).toEqual({ text: "", words: [] });
  });

  it("separates paragraphs as sentences", () => {
    const r = extractWords(mount("<p>Hello world</p><p>Second para.</p>"));
    expect(r.text).toBe("Hello world. Second para.");
    expect(spoken(r)).toEqual(["Hello", "world", "Second", "para."]);
  });

  it("does not add spaces around inline formatting", () => {
    const r = extractWords(mount("<p>A <strong>bold</strong> move, <em>really</em>.</p>"));
    expect(r.text).toBe("A bold move, really.");
    expect(spoken(r)).toEqual(["A", "bold", "move,", "really", "."]);
  });

  it("collapses whitespace", () => {
    expect(extractWords(mount("<p>  lots   of\n\n spaces </p>")).text).toBe("lots of spaces.");
  });

  it("reads list items and headings as sentences", () => {
    const r = extractWords(mount("<h2>Overview</h2>\n<ul>\n<li>First item</li>\n<li>Second item</li>\n</ul>"));
    expect(r.text).toBe("Overview. First item. Second item.");
  });

  it("reads tables row by row", () => {
    const r = extractWords(
      mount("<table><tr><th>Name</th><th>Age</th></tr><tr><td>Ann</td><td>30</td></tr></table>"),
    );
    expect(r.text).toBe("Name Age. Ann 30.");
  });

  it("replaces code blocks with a phrase that has no range", () => {
    const r = extractWords(mount("<p>Run this:</p><pre><code>npm i\nfoo</code></pre><p>Done</p>"));
    expect(r.text).toBe("Run this: code block. Done.");
    expect(spoken(r)).toEqual(["Run", "this:", "code", "block", "Done"]);
    expect(r.words[2].range).toBeNull();
    expect(r.words[3].range).toBeNull();
  });

  it("reads inline code normally", () => {
    expect(extractWords(mount("<p>Use <code>npm</code> now</p>")).text).toBe("Use npm now.");
  });

  it("replaces KaTeX with 'equation'", () => {
    const r = extractWords(
      mount(
        '<p>So <span class="katex"><span class="katex-mathml">x</span><span class="katex-html" aria-hidden="true">x</span></span> grows</p>',
      ),
    );
    expect(r.text).toBe("So equation grows.");
  });

  it("skips citations and opted-out elements", () => {
    const r = extractWords(
      mount('<p>Fact<sup data-citation="1">[1]</sup> here <span data-dictation="skip">hidden</span>now</p>'),
    );
    expect(r.text).toBe("Fact here now.");
  });

  it("skips hidden and screen-reader-only content", () => {
    expect(extractWords(mount('<p>a <span class="sr-only">b</span> c</p>')).text).toBe("a c.");
    expect(extractWords(mount('<p>a <span class="visually-hidden">b</span> c</p>')).text).toBe("a c.");
    expect(extractWords(mount("<p>a <span hidden>b</span> c</p>")).text).toBe("a c.");
  });

  it("gives every ranged word a DOM range covering exactly its text", () => {
    const r = extractWords(mount("<h1>Title</h1><p>Some <strong>bold</strong> text, <em>ok</em>?</p><ul><li>a b</li></ul>"));
    for (const w of r.words) {
      expect(w.range?.toString()).toBe(r.text.slice(w.start, w.end));
    }
  });

  it("honours custom options", () => {
    const r = extractWords(mount("<p>See</p><pre>x = 1</pre><p>end</p>"), { replace: [], skip: "" });
    expect(r.text).toBe("See. x = 1. end.");
  });
});

describe("wordIndexAtOffset", () => {
  const { words } = extractWords(mount("<p>alpha beta gamma</p>"));

  it("maps offsets to the word that starts at or before them", () => {
    expect(wordIndexAtOffset(words, 0)).toBe(0);
    expect(wordIndexAtOffset(words, 5)).toBe(0);
    expect(wordIndexAtOffset(words, 6)).toBe(1);
    expect(wordIndexAtOffset(words, 999)).toBe(2);
  });

  it("returns -1 before the first word or for no words", () => {
    expect(wordIndexAtOffset(words, -1)).toBe(-1);
    expect(wordIndexAtOffset([], 0)).toBe(-1);
  });
});

describe("wordIndexAtPoint", () => {
  it("maps a caret position in a text node to a word", () => {
    const el = mount("<p>alpha beta gamma</p>");
    const { words } = extractWords(el);
    const node = el.querySelector("p")!.firstChild!;
    expect(wordIndexAtPoint(words, node, 0)).toBe(0);
    expect(wordIndexAtPoint(words, node, 6)).toBe(1);
    expect(wordIndexAtPoint(words, node, 10)).toBe(1);
    expect(wordIndexAtPoint(words, node, 11)).toBe(2);
    expect(wordIndexAtPoint(words, node, 16)).toBe(2);
  });

  it("returns -1 for a node without words", () => {
    const el = mount("<p>alpha</p>");
    const { words } = extractWords(el);
    expect(wordIndexAtPoint(words, document.body, 0)).toBe(-1);
  });
});
