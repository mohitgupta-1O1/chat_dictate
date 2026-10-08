import { afterEach, describe, expect, it, vi } from "vitest";
import { createHighlighter } from "../highlighter";

class FakeHighlight {
  ranges: Range[];
  priority = 0;
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

function stubHighlightApi() {
  const registry = new Map<string, FakeHighlight>();
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal("Highlight", FakeHighlight);
  return registry;
}

function wordRange(text = "hello world"): Range {
  const p = document.createElement("p");
  p.textContent = text;
  document.body.appendChild(p);
  const range = document.createRange();
  range.setStart(p.firstChild!, 0);
  range.setEnd(p.firstChild!, 5);
  return range;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("with the CSS Custom Highlight API", () => {
  it("registers the range under dictation-word", () => {
    const registry = stubHighlightApi();
    const range = wordRange();
    createHighlighter({ autoScroll: false }).show(range);
    expect(registry.get("dictation-word")?.ranges).toEqual([range]);
  });

  it("clear removes only its own highlight", () => {
    const registry = stubHighlightApi();
    const a = createHighlighter({ autoScroll: false });
    const b = createHighlighter({ autoScroll: false });
    a.show(wordRange());
    b.show(wordRange());
    a.clear();
    expect(registry.has("dictation-word")).toBe(true);
    b.clear();
    expect(registry.has("dictation-word")).toBe(false);
  });

  it("show(null) clears the highlight", () => {
    const registry = stubHighlightApi();
    const h = createHighlighter({ autoScroll: false });
    h.show(wordRange());
    h.show(null);
    expect(registry.has("dictation-word")).toBe(false);
  });
});

describe("overlay fallback", () => {
  it("draws one box per client rect and removes them on clear", () => {
    const range = wordRange();
    Object.assign(range, {
      getClientRects: () => [
        { left: 10, top: 20, width: 30, height: 12 },
        { left: 0, top: 40, width: 15, height: 12 },
      ],
    });
    const h = createHighlighter({ autoScroll: false });
    h.show(range);
    const boxes = document.querySelectorAll<HTMLElement>(".dictation-overlay-box");
    expect(boxes).toHaveLength(2);
    expect(boxes[0].style.left).toBe("10px");
    expect(boxes[0].style.top).toBe("20px");
    h.clear();
    expect(document.querySelectorAll(".dictation-overlay-box")).toHaveLength(0);
  });
});

describe("auto-scroll", () => {
  function rangeAt(top: number): Range {
    const range = wordRange();
    Object.assign(range, {
      getBoundingClientRect: () => ({ top, bottom: top + 12, left: 0, right: 10, width: 10, height: 12 }),
    });
    return range;
  }

  it("scrolls the window when the word is below the viewport", () => {
    stubHighlightApi();
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    createHighlighter().show(rangeAt(2000));
    expect(scrollBy).toHaveBeenCalledWith({ top: 2000 - window.innerHeight / 3, behavior: "smooth" });
  });

  it("does not scroll when the word is visible or auto-scroll is off", () => {
    stubHighlightApi();
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    createHighlighter().show(rangeAt(100));
    createHighlighter({ autoScroll: false }).show(rangeAt(2000));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("does not scroll when show is told not to", () => {
    stubHighlightApi();
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    createHighlighter().show(rangeAt(2000), { scroll: false });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("scrollIntoView scrolls even when the word is visible", () => {
    stubHighlightApi();
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const h = createHighlighter();
    const range = rangeAt(100);
    h.show(range);
    expect(scrollBy).not.toHaveBeenCalled();
    h.scrollIntoView(range);
    expect(scrollBy).toHaveBeenCalledWith({ top: 100 - window.innerHeight / 3, behavior: "smooth" });
  });

  it("scrollIntoView does nothing when auto-scroll is off", () => {
    stubHighlightApi();
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    createHighlighter({ autoScroll: false }).scrollIntoView(rangeAt(2000));
    expect(scrollBy).not.toHaveBeenCalled();
  });
});

describe("sentence layer", () => {
  it("registers the sentence under dictation-sentence below the word", () => {
    const registry = stubHighlightApi();
    const h = createHighlighter({ autoScroll: false });
    const word = wordRange();
    const sentence = wordRange("a whole sentence");
    h.show(word);
    h.showSentence(sentence);
    expect(registry.get("dictation-sentence")?.ranges).toEqual([sentence]);
    expect(registry.get("dictation-sentence")!.priority).toBeLessThan(registry.get("dictation-word")!.priority);
  });

  it("showSentence(null) clears only the sentence; clear() clears both", () => {
    const registry = stubHighlightApi();
    const h = createHighlighter({ autoScroll: false });
    h.show(wordRange());
    h.showSentence(wordRange());
    h.showSentence(null);
    expect(registry.has("dictation-sentence")).toBe(false);
    expect(registry.has("dictation-word")).toBe(true);
    h.showSentence(wordRange());
    h.clear();
    expect(registry.size).toBe(0);
  });

  it("never scrolls for the sentence", () => {
    stubHighlightApi();
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const range = wordRange();
    Object.assign(range, {
      getBoundingClientRect: () => ({ top: 2000, bottom: 2012, left: 0, right: 10, width: 10, height: 12 }),
    });
    createHighlighter().showSentence(range);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("draws overlay sentence boxes without the Highlight API", () => {
    const range = wordRange();
    Object.assign(range, { getClientRects: () => [{ left: 1, top: 2, width: 3, height: 4 }] });
    const h = createHighlighter({ autoScroll: false });
    h.showSentence(range);
    expect(document.querySelectorAll(".dictation-overlay-sentence")).toHaveLength(1);
    expect(document.querySelectorAll(".dictation-overlay-box")).toHaveLength(0);
    h.clear();
    expect(document.querySelectorAll(".dictation-overlay-sentence")).toHaveLength(0);
  });

  it("keeps overlay word and sentence boxes independent", () => {
    const rects = (range: Range) =>
      Object.assign(range, { getClientRects: () => [{ left: 1, top: 2, width: 3, height: 4 }] });
    const h = createHighlighter({ autoScroll: false });
    const count = (selector: string) => document.querySelectorAll(selector).length;
    h.showSentence(rects(wordRange("a whole sentence")));
    h.show(rects(wordRange()));
    expect(count(".dictation-overlay-sentence")).toBe(1);
    expect(count(".dictation-overlay-box")).toBe(1);
    h.show(null);
    expect(count(".dictation-overlay-sentence")).toBe(1);
    expect(count(".dictation-overlay-box")).toBe(0);
    h.show(rects(wordRange()));
    h.showSentence(null);
    expect(count(".dictation-overlay-sentence")).toBe(0);
    expect(count(".dictation-overlay-box")).toBe(1);
  });
});
