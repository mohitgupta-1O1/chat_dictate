import { HIGHLIGHT_NAME } from "./constants";

export interface Highlighter {
  /**
   * Highlights `range`; `null` clears (used for spoken phrases like "code block").
   * `scroll: false` skips auto-scroll (the user scrolled away).
   */
  show(range: Range | null, options?: { scroll?: boolean }): void;
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
  const painter: Painter = supportsHighlightApi() ? new CssHighlightPainter() : new OverlayPainter();
  return {
    show(range, { scroll = true } = {}) {
      if (!range) {
        painter.clear();
        return;
      }
      painter.show(range);
      if (autoScroll && scroll) scrollRangeIntoView(range);
    },
    scrollIntoView(range) {
      if (autoScroll) scrollRangeIntoView(range, true);
    },
    clear: () => painter.clear(),
    dispose: () => painter.clear(),
  };
}

class CssHighlightPainter implements Painter {
  private highlight: Highlight | null = null;

  show(range: Range): void {
    const highlight = new Highlight(range);
    CSS.highlights.set(HIGHLIGHT_NAME, highlight);
    this.highlight = highlight;
  }

  clear(): void {
    // Another message may own the highlight by now; only remove our own.
    if (this.highlight && CSS.highlights.get(HIGHLIGHT_NAME) === this.highlight) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
    }
    this.highlight = null;
  }
}

/** For browsers without the Highlight API: boxes positioned over the word, outside the message DOM. */
class OverlayPainter implements Painter {
  private boxes: HTMLElement[] = [];
  private range: Range | null = null;
  private readonly redraw = () => this.draw();

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
      box.className = "dictation-overlay-box";
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
