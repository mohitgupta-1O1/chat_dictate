# Chat Dictation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A drop-in `src/features/dictation/` module that reads an AI chat response aloud at 0.5x / 1x / 1.5x / 2x and highlights each word as it is spoken, proven in a Next.js demo that renders responses with both react-markdown and Markdoc.

**Architecture:** After a message renders, `extract-words` walks its text nodes and builds a word index (char offsets + DOM `Range`s). A framework-agnostic `DictationController` sends text to a pluggable `SpeechEngine` (browser Web Speech now, cloud later), maps boundary offsets back to words, and paints the current word with the CSS Custom Highlight API (overlay fallback) — no DOM mutation. A React hook and toolbar wrap the controller.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript 5.9 (strict), Vitest 5 + jsdom + Testing Library, react-markdown 10 (+ remark-gfm, remark-math, rehype-katex), @markdoc/markdoc.

**Spec:** `docs/superpowers/specs/2026-10-09-chat-dictation-design.md`

## Global Constraints

- Next.js 16, React 19, TypeScript `strict: true`. Pin `typescript@~5.9` (TS 7 is untested with Next's type-check step).
- Speeds are exactly `0.5, 1, 1.5, 2`; default `1`.
- CSS highlight name is `dictation-word`.
- Everything under `src/features/dictation/` depends only on `react` and browser APIs — no other runtime dependency, no imports from `src/demo` or `src/app`.
- The message container's DOM is never mutated by the feature (highlight via `CSS.highlights`; fallback overlay lives in `document.body`).
- No `window`/`document` access at module top level (SSR-safe). Hook and toolbar files start with `"use client"`.
- Excluded content: `pre` → spoken "code block"; `.katex-display, .katex` → spoken "equation"; citations / `aria-hidden` / `data-dictation="skip"` skipped silently.
- Web Speech text is chunked at sentence ends into ≤200-char utterances.

## Review Focus

1. **Clicking inside a message to select text, follow a link or press a button must not start speech** — hook tests in Task 6 (selection, link).
2. **Message content changing mid-playback (streaming, regeneration) must stop speech instead of highlighting stale ranges** — Task 5 `invalidate` test, Task 6 rerender test.
3. **Leaving the page or unmounting the message while speaking must silence the voice** — Task 6 unmount and `pagehide` tests.
4. **Long text without sentence punctuation, and decimals like `3.14`, must chunk into ≤200-char pieces without splitting words** — Task 3 `splitIntoChunks` tests.
5. **Voices that never fire boundary events must still move the highlight, and freeze it while paused** — Task 3 estimated-timing tests including pause before/after the fallback fires.

---

## File Structure

```
package.json, tsconfig.json, next.config.ts, vitest.config.ts, .gitignore
src/app/layout.tsx, src/app/page.tsx, src/app/globals.css        demo shell
src/demo/AgentMarkdown.tsx      react-markdown renderer (mirrors main project's agent-markdown)
src/demo/MarkdocMarkdown.tsx    Markdoc renderer + citation tag (mirrors main project's markdown.tsx)
src/demo/messages.ts            mock assistant messages
src/demo/ChatMessage.tsx        one message + dictation wiring (the integration example)
src/demo/ChatDemo.tsx           message list, simulated streaming
src/demo/__tests__/renderers.test.tsx   extraction against real renderer output
src/features/dictation/
  constants.ts                  RATES, DEFAULT_RATE, HIGHLIGHT_NAME
  extract-words.ts              DOM → { text, words }
  engines/types.ts              SpeechEngine interface
  engines/web-speech-engine.ts  Web Speech implementation
  highlighter.ts                CSS highlight / overlay + auto-scroll
  dictation-controller.ts       playback state machine + single-active lock
  use-dictation.ts              React hook
  DictationToolbar.tsx          UI
  dictation.css                 highlight + toolbar styles
  index.ts                      public exports
  README.md                     integration guide
  __tests__/*.test.ts(x), __tests__/fake-engine.ts
```

---

### Task 1: Project scaffold and constants

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.gitignore`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- Create: `src/features/dictation/constants.ts`
- Test: `src/features/dictation/__tests__/constants.test.ts`

**Interfaces:**
- Produces: `RATES: readonly [0.5, 1, 1.5, 2]`, `type DictationRate`, `DEFAULT_RATE: DictationRate = 1`, `HIGHLIGHT_NAME = "dictation-word"`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "chat-dictation",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
npm install next@16 react@19 react-dom@19 react-markdown@10 remark-gfm remark-math rehype-katex katex @markdoc/markdoc
npm install -D typescript@~5.9 @types/node @types/react @types/react-dom vitest jsdom @testing-library/react @testing-library/dom
```

- [ ] **Step 3: Create config files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`next.config.ts`:
```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

`vitest.config.ts`:
```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
```

`.gitignore`:
```
node_modules
.next
next-env.d.ts
*.tsbuildinfo
```

- [ ] **Step 4: Create the minimal app shell**

`src/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = { title: "Chat Dictation Demo" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`src/app/page.tsx`:
```tsx
export default function Page() {
  return <main>Chat dictation demo</main>;
}
```

`src/app/globals.css`:
```css
body {
  margin: 0;
  font-family: system-ui, sans-serif;
  line-height: 1.6;
}
```

- [ ] **Step 5: Write the failing test** — `src/features/dictation/__tests__/constants.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_RATE, HIGHLIGHT_NAME, RATES } from "../constants";

describe("constants", () => {
  it("offers exactly the four approved speeds, defaulting to 1x", () => {
    expect(RATES).toEqual([0.5, 1, 1.5, 2]);
    expect(DEFAULT_RATE).toBe(1);
  });

  it("names the CSS highlight", () => {
    expect(HIGHLIGHT_NAME).toBe("dictation-word");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../constants`.

- [ ] **Step 7: Implement** — `src/features/dictation/constants.ts`

```ts
export const RATES = [0.5, 1, 1.5, 2] as const;

export type DictationRate = (typeof RATES)[number];

export const DEFAULT_RATE: DictationRate = 1;

/** Name used with the CSS Custom Highlight API: `::highlight(dictation-word)`. */
export const HIGHLIGHT_NAME = "dictation-word";
```

- [ ] **Step 8: Verify tests, typecheck and build**

Run: `npm test && npm run build && npm run typecheck`
Expected: 2 tests pass; `next build` succeeds (it also generates `next-env.d.ts`); `tsc` reports no errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js demo and dictation constants"
```

---

### Task 2: Word extraction from rendered DOM

**Files:**
- Create: `src/features/dictation/extract-words.ts`
- Test: `src/features/dictation/__tests__/extract-words.test.ts`

**Interfaces:**
- Produces:
  - `interface Word { start: number; end: number; range: Range | null }`
  - `interface ExtractedText { text: string; words: Word[] }`
  - `interface Replacement { selector: string; phrase: string }`
  - `interface ExtractOptions { replace?: Replacement[]; skip?: string }`
  - `DEFAULT_REPLACE: Replacement[]`, `DEFAULT_SKIP: string`
  - `extractWords(container: Element, options?: ExtractOptions): ExtractedText`
  - `wordIndexAtOffset(words: readonly Word[], offset: number): number` (-1 if none)
  - `wordIndexAtPoint(words: readonly Word[], node: Node, offset: number): number` (-1 if node has no words)

- [ ] **Step 1: Write the failing tests** — `src/features/dictation/__tests__/extract-words.test.ts`

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/dictation/__tests__/extract-words.test.ts`
Expected: FAIL — cannot resolve `../extract-words`.

- [ ] **Step 3: Implement** — `src/features/dictation/extract-words.ts`

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/dictation/__tests__/extract-words.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/dictation/extract-words.ts src/features/dictation/__tests__/extract-words.test.ts
git commit -m "feat(dictation): extract spoken text and word ranges from rendered DOM"
```

---

### Task 3: Speech engine interface and Web Speech engine

**Files:**
- Create: `src/features/dictation/engines/types.ts`
- Create: `src/features/dictation/engines/web-speech-engine.ts`
- Test: `src/features/dictation/__tests__/web-speech-engine.test.ts`

**Interfaces:**
- Produces (`engines/types.ts`):
  ```ts
  type Unsubscribe = () => void;
  interface VoiceInfo { id: string; name: string; lang: string }
  interface SpeakOptions { rate: number; voiceId?: string }
  interface SpeechEngine {
    speak(text: string, options: SpeakOptions): void;
    pause(): void; resume(): void; cancel(): void;
    onBoundary(cb: (charIndex: number) => void): Unsubscribe;
    onEnd(cb: () => void): Unsubscribe;
    onError(cb: (error: Error) => void): Unsubscribe;
    listVoices(): Promise<VoiceInfo[]>;
  }
  ```
- Produces (`engines/web-speech-engine.ts`): `splitIntoChunks(text, maxLength = 200): TextChunk[]` (`TextChunk = { text: string; offset: number }`), `estimateWordTimings(text, rate): WordTiming[]` (`WordTiming = { charIndex: number; atMs: number }`), `pickDefaultVoice(voices, lang): SpeechSynthesisVoice | null`, `isWebSpeechSupported(): boolean`, `getWebSpeechEngine(): WebSpeechEngine | null` (shared singleton), `class WebSpeechEngine implements SpeechEngine` with `constructor(options?: WebSpeechEngineOptions)` where `WebSpeechEngineOptions = { synth?, Utterance?, lang?, boundaryTimeoutMs? (600), voicesTimeoutMs? (1500), maxChunkLength? (200) }`. `VoiceInfo.id` is `SpeechSynthesisVoice.voiceURI`.

- [ ] **Step 1: Write the engine interface** — `src/features/dictation/engines/types.ts`

```ts
export type Unsubscribe = () => void;

export interface VoiceInfo {
  id: string;
  name: string;
  lang: string;
}

export interface SpeakOptions {
  rate: number;
  voiceId?: string;
}

/**
 * A text-to-speech backend. `speak()` replaces anything currently speaking;
 * boundary indexes are offsets into the `text` passed to the latest `speak()`.
 */
export interface SpeechEngine {
  speak(text: string, options: SpeakOptions): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  onBoundary(cb: (charIndex: number) => void): Unsubscribe;
  onEnd(cb: () => void): Unsubscribe;
  onError(cb: (error: Error) => void): Unsubscribe;
  listVoices(): Promise<VoiceInfo[]>;
}
```

- [ ] **Step 2: Write the failing tests** — `src/features/dictation/__tests__/web-speech-engine.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebSpeechEngine,
  estimateWordTimings,
  pickDefaultVoice,
  splitIntoChunks,
  type WebSpeechEngineOptions,
} from "../engines/web-speech-engine";

class MockUtterance {
  text: string;
  rate = 1;
  lang = "";
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onboundary: ((event: { charIndex: number; name?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

class MockSynth {
  queue: MockUtterance[] = [];
  voices: SpeechSynthesisVoice[] = [];
  calls: string[] = [];
  private listeners = new Set<() => void>();
  speak(u: MockUtterance) {
    this.queue.push(u);
  }
  cancel() {
    this.calls.push("cancel");
    this.queue = [];
  }
  pause() {
    this.calls.push("pause");
  }
  resume() {
    this.calls.push("resume");
  }
  getVoices() {
    return this.voices;
  }
  addEventListener(_type: string, cb: () => void) {
    this.listeners.add(cb);
  }
  removeEventListener(_type: string, cb: () => void) {
    this.listeners.delete(cb);
  }
  fireVoicesChanged() {
    this.listeners.forEach((cb) => cb());
  }
}

function voice(partial: Partial<SpeechSynthesisVoice>): SpeechSynthesisVoice {
  return {
    voiceURI: partial.name ?? "v",
    name: "v",
    lang: "en-US",
    localService: false,
    default: false,
    ...partial,
  } as SpeechSynthesisVoice;
}

function setup(options: WebSpeechEngineOptions = {}) {
  const synth = new MockSynth();
  const engine = new WebSpeechEngine({
    synth: synth as unknown as SpeechSynthesis,
    Utterance: MockUtterance as unknown as typeof SpeechSynthesisUtterance,
    lang: "en-US",
    ...options,
  });
  const boundaries: number[] = [];
  const errors: string[] = [];
  let ends = 0;
  engine.onBoundary((i) => boundaries.push(i));
  engine.onEnd(() => ends++);
  engine.onError((e) => errors.push(e.message));
  return { synth, engine, boundaries, errors, ends: () => ends };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("splitIntoChunks", () => {
  it("splits at sentence ends and keeps offsets", () => {
    expect(splitIntoChunks("Hello there. How are you? Fine.")).toEqual([
      { text: "Hello there. ", offset: 0 },
      { text: "How are you? ", offset: 13 },
      { text: "Fine.", offset: 26 },
    ]);
  });

  it("does not split decimals or inside ellipses", () => {
    expect(splitIntoChunks("Pi is 3.14 today. Wait... what?").map((c) => c.text)).toEqual([
      "Pi is 3.14 today. ",
      "Wait... what?",
    ]);
  });

  it("splits long unpunctuated text at spaces into chunks of at most 200 chars", () => {
    const text = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(200);
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
      expect(chunk.offset === 0 || text[chunk.offset - 1] === " ").toBe(true);
    }
    expect(chunks.map((c) => c.text).join("")).toBe(text);
  });

  it("drops whitespace-only text", () => {
    expect(splitIntoChunks("   ")).toEqual([]);
  });
});

describe("estimateWordTimings", () => {
  it("spaces words by length and scales with rate", () => {
    expect(estimateWordTimings("one two", 1)).toEqual([
      { charIndex: 0, atMs: 0 },
      { charIndex: 4, atMs: 260 },
    ]);
    expect(estimateWordTimings("one two", 2)[1].atMs).toBe(130);
  });
});

describe("pickDefaultVoice", () => {
  it("prefers the local default voice for the language", () => {
    const voices = [
      voice({ name: "Google", default: true }),
      voice({ name: "Albert", localService: true }),
      voice({ name: "Samantha", localService: true, default: true }),
    ];
    expect(pickDefaultVoice(voices, "en-US")?.name).toBe("Samantha");
  });

  it("falls back to any local voice with the exact language", () => {
    const voices = [voice({ name: "Google", default: true }), voice({ name: "Alex", localService: true })];
    expect(pickDefaultVoice(voices, "en-US")?.name).toBe("Alex");
  });

  it("matches on base language and normalises underscores", () => {
    const voices = [voice({ name: "Amelie", lang: "fr-FR", localService: true }), voice({ name: "Alex", lang: "en_US", localService: true })];
    expect(pickDefaultVoice(voices, "en-GB")?.name).toBe("Alex");
  });

  it("returns null when nothing matches", () => {
    expect(pickDefaultVoice([voice({ name: "Alex" })], "ja-JP")).toBeNull();
  });
});

describe("WebSpeechEngine", () => {
  it("queues one utterance per sentence with rate and voice", () => {
    const { synth, engine } = setup();
    synth.voices = [voice({ name: "Samantha", localService: true, default: true })];
    engine.speak("One. Two.", { rate: 1.5 });
    expect(synth.queue.map((u) => u.text)).toEqual(["One. ", "Two."]);
    expect(synth.queue.every((u) => u.rate === 1.5 && u.voice?.name === "Samantha")).toBe(true);
  });

  it("uses the requested voice id", () => {
    const { synth, engine } = setup();
    synth.voices = [voice({ name: "Samantha", localService: true, default: true }), voice({ name: "Daniel", lang: "en-GB" })];
    engine.speak("Hi.", { rate: 1, voiceId: "Daniel" });
    expect(synth.queue[0].voice?.name).toBe("Daniel");
  });

  it("maps word boundaries into offsets of the full text and ignores sentence boundaries", () => {
    const { synth, engine, boundaries } = setup();
    engine.speak("One. Two three.", { rate: 1 });
    const second = synth.queue[1];
    second.onstart!();
    second.onboundary!({ charIndex: 0, name: "sentence" });
    second.onboundary!({ charIndex: 4, name: "word" });
    expect(boundaries).toEqual([9]);
  });

  it("emits end only after the last chunk", () => {
    const { synth, engine, ends } = setup();
    engine.speak("One. Two.", { rate: 1 });
    const [first, second] = synth.queue;
    first.onend!();
    expect(ends()).toBe(0);
    second.onend!();
    expect(ends()).toBe(1);
  });

  it("ignores events from a cancelled session and unpauses the synth on cancel", () => {
    const { synth, engine, boundaries, errors, ends } = setup();
    engine.speak("Hi.", { rate: 1 });
    const [u] = synth.queue;
    synth.calls = [];
    engine.cancel();
    u.onboundary!({ charIndex: 0, name: "word" });
    u.onend!();
    u.onerror!({ error: "synthesis-failed" });
    expect([boundaries, errors, ends()]).toEqual([[], [], 0]);
    expect(synth.calls).toEqual(["cancel", "resume"]);
  });

  it("reports real errors but not cancellations", () => {
    const { synth, engine, errors } = setup();
    engine.speak("Hi.", { rate: 1 });
    synth.queue[0].onerror!({ error: "interrupted" });
    synth.queue[0].onerror!({ error: "canceled" });
    expect(errors).toEqual([]);
    engine.speak("Hi.", { rate: 1 });
    synth.queue[0].onerror!({ error: "synthesis-failed" });
    expect(errors).toEqual(["Speech synthesis failed: synthesis-failed"]);
  });

  it("ends asynchronously when there is nothing to say", async () => {
    const { engine, ends } = setup();
    engine.speak("   ", { rate: 1 });
    expect(ends()).toBe(0);
    await Promise.resolve();
    expect(ends()).toBe(1);
  });

  describe("estimated timing for voices without boundary events", () => {
    // "one two three four." → word timings at 0, 260, 520, 910 ms (rate 1)
    it("starts estimating after the boundary timeout", () => {
      vi.useFakeTimers();
      const { synth, engine, boundaries } = setup();
      engine.speak("one two three four.", { rate: 1 });
      synth.queue[0].onstart!();
      vi.advanceTimersByTime(599);
      expect(boundaries).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(boundaries).toEqual([8]);
      vi.advanceTimersByTime(310);
      expect(boundaries).toEqual([8, 14]);
    });

    it("does not estimate when real boundaries arrive", () => {
      vi.useFakeTimers();
      const { synth, engine, boundaries } = setup();
      engine.speak("one two three four.", { rate: 1 });
      synth.queue[0].onstart!();
      vi.advanceTimersByTime(100);
      synth.queue[0].onboundary!({ charIndex: 0, name: "word" });
      vi.advanceTimersByTime(5000);
      expect(boundaries).toEqual([0]);
    });

    it("estimates immediately for a voice already known to lack boundaries", () => {
      vi.useFakeTimers();
      const { synth, engine, boundaries } = setup();
      engine.speak("a b.", { rate: 1 });
      synth.queue[0].onstart!();
      vi.advanceTimersByTime(600);
      engine.speak("c d.", { rate: 1 });
      boundaries.length = 0;
      synth.queue[0].onstart!();
      expect(boundaries).toEqual([0]);
    });

    it("freezes estimates while paused", () => {
      vi.useFakeTimers();
      const { synth, engine, boundaries } = setup();
      engine.speak("one two three four five.", { rate: 1 });
      synth.queue[0].onstart!();
      vi.advanceTimersByTime(600);
      expect(boundaries).toEqual([8]);
      engine.pause();
      vi.advanceTimersByTime(5000);
      expect(boundaries).toEqual([8]);
      engine.resume();
      vi.advanceTimersByTime(310);
      expect(boundaries).toEqual([8, 14]);
    });

    it("counts only speaking time toward the boundary timeout", () => {
      vi.useFakeTimers();
      const { synth, engine, boundaries } = setup();
      engine.speak("one two three four.", { rate: 1 });
      synth.queue[0].onstart!();
      vi.advanceTimersByTime(300);
      engine.pause();
      vi.advanceTimersByTime(1000);
      engine.resume();
      vi.advanceTimersByTime(299);
      expect(boundaries).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(boundaries).toEqual([8]);
    });
  });

  describe("listVoices", () => {
    it("waits for voiceschanged when voices are not loaded yet", async () => {
      const { synth, engine } = setup();
      const pending = engine.listVoices();
      synth.voices = [voice({ name: "Alex" })];
      synth.fireVoicesChanged();
      expect(await pending).toEqual([{ id: "Alex", name: "Alex", lang: "en-US" }]);
    });

    it("gives up after the timeout", async () => {
      vi.useFakeTimers();
      const { engine } = setup();
      const pending = engine.listVoices();
      vi.advanceTimersByTime(1500);
      expect(await pending).toEqual([]);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/features/dictation/__tests__/web-speech-engine.test.ts`
Expected: FAIL — cannot resolve `../engines/web-speech-engine`.

- [ ] **Step 4: Implement** — `src/features/dictation/engines/web-speech-engine.ts`

```ts
import type { SpeakOptions, SpeechEngine, Unsubscribe, VoiceInfo } from "./types";

export interface TextChunk {
  text: string;
  /** Offset of the chunk in the full text. */
  offset: number;
}

export interface WordTiming {
  charIndex: number;
  atMs: number;
}

export interface WebSpeechEngineOptions {
  synth?: SpeechSynthesis;
  Utterance?: typeof SpeechSynthesisUtterance;
  /** Language used to pick a default voice. Defaults to <html lang> or navigator.language. */
  lang?: string;
  /** Start estimating word timing if a chunk produces no boundary event within this time. */
  boundaryTimeoutMs?: number;
  voicesTimeoutMs?: number;
  maxChunkLength?: number;
}

const MS_PER_CHAR = 65;
const PUNCTUATION_PAUSE_MS = 250;

/**
 * Splits text at sentence ends (and, for long sentences, at spaces) so each
 * utterance stays short — Chrome silently stops utterances after ~15 seconds.
 */
export function splitIntoChunks(text: string, maxLength = 200): TextChunk[] {
  const chunks: TextChunk[] = [];
  const add = (start: number, end: number) => {
    const slice = text.slice(start, end);
    if (/\S/.test(slice)) chunks.push({ text: slice, offset: start });
  };
  const push = (start: number, end: number) => {
    while (end - start > maxLength) {
      const space = text.lastIndexOf(" ", start + maxLength - 1);
      const cut = space > start ? space + 1 : start + maxLength;
      add(start, cut);
      start = cut;
    }
    add(start, end);
  };

  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === "." || ch === "!" || ch === "?") && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      let end = i + 1;
      while (end < text.length && /\s/.test(text[end])) end++;
      push(start, end);
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) push(start, text.length);
  return chunks;
}

/** Rough per-word start times, used when a voice does not report word boundaries. */
export function estimateWordTimings(text: string, rate: number): WordTiming[] {
  const timings: WordTiming[] = [];
  let at = 0;
  for (const match of text.matchAll(/\S+/g)) {
    const word = match[0];
    timings.push({ charIndex: match.index ?? 0, atMs: at });
    at += ((word.length + 1) * MS_PER_CHAR + (/[.,;:!?]$/.test(word) ? PUNCTUATION_PAUSE_MS : 0)) / rate;
  }
  return timings;
}

const normaliseLang = (lang: string) => lang.toLowerCase().replace("_", "-");

/** Prefers local voices: they report word boundaries reliably, remote ones often do not. */
export function pickDefaultVoice(voices: readonly SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  const wanted = normaliseLang(lang);
  const base = wanted.split("-")[0];
  const exact = (v: SpeechSynthesisVoice) => normaliseLang(v.lang) === wanted;
  const sameBase = (v: SpeechSynthesisVoice) => normaliseLang(v.lang).split("-")[0] === base;
  return (
    voices.find((v) => v.localService && v.default && sameBase(v)) ??
    voices.find((v) => v.localService && exact(v)) ??
    voices.find((v) => v.localService && sameBase(v)) ??
    voices.find((v) => v.default && sameBase(v)) ??
    voices.find(sameBase) ??
    null
  );
}

export function isWebSpeechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.SpeechSynthesisUtterance === "function"
  );
}

let sharedEngine: WebSpeechEngine | null = null;

/** The app-wide browser engine, or null during SSR / in unsupported browsers. */
export function getWebSpeechEngine(): WebSpeechEngine | null {
  if (!isWebSpeechSupported()) return null;
  sharedEngine ??= new WebSpeechEngine();
  return sharedEngine;
}

function defaultLang(): string {
  if (typeof document !== "undefined" && document.documentElement.lang) return document.documentElement.lang;
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  return "en-US";
}

/** Emits estimated boundaries on a timer; can be stopped and re-run from an elapsed time. */
class EstimatedBoundaries {
  private next = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly timings: WordTiming[];
  private readonly emit: (charIndex: number) => void;

  constructor(timings: WordTiming[], emit: (charIndex: number) => void) {
    this.timings = timings;
    this.emit = emit;
  }

  run(elapsedMs: number): void {
    this.stop();
    let due = -1;
    while (this.next < this.timings.length && this.timings[this.next].atMs <= elapsedMs) {
      due = this.next;
      this.next++;
    }
    if (due >= 0) this.emit(this.timings[due].charIndex);
    for (let i = this.next; i < this.timings.length; i++) {
      const timing = this.timings[i];
      this.timers.push(
        setTimeout(() => {
          this.next = i + 1;
          this.emit(timing.charIndex);
        }, timing.atMs - elapsedMs),
      );
    }
  }

  stop(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
}

interface ActiveChunk {
  chunk: TextChunk;
  rate: number;
  gotBoundary: boolean;
  estimate: EstimatedBoundaries | null;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  /** Speaking time accumulated before the last resume. */
  activeMs: number;
  resumedAt: number;
}

export class WebSpeechEngine implements SpeechEngine {
  private readonly synth: SpeechSynthesis;
  private readonly Utterance: typeof SpeechSynthesisUtterance;
  private readonly lang: string | undefined;
  private readonly boundaryTimeoutMs: number;
  private readonly voicesTimeoutMs: number;
  private readonly maxChunkLength: number;
  private readonly boundaryListeners = new Set<(charIndex: number) => void>();
  private readonly endListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly noBoundaryVoices = new Set<string>();
  private session = 0;
  // Kept referenced: Chrome drops events of utterances that get garbage collected.
  private utterances: SpeechSynthesisUtterance[] = [];
  private current: ActiveChunk | null = null;
  private paused = false;
  private voiceKey = "default";
  private voices: SpeechSynthesisVoice[] = [];
  private voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;

  constructor(options: WebSpeechEngineOptions = {}) {
    this.synth = options.synth ?? window.speechSynthesis;
    this.Utterance = options.Utterance ?? window.SpeechSynthesisUtterance;
    this.lang = options.lang;
    this.boundaryTimeoutMs = options.boundaryTimeoutMs ?? 600;
    this.voicesTimeoutMs = options.voicesTimeoutMs ?? 1500;
    this.maxChunkLength = options.maxChunkLength ?? 200;
  }

  speak(text: string, { rate, voiceId }: SpeakOptions): void {
    this.cancel();
    const session = this.session;
    const live = () => session === this.session;
    const chunks = splitIntoChunks(text, this.maxChunkLength);
    if (chunks.length === 0) {
      queueMicrotask(() => {
        if (live()) this.endListeners.forEach((cb) => cb());
      });
      return;
    }

    const voice = this.findVoice(voiceId);
    this.voiceKey = voice?.voiceURI ?? "default";
    this.utterances = chunks.map((chunk, index) => {
      const utterance = new this.Utterance(chunk.text);
      utterance.rate = rate;
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.onstart = () => {
        if (live()) this.startChunk(chunk, rate);
      };
      utterance.onboundary = (event) => {
        if (live() && event.name !== "sentence") this.handleRealBoundary(chunk, event.charIndex);
      };
      utterance.onend = () => {
        if (!live()) return;
        this.finishChunk();
        if (index === chunks.length - 1) {
          this.utterances = [];
          this.endListeners.forEach((cb) => cb());
        }
      };
      utterance.onerror = (event) => {
        if (!live() || event.error === "canceled" || event.error === "interrupted") return;
        this.cancel();
        const error = new Error(`Speech synthesis failed: ${event.error}`);
        this.errorListeners.forEach((cb) => cb(error));
      };
      return utterance;
    });
    this.utterances.forEach((utterance) => this.synth.speak(utterance));
  }

  pause(): void {
    if (this.paused) return;
    this.synth.pause();
    const active = this.current;
    if (active) {
      active.activeMs += Date.now() - active.resumedAt;
      if (active.fallbackTimer) clearTimeout(active.fallbackTimer);
      active.fallbackTimer = null;
      active.estimate?.stop();
    }
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.synth.resume();
    const active = this.current;
    if (!active) return;
    active.resumedAt = Date.now();
    if (active.estimate) active.estimate.run(active.activeMs);
    else if (!active.gotBoundary) this.armFallback(active, Math.max(0, this.boundaryTimeoutMs - active.activeMs));
  }

  cancel(): void {
    this.session++;
    this.finishChunk();
    this.utterances = [];
    this.paused = false;
    this.synth.cancel();
    // Chrome keeps the queue paused after cancel(), which would mute the next speak().
    this.synth.resume();
  }

  onBoundary(cb: (charIndex: number) => void): Unsubscribe {
    this.boundaryListeners.add(cb);
    return () => {
      this.boundaryListeners.delete(cb);
    };
  }

  onEnd(cb: () => void): Unsubscribe {
    this.endListeners.add(cb);
    return () => {
      this.endListeners.delete(cb);
    };
  }

  onError(cb: (error: Error) => void): Unsubscribe {
    this.errorListeners.add(cb);
    return () => {
      this.errorListeners.delete(cb);
    };
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const voices = await this.loadVoices();
    return voices.map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang }));
  }

  private loadVoices(): Promise<SpeechSynthesisVoice[]> {
    const ready = this.synth.getVoices();
    if (ready.length > 0) {
      this.voices = ready;
      return Promise.resolve(ready);
    }
    this.voicesPromise ??= new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.synth.removeEventListener("voiceschanged", done);
        this.voices = this.synth.getVoices();
        this.voicesPromise = null;
        resolve(this.voices);
      };
      const timer = setTimeout(done, this.voicesTimeoutMs);
      this.synth.addEventListener("voiceschanged", done);
    });
    return this.voicesPromise;
  }

  private findVoice(voiceId?: string): SpeechSynthesisVoice | null {
    const voices = this.voices.length > 0 ? this.voices : this.synth.getVoices();
    if (voiceId) {
      const match = voices.find((v) => v.voiceURI === voiceId);
      if (match) return match;
    }
    return pickDefaultVoice(voices, this.lang ?? defaultLang());
  }

  private emitBoundary(charIndex: number): void {
    this.boundaryListeners.forEach((cb) => cb(charIndex));
  }

  private startChunk(chunk: TextChunk, rate: number): void {
    this.finishChunk();
    const active: ActiveChunk = {
      chunk,
      rate,
      gotBoundary: false,
      estimate: null,
      fallbackTimer: null,
      activeMs: 0,
      resumedAt: Date.now(),
    };
    this.current = active;
    if (this.noBoundaryVoices.has(this.voiceKey)) this.startEstimate(active, 0);
    else this.armFallback(active, this.boundaryTimeoutMs);
  }

  private armFallback(active: ActiveChunk, delayMs: number): void {
    active.fallbackTimer = setTimeout(() => {
      active.fallbackTimer = null;
      if (active.gotBoundary || this.current !== active) return;
      this.noBoundaryVoices.add(this.voiceKey);
      this.startEstimate(active, active.activeMs + Date.now() - active.resumedAt);
    }, delayMs);
  }

  private startEstimate(active: ActiveChunk, elapsedMs: number): void {
    const { offset } = active.chunk;
    active.estimate = new EstimatedBoundaries(estimateWordTimings(active.chunk.text, active.rate), (charIndex) =>
      this.emitBoundary(offset + charIndex),
    );
    active.estimate.run(elapsedMs);
  }

  private handleRealBoundary(chunk: TextChunk, charIndex: number): void {
    const active = this.current;
    if (active && active.chunk === chunk) {
      active.gotBoundary = true;
      if (active.fallbackTimer) clearTimeout(active.fallbackTimer);
      active.fallbackTimer = null;
      active.estimate?.stop();
      active.estimate = null;
    }
    this.noBoundaryVoices.delete(this.voiceKey);
    this.emitBoundary(chunk.offset + charIndex);
  }

  private finishChunk(): void {
    const active = this.current;
    if (!active) return;
    if (active.fallbackTimer) clearTimeout(active.fallbackTimer);
    active.estimate?.stop();
    this.current = null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/features/dictation/__tests__/web-speech-engine.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/features/dictation/engines src/features/dictation/__tests__/web-speech-engine.test.ts
git commit -m "feat(dictation): add SpeechEngine interface and Web Speech engine"
```

---

### Task 4: Highlighter

**Files:**
- Create: `src/features/dictation/highlighter.ts`
- Test: `src/features/dictation/__tests__/highlighter.test.ts`

**Interfaces:**
- Consumes: `HIGHLIGHT_NAME` from `constants.ts`.
- Produces: `interface Highlighter { show(range: Range | null): void; clear(): void; dispose(): void }`, `interface HighlighterOptions { autoScroll?: boolean }` (default true), `createHighlighter(options?: HighlighterOptions): Highlighter`, `supportsHighlightApi(): boolean`. Overlay boxes use class `dictation-overlay-box`.

- [ ] **Step 1: Write the failing tests** — `src/features/dictation/__tests__/highlighter.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHighlighter } from "../highlighter";

class FakeHighlight {
  ranges: Range[];
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/dictation/__tests__/highlighter.test.ts`
Expected: FAIL — cannot resolve `../highlighter`.

- [ ] **Step 3: Implement** — `src/features/dictation/highlighter.ts`

```ts
import { HIGHLIGHT_NAME } from "./constants";

export interface Highlighter {
  /** Highlights `range`; `null` clears (used for spoken phrases like "code block"). */
  show(range: Range | null): void;
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
    show(range) {
      if (!range) {
        painter.clear();
        return;
      }
      painter.show(range);
      if (autoScroll) scrollRangeIntoView(range);
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

function scrollRangeIntoView(range: Range): void {
  if (typeof range.getBoundingClientRect !== "function") return;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  const element = range.startContainer.parentElement;
  const scroller = element ? findScrollParent(element) : null;
  if (scroller) {
    const box = scroller.getBoundingClientRect();
    if (rect.top < box.top + SCROLL_MARGIN || rect.bottom > box.bottom - SCROLL_MARGIN) {
      scroller.scrollBy({ top: rect.top - (box.top + box.height / 3), behavior: "smooth" });
    }
    return;
  }
  if (rect.top < SCROLL_MARGIN || rect.bottom > window.innerHeight - SCROLL_MARGIN) {
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
```

Note: `findScrollParent` starts at the word's parent's parent; the word's own parent is a `p`/`li`, which is never the scroll container in practice. If TypeScript reports `Highlight`/`CSS.highlights` as unknown, the installed TS lib is too old — confirm `typescript@~5.9` is installed rather than adding custom declarations.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/dictation/__tests__/highlighter.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/dictation/highlighter.ts src/features/dictation/__tests__/highlighter.test.ts
git commit -m "feat(dictation): highlight current word via CSS Highlight API with overlay fallback"
```

---

### Task 5: Dictation controller

**Files:**
- Create: `src/features/dictation/dictation-controller.ts`
- Create: `src/features/dictation/__tests__/fake-engine.ts`
- Test: `src/features/dictation/__tests__/dictation-controller.test.ts`

**Interfaces:**
- Consumes: `extractWords`, `wordIndexAtOffset`, `wordIndexAtPoint`, `ExtractOptions`, `ExtractedText` (Task 2); `SpeechEngine`, `Unsubscribe`, `VoiceInfo` (Task 3); `createHighlighter`, `Highlighter` (Task 4); `DEFAULT_RATE` (Task 1).
- Produces:
  - `type DictationStatus = "idle" | "loading" | "playing" | "paused"`
  - `interface DictationSnapshot { status: DictationStatus; rate: number; voiceId: string | undefined; currentWordIndex: number; error: string | null }` (`currentWordIndex` is -1 when nothing is highlighted)
  - `interface DictationControllerOptions { getContainer: () => HTMLElement | null; getEngine: () => SpeechEngine | null; extractOptions?: ExtractOptions; createHighlighter?: () => Highlighter; watchdogMs?: number /* 10000 */; initialRate?: number }`
  - `class DictationController` with `subscribe(listener): Unsubscribe` and `getSnapshot(): DictationSnapshot` (both bound arrow properties), `play(): Promise<void>`, `pause(): void`, `resume(): Promise<void>`, `stop(): void`, `setRate(rate): Promise<void>`, `setVoice(voiceId | undefined): Promise<void>`, `seekToWord(index): Promise<void>`, `seekToPoint(node, offset): Promise<void>`, `invalidate(): void`, `dispose(): void`, `listVoices(): Promise<VoiceInfo[]>`
  - `stopActiveDictation(): void`
  - Test helper `FakeEngine` (also used by Task 6).

- [ ] **Step 1: Write the fake engine** — `src/features/dictation/__tests__/fake-engine.ts`

```ts
import type { SpeakOptions, SpeechEngine, Unsubscribe, VoiceInfo } from "../engines/types";

/** A SpeechEngine driven by the test: call emitBoundary/emitEnd/emitError to simulate speech. */
export class FakeEngine implements SpeechEngine {
  calls: string[] = [];
  spoken: Array<{ text: string } & SpeakOptions> = [];
  voices: VoiceInfo[] = [];
  private readonly boundary = new Set<(charIndex: number) => void>();
  private readonly end = new Set<() => void>();
  private readonly error = new Set<(error: Error) => void>();

  speak(text: string, options: SpeakOptions): void {
    this.calls.push("speak");
    this.spoken.push({ text, ...options });
  }
  pause(): void {
    this.calls.push("pause");
  }
  resume(): void {
    this.calls.push("resume");
  }
  cancel(): void {
    this.calls.push("cancel");
  }
  onBoundary(cb: (charIndex: number) => void): Unsubscribe {
    this.boundary.add(cb);
    return () => {
      this.boundary.delete(cb);
    };
  }
  onEnd(cb: () => void): Unsubscribe {
    this.end.add(cb);
    return () => {
      this.end.delete(cb);
    };
  }
  onError(cb: (error: Error) => void): Unsubscribe {
    this.error.add(cb);
    return () => {
      this.error.delete(cb);
    };
  }
  listVoices(): Promise<VoiceInfo[]> {
    return Promise.resolve(this.voices);
  }

  get lastSpoken() {
    return this.spoken.at(-1);
  }
  get listenerCount() {
    return this.boundary.size;
  }
  emitBoundary(charIndex: number) {
    this.boundary.forEach((cb) => cb(charIndex));
  }
  emitEnd() {
    this.end.forEach((cb) => cb());
  }
  emitError(error: Error) {
    this.error.forEach((cb) => cb(error));
  }
}
```

- [ ] **Step 2: Write the failing tests** — `src/features/dictation/__tests__/dictation-controller.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationController, stopActiveDictation } from "../dictation-controller";
import type { VoiceInfo } from "../engines/types";
import type { Highlighter } from "../highlighter";
import { FakeEngine } from "./fake-engine";

class FakeHighlighter implements Highlighter {
  shown: (Range | null)[] = [];
  cleared = 0;
  show(range: Range | null) {
    this.shown.push(range);
  }
  clear() {
    this.cleared++;
  }
  dispose() {
    this.clear();
  }
  get lastText() {
    return this.shown.at(-1)?.toString();
  }
}

// "one two three four." — words start at 0, 4, 8, 14
function setup(html = "<p>one two three four</p>", engine = new FakeEngine(), watchdogMs = 10_000) {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const highlighter = new FakeHighlighter();
  const controller = new DictationController({
    getContainer: () => container,
    getEngine: () => engine,
    createHighlighter: () => highlighter,
    watchdogMs,
  });
  return { container, engine, highlighter, controller, state: () => controller.getSnapshot() };
}

afterEach(() => {
  stopActiveDictation();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("DictationController", () => {
  it("plays the whole message from the first word", async () => {
    const { engine, highlighter, controller, state } = setup();
    await controller.play();
    expect(engine.lastSpoken).toEqual({ text: "one two three four.", rate: 1, voiceId: undefined });
    expect(state()).toMatchObject({ status: "playing", currentWordIndex: 0, error: null });
    expect(highlighter.lastText).toBe("one");
  });

  it("highlights the word at each boundary", async () => {
    const { engine, highlighter, controller, state } = setup();
    await controller.play();
    engine.emitBoundary(8);
    expect(state().currentWordIndex).toBe(2);
    expect(highlighter.lastText).toBe("three");
  });

  it("restarts from the current word when the speed changes", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    engine.emitBoundary(8);
    await controller.setRate(2);
    expect(engine.lastSpoken).toEqual({ text: "three four.", rate: 2, voiceId: undefined });
    engine.emitBoundary(6);
    expect(state()).toMatchObject({ currentWordIndex: 3, rate: 2 });
  });

  it("restarts from the current word when the voice changes", async () => {
    const { engine, controller } = setup();
    await controller.play();
    engine.emitBoundary(4);
    await controller.setVoice("daniel");
    expect(engine.lastSpoken).toEqual({ text: "two three four.", rate: 1, voiceId: "daniel" });
  });

  it("seeks to a word from idle", async () => {
    const { engine, controller, state } = setup();
    await controller.seekToWord(3);
    expect(engine.lastSpoken?.text).toBe("four.");
    expect(state().status).toBe("playing");
  });

  it("seeks to a caret position", async () => {
    const { container, engine, controller } = setup();
    await controller.seekToPoint(container.querySelector("p")!.firstChild!, 9);
    expect(engine.lastSpoken?.text).toBe("three four.");
  });

  it("pauses and resumes through the engine", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    controller.pause();
    expect(state().status).toBe("paused");
    expect(engine.calls.at(-1)).toBe("pause");
    await controller.resume();
    expect(state().status).toBe("playing");
    expect(engine.calls.at(-1)).toBe("resume");
    expect(engine.spoken).toHaveLength(1);
  });

  it("silences an engine that ignores pause and restarts on resume", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    engine.emitBoundary(4);
    controller.pause();
    engine.emitBoundary(8);
    expect(engine.calls.at(-1)).toBe("cancel");
    expect(state().currentWordIndex).toBe(1);
    await controller.resume();
    expect(engine.lastSpoken?.text).toBe("two three four.");
  });

  it("applies a speed change made while paused on resume", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    engine.emitBoundary(4);
    controller.pause();
    await controller.setRate(1.5);
    expect(state().status).toBe("paused");
    expect(engine.spoken).toHaveLength(1);
    await controller.resume();
    expect(engine.lastSpoken).toEqual({ text: "two three four.", rate: 1.5, voiceId: undefined });
  });

  it("returns to idle and clears the highlight at the end", async () => {
    const { engine, highlighter, controller, state } = setup();
    await controller.play();
    engine.emitEnd();
    expect(state()).toMatchObject({ status: "idle", currentWordIndex: -1 });
    expect(highlighter.cleared).toBeGreaterThan(0);
  });

  it("surfaces engine errors", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    engine.emitError(new Error("boom"));
    expect(state()).toMatchObject({ status: "idle", error: "boom" });
  });

  it("stops and unsubscribes", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    controller.stop();
    expect(engine.calls.at(-1)).toBe("cancel");
    expect(state()).toMatchObject({ status: "idle", currentWordIndex: -1 });
    expect(engine.listenerCount).toBe(0);
  });

  it("allows only one message to play at a time", async () => {
    const a = setup();
    const b = setup("<p>other words</p>", a.engine);
    await a.controller.play();
    await b.controller.play();
    expect(a.state().status).toBe("idle");
    a.engine.emitBoundary(6);
    expect(b.state().currentWordIndex).toBe(1);
    expect(a.state().currentWordIndex).toBe(-1);
    expect(a.engine.listenerCount).toBe(1);
  });

  it("stops and re-reads the DOM after invalidate", async () => {
    const { container, engine, controller, state } = setup();
    await controller.play();
    container.innerHTML = "<p>new words</p>";
    controller.invalidate();
    expect(state().status).toBe("idle");
    await controller.play();
    expect(engine.lastSpoken?.text).toBe("new words.");
  });

  it("does not speak if stopped while loading voices", async () => {
    const { engine, controller, state } = setup();
    let resolveVoices: (v: VoiceInfo[]) => void = () => {};
    engine.listVoices = () => new Promise((resolve) => (resolveVoices = resolve));
    const pending = controller.play();
    expect(state().status).toBe("loading");
    controller.stop();
    resolveVoices([]);
    await pending;
    expect(engine.spoken).toHaveLength(0);
    expect(state().status).toBe("idle");
  });

  it("ignores boundaries while loading", async () => {
    const { engine, controller, state } = setup();
    let resolveVoices: (v: VoiceInfo[]) => void = () => {};
    engine.listVoices = () => new Promise((resolve) => (resolveVoices = resolve));
    const pending = controller.play();
    engine.emitBoundary(8);
    expect(state().currentWordIndex).toBe(0);
    resolveVoices([]);
    await pending;
  });

  it("reports an error when there is nothing to read", async () => {
    const { engine, controller, state } = setup("<p>   </p>");
    await controller.play();
    expect(engine.spoken).toHaveLength(0);
    expect(state()).toMatchObject({ status: "idle", error: "There is no text to read." });
  });

  it("restarts a stalled engine once, then gives up", async () => {
    vi.useFakeTimers();
    const { engine, controller, state } = setup(undefined, undefined, 1000);
    await controller.play();
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.spoken).toHaveLength(2);
    expect(engine.lastSpoken?.text).toBe("one two three four.");
    await vi.advanceTimersByTimeAsync(1000);
    expect(state()).toMatchObject({ status: "idle", error: "Speech stopped responding." });
  });

  it("does not restart while boundaries keep arriving", async () => {
    vi.useFakeTimers();
    const { engine, controller } = setup(undefined, undefined, 1000);
    await controller.play();
    await vi.advanceTimersByTimeAsync(900);
    engine.emitBoundary(4);
    await vi.advanceTimersByTimeAsync(900);
    expect(engine.spoken).toHaveLength(1);
  });

  it("can play again after dispose (React StrictMode remounts)", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    controller.dispose();
    await controller.play();
    expect(engine.spoken).toHaveLength(2);
    expect(state().status).toBe("playing");
  });

  it("passes listVoices through to the engine", async () => {
    const { engine, controller } = setup();
    engine.voices = [{ id: "a", name: "A", lang: "en-US" }];
    expect(await controller.listVoices()).toEqual(engine.voices);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/features/dictation/__tests__/dictation-controller.test.ts`
Expected: FAIL — cannot resolve `../dictation-controller`.

- [ ] **Step 4: Implement** — `src/features/dictation/dictation-controller.ts`

```ts
import { DEFAULT_RATE } from "./constants";
import type { SpeechEngine, Unsubscribe, VoiceInfo } from "./engines/types";
import {
  extractWords,
  wordIndexAtOffset,
  wordIndexAtPoint,
  type ExtractOptions,
  type ExtractedText,
} from "./extract-words";
import { createHighlighter, type Highlighter } from "./highlighter";

export type DictationStatus = "idle" | "loading" | "playing" | "paused";

export interface DictationSnapshot {
  status: DictationStatus;
  rate: number;
  voiceId: string | undefined;
  /** Index into the extracted words, or -1 when nothing is highlighted. */
  currentWordIndex: number;
  error: string | null;
}

export interface DictationControllerOptions {
  getContainer: () => HTMLElement | null;
  getEngine: () => SpeechEngine | null;
  extractOptions?: ExtractOptions;
  createHighlighter?: () => Highlighter;
  /** Restart from the current word if the engine is silent this long while playing. */
  watchdogMs?: number;
  initialRate?: number;
}

let activeController: DictationController | null = null;

/** Stops whichever message is currently being read aloud. */
export function stopActiveDictation(): void {
  activeController?.stop();
}

/** Playback state for one message. Only one controller plays at a time app-wide. */
export class DictationController {
  private snapshot: DictationSnapshot;
  private readonly options: DictationControllerOptions;
  private readonly listeners = new Set<() => void>();
  private extracted: ExtractedText | null = null;
  private highlighter: Highlighter | null = null;
  private engine: SpeechEngine | null = null;
  private engineUnsubs: Unsubscribe[] = [];
  private baseOffset = 0;
  private startToken = 0;
  private pausedByCancel = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private stalledAt = -1;

  constructor(options: DictationControllerOptions) {
    this.options = options;
    this.snapshot = {
      status: "idle",
      rate: options.initialRate ?? DEFAULT_RATE,
      voiceId: undefined,
      currentWordIndex: -1,
      error: null,
    };
  }

  subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): DictationSnapshot => this.snapshot;

  async play(): Promise<void> {
    const { status, currentWordIndex } = this.snapshot;
    if (status === "playing" || status === "loading") return;
    if (status === "paused") return this.resume();
    return this.startFrom(Math.max(0, currentWordIndex));
  }

  pause(): void {
    if (this.snapshot.status !== "playing") return;
    this.engine?.pause();
    this.clearWatchdog();
    this.update({ status: "paused" });
  }

  async resume(): Promise<void> {
    if (this.snapshot.status !== "paused") return;
    if (this.pausedByCancel) return this.startFrom(this.snapshot.currentWordIndex);
    this.engine?.resume();
    this.update({ status: "playing" });
    this.armWatchdog();
  }

  stop(): void {
    this.startToken++;
    this.clearWatchdog();
    this.pausedByCancel = false;
    if (activeController === this) this.engine?.cancel();
    this.release();
    this.highlighter?.clear();
    this.update({ status: "idle", currentWordIndex: -1, error: null });
  }

  async setRate(rate: number): Promise<void> {
    this.update({ rate });
    return this.restartIfActive();
  }

  async setVoice(voiceId: string | undefined): Promise<void> {
    this.update({ voiceId });
    return this.restartIfActive();
  }

  async seekToWord(index: number): Promise<void> {
    return this.startFrom(index);
  }

  async seekToPoint(node: Node, offset: number): Promise<void> {
    const extracted = this.ensureExtracted();
    if (!extracted) return;
    const index = wordIndexAtPoint(extracted.words, node, offset);
    if (index >= 0) return this.startFrom(index);
  }

  /** Call when the message content changed: stops playback and forgets cached words. */
  invalidate(): void {
    this.extracted = null;
    if (this.snapshot.status !== "idle") this.stop();
  }

  /** Stops and releases resources. The controller stays usable (StrictMode remounts). */
  dispose(): void {
    this.stop();
    this.highlighter?.dispose();
    this.highlighter = null;
    this.extracted = null;
  }

  listVoices(): Promise<VoiceInfo[]> {
    return this.options.getEngine()?.listVoices() ?? Promise.resolve([]);
  }

  private async restartIfActive(): Promise<void> {
    const { status, currentWordIndex } = this.snapshot;
    if (status === "playing") return this.startFrom(currentWordIndex);
    if (status === "paused") {
      // Engines can't change rate/voice mid-utterance; restart from this word on resume.
      this.engine?.cancel();
      this.pausedByCancel = true;
    }
    // While loading, startFrom reads the new rate/voice after its await.
  }

  private async startFrom(requestedIndex: number, fromWatchdog = false): Promise<void> {
    const engine = this.options.getEngine();
    const extracted = this.ensureExtracted();
    if (!engine || !extracted) return;
    if (extracted.words.length === 0) {
      this.update({ error: "There is no text to read." });
      return;
    }

    const token = ++this.startToken;
    const index = Math.min(Math.max(requestedIndex, 0), extracted.words.length - 1);
    if (!fromWatchdog) this.stalledAt = -1;
    this.acquire(engine);
    engine.cancel();
    this.clearWatchdog();
    this.pausedByCancel = false;
    this.setWord(index);
    this.update({ status: "loading", error: null });

    try {
      await engine.listVoices();
    } catch {
      // Speak with the engine's default voice.
    }
    if (token !== this.startToken) return;

    this.baseOffset = extracted.words[index].start;
    this.update({ status: "playing" });
    engine.speak(extracted.text.slice(this.baseOffset), {
      rate: this.snapshot.rate,
      voiceId: this.snapshot.voiceId,
    });
    this.armWatchdog();
  }

  private ensureExtracted(): ExtractedText | null {
    if (this.extracted) return this.extracted;
    const container = this.options.getContainer();
    if (!container) return null;
    this.extracted = extractWords(container, this.options.extractOptions);
    return this.extracted;
  }

  private acquire(engine: SpeechEngine): void {
    if (activeController !== this) {
      activeController?.stop();
      activeController = this;
    }
    if (this.engine !== engine) this.unsubscribeEngine();
    this.engine = engine;
    if (this.engineUnsubs.length === 0) {
      this.engineUnsubs = [
        engine.onBoundary(this.handleBoundary),
        engine.onEnd(this.handleEnd),
        engine.onError(this.handleError),
      ];
    }
  }

  private release(): void {
    this.unsubscribeEngine();
    if (activeController === this) activeController = null;
  }

  private unsubscribeEngine(): void {
    this.engineUnsubs.forEach((unsubscribe) => unsubscribe());
    this.engineUnsubs = [];
  }

  private readonly handleBoundary = (charIndex: number): void => {
    const extracted = this.extracted;
    if (!extracted) return;
    if (this.snapshot.status === "paused") {
      // The engine ignored pause(); silence it and restart from the paused word on resume.
      this.engine?.cancel();
      this.pausedByCancel = true;
      return;
    }
    if (this.snapshot.status !== "playing") return;
    const index = wordIndexAtOffset(extracted.words, this.baseOffset + charIndex);
    if (index >= 0 && index !== this.snapshot.currentWordIndex) {
      this.stalledAt = -1;
      this.setWord(index);
    }
    this.armWatchdog();
  };

  private readonly handleEnd = (): void => {
    if (this.snapshot.status === "paused") {
      this.pausedByCancel = true;
      return;
    }
    if (this.snapshot.status === "playing") this.stop();
  };

  private readonly handleError = (error: Error): void => {
    this.stop();
    this.update({ error: error.message });
  };

  private setWord(index: number): void {
    const word = this.extracted?.words[index];
    if (!word) return;
    this.highlighter ??= (this.options.createHighlighter ?? createHighlighter)();
    this.highlighter.show(word.range);
    this.update({ currentWordIndex: index });
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.snapshot.status !== "playing") return;
      const index = this.snapshot.currentWordIndex;
      if (this.stalledAt === index) {
        this.stop();
        this.update({ error: "Speech stopped responding." });
        return;
      }
      this.stalledAt = index;
      void this.startFrom(index, true);
    }, this.options.watchdogMs ?? 10_000);
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private update(patch: Partial<DictationSnapshot>): void {
    const keys = Object.keys(patch) as (keyof DictationSnapshot)[];
    if (keys.every((key) => this.snapshot[key] === patch[key])) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/features/dictation/__tests__/dictation-controller.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/features/dictation/dictation-controller.ts src/features/dictation/__tests__/fake-engine.ts src/features/dictation/__tests__/dictation-controller.test.ts
git commit -m "feat(dictation): add playback controller with seek, rate change and single-player lock"
```

---

### Task 6: `useDictation` hook

**Files:**
- Create: `src/features/dictation/use-dictation.ts`
- Test: `src/features/dictation/__tests__/use-dictation.test.tsx`

**Interfaces:**
- Consumes: `DictationController`, `DictationSnapshot` (Task 5); `SpeechEngine`, `VoiceInfo` (Task 3); `getWebSpeechEngine`, `isWebSpeechSupported` (Task 3); `ExtractOptions` (Task 2); `createHighlighter` (Task 4); `FakeEngine` test helper (Task 5).
- Produces:
  - `interface UseDictationOptions { isComplete?: boolean /* true */; engine?: SpeechEngine; extractOptions?: ExtractOptions; autoScroll?: boolean /* true */; clickToSeek?: boolean /* true */ }` — `extractOptions` and `autoScroll` are read once on mount.
  - `interface UseDictationResult extends DictationSnapshot { supported: boolean; disabled: boolean; play(): void; pause(): void; resume(): void; stop(): void; setRate(rate: number): void; setVoice(voiceId: string | undefined): void; seekToWord(index: number): void; listVoices(): Promise<VoiceInfo[]> }` — action functions are stable across renders unless `disabled` changes.
  - `useDictation(ref: RefObject<HTMLElement | null>, options?: UseDictationOptions): UseDictationResult`

- [ ] **Step 1: Write the failing tests** — `src/features/dictation/__tests__/use-dictation.test.tsx`

```tsx
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { stopActiveDictation } from "../dictation-controller";
import type { SpeechEngine } from "../engines/types";
import { useDictation } from "../use-dictation";
import { FakeEngine } from "./fake-engine";

function Message({ html, engine, isComplete = true }: { html: string; engine?: SpeechEngine; isComplete?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const d = useDictation(ref, { engine, isComplete, autoScroll: false });
  return (
    <div>
      <button type="button" onClick={d.play}>
        play
      </button>
      <output data-testid="state">{`${d.supported}|${d.disabled}|${d.status}|${d.currentWordIndex}`}</output>
      <div ref={ref} data-testid="content" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

const state = () => screen.getByTestId("state").textContent;
const content = () => screen.getByTestId("content");

async function clickPlay() {
  await act(async () => {
    fireEvent.click(screen.getByText("play"));
  });
}

function mockCaret(node: Node, offset: number) {
  Object.defineProperty(document, "caretRangeFromPoint", {
    configurable: true,
    value: () => {
      const range = document.createRange();
      range.setStart(node, offset);
      return range;
    },
  });
}

afterEach(() => {
  cleanup();
  stopActiveDictation();
  delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
  window.getSelection()?.removeAllRanges();
});

describe("useDictation", () => {
  it("is unsupported without an engine or speechSynthesis", () => {
    render(<Message html="<p>hi</p>" />);
    expect(state()).toBe("false|true|idle|-1");
  });

  it("reads the message aloud", async () => {
    const engine = new FakeEngine();
    render(<Message html="<p>hello brave world</p>" engine={engine} />);
    await clickPlay();
    expect(engine.lastSpoken?.text).toBe("hello brave world.");
    expect(state()).toBe("true|false|playing|0");
  });

  it("stays disabled while the response is incomplete", async () => {
    const engine = new FakeEngine();
    render(<Message html="<p>partial</p>" engine={engine} isComplete={false} />);
    await clickPlay();
    expect(state()).toBe("true|true|idle|-1");
    expect(engine.spoken).toHaveLength(0);
  });

  it("stops when the message content changes", async () => {
    const engine = new FakeEngine();
    const { rerender } = render(<Message html="<p>first version</p>" engine={engine} />);
    await clickPlay();
    rerender(<Message html="<p>second version</p>" engine={engine} />);
    await waitFor(() => expect(state()).toBe("true|false|idle|-1"));
    await clickPlay();
    expect(engine.lastSpoken?.text).toBe("second version.");
  });

  it("cancels speech on unmount", async () => {
    const engine = new FakeEngine();
    const { unmount } = render(<Message html="<p>hello</p>" engine={engine} />);
    await clickPlay();
    unmount();
    expect(engine.calls.at(-1)).toBe("cancel");
  });

  it("stops on pagehide", async () => {
    const engine = new FakeEngine();
    render(<Message html="<p>hello</p>" engine={engine} />);
    await clickPlay();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(state()).toBe("true|false|idle|-1");
  });

  describe("click to seek", () => {
    it("starts reading from the clicked word", async () => {
      const engine = new FakeEngine();
      render(<Message html="<p>hello brave world</p>" engine={engine} />);
      const p = content().querySelector("p")!;
      mockCaret(p.firstChild!, 7);
      await act(async () => {
        fireEvent.click(p);
      });
      expect(engine.lastSpoken?.text).toBe("brave world.");
    });

    it("ignores clicks that end a text selection", async () => {
      const engine = new FakeEngine();
      render(<Message html="<p>hello brave world</p>" engine={engine} />);
      const p = content().querySelector("p")!;
      window.getSelection()!.selectAllChildren(p);
      mockCaret(p.firstChild!, 7);
      await act(async () => {
        fireEvent.click(p);
      });
      expect(engine.spoken).toHaveLength(0);
    });

    it("ignores clicks on links", async () => {
      const engine = new FakeEngine();
      render(<Message html='<p>go <a href="#x">here</a> now</p>' engine={engine} />);
      const link = content().querySelector("a")!;
      mockCaret(link.firstChild!, 1);
      await act(async () => {
        fireEvent.click(link);
      });
      expect(engine.spoken).toHaveLength(0);
    });

    it("ignores clicks while the response is incomplete", async () => {
      const engine = new FakeEngine();
      render(<Message html="<p>hello brave world</p>" engine={engine} isComplete={false} />);
      const p = content().querySelector("p")!;
      mockCaret(p.firstChild!, 7);
      await act(async () => {
        fireEvent.click(p);
      });
      expect(engine.spoken).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/dictation/__tests__/use-dictation.test.tsx`
Expected: FAIL — cannot resolve `../use-dictation`.

- [ ] **Step 3: Implement** — `src/features/dictation/use-dictation.ts`

```ts
"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { DictationController, type DictationSnapshot } from "./dictation-controller";
import type { SpeechEngine, VoiceInfo } from "./engines/types";
import { getWebSpeechEngine, isWebSpeechSupported } from "./engines/web-speech-engine";
import type { ExtractOptions } from "./extract-words";
import { createHighlighter } from "./highlighter";

export interface UseDictationOptions {
  /** False while the response is still streaming; dictation stays disabled. Default true. */
  isComplete?: boolean;
  /** Speech backend. Defaults to the browser's Web Speech API. */
  engine?: SpeechEngine;
  /** What to skip or replace when reading. Read once on mount. */
  extractOptions?: ExtractOptions;
  /** Keep the highlighted word in view. Read once on mount. Default true. */
  autoScroll?: boolean;
  /** Clicking a word starts reading from it. Default true. */
  clickToSeek?: boolean;
}

export interface UseDictationResult extends DictationSnapshot {
  supported: boolean;
  disabled: boolean;
  play(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setRate(rate: number): void;
  setVoice(voiceId: string | undefined): void;
  seekToWord(index: number): void;
  listVoices(): Promise<VoiceInfo[]>;
}

// Clicks on these keep their normal behaviour instead of seeking.
const INTERACTIVE =
  'a, button, input, textarea, select, summary, label, [role="button"], [contenteditable=""], [contenteditable="true"], [data-dictation="skip"]';

const noopSubscribe = () => () => {};

export function useDictation(
  ref: RefObject<HTMLElement | null>,
  options: UseDictationOptions = {},
): UseDictationResult {
  const { isComplete = true, engine, extractOptions, autoScroll = true, clickToSeek = true } = options;

  // False on the server and during hydration, so markup matches.
  const supported = useSyncExternalStore(
    noopSubscribe,
    () => engine !== undefined || isWebSpeechSupported(),
    () => false,
  );
  const disabled = !supported || !isComplete;

  const engineRef = useRef(engine);
  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

  const [controller] = useState(
    () =>
      new DictationController({
        getContainer: () => ref.current,
        getEngine: () => engineRef.current ?? getWebSpeechEngine(),
        extractOptions,
        createHighlighter: () => createHighlighter({ autoScroll }),
      }),
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const observer = new MutationObserver(() => controller.invalidate());
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [controller, ref]);

  useEffect(() => {
    if (!isComplete) controller.stop();
  }, [controller, isComplete]);

  useEffect(() => {
    // Chrome keeps speaking after navigation unless cancelled.
    const onPageHide = () => controller.stop();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    const container = ref.current;
    if (!container || !clickToSeek || disabled) return;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
      const caret = caretFromPoint(event.clientX, event.clientY);
      if (caret && container.contains(caret.node)) void controller.seekToPoint(caret.node, caret.offset);
    };
    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
  }, [controller, ref, clickToSeek, disabled]);

  const actions = useMemo(
    () => ({
      play: () => {
        if (!disabled) void controller.play();
      },
      pause: () => controller.pause(),
      resume: () => {
        void controller.resume();
      },
      stop: () => controller.stop(),
      setRate: (rate: number) => {
        void controller.setRate(rate);
      },
      setVoice: (voiceId: string | undefined) => {
        void controller.setVoice(voiceId);
      },
      seekToWord: (index: number) => {
        if (!disabled) void controller.seekToWord(index);
      },
      listVoices: () => controller.listVoices(),
    }),
    [controller, disabled],
  );

  return useMemo(() => ({ ...snapshot, supported, disabled, ...actions }), [snapshot, supported, disabled, actions]);
}

function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as unknown as {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/dictation/__tests__/use-dictation.test.tsx && npm run typecheck`
Expected: PASS; no type errors. If jsdom implements `caretPositionFromPoint` and it shadows the mocked `caretRangeFromPoint`, mock `caretPositionFromPoint` in `mockCaret` instead (returning `{ offsetNode: node, offset }`).

- [ ] **Step 5: Commit**

```bash
git add src/features/dictation/use-dictation.ts src/features/dictation/__tests__/use-dictation.test.tsx
git commit -m "feat(dictation): add useDictation hook with click-to-seek and lifecycle cleanup"
```

---

### Task 7: Toolbar, styles and public exports

**Files:**
- Create: `src/features/dictation/DictationToolbar.tsx`
- Create: `src/features/dictation/dictation.css`
- Create: `src/features/dictation/index.ts`
- Test: `src/features/dictation/__tests__/DictationToolbar.test.tsx`

**Interfaces:**
- Consumes: `UseDictationResult` (Task 6), `RATES` (Task 1), `VoiceInfo` (Task 3).
- Produces: `DictationToolbar(props: { dictation: UseDictationResult; showVoicePicker?: boolean; className?: string })`; the public barrel `@/features/dictation`.

UI decision (deviation from spec §9, to keep native button behaviour): Space activates whichever toolbar button has focus (on the main button that toggles Pause/Resume). Escape stops reading from anywhere in the toolbar. Overriding Space globally would break the speed buttons for keyboard users.

- [ ] **Step 1: Write the failing tests** — `src/features/dictation/__tests__/DictationToolbar.test.tsx`

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationToolbar } from "../DictationToolbar";
import type { UseDictationResult } from "../use-dictation";

function fakeDictation(overrides: Partial<UseDictationResult> = {}): UseDictationResult {
  return {
    status: "idle",
    rate: 1,
    voiceId: undefined,
    currentWordIndex: -1,
    error: null,
    supported: true,
    disabled: false,
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    setRate: vi.fn(),
    setVoice: vi.fn(),
    seekToWord: vi.fn(),
    listVoices: vi.fn(async () => [{ id: "v1", name: "Samantha", lang: "en-US" }]),
    ...overrides,
  };
}

afterEach(cleanup);

describe("DictationToolbar", () => {
  it("renders nothing when speech is unsupported", () => {
    const { container } = render(<DictationToolbar dictation={fakeDictation({ supported: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("starts reading from the Dictate button", () => {
    const d = fakeDictation();
    render(<DictationToolbar dictation={d} />);
    fireEvent.click(screen.getByRole("button", { name: "Read this response aloud" }));
    expect(d.play).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Stop reading" })).toBeNull();
  });

  it("disables Dictate while the response is incomplete", () => {
    render(<DictationToolbar dictation={fakeDictation({ disabled: true })} />);
    expect(screen.getByRole("button", { name: "Read this response aloud" })).toBeDisabled();
  });

  it("shows Pause and Stop while playing", () => {
    const d = fakeDictation({ status: "playing" });
    render(<DictationToolbar dictation={d} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause reading" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop reading" }));
    expect(d.pause).toHaveBeenCalled();
    expect(d.stop).toHaveBeenCalled();
    expect(screen.getByText("Reading aloud")).toBeTruthy();
  });

  it("shows Resume while paused", () => {
    const d = fakeDictation({ status: "paused" });
    render(<DictationToolbar dictation={d} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume reading" }));
    expect(d.resume).toHaveBeenCalled();
  });

  it("offers exactly the four speeds and marks the current one", () => {
    const d = fakeDictation({ rate: 1.5 });
    render(<DictationToolbar dictation={d} />);
    const group = screen.getByRole("group", { name: "Reading speed" });
    const buttons = Array.from(group.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["0.5x", "1x", "1.5x", "2x"]);
    expect(screen.getByRole("button", { name: "1.5x" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1x" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "2x" }));
    expect(d.setRate).toHaveBeenCalledWith(2);
  });

  it("stops on Escape while active", () => {
    const d = fakeDictation({ status: "playing" });
    render(<DictationToolbar dictation={d} />);
    fireEvent.keyDown(screen.getByRole("toolbar"), { key: "Escape" });
    expect(d.stop).toHaveBeenCalled();
  });

  it("shows errors", () => {
    render(<DictationToolbar dictation={fakeDictation({ error: "boom" })} />);
    expect(screen.getByRole("alert").textContent).toBe("boom");
  });

  it("lists voices and selects one", async () => {
    const d = fakeDictation();
    render(<DictationToolbar dictation={d} showVoicePicker />);
    await screen.findByRole("option", { name: "Samantha (en-US)" });
    fireEvent.change(screen.getByRole("combobox", { name: "Voice" }), { target: { value: "v1" } });
    expect(d.setVoice).toHaveBeenCalledWith("v1");
  });
});
```

`toBeEmptyDOMElement`, `toBeDisabled` and `toHaveAttribute` come from `@testing-library/jest-dom`. Install it and register it:

```bash
npm install -D @testing-library/jest-dom
```

Add to `vitest.config.ts` under `test`: `setupFiles: ["./vitest.setup.ts"],` and create `vitest.setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/dictation/__tests__/DictationToolbar.test.tsx`
Expected: FAIL — cannot resolve `../DictationToolbar`.

- [ ] **Step 3: Implement the toolbar** — `src/features/dictation/DictationToolbar.tsx`

```tsx
"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { RATES } from "./constants";
import type { DictationStatus } from "./dictation-controller";
import type { VoiceInfo } from "./engines/types";
import type { UseDictationResult } from "./use-dictation";

export interface DictationToolbarProps {
  dictation: UseDictationResult;
  /** Show a voice selector. Handy for testing voices; often hidden in production. */
  showVoicePicker?: boolean;
  className?: string;
}

const STATUS_TEXT: Record<DictationStatus, string> = {
  idle: "",
  loading: "Preparing voice",
  playing: "Reading aloud",
  paused: "Paused",
};

export function DictationToolbar({ dictation, showVoicePicker = false, className }: DictationToolbarProps) {
  if (!dictation.supported) return null;
  const { status, rate, error, disabled } = dictation;
  const active = status !== "idle";

  const primary =
    status === "playing"
      ? { icon: "❚❚", label: "Pause", aria: "Pause reading", onClick: dictation.pause }
      : status === "paused"
        ? { icon: "▶", label: "Resume", aria: "Resume reading", onClick: dictation.resume }
        : status === "loading"
          ? { icon: "…", label: "Loading", aria: "Loading voice", onClick: undefined }
          : { icon: "▶", label: "Dictate", aria: "Read this response aloud", onClick: dictation.play };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && active) {
      event.preventDefault();
      dictation.stop();
    }
  };

  return (
    <div
      role="toolbar"
      aria-label="Read aloud"
      className={["dictation-toolbar", className].filter(Boolean).join(" ")}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="dictation-btn dictation-primary"
        aria-label={primary.aria}
        onClick={primary.onClick}
        disabled={disabled || status === "loading"}
        title={disabled ? "Available when the response finishes" : undefined}
      >
        <span aria-hidden="true">{primary.icon}</span> {primary.label}
      </button>
      {active && (
        <button type="button" className="dictation-btn" aria-label="Stop reading" onClick={dictation.stop}>
          <span aria-hidden="true">■</span> Stop
        </button>
      )}
      <div role="group" aria-label="Reading speed" className="dictation-rates">
        {RATES.map((value) => (
          <button
            key={value}
            type="button"
            className="dictation-rate"
            aria-pressed={rate === value}
            onClick={() => dictation.setRate(value)}
          >
            {value}x
          </button>
        ))}
      </div>
      {showVoicePicker && <VoicePicker dictation={dictation} />}
      <span className="dictation-sr-only" aria-live="polite">
        {STATUS_TEXT[status]}
      </span>
      {error && (
        <span className="dictation-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function VoicePicker({ dictation }: { dictation: UseDictationResult }) {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const { listVoices } = dictation;

  useEffect(() => {
    let cancelled = false;
    void listVoices().then((list) => {
      if (!cancelled) setVoices(list);
    });
    return () => {
      cancelled = true;
    };
  }, [listVoices]);

  return (
    <select
      className="dictation-voice"
      aria-label="Voice"
      value={dictation.voiceId ?? ""}
      onChange={(event) => dictation.setVoice(event.target.value || undefined)}
    >
      <option value="">Default voice</option>
      {voices.map((voice) => (
        <option key={voice.id} value={voice.id}>
          {voice.name} ({voice.lang})
        </option>
      ))}
    </select>
  );
}
```

- [ ] **Step 4: Add styles** — `src/features/dictation/dictation.css`

```css
:root {
  --dictation-highlight-bg: #fde68a;
  --dictation-accent: #2563eb;
}

@media (prefers-color-scheme: dark) {
  :root {
    --dictation-highlight-bg: #854d0e;
    --dictation-accent: #60a5fa;
  }
}

::highlight(dictation-word) {
  background-color: var(--dictation-highlight-bg);
}

.dictation-overlay-box {
  background-color: var(--dictation-highlight-bg);
  mix-blend-mode: multiply;
  border-radius: 2px;
  z-index: 1;
}

.dictation-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0.5rem 0;
  font-size: 0.875rem;
}

.dictation-btn,
.dictation-rate {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 6px;
  padding: 0.25rem 0.6rem;
  cursor: pointer;
}

.dictation-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.dictation-primary {
  border-color: var(--dictation-accent);
  color: var(--dictation-accent);
}

.dictation-rates {
  display: inline-flex;
}

.dictation-rate {
  border-radius: 0;
  margin-left: -1px;
}

.dictation-rate:first-child {
  border-radius: 6px 0 0 6px;
  margin-left: 0;
}

.dictation-rate:last-child {
  border-radius: 0 6px 6px 0;
}

.dictation-rate[aria-pressed="true"] {
  background: var(--dictation-accent);
  border-color: var(--dictation-accent);
  color: #fff;
}

select.dictation-voice {
  font: inherit;
  padding: 0.2rem;
  border-radius: 6px;
  max-width: 14rem;
}

.dictation-error {
  color: #dc2626;
}

.dictation-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
```

- [ ] **Step 5: Add public exports** — `src/features/dictation/index.ts`

```ts
export { DictationToolbar, type DictationToolbarProps } from "./DictationToolbar";
export { useDictation, type UseDictationOptions, type UseDictationResult } from "./use-dictation";
export { stopActiveDictation, type DictationSnapshot, type DictationStatus } from "./dictation-controller";
export { DEFAULT_RATE, HIGHLIGHT_NAME, RATES, type DictationRate } from "./constants";
export { DEFAULT_REPLACE, DEFAULT_SKIP, type ExtractOptions, type Replacement } from "./extract-words";
export type { SpeakOptions, SpeechEngine, Unsubscribe, VoiceInfo } from "./engines/types";
export { WebSpeechEngine } from "./engines/web-speech-engine";
```

- [ ] **Step 6: Run all tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all test files PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(dictation): add toolbar UI, styles and public exports"
```

---

### Task 8: Demo app with both renderers

**Files:**
- Create: `src/demo/AgentMarkdown.tsx`, `src/demo/MarkdocMarkdown.tsx`, `src/demo/messages.ts`, `src/demo/ChatMessage.tsx`, `src/demo/ChatDemo.tsx`
- Modify: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- Test: `src/demo/__tests__/renderers.test.tsx`

**Interfaces:**
- Consumes: `extractWords` (Task 2); `useDictation`, `DictationToolbar` via `@/features/dictation` (Task 7).
- Produces: `AgentMarkdown({ content })`, `MarkdocMarkdown({ content })`, `markdocConfig`, `markdocComponents`, `DEMO_MESSAGES`, `STREAMING_MESSAGE`, `ChatMessage({ message, isComplete? })`, `ChatDemo()`.

- [ ] **Step 1: Create the renderers**

`src/demo/AgentMarkdown.tsx` (mirrors the main project's agent-mode renderer):
```tsx
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
```

`src/demo/MarkdocMarkdown.tsx` (mirrors the main project's Markdoc renderer with a citation tag):
```tsx
import Markdoc, { type Config } from "@markdoc/markdoc";
import React from "react";

export const markdocConfig: Config = {
  tags: {
    citation: {
      render: "Citation",
      selfClosing: true,
      attributes: { id: { type: Number, required: true } },
    },
  },
};

function Citation({ id }: { id: number }) {
  return (
    <sup data-citation={id} className="citation">
      [{id}]
    </sup>
  );
}

export const markdocComponents = { Citation };

export function MarkdocMarkdown({ content }: { content: string }) {
  const tree = Markdoc.transform(Markdoc.parse(content), markdocConfig);
  return <>{Markdoc.renderers.react(tree, React, { components: markdocComponents })}</>;
}
```

- [ ] **Step 2: Write the failing renderer test** — `src/demo/__tests__/renderers.test.tsx`

```tsx
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
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run src/demo/__tests__/renderers.test.tsx`
Expected: PASS (the renderers and `extractWords` already exist). If an expected string differs, inspect the rendered HTML (`console.log(el.innerHTML)`), decide whether the difference is a real extraction bug (fix `extract-words.ts` and add a unit test for it in Task 2's file) or a harmless renderer detail (update the expectation), and note which in the commit message.

- [ ] **Step 4: Create messages and chat components**

`src/demo/messages.ts`:
```ts
export type Renderer = "react-markdown" | "markdoc";

export interface DemoMessage {
  id: string;
  renderer: Renderer;
  content: string;
}

export const DEMO_MESSAGES: DemoMessage[] = [
  {
    id: "agent",
    renderer: "react-markdown",
    content: [
      "## How compound interest works",
      "",
      "Compound interest means you earn **interest on your interest**. Each period, the interest is added to the balance, so the next period's interest is a little larger.",
      "",
      "The formula is $A = P(1 + r/n)^{nt}$, where:",
      "",
      "- *P* is the starting amount",
      "- *r* is the yearly rate",
      "- *n* is how many times per year interest is added",
      "",
      "| Years | Balance at 5% |",
      "|---|---|",
      "| 1 | \\$1,050 |",
      "| 10 | \\$1,629 |",
      "",
      "You can check this with a few lines of code:",
      "",
      "```python",
      "balance = 1000 * (1 + 0.05) ** 10",
      "```",
      "",
      "Starting early matters more than starting big.",
    ].join("\n"),
  },
  {
    id: "markdoc",
    renderer: "markdoc",
    content: [
      "# Summary of the report",
      "",
      "Revenue grew by 12% compared with last year {% citation id=1 /%}, mainly from the new subscription plan.",
      "",
      "Costs stayed flat {% citation id=2 /%}. The team expects similar results next quarter.",
    ].join("\n"),
  },
];

export const STREAMING_MESSAGE: DemoMessage = {
  id: "long",
  renderer: "react-markdown",
  content: [
    "## A longer answer to test auto-scroll",
    "",
    ...Array.from(
      { length: 8 },
      (_, i) =>
        `Paragraph ${i + 1}. Reading long answers on screen can be tiring, so listening while the current word is highlighted helps you keep your place. You can pause at any time, change the speed, or click any word to jump straight to it.\n`,
    ),
  ].join("\n"),
};
```

`src/demo/ChatMessage.tsx` (the integration example for the main project):
```tsx
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
```

`src/demo/ChatDemo.tsx`:
```tsx
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
```

- [ ] **Step 5: Wire the page, layout and styles**

`src/app/layout.tsx` — replace the import line `import "./globals.css";` with:
```tsx
import "katex/dist/katex.min.css";
import "@/features/dictation/dictation.css";
import "./globals.css";
```

`src/app/page.tsx`:
```tsx
import { ChatDemo } from "@/demo/ChatDemo";

export default function Page() {
  return (
    <main className="chat">
      <h1>Chat dictation demo</h1>
      <ChatDemo />
    </main>
  );
}
```

`src/app/globals.css` (replace contents):
```css
body {
  margin: 0;
  font-family: system-ui, sans-serif;
  line-height: 1.6;
}

.chat {
  max-width: 760px;
  margin: 0 auto;
  padding: 1rem;
}

.chat-scroll {
  height: 75vh;
  overflow-y: auto;
  border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  border-radius: 12px;
  padding: 1rem;
}

.chat-user {
  margin: 1rem 0 0.5rem auto;
  width: fit-content;
  max-width: 80%;
  padding: 0.5rem 0.9rem;
  border-radius: 12px;
  background: color-mix(in srgb, #2563eb 12%, transparent);
}

.chat-message {
  padding: 0.75rem 1rem;
  border-radius: 12px;
  background: color-mix(in srgb, currentColor 5%, transparent);
}

.chat-message-meta {
  font-size: 0.75rem;
  opacity: 0.6;
}

.chat-message-body table {
  border-collapse: collapse;
}

.chat-message-body th,
.chat-message-body td {
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  padding: 0.25rem 0.6rem;
}

.chat-message-body pre {
  overflow-x: auto;
  padding: 0.75rem;
  border-radius: 8px;
  background: color-mix(in srgb, currentColor 8%, transparent);
}
```

- [ ] **Step 6: Verify tests, typecheck and production build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests pass; no type errors; `next build` completes and lists route `/`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(demo): chat demo with react-markdown and Markdoc messages"
```

---

### Task 9: Integration guide and manual verification

**Files:**
- Create: `src/features/dictation/README.md`

**Interfaces:**
- Consumes: everything above. No code changes unless manual testing finds a bug (then follow superpowers:systematic-debugging, add a failing test, fix, commit).

- [ ] **Step 1: Write the integration guide** — `src/features/dictation/README.md`

````markdown
# Dictation (read aloud with word highlighting)

Reads an assistant message aloud at 0.5x, 1x, 1.5x or 2x and highlights each word as it is spoken.
Works with any renderer (react-markdown, Markdoc, plain HTML) because it reads the rendered DOM.

## Add to a project

1. Copy this folder to `src/features/dictation/`. Delete `__tests__/` if you don't use Vitest.
2. Import the styles once, e.g. in `app/layout.tsx`:
   ```tsx
   import "@/features/dictation/dictation.css";
   ```
3. Wrap each assistant message:
   ```tsx
   "use client";
   import { useRef } from "react";
   import { DictationToolbar, useDictation } from "@/features/dictation";

   function AssistantMessage({ content, isStreaming }: { content: string; isStreaming: boolean }) {
     const ref = useRef<HTMLDivElement>(null);
     const dictation = useDictation(ref, { isComplete: !isStreaming });
     return (
       <>
         <div ref={ref}>
           <AgentMarkdown content={content} />
         </div>
         <DictationToolbar dictation={dictation} />
       </>
     );
   }
   ```

## What gets read

| Content | Behaviour |
|---|---|
| `pre` (code blocks) | Spoken as "code block" |
| `.katex`, `.katex-display` | Spoken as "equation" |
| `[data-citation]`, `sup.citation`, `[aria-hidden="true"]`, `[data-dictation="skip"]` | Skipped |
| Everything else | Read as rendered; headings, list items and table rows end with a pause |

If your citation component renders differently, pass your own selectors:

```tsx
import { DEFAULT_SKIP, useDictation } from "@/features/dictation";

useDictation(ref, { extractOptions: { skip: `${DEFAULT_SKIP}, .my-citation` } });
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `isComplete` | `true` | Keep the toolbar disabled while the response streams |
| `engine` | browser Web Speech | Any `SpeechEngine` implementation |
| `extractOptions` | see above | `{ replace, skip }` |
| `autoScroll` | `true` | Keep the spoken word visible |
| `clickToSeek` | `true` | Clicking a word starts reading from it |

Customise colours with `--dictation-highlight-bg` and `--dictation-accent`.

## Adding a cloud voice later

Implement `SpeechEngine` (see `engines/types.ts`) and pass it as `engine`:

- `speak(text, { rate, voiceId })`: call a Next.js route handler that returns audio plus word timings
  (character offsets into `text` with start times), play it in an `<audio>` element, and call the
  boundary listeners from a `requestAnimationFrame` loop as `audio.currentTime` passes each timing.
- `pause` / `resume` / `cancel`: map to the audio element.
- Boundary indexes must be offsets into the `text` given to the latest `speak()`.

The controller and UI do not change.

## Browser support

Highlighting uses the CSS Custom Highlight API (Chrome/Edge 105+, Safari 17.2+, Firefox 140+), with
an overlay fallback for older browsers. Voices that report no word positions (for example Chrome's
online "Google" voices) fall back to estimated timing, so highlighting there is approximate.
````

- [ ] **Step 2: Run the full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 3: Manual verification in the browser (with the human partner)**

Run: `npm run dev` and open http://localhost:3000 in Chrome, Safari and Edge on macOS. Check:

1. Dictate on the first message: voice speaks; the highlighted word tracks the voice at 0.5x, 1x, 1.5x and 2x.
2. Change speed mid-sentence: continues from the current word at the new speed.
3. Pause, wait, Resume: continues from the same word.
4. Stop: voice stops, highlight disappears.
5. Click a word in the middle of a message: reading starts from that word.
6. Selecting text with the mouse does not start reading.
7. Code block reads as "code block"; maths reads as "equation"; citations are skipped in the Markdoc message.
8. Long message: Dictate disabled while streaming; once complete, the chat pane auto-scrolls to keep the word visible.
9. Start message 1, then Dictate message 2: message 1 stops.
10. Reload the page while speaking: the voice stops.
11. Voice picker: choose a "Google" voice in Chrome — highlighting still moves (estimated timing).

Record any failure, reproduce it, fix it with a failing test first, and re-run Step 2.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs(dictation): add integration guide"
```
