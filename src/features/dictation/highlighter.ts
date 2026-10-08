import { HIGHLIGHT_NAME, SENTENCE_HIGHLIGHT_NAME } from "./constants";

export interface Highlighter {
  /**
   * Highlights `range`; `null` clears (used for spoken phrases like "code block").
   * `scroll: false` skips auto-scroll (the user scrolled away).
   */
  show(range: Range | null, options?: { scroll?: boolean }): void;
  /** Highlights the current sentence beneath the word; `null` clears it. Never scrolls. */
  showSentence(range: Range | null): void;
  /** Scrolls `range` into view now, even if it is already visible. No-op without auto-scroll. */
  scrollIntoView(range: Range): void;
  clear(): void;
  dispose(): void;
}

export interface HighlighterOptions {
  /** Scroll the highlighted word into view when it leaves the visible area. Default true. */
  autoScroll?: boolean;
}

interface Painter {
  show(range: Range): void;
  clear(): void;
}

const SCROLL_MARGIN = 48;

export function supportsHighlightApi(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";
}

export function createHighlighter(options: HighlighterOptions = {}): Highlighter {
  const autoScroll = options.autoScroll ?? true;
  const api = supportsHighlightApi();
  const word: Painter = api ? new CssHighlightPainter(HIGHLIGHT_NAME, 1) : new OverlayPainter("dictation-overlay-box");
  const sentence: Painter = api
    ? new CssHighlightPainter(SENTENCE_HIGHLIGHT_NAME, 0)
    : new OverlayPainter("dictation-overlay-sentence");
  const clearAll = () => {
    word.clear();
    sentence.clear();
  };
  return {
    show(range, { scroll = true } = {}) {
      if (!range) {
        word.clear();
        return;
      }
      word.show(range);
      if (autoScroll && scroll) scrollRangeIntoView(range);
    },
    showSentence(range) {
      if (range) sentence.show(range);
      else sentence.clear();
    },
    scrollIntoView(range) {
      if (autoScroll) scrollRangeIntoView(range, true);
    },
    clear: clearAll,
    dispose: clearAll,
  };
}

class CssHighlightPainter implements Painter {
  private highlight: Highlight | null = null;
  private readonly name: string;
  private readonly priority: number;

  constructor(name: string, priority: number) {
    this.name = name;
    this.priority = priority;
  }

  show(range: Range): void {
    const highlight = new Highlight(range);
    highlight.priority = this.priority;
    CSS.highlights.set(this.name, highlight);
    this.highlight = highlight;
  }

  clear(): void {
    // Another message may own the highlight by now; only remove our own.
    if (this.highlight && CSS.highlights.get(this.name) === this.highlight) {
      CSS.highlights.delete(this.name);
    }
    this.highlight = null;
  }
}

/** For browsers without the Highlight API: boxes positioned over the word, outside the message DOM. */
class OverlayPainter implements Painter {
  private boxes: HTMLElement[] = [];
  private range: Range | null = null;
  private readonly className: string;
  private readonly redraw = () => this.draw();

  constructor(className: string) {
    this.className = className;
  }

  show(range: Range): void {
    if (!this.range) {
      window.addEventListener("scroll", this.redraw, true);
      window.addEventListener("resize", this.redraw);
    }
    this.range = range;
    this.draw();
  }

  clear(): void {
    this.removeBoxes();
    if (this.range) {
      window.removeEventListener("scroll", this.redraw, true);
      window.removeEventListener("resize", this.redraw);
    }
    this.range = null;
  }

  private draw(): void {
    this.removeBoxes();
    if (!this.range || typeof this.range.getClientRects !== "function") return;
    for (const rect of Array.from(this.range.getClientRects())) {
      const box = document.createElement("div");
      box.className = this.className;
      box.setAttribute("aria-hidden", "true");
      Object.assign(box.style, {
        position: "absolute",
        pointerEvents: "none",
        left: `${rect.left + window.scrollX}px`,
        top: `${rect.top + window.scrollY}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      document.body.appendChild(box);
      this.boxes.push(box);
    }
  }

  private removeBoxes(): void {
    this.boxes.forEach((box) => box.remove());
    this.boxes = [];
  }
}

function scrollRangeIntoView(range: Range, force = false): void {
  if (typeof range.getBoundingClientRect !== "function") return;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  const element = range.startContainer.parentElement;
  const scroller = element ? findScrollParent(element) : null;
  if (scroller) {
    const box = scroller.getBoundingClientRect();
    if (force || rect.top < box.top + SCROLL_MARGIN || rect.bottom > box.bottom - SCROLL_MARGIN) {
      scroller.scrollBy({ top: rect.top - (box.top + box.height / 3), behavior: "smooth" });
    }
    return;
  }
  if (force || rect.top < SCROLL_MARGIN || rect.bottom > window.innerHeight - SCROLL_MARGIN) {
    window.scrollBy({ top: rect.top - window.innerHeight / 3, behavior: "smooth" });
  }
}

function findScrollParent(element: Element): HTMLElement | null {
  for (let node: HTMLElement | null = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}
