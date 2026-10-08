export interface Word {
  /** Offset of the word's first character in `ExtractedText.text`. */
  start: number;
  /** Offset just past the word's last character. */
  end: number;
  /** DOM range covering the word, or null for spoken replacement phrases. */
  range: Range | null;
}

export interface ExtractedText {
  text: string;
  words: Word[];
}

export interface Replacement {
  selector: string;
  phrase: string;
}

export interface ExtractOptions {
  /** Elements read as a short phrase instead of their content. */
  replace?: Replacement[];
  /** Elements skipped silently. An empty string disables skipping. */
  skip?: string;
}

export const DEFAULT_REPLACE: Replacement[] = [
  { selector: "pre", phrase: "code block" },
  { selector: ".katex-display, .katex", phrase: "equation" },
];

export const DEFAULT_SKIP = [
  "[data-citation]",
  "sup.citation",
  '[aria-hidden="true"]',
  "[hidden]",
  ".sr-only",
  ".visually-hidden",
  "script",
  "style",
  "template",
  '[data-dictation="skip"]',
].join(", ");

// Speech should pause after these as at the end of a sentence.
const SENTENCE_BLOCKS = new Set([
  "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "BLOCKQUOTE", "PRE", "DT", "DD", "CAPTION", "FIGCAPTION",
]);
// These only need a word separator.
const SOFT_BLOCKS = new Set([
  "DIV", "TD", "TH", "BR", "HR", "UL", "OL", "DL", "TABLE", "THEAD", "TBODY", "TFOOT",
  "SECTION", "ARTICLE", "HEADER", "FOOTER", "FIGURE",
]);

const WORD_RE = /\S+/g;

const isSentenceBlock = (el: Element) => SENTENCE_BLOCKS.has(el.tagName) || el.classList.contains("katex-display");

/**
 * Walks the rendered message and returns the text to speak plus a word index.
 * The DOM is only read, never modified.
 */
export function extractWords(container: Element, options: ExtractOptions = {}): ExtractedText {
  const replace = options.replace ?? DEFAULT_REPLACE;
  const skip = options.skip ?? DEFAULT_SKIP;
  const doc = container.ownerDocument;
  const words: Word[] = [];
  let text = "";

  const softBreak = () => {
    if (text !== "" && !/\s$/.test(text)) text += " ";
  };
  const hardBreak = () => {
    text = text.replace(/\s+$/, "");
    if (text === "") return;
    text += /[.!?;:,]$/.test(text) ? " " : ". ";
  };
  const addWord = (word: string, range: Range | null) => {
    const start = text.length;
    text += word;
    words.push({ start, end: text.length, range });
  };

  const visitText = (node: Text) => {
    const data = node.data;
    let last = 0;
    for (const match of data.matchAll(WORD_RE)) {
      const index = match.index ?? 0;
      if (index > last) softBreak();
      const range = doc.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + match[0].length);
      addWord(match[0], range);
      last = index + match[0].length;
    }
    if (last < data.length) softBreak();
  };

  const visitElement = (el: Element) => {
    if (skip && el.matches(skip)) return;
    const lineBreak = isSentenceBlock(el) ? hardBreak : SOFT_BLOCKS.has(el.tagName) ? softBreak : null;
    lineBreak?.();
    const replacement = replace.find((r) => el.matches(r.selector));
    if (replacement) {
      for (const word of replacement.phrase.split(/\s+/).filter(Boolean)) {
        softBreak();
        addWord(word, null);
      }
      softBreak();
    } else {
      el.childNodes.forEach(visit);
    }
    lineBreak?.();
  };

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) visitText(node as Text);
    else if (node.nodeType === Node.ELEMENT_NODE) visitElement(node as Element);
  };

  container.childNodes.forEach(visit);
  return { text: text.replace(/\s+$/, ""), words };
}

/** Index of the word containing (or last starting before) `offset` in the spoken text. */
export function wordIndexAtOffset(words: readonly Word[], offset: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Index of the word at a caret position (as returned by caretPositionFromPoint). */
export function wordIndexAtPoint(words: readonly Word[], node: Node, offset: number): number {
  let last = -1;
  for (let i = 0; i < words.length; i++) {
    const range = words[i].range;
    if (!range || range.startContainer !== node) continue;
    if (offset <= range.endOffset) return i;
    last = i;
  }
  return last;
}
