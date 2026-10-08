# Dictation Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add remembered speed/voice, sentence skipping, a floating mini-player and a sentence highlight to the existing `src/features/dictation/` module.

**Architecture:** A module-level preferences store (localStorage-backed) feeds every `DictationController`. Word extraction also produces sentences; the highlighter gains a second, lower-priority highlight layer; the controller gains `skipSentence` and an "active dictation" external store that a single `<DictationMiniPlayer />` subscribes to, showing itself when the active message's toolbar is off-screen (IntersectionObserver).

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9 strict, Vitest 5 + jsdom + Testing Library (+ jest-dom).

**Spec:** `docs/superpowers/specs/2026-10-09-dictation-enhancements-design.md` (builds on `docs/superpowers/specs/2026-10-09-chat-dictation-design.md`)

## Global Constraints

- Everything under `src/features/dictation/` depends only on `react` and browser APIs; no imports from `src/demo` or `src/app`.
- The message container's DOM is never mutated (highlights via `CSS.highlights`; overlay fallback boxes live in `document.body`).
- No `window`/`document`/`localStorage` access at module top level; module state must not be mutated during SSR. Hook/toolbar/mini-player files start with `"use client"`.
- Speeds are exactly `0.5, 1, 1.5, 2`; default `1`.
- Highlight names: word `dictation-word`, sentence `dictation-sentence` (word wins: higher priority).
- localStorage key: `dictation:preferences`.
- Toolbar-like elements carry `data-dictation="skip"`; accessible names start with the visible text when a button has visible words; icon-only buttons use `aria-label`.
- Existing behaviour must not regress: deferred single-click seek ignoring double/triple clicks; MutationObserver ignoring `[data-dictation="skip"]`; `isComplete` changes → `controller.invalidate()`; user-scroll → following off + "Back to current word".
- Test command: `npm test`; also `npm run typecheck` and `npm run build` must pass at the end of every task. Vitest globals are off: test files import from `vitest` and call `cleanup()` themselves.

## Review Focus

1. **Blocked or corrupt storage (private mode, quota, garbage JSON, rate 3) must never crash and must fall back to 1x / default voice** — Task 1 tests.
2. **Changing speed from the mini-player while reading must continue from the current word at the new speed, and every toolbar must show the new speed** — Task 6 test.
3. **Skipping while paused must stay paused and resume from the new sentence** — Task 4 test.
4. **The mini-player must not appear while the message's own toolbar is visible, nor during SSR/idle** — Task 6 tests.
5. **Arrow keys used inside the voice `<select>` must not skip sentences** — Task 5 test.

---

## File Structure

```
src/features/dictation/
  preferences.ts            NEW  saved rate/voice store (localStorage)
  toolbar-keys.ts           NEW  shared keydown → action mapping for both toolbars
  DictationMiniPlayer.tsx   NEW  floating pill
  constants.ts              + SENTENCE_HIGHLIGHT_NAME
  extract-words.ts          + Sentence, sentences[], word.sentence, sentenceRange()
  highlighter.ts            + showSentence(), sentence layer
  dictation-controller.ts   preferences; skipSentence; sentence highlight; active-dictation store; toolbar element
  use-dictation.ts          + skipSentence, toolbarRef
  DictationToolbar.tsx      + ⏮ ⏭, arrow keys, ref registration
  dictation.css             + sentence highlight, skip buttons, mini-player
  index.ts                  + new exports
  README.md                 docs
  __tests__/preferences.test.ts, DictationMiniPlayer.test.tsx (new) + updates to existing tests
src/app/page.tsx            mount <DictationMiniPlayer />
src/demo/__tests__/renderers.test.tsx  + sentence assertions
```

---

### Task 1: Preferences store wired into the controller

**Files:**
- Create: `src/features/dictation/preferences.ts`
- Modify: `src/features/dictation/dictation-controller.ts` (constructor, `subscribe`, `setRate`, `setVoice`, `startFrom`, `dispose`; remove `initialRate`)
- Modify: `src/features/dictation/index.ts`
- Test: `src/features/dictation/__tests__/preferences.test.ts` (new), `src/features/dictation/__tests__/dictation-controller.test.ts` (add tests + reset in `afterEach`)

**Interfaces:**
- Produces: `interface DictationPreferences { rate: number; voiceId: string | undefined }`, `getPreferences(): DictationPreferences`, `setPreferences(patch: Partial<DictationPreferences>): void`, `subscribePreferences(listener: () => void): Unsubscribe`, `resetPreferencesForTests(): void` (not exported from index).
- Controller: snapshot `rate`/`voiceId` mirror the store; `setRate`/`setVoice` write the store and still return a Promise that resolves after any restart. `DictationControllerOptions.initialRate` is removed.

- [ ] **Step 1: Write the failing preferences tests** — `src/features/dictation/__tests__/preferences.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPreferences, resetPreferencesForTests, setPreferences, subscribePreferences } from "../preferences";

const KEY = "dictation:preferences";

afterEach(() => {
  localStorage.clear();
  resetPreferencesForTests();
  vi.restoreAllMocks();
});

describe("preferences", () => {
  it("defaults to 1x and the default voice", () => {
    expect(getPreferences()).toEqual({ rate: 1, voiceId: undefined });
  });

  it("loads saved values", () => {
    localStorage.setItem(KEY, JSON.stringify({ rate: 1.5, voiceId: "Samantha" }));
    expect(getPreferences()).toEqual({ rate: 1.5, voiceId: "Samantha" });
  });

  it("rejects invalid values field by field", () => {
    localStorage.setItem(KEY, JSON.stringify({ rate: 3, voiceId: "Daniel" }));
    expect(getPreferences()).toEqual({ rate: 1, voiceId: "Daniel" });
    resetPreferencesForTests();
    localStorage.setItem(KEY, JSON.stringify({ rate: 2, voiceId: 42 }));
    expect(getPreferences()).toEqual({ rate: 2, voiceId: undefined });
  });

  it("falls back to defaults for corrupt JSON", () => {
    localStorage.setItem(KEY, "{not json");
    expect(getPreferences()).toEqual({ rate: 1, voiceId: undefined });
  });

  it("falls back to defaults when storage throws on read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getPreferences()).toEqual({ rate: 1, voiceId: undefined });
  });

  it("persists changes and notifies subscribers once per change", () => {
    const listener = vi.fn();
    subscribePreferences(listener);
    setPreferences({ rate: 2 });
    setPreferences({ rate: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ rate: 2 });
    resetPreferencesForTests();
    expect(getPreferences().rate).toBe(2);
  });

  it("ignores invalid rates", () => {
    const listener = vi.fn();
    subscribePreferences(listener);
    setPreferences({ rate: 3 });
    expect(getPreferences().rate).toBe(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps working in memory when storage throws on write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const listener = vi.fn();
    subscribePreferences(listener);
    setPreferences({ voiceId: "Alex" });
    expect(getPreferences().voiceId).toBe("Alex");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePreferences(listener);
    unsubscribe();
    setPreferences({ rate: 0.5 });
    expect(listener).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/dictation/__tests__/preferences.test.ts`
Expected: FAIL — cannot resolve `../preferences`.

- [ ] **Step 3: Implement** — `src/features/dictation/preferences.ts`

```ts
import { DEFAULT_RATE, RATES } from "./constants";
import type { Unsubscribe } from "./engines/types";

export interface DictationPreferences {
  rate: number;
  voiceId: string | undefined;
}

const STORAGE_KEY = "dictation:preferences";
const DEFAULTS: DictationPreferences = { rate: DEFAULT_RATE, voiceId: undefined };

let current: DictationPreferences | null = null;
const listeners = new Set<() => void>();

const isRate = (value: unknown): value is number => (RATES as readonly unknown[]).includes(value);

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // some browsers throw just for touching localStorage when it is blocked
  }
}

function load(): DictationPreferences {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULTS;
    const { rate, voiceId } = parsed as Record<string, unknown>;
    return {
      rate: isRate(rate) ? rate : DEFAULTS.rate,
      voiceId: typeof voiceId === "string" ? voiceId : undefined,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Saved speed and voice, shared by every message. Defaults during SSR. */
export function getPreferences(): DictationPreferences {
  if (typeof window === "undefined") return DEFAULTS;
  current ??= load();
  return current;
}

export function setPreferences(patch: Partial<DictationPreferences>): void {
  if (typeof window === "undefined") return;
  const previous = getPreferences();
  const next = { ...previous, ...patch };
  if (!isRate(next.rate)) next.rate = previous.rate;
  if (next.rate === previous.rate && next.voiceId === previous.voiceId) return;
  current = next;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: keep the change for this page only.
  }
  listeners.forEach((listener) => listener());
}

export function subscribePreferences(listener: () => void): Unsubscribe {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper: forget cached preferences and listeners, as after a page reload. */
export function resetPreferencesForTests(): void {
  current = null;
  listeners.clear();
}
```

- [ ] **Step 4: Run preferences tests**

Run: `npx vitest run src/features/dictation/__tests__/preferences.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing controller tests** — in `src/features/dictation/__tests__/dictation-controller.test.ts`

Add to the imports: `import { getPreferences, resetPreferencesForTests } from "../preferences";`
Replace the `afterEach` with:
```ts
afterEach(() => {
  stopActiveDictation();
  vi.useRealTimers();
  document.body.innerHTML = "";
  localStorage.clear();
  resetPreferencesForTests();
});
```
Add inside `describe("DictationController", ...)`:
```ts
  it("starts with the saved speed and voice", async () => {
    localStorage.setItem("dictation:preferences", JSON.stringify({ rate: 1.5, voiceId: "Daniel" }));
    resetPreferencesForTests();
    const { engine, controller, state } = setup();
    expect(state()).toMatchObject({ rate: 1.5, voiceId: "Daniel" });
    await controller.play();
    expect(engine.lastSpoken).toMatchObject({ rate: 1.5, voiceId: "Daniel" });
  });

  it("saves speed and voice changes", async () => {
    const { controller } = setup();
    await controller.setRate(2);
    await controller.setVoice("Alex");
    expect(getPreferences()).toEqual({ rate: 2, voiceId: "Alex" });
  });

  it("shares a speed change with every message", async () => {
    const a = setup();
    const b = setup("<p>other words</p>", a.engine);
    await a.controller.setRate(0.5);
    expect(b.state().rate).toBe(0.5);
  });

  it("restarts the playing message when another message changes the speed", async () => {
    const a = setup();
    const b = setup("<p>other words</p>", a.engine);
    await a.controller.play();
    a.engine.emitBoundary(8);
    await b.controller.setRate(2);
    // a restarts on its own (it awaits voices first), so wait for its new utterance.
    await vi.waitFor(() =>
      expect(a.engine.lastSpoken).toEqual({ text: "three four.", rate: 2, voiceId: undefined }),
    );
    expect(b.state().status).toBe("idle");
  });

  it("ignores speeds outside the allowed set", async () => {
    const { controller, state } = setup();
    await controller.setRate(3);
    expect(state().rate).toBe(1);
  });
```

- [ ] **Step 6: Run to verify the new tests fail**

Run: `npx vitest run src/features/dictation/__tests__/dictation-controller.test.ts`
Expected: the five new tests FAIL (rate not saved/shared); existing tests still pass.

- [ ] **Step 7: Wire preferences into the controller** — `src/features/dictation/dictation-controller.ts`

1. Imports: remove `import { DEFAULT_RATE } from "./constants";`; add
```ts
import { getPreferences, setPreferences, subscribePreferences } from "./preferences";
```
2. Remove `initialRate?: number;` from `DictationControllerOptions`.
3. Add private fields after `private stalledAt = -1;`:
```ts
  private preferencesUnsub: Unsubscribe | null = null;
  private preferenceRestart: Promise<void> = Promise.resolve();
```
4. Constructor body becomes:
```ts
    this.options = options;
    const { rate, voiceId } = getPreferences();
    this.snapshot = {
      status: "idle",
      rate,
      voiceId,
      currentWordIndex: -1,
      following: true,
      error: null,
    };
    this.watchPreferences();
```
5. `subscribe` becomes:
```ts
  subscribe = (listener: () => void): Unsubscribe => {
    this.watchPreferences();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
```
6. Replace `setRate` and `setVoice` with:
```ts
  /** Saves the speed for every message; the playing one continues from its current word. */
  async setRate(rate: number): Promise<void> {
    this.watchPreferences();
    setPreferences({ rate });
    return this.preferenceRestart;
  }

  /** Saves the voice for every message; the playing one continues from its current word. */
  async setVoice(voiceId: string | undefined): Promise<void> {
    this.watchPreferences();
    setPreferences({ voiceId });
    return this.preferenceRestart;
  }
```
7. In `dispose()`, after `this.stop();` add:
```ts
    this.preferencesUnsub?.();
    this.preferencesUnsub = null;
```
8. In `startFrom`, add `this.watchPreferences();` as the first line.
9. Add private members (e.g. after `restartIfActive`):
```ts
  /** Subscribes to saved preferences (again after dispose); never during SSR. */
  private watchPreferences(): void {
    if (this.preferencesUnsub || typeof window === "undefined") return;
    this.preferencesUnsub = subscribePreferences(this.handlePreferences);
    const { rate, voiceId } = getPreferences();
    this.update({ rate, voiceId });
  }

  private readonly handlePreferences = (): void => {
    const { rate, voiceId } = getPreferences();
    if (rate === this.snapshot.rate && voiceId === this.snapshot.voiceId) return;
    this.update({ rate, voiceId });
    this.preferenceRestart = this.restartIfActive();
  };
```

- [ ] **Step 8: Export the store** — `src/features/dictation/index.ts`, add:
```ts
export { getPreferences, setPreferences, subscribePreferences, type DictationPreferences } from "./preferences";
```

- [ ] **Step 9: Verify everything**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests pass (existing hook/toolbar tests included); no type errors; build succeeds. If an existing test in another file now leaks a changed rate between tests, add `localStorage.clear(); resetPreferencesForTests();` to that file's `afterEach` (import from `../preferences`).

- [ ] **Step 10: Commit**

```bash
git add src/features/dictation
git commit -m "feat(dictation): remember speed and voice across messages and reloads"
```

---

### Task 2: Sentences in word extraction

**Files:**
- Modify: `src/features/dictation/extract-words.ts`
- Test: `src/features/dictation/__tests__/extract-words.test.ts`, `src/demo/__tests__/renderers.test.tsx`

**Interfaces:**
- Produces: `interface Sentence { startWord: number; endWord: number }` (inclusive), `ExtractedText.sentences: Sentence[]`, `Word.sentence: number`, `sentenceRange(words: readonly Word[], sentence: Sentence): Range | null` (from the first ranged word's start to the last ranged word's end; `null` if no word in the sentence has a range).

- [ ] **Step 1: Write failing tests** — append to `src/features/dictation/__tests__/extract-words.test.ts`

Add `sentenceRange` to the import from `../extract-words`, then add:
```ts
describe("sentences", () => {
  const sentenceTexts = (r: ExtractedText) =>
    r.sentences.map((s) => r.text.slice(r.words[s.startWord].start, r.words[s.endWord].end));

  it("splits at sentence punctuation", () => {
    const r = extractWords(mount("<p>One two. Three four! Five?</p>"));
    expect(r.sentences).toEqual([
      { startWord: 0, endWord: 1 },
      { startWord: 2, endWord: 3 },
      { startWord: 4, endWord: 4 },
    ]);
    expect(r.words.map((w) => w.sentence)).toEqual([0, 0, 1, 1, 2]);
  });

  it("allows closing quotes and brackets after the punctuation", () => {
    const r = extractWords(mount('<p>He said "go." Then left (fast.) Done</p>'));
    expect(sentenceTexts(r)).toEqual(['He said "go."', "Then left (fast.)", "Done"]);
  });

  it("does not split decimals or ellipses", () => {
    expect(sentenceTexts(extractWords(mount("<p>Pi is 3.14 today. Wait... what?</p>")))).toEqual([
      "Pi is 3.14 today.",
      "Wait... what?",
    ]);
  });

  it("ends a sentence at every block break", () => {
    const r = extractWords(
      mount("<h2>Title</h2><ul><li>one</li><li>two</li></ul><table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>"),
    );
    expect(sentenceTexts(r)).toEqual(["Title", "one", "two", "A B", "1 2"]);
  });

  it("makes a code block its own sentence and keeps inline equations inside theirs", () => {
    const r = extractWords(
      mount('<p>Run this:</p><pre>x</pre><p>So <span class="katex">x</span> grows.</p>'),
    );
    expect(sentenceTexts(r)).toEqual(["Run this:", "code block", "So equation grows."]);
  });

  it("has no sentences for an empty container", () => {
    expect(extractWords(mount("")).sentences).toEqual([]);
  });

  it("builds a range covering a sentence's words", () => {
    const el = mount("<p>One <b>two</b>. Three</p><pre>x</pre>");
    const r = extractWords(el);
    expect(sentenceRange(r.words, r.sentences[0])?.toString()).toBe("One two.");
    expect(sentenceRange(r.words, r.sentences[2])).toBeNull(); // "code block" has no range
  });
});
```

Add to `src/demo/__tests__/renderers.test.tsx` a helper and two assertions:
```tsx
const sentenceTexts = (el: HTMLElement) => {
  const r = extractWords(el);
  return r.sentences.map((s) => r.text.slice(r.words[s.startWord].start, r.words[s.endWord].end));
};
```
In the react-markdown test add:
```tsx
    expect(sentenceTexts(el)).toEqual([
      "Title", "Some bold text with code.", "one", "two", "A B", "1 2", "code block", "Math equation here.",
    ]);
```
In the Markdoc test add:
```tsx
    expect(sentenceTexts(el)).toEqual(["Title", "Fact here.", "code block"]);
```
(If the renderer tests already render additional content, e.g. inline code, keep the existing assertions and adjust these expected arrays to the same extracted text, sentence by sentence.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/dictation/__tests__/extract-words.test.ts src/demo/__tests__/renderers.test.tsx`
Expected: FAIL — `sentences` undefined / `sentenceRange` not exported.

- [ ] **Step 3: Implement** — `src/features/dictation/extract-words.ts`

1. Extend the types:
```ts
export interface Word {
  /** Offset of the word's first character in `ExtractedText.text`. */
  start: number;
  /** Offset just past the word's last character. */
  end: number;
  /** DOM range covering the word, or null for spoken replacement phrases. */
  range: Range | null;
  /** Index into `ExtractedText.sentences`. */
  sentence: number;
}

/** Inclusive word indexes of one sentence. */
export interface Sentence {
  startWord: number;
  endWord: number;
}

export interface ExtractedText {
  text: string;
  words: Word[];
  sentences: Sentence[];
}
```
2. Add near `WORD_RE`:
```ts
// A word ending a sentence: . ! or ? (not an ellipsis), optionally followed by closing quotes/brackets.
const SENTENCE_END_RE = /(?<!\.)[.!?]["'”’)\]]*$/;
```
3. In `extractWords`, after `let text = "";` add:
```ts
  const sentences: Sentence[] = [];
  let sentenceOpen = false;
```
4. In `hardBreak`, make the first line `sentenceOpen = false;` (before trimming).
5. Replace `addWord` with:
```ts
  const addWord = (word: string, range: Range | null) => {
    if (!sentenceOpen) {
      sentences.push({ startWord: words.length, endWord: words.length });
      sentenceOpen = true;
    }
    const start = text.length;
    text += word;
    words.push({ start, end: text.length, range, sentence: sentences.length - 1 });
    sentences[sentences.length - 1].endWord = words.length - 1;
    if (range && SENTENCE_END_RE.test(word)) sentenceOpen = false;
  };
```
6. Return `{ text: text.replace(/\s+$/, ""), words, sentences }`.
7. Add after `wordIndexAtPoint`:
```ts
/** A range from the first to the last on-page word of `sentence`, or null if it has none. */
export function sentenceRange(words: readonly Word[], sentence: Sentence): Range | null {
  let first: Range | null = null;
  let last: Range | null = null;
  for (let i = sentence.startWord; i <= sentence.endWord; i++) {
    const range = words[i].range;
    if (!range) continue;
    first ??= range;
    last = range;
  }
  if (!first || !last) return null;
  const range = first.startContainer.ownerDocument!.createRange();
  range.setStart(first.startContainer, first.startOffset);
  range.setEnd(last.endContainer, last.endOffset);
  return range;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/features/dictation/__tests__/extract-words.test.ts src/demo/__tests__/renderers.test.tsx`
Expected: PASS. Then `npm test && npm run typecheck` — any test that builds `Word` literals by hand (e.g. `toEqual({ text: "", words: [] })`) must be updated to include `sentences: []`.

- [ ] **Step 5: Commit**

```bash
git add src/features/dictation/extract-words.ts src/features/dictation/__tests__/extract-words.test.ts src/demo/__tests__/renderers.test.tsx
git commit -m "feat(dictation): extract sentences alongside words"
```

---

### Task 3: Sentence highlight layer

**Files:**
- Modify: `src/features/dictation/constants.ts`, `src/features/dictation/highlighter.ts`, `src/features/dictation/dictation.css`, `src/features/dictation/index.ts`
- Modify (type upkeep only): `FakeHighlighter` in `src/features/dictation/__tests__/dictation-controller.test.ts`
- Test: `src/features/dictation/__tests__/highlighter.test.ts`

**Interfaces:**
- Produces: `SENTENCE_HIGHLIGHT_NAME = "dictation-sentence"`; `Highlighter.showSentence(range: Range | null): void` (never scrolls; `null` clears only the sentence layer); `clear()`/`dispose()` clear both layers. CSS-API highlights: word priority `1`, sentence priority `0`. Overlay fallback sentence boxes use class `dictation-overlay-sentence`.

- [ ] **Step 1: Write failing tests** — `src/features/dictation/__tests__/highlighter.test.ts`

Give `FakeHighlight` a priority field:
```ts
class FakeHighlight {
  ranges: Range[];
  priority = 0;
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
```
Add:
```ts
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
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/dictation/__tests__/highlighter.test.ts`
Expected: FAIL — `showSentence` is not a function.

- [ ] **Step 3: Implement**

`src/features/dictation/constants.ts`, add:
```ts
/** Fainter layer under the word: `::highlight(dictation-sentence)`. */
export const SENTENCE_HIGHLIGHT_NAME = "dictation-sentence";
```

`src/features/dictation/highlighter.ts`:
1. Import `SENTENCE_HIGHLIGHT_NAME` alongside `HIGHLIGHT_NAME`.
2. Add to the `Highlighter` interface:
```ts
  /** Highlights the current sentence beneath the word; `null` clears it. Never scrolls. */
  showSentence(range: Range | null): void;
```
3. Replace `createHighlighter` with:
```ts
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
```
4. `CssHighlightPainter` takes a name and priority:
```ts
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
```
5. `OverlayPainter` takes the box class name: add a `private readonly className: string;` field set in a `constructor(className: string)`, and use `box.className = this.className;` instead of the literal.

`src/features/dictation/dictation.css`:
- In `:root` add `--dictation-sentence-bg: #fef9c3;`; in the dark `:root` add `--dictation-sentence-bg: #3f2d0a;`.
- Add:
```css
::highlight(dictation-sentence) {
  background-color: var(--dictation-sentence-bg);
}

.dictation-overlay-sentence {
  background-color: var(--dictation-sentence-bg);
  mix-blend-mode: multiply;
  z-index: 0;
}
```

`src/features/dictation/index.ts`: export `SENTENCE_HIGHLIGHT_NAME` from `./constants` alongside `HIGHLIGHT_NAME`.

`src/features/dictation/__tests__/dictation-controller.test.ts`: add to `FakeHighlighter`:
```ts
  sentences: (Range | null)[] = [];
  showSentence(range: Range | null) {
    this.sentences.push(range);
  }
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/dictation
git commit -m "feat(dictation): add a sentence highlight layer beneath the word"
```

---

### Task 4: Controller — sentence highlight and `skipSentence`

**Files:**
- Modify: `src/features/dictation/dictation-controller.ts`
- Test: `src/features/dictation/__tests__/dictation-controller.test.ts`

**Interfaces:**
- Consumes: `Sentence`, `sentenceRange`, `Word.sentence`, `ExtractedText.sentences` (Task 2); `Highlighter.showSentence` (Task 3).
- Produces: `DictationController.skipSentence(direction: -1 | 1): Promise<void>` — `-1`: if the current word is more than 2 words past its sentence's first word, go to that sentence's start, else to the previous sentence's start (first sentence → its own start); `+1`: next sentence's start, no-op on the last sentence. Playing/loading → reads from there; paused → moves the highlight, stays paused, resume reads from there; idle → no-op. Sentence highlight is shown whenever the current word's sentence changes, cleared on stop.

- [ ] **Step 1: Write failing tests** — add inside `describe("DictationController", ...)`:

```ts
  // "One two. Three four." — words start at 0, 4, 9, 15
  const TWO_SENTENCES = "<p>One two. Three four.</p>";

  it("highlights the current sentence and updates it only when the sentence changes", async () => {
    const { engine, highlighter, controller } = setup(TWO_SENTENCES);
    await controller.play();
    expect(highlighter.sentences.map((r) => r?.toString())).toEqual(["One two."]);
    engine.emitBoundary(4);
    expect(highlighter.sentences).toHaveLength(1);
    engine.emitBoundary(9);
    expect(highlighter.sentences.map((r) => r?.toString())).toEqual(["One two.", "Three four."]);
  });

  it("skips to the next sentence while playing", async () => {
    const { engine, controller, state } = setup(TWO_SENTENCES);
    await controller.play();
    await controller.skipSentence(1);
    expect(engine.lastSpoken?.text).toBe("Three four.");
    expect(state()).toMatchObject({ status: "playing", currentWordIndex: 2 });
  });

  it("does nothing when skipping past the last sentence", async () => {
    const { engine, controller } = setup(TWO_SENTENCES);
    await controller.seekToWord(3);
    await controller.skipSentence(1);
    expect(engine.spoken).toHaveLength(1);
  });

  it("goes to the previous sentence near the start of a sentence", async () => {
    const { engine, controller } = setup(TWO_SENTENCES);
    await controller.seekToWord(2);
    await controller.skipSentence(-1);
    expect(engine.lastSpoken?.text).toBe("One two. Three four.");
  });

  it("restarts the current sentence when well into it", async () => {
    // "One two. Three four five six seven." — sentence 1 starts at word 2
    const { engine, controller } = setup("<p>One two. Three four five six seven.</p>");
    await controller.seekToWord(5);
    await controller.skipSentence(-1);
    expect(engine.lastSpoken?.text).toBe("Three four five six seven.");
  });

  it("stays paused when skipping while paused, then resumes from the new sentence", async () => {
    const { engine, controller, state } = setup(TWO_SENTENCES);
    await controller.play();
    controller.pause();
    await controller.skipSentence(1);
    expect(state()).toMatchObject({ status: "paused", currentWordIndex: 2 });
    expect(engine.calls.at(-1)).toBe("cancel");
    expect(engine.spoken).toHaveLength(1);
    await controller.resume();
    expect(engine.lastSpoken?.text).toBe("Three four.");
  });

  it("ignores skips while idle", async () => {
    const { engine, controller } = setup(TWO_SENTENCES);
    await controller.skipSentence(1);
    expect(engine.spoken).toHaveLength(0);
  });

  it("clears the sentence highlight on stop and shows it again on the next play", async () => {
    const { highlighter, controller } = setup(TWO_SENTENCES);
    await controller.play();
    controller.stop();
    await controller.play();
    expect(highlighter.sentences.map((r) => r?.toString())).toEqual(["One two.", "One two."]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/dictation/__tests__/dictation-controller.test.ts`
Expected: the new tests FAIL (`skipSentence` missing, no sentence highlight).

- [ ] **Step 3: Implement** — `src/features/dictation/dictation-controller.ts`

1. Add `sentenceRange` to the import from `./extract-words`.
2. Add field: `private currentSentence = -1;`
3. In `stop()`, after `this.highlighter?.clear();` add `this.currentSentence = -1;`
4. In `invalidate()`, after `this.extracted = null;` add `this.currentSentence = -1;`
5. Add the public method (after `seekToPoint`):
```ts
  /**
   * Moves by sentence like a music player: back restarts the current sentence unless
   * we are at its start, then it goes to the previous one. Paused stays paused.
   */
  async skipSentence(direction: -1 | 1): Promise<void> {
    const { status, currentWordIndex } = this.snapshot;
    const extracted = this.extracted;
    if (status === "idle" || !extracted || currentWordIndex < 0) return;
    const { words, sentences } = extracted;
    const current = words[currentWordIndex].sentence;
    let target: number;
    if (direction === 1) {
      if (current >= sentences.length - 1) return;
      target = current + 1;
    } else {
      target = currentWordIndex - sentences[current].startWord > 2 ? current : Math.max(0, current - 1);
    }
    const index = sentences[target].startWord;
    if (status === "paused") {
      this.engine?.cancel();
      this.pausedByCancel = true;
      this.setWord(index);
      return;
    }
    return this.startFrom(index);
  }
```
6. Replace `setWord` with:
```ts
  private setWord(index: number): void {
    const extracted = this.extracted;
    const word = extracted?.words[index];
    if (!extracted || !word) return;
    this.highlighter ??= (this.options.createHighlighter ?? createHighlighter)();
    if (word.sentence !== this.currentSentence) {
      this.currentSentence = word.sentence;
      this.highlighter.showSentence(sentenceRange(extracted.words, extracted.sentences[word.sentence]));
    }
    this.highlighter.show(word.range, { scroll: this.snapshot.following });
    this.update({ currentWordIndex: index });
  }
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/dictation/dictation-controller.ts src/features/dictation/__tests__/dictation-controller.test.ts
git commit -m "feat(dictation): highlight the current sentence and skip by sentence"
```

---

### Task 5: Hook and toolbar — ⏮ ⏭ buttons and arrow keys

**Files:**
- Create: `src/features/dictation/toolbar-keys.ts`
- Modify: `src/features/dictation/use-dictation.ts`, `src/features/dictation/DictationToolbar.tsx`, `src/features/dictation/dictation.css`
- Test: `src/features/dictation/__tests__/DictationToolbar.test.tsx`, `src/features/dictation/__tests__/use-dictation.test.tsx`

**Interfaces:**
- Consumes: `DictationController.skipSentence` (Task 4).
- Produces: `UseDictationResult.skipSentence(direction: -1 | 1): void`; `type ToolbarKeyAction = "stop" | "previous" | "next"`; `toolbarKeyAction(event: { key: string; target: EventTarget | null }): ToolbarKeyAction | null` (Escape → stop; ArrowLeft/ArrowRight → previous/next unless the target is a `<select>`).

- [ ] **Step 1: Write failing tests**

`src/features/dictation/__tests__/DictationToolbar.test.tsx` — add `skipSentence: vi.fn(),` to `fakeDictation`'s defaults, then add:
```tsx
  it("shows sentence skip buttons only while active", () => {
    render(<DictationToolbar dictation={fakeDictation()} />);
    expect(screen.queryByRole("button", { name: "Previous sentence" })).toBeNull();
    cleanup();
    const d = fakeDictation({ status: "playing" });
    render(<DictationToolbar dictation={d} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous sentence" }));
    fireEvent.click(screen.getByRole("button", { name: "Next sentence" }));
    expect(d.skipSentence).toHaveBeenNthCalledWith(1, -1);
    expect(d.skipSentence).toHaveBeenNthCalledWith(2, 1);
  });

  it("disables sentence skip while the voice loads", () => {
    render(<DictationToolbar dictation={fakeDictation({ status: "loading" })} />);
    expect(screen.getByRole("button", { name: "Next sentence" })).toBeDisabled();
  });

  it("skips with the arrow keys while active", () => {
    const d = fakeDictation({ status: "paused" });
    render(<DictationToolbar dictation={d} />);
    fireEvent.keyDown(screen.getByRole("toolbar"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("toolbar"), { key: "ArrowLeft" });
    expect(d.skipSentence).toHaveBeenNthCalledWith(1, 1);
    expect(d.skipSentence).toHaveBeenNthCalledWith(2, -1);
  });

  it("leaves arrow keys to the voice picker", async () => {
    const d = fakeDictation({ status: "playing" });
    render(<DictationToolbar dictation={d} showVoicePicker />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Voice" }), { key: "ArrowRight" });
    expect(d.skipSentence).not.toHaveBeenCalled();
    await screen.findByRole("option", { name: "Samantha (en-US)" });
  });
```

`src/features/dictation/__tests__/use-dictation.test.tsx` — in the `Message` test component add a button after the play button:
```tsx
      <button type="button" onClick={() => d.skipSentence(1)}>
        next
      </button>
```
and add:
```tsx
  it("skips to the next sentence", async () => {
    const engine = new FakeEngine();
    render(<Message html="<p>One two. Three four.</p>" engine={engine} />);
    await clickPlay();
    await act(async () => {
      fireEvent.click(screen.getByText("next"));
    });
    expect(engine.lastSpoken?.text).toBe("Three four.");
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/dictation/__tests__/DictationToolbar.test.tsx src/features/dictation/__tests__/use-dictation.test.tsx`
Expected: FAIL — no skip buttons / `skipSentence` not a function.

- [ ] **Step 3: Implement**

`src/features/dictation/toolbar-keys.ts`:
```ts
export type ToolbarKeyAction = "stop" | "previous" | "next";

/** Keyboard shortcuts shared by the message toolbar and the mini-player. */
export function toolbarKeyAction(event: { key: string; target: EventTarget | null }): ToolbarKeyAction | null {
  if (event.key === "Escape") return "stop";
  // Arrow keys change the selected voice inside the picker.
  if (event.target instanceof HTMLSelectElement) return null;
  if (event.key === "ArrowLeft") return "previous";
  if (event.key === "ArrowRight") return "next";
  return null;
}
```

`src/features/dictation/use-dictation.ts`:
- Add to `UseDictationResult`:
```ts
  /** Jumps a sentence back (-1) or forward (1) while reading or paused. */
  skipSentence(direction: -1 | 1): void;
```
- Add to the `actions` memo:
```ts
      skipSentence: (direction: -1 | 1) => {
        void controller.skipSentence(direction);
      },
```

`src/features/dictation/DictationToolbar.tsx`:
- Import `toolbarKeyAction` from `./toolbar-keys`.
- Replace `onKeyDown` with:
```tsx
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = active ? toolbarKeyAction(event) : null;
    if (!action) return;
    event.preventDefault();
    if (action === "stop") dictation.stop();
    else dictation.skipSentence(action === "next" ? 1 : -1);
  };
```
- Directly after the primary button add:
```tsx
      {active && (
        <>
          <button
            type="button"
            className="dictation-btn dictation-skip"
            aria-label="Previous sentence"
            onClick={() => dictation.skipSentence(-1)}
            disabled={status === "loading"}
          >
            ⏮
          </button>
          <button
            type="button"
            className="dictation-btn dictation-skip"
            aria-label="Next sentence"
            onClick={() => dictation.skipSentence(1)}
            disabled={status === "loading"}
          >
            ⏭
          </button>
        </>
      )}
```

`src/features/dictation/dictation.css`, add:
```css
.dictation-skip {
  padding: 0.25rem 0.45rem;
  line-height: 1;
}
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck`
Expected: PASS, no act() warnings.

- [ ] **Step 5: Commit**

```bash
git add src/features/dictation
git commit -m "feat(dictation): add sentence skip buttons and arrow-key shortcuts"
```

---

### Task 6: Floating mini-player

**Files:**
- Create: `src/features/dictation/DictationMiniPlayer.tsx`
- Modify: `src/features/dictation/dictation-controller.ts` (active-dictation store, toolbar element), `src/features/dictation/use-dictation.ts` (`toolbarRef`), `src/features/dictation/DictationToolbar.tsx` (attach ref), `src/features/dictation/dictation.css`, `src/features/dictation/index.ts`
- Test: `src/features/dictation/__tests__/DictationMiniPlayer.test.tsx` (new), `src/features/dictation/__tests__/dictation-controller.test.ts`, `src/features/dictation/__tests__/DictationToolbar.test.tsx` (fake gains `toolbarRef`)

**Interfaces:**
- Consumes: controller API incl. `skipSentence`, `followCurrentWord`, `setRate`, `pause`, `resume`, `stop`, `subscribe`, `getSnapshot`; `toolbarKeyAction` (Task 5); `RATES`.
- Produces: `getActiveDictation(): DictationController | null`, `subscribeActiveDictation(listener: () => void): Unsubscribe` (notifies when the playing controller changes), `DictationController.setToolbarElement(element: HTMLElement | null): void`, `DictationController.getToolbarElement(): HTMLElement | null`, `UseDictationResult.toolbarRef: (element: HTMLElement | null) => void`, `DictationMiniPlayer(props: { className?: string })`.

- [ ] **Step 1: Write failing controller tests** — add to `dictation-controller.test.ts`

Import `getActiveDictation, subscribeActiveDictation` from `../dictation-controller`, then:
```ts
  it("publishes the playing controller", async () => {
    const a = setup();
    const b = setup("<p>other words</p>", a.engine);
    const listener = vi.fn();
    const unsubscribe = subscribeActiveDictation(listener);
    await a.controller.play();
    expect(getActiveDictation()).toBe(a.controller);
    await b.controller.play();
    expect(getActiveDictation()).toBe(b.controller);
    b.controller.stop();
    expect(getActiveDictation()).toBeNull();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("remembers its toolbar element", () => {
    const { controller } = setup();
    const el = document.createElement("div");
    controller.setToolbarElement(el);
    expect(controller.getToolbarElement()).toBe(el);
    controller.setToolbarElement(null);
    expect(controller.getToolbarElement()).toBeNull();
  });
```

- [ ] **Step 2: Write failing mini-player tests** — `src/features/dictation/__tests__/DictationMiniPlayer.test.tsx`

```tsx
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationMiniPlayer } from "../DictationMiniPlayer";
import { DictationController, stopActiveDictation } from "../dictation-controller";
import type { Highlighter } from "../highlighter";
import { resetPreferencesForTests } from "../preferences";
import { FakeEngine } from "./fake-engine";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed: Element[] = [];
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
  trigger(isIntersecting: boolean) {
    act(() => {
      this.callback(
        [{ isIntersecting, target: this.observed[0] } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    });
  }
}

const noopHighlighter = (): Highlighter => ({
  show() {},
  showSentence() {},
  scrollIntoView() {},
  clear() {},
  dispose() {},
});

// "One two. Three four." — sentence 2 starts at word 2
function setup({ withToolbar = true } = {}) {
  const container = document.createElement("div");
  container.innerHTML = "<p>One two. Three four.</p>";
  document.body.appendChild(container);
  const engine = new FakeEngine();
  const controller = new DictationController({
    getContainer: () => container,
    getEngine: () => engine,
    createHighlighter: noopHighlighter,
  });
  if (withToolbar) controller.setToolbarElement(document.createElement("div"));
  render(<DictationMiniPlayer />);
  return { engine, controller };
}

const pill = () => screen.queryByRole("toolbar", { name: "Reading controls" });
const lastObserver = () => FakeIntersectionObserver.instances.at(-1)!;

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  stopActiveDictation();
  vi.unstubAllGlobals();
  localStorage.clear();
  resetPreferencesForTests();
  document.body.innerHTML = "";
});

describe("DictationMiniPlayer", () => {
  it("renders nothing while nothing is being read", () => {
    setup();
    expect(pill()).toBeNull();
  });

  it("stays hidden while the message toolbar is on screen", async () => {
    const { controller } = setup();
    await act(() => controller.play());
    lastObserver().trigger(true);
    expect(pill()).toBeNull();
  });

  it("appears when the message toolbar scrolls out of view", async () => {
    const { controller } = setup();
    await act(() => controller.play());
    lastObserver().trigger(false);
    expect(pill()).not.toBeNull();
    lastObserver().trigger(true);
    expect(pill()).toBeNull();
  });

  it("shows whenever reading if the message has no registered toolbar", async () => {
    const { controller } = setup({ withToolbar: false });
    await act(() => controller.play());
    expect(pill()).not.toBeNull();
  });

  it("pauses, resumes, skips and stops the playing message", async () => {
    const { engine, controller } = setup();
    await act(() => controller.play());
    lastObserver().trigger(false);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(controller.getSnapshot().status).toBe("paused");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    });
    expect(controller.getSnapshot().status).toBe("playing");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next sentence" }));
    });
    expect(engine.lastSpoken?.text).toBe("Three four.");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(controller.getSnapshot().status).toBe("idle");
    expect(pill()).toBeNull();
  });

  it("cycles the speed and continues from the current word at the new speed", async () => {
    const { engine, controller } = setup();
    await act(() => controller.play());
    lastObserver().trigger(false);
    act(() => engine.emitBoundary(9));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^1x/ }));
    });
    expect(controller.getSnapshot().rate).toBe(1.5);
    await vi.waitFor(() =>
      expect(engine.lastSpoken).toEqual({ text: "Three four.", rate: 1.5, voiceId: undefined }),
    );
    expect(screen.getByRole("button", { name: /^1\.5x/ })).toBeTruthy();
  });

  it("offers Back to current word only after the user scrolled away", async () => {
    const { controller } = setup();
    await act(() => controller.play());
    lastObserver().trigger(false);
    expect(screen.queryByRole("button", { name: "Back to current word" })).toBeNull();
    act(() => controller.setFollowing(false));
    fireEvent.click(screen.getByRole("button", { name: "Back to current word" }));
    expect(controller.getSnapshot().following).toBe(true);
  });

  it("supports the same keyboard shortcuts as the toolbar", async () => {
    const { engine, controller } = setup();
    await act(() => controller.play());
    lastObserver().trigger(false);
    await act(async () => {
      fireEvent.keyDown(pill()!, { key: "ArrowRight" });
    });
    expect(engine.lastSpoken?.text).toBe("Three four.");
    act(() => {
      fireEvent.keyDown(pill()!, { key: "Escape" });
    });
    expect(controller.getSnapshot().status).toBe("idle");
  });
});
```

In `DictationToolbar.test.tsx`, add `toolbarRef: vi.fn(),` to `fakeDictation`'s defaults and add:
```tsx
  it("registers its root element for the mini-player", () => {
    const d = fakeDictation();
    render(<DictationToolbar dictation={d} />);
    expect(d.toolbarRef).toHaveBeenCalledWith(screen.getByRole("toolbar"));
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/features/dictation/__tests__/dictation-controller.test.ts src/features/dictation/__tests__/DictationMiniPlayer.test.tsx src/features/dictation/__tests__/DictationToolbar.test.tsx`
Expected: FAIL — missing exports / module.

- [ ] **Step 4: Implement the controller parts** — `src/features/dictation/dictation-controller.ts`

After `let activeController: DictationController | null = null;` add:
```ts
const activeListeners = new Set<() => void>();

function setActiveController(controller: DictationController | null): void {
  if (activeController === controller) return;
  activeController = controller;
  activeListeners.forEach((listener) => listener());
}

/** The message currently being read (playing, paused or loading), if any. */
export function getActiveDictation(): DictationController | null {
  return activeController;
}

export function subscribeActiveDictation(listener: () => void): Unsubscribe {
  activeListeners.add(listener);
  return () => {
    activeListeners.delete(listener);
  };
}
```
In `acquire`, replace `activeController = this;` with `setActiveController(this);`.
In `release`, replace `if (activeController === this) activeController = null;` with `if (activeController === this) setActiveController(null);`.
Add a field `private toolbarElement: HTMLElement | null = null;` and methods:
```ts
  /** The message's toolbar; the mini-player shows itself when it is off-screen. */
  setToolbarElement(element: HTMLElement | null): void {
    this.toolbarElement = element;
  }

  getToolbarElement(): HTMLElement | null {
    return this.toolbarElement;
  }
```

- [ ] **Step 5: Hook and toolbar wiring**

`use-dictation.ts`: add to `UseDictationResult`:
```ts
  /** Attach to the toolbar root so the mini-player knows when it is off-screen. */
  toolbarRef: (element: HTMLElement | null) => void;
```
and to the `actions` memo:
```ts
      toolbarRef: (element: HTMLElement | null) => controller.setToolbarElement(element),
```
`DictationToolbar.tsx`: add `ref={dictation.toolbarRef}` to the root `<div role="toolbar" ...>`.

- [ ] **Step 6: Implement the mini-player** — `src/features/dictation/DictationMiniPlayer.tsx`

```tsx
"use client";

import { useEffect, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { RATES } from "./constants";
import { getActiveDictation, subscribeActiveDictation, type DictationController } from "./dictation-controller";
import { toolbarKeyAction } from "./toolbar-keys";

export interface DictationMiniPlayerProps {
  className?: string;
}

const noActiveDictation = () => null;

/**
 * Floating controls for the message being read, shown while its own toolbar is off-screen.
 * Mount once, e.g. in the root layout.
 */
export function DictationMiniPlayer({ className }: DictationMiniPlayerProps) {
  const controller = useSyncExternalStore(subscribeActiveDictation, getActiveDictation, noActiveDictation);
  return controller ? <MiniPlayer controller={controller} className={className} /> : null;
}

function MiniPlayer({ controller, className }: { controller: DictationController; className?: string }) {
  const { status, rate, following } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const toolbarVisible = useToolbarVisible(controller);
  if (status === "idle") return null;

  const visible = !toolbarVisible;
  const loading = status === "loading";
  const nextRate = RATES[(RATES.indexOf(rate as (typeof RATES)[number]) + 1) % RATES.length];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = toolbarKeyAction(event);
    if (!action) return;
    event.preventDefault();
    if (action === "stop") controller.stop();
    else void controller.skipSentence(action === "next" ? 1 : -1);
  };

  return (
    <div
      role="toolbar"
      aria-label="Reading controls"
      data-dictation="skip"
      data-visible={visible}
      aria-hidden={!visible}
      inert={!visible}
      className={["dictation-mini", className].filter(Boolean).join(" ")}
      onKeyDown={onKeyDown}
    >
      {status === "playing" ? (
        <button type="button" className="dictation-mini-btn" aria-label="Pause" onClick={() => controller.pause()}>
          ❚❚
        </button>
      ) : (
        <button
          type="button"
          className="dictation-mini-btn"
          aria-label="Resume"
          disabled={loading}
          onClick={() => void controller.resume()}
        >
          ▶
        </button>
      )}
      <button
        type="button"
        className="dictation-mini-btn"
        aria-label="Previous sentence"
        disabled={loading}
        onClick={() => void controller.skipSentence(-1)}
      >
        ⏮
      </button>
      <button
        type="button"
        className="dictation-mini-btn"
        aria-label="Next sentence"
        disabled={loading}
        onClick={() => void controller.skipSentence(1)}
      >
        ⏭
      </button>
      <button
        type="button"
        className="dictation-mini-btn dictation-mini-rate"
        aria-label={`${rate}x speed, change to ${nextRate}x`}
        onClick={() => void controller.setRate(nextRate)}
      >
        {rate}x
      </button>
      {!following && (
        <button type="button" className="dictation-mini-btn" onClick={() => controller.followCurrentWord()}>
          <span aria-hidden="true">↓</span> Back to current word
        </button>
      )}
      <button type="button" className="dictation-mini-btn" aria-label="Stop" onClick={() => controller.stop()}>
        ✕
      </button>
    </div>
  );
}

/** Tracks whether the message's own toolbar is on screen; true until known. */
function useToolbarVisible(controller: DictationController): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const element = controller.getToolbarElement();
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, [controller]);
  return visible;
}
```

Note on hidden state: while the toolbar is on screen the pill stays mounted (so it can slide out) but is `aria-hidden` and `inert`, which also removes it from `getByRole` queries.

- [ ] **Step 7: Styles** — `src/features/dictation/dictation.css`

In `:root` add `--dictation-mini-bg: #111827; --dictation-mini-fg: #f9fafb;`; in the dark `:root` add `--dictation-mini-bg: #f9fafb; --dictation-mini-fg: #111827;`. Then add:
```css
.dictation-mini {
  position: fixed;
  left: 50%;
  bottom: var(--dictation-mini-offset, 1rem);
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 0.15rem;
  max-width: calc(100vw - 2rem);
  padding: 0.3rem 0.45rem;
  border-radius: 999px;
  background: var(--dictation-mini-bg);
  color: var(--dictation-mini-fg);
  box-shadow: 0 8px 28px rgb(0 0 0 / 0.22);
  font-size: 0.875rem;
  transform: translate(-50%, calc(100% + 2rem));
  opacity: 0;
  transition:
    transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 220ms ease;
}

.dictation-mini[data-visible="true"] {
  transform: translate(-50%, 0);
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .dictation-mini {
    transition: none;
  }
}

.dictation-mini-btn {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 999px;
  padding: 0.35rem 0.6rem;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}

.dictation-mini-btn:hover:not(:disabled) {
  background: color-mix(in srgb, currentColor 14%, transparent);
}

.dictation-mini-btn:focus-visible {
  outline: 2px solid var(--dictation-accent);
  outline-offset: 1px;
}

.dictation-mini-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.dictation-mini-rate {
  min-width: 3.2rem;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 8: Export** — `src/features/dictation/index.ts`, add:
```ts
export { DictationMiniPlayer, type DictationMiniPlayerProps } from "./DictationMiniPlayer";
```
and add `getActiveDictation, subscribeActiveDictation` to the existing export from `./dictation-controller`.

- [ ] **Step 9: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS; no act() warnings. If TypeScript rejects `inert={!visible}`, check `@types/react` is 19.x (it types `inert?: boolean`).

- [ ] **Step 10: Commit**

```bash
git add src/features/dictation
git commit -m "feat(dictation): floating mini-player for the message being read"
```

---

### Task 7: Demo wiring and README

**Files:**
- Modify: `src/app/page.tsx`, `src/features/dictation/README.md`

**Interfaces:**
- Consumes: `DictationMiniPlayer` and the preferences exports via `@/features/dictation`.

- [ ] **Step 1: Mount the mini-player** — `src/app/page.tsx`

```tsx
import { ChatDemo } from "@/demo/ChatDemo";
import { DictationMiniPlayer } from "@/features/dictation";

export default function Page() {
  return (
    <main className="chat">
      <h1>Chat dictation demo</h1>
      <ChatDemo />
      <DictationMiniPlayer />
    </main>
  );
}
```

- [ ] **Step 2: Update the README** — `src/features/dictation/README.md`. Read it first, then add (matching its tone and headings):
  - In "Add to a project": a step "4. Mount `<DictationMiniPlayer />` once (e.g. in `app/layout.tsx` or your chat page). It appears while a message is being read and that message's toolbar is off-screen. Lift it above a chat input with `--dictation-mini-offset` (default `1rem`)."
  - A "Speed and voice are remembered" section: saved per browser in `localStorage` (`dictation:preferences`), shared by every message; invalid or blocked storage falls back to 1x and the default voice; `getPreferences`, `setPreferences`, `subscribePreferences` exports for custom UI.
  - A "Sentences" section: the current sentence gets a faint highlight (`::highlight(dictation-sentence)`, colour `--dictation-sentence-bg`); ⏮ restarts the current sentence, or goes to the previous one when you are within its first words; ⏭ goes to the next; paused stays paused; keyboard ← / → (Esc stops) in the toolbar and mini-player.
  - Add `--dictation-sentence-bg`, `--dictation-mini-bg`, `--dictation-mini-fg`, `--dictation-mini-offset` to the CSS variables list (including the `.dark` override example if the README has one).
  - Mention `toolbarRef` on the hook result only if the README documents custom toolbars; otherwise skip.

- [ ] **Step 3: Verify**

Run: `npm test && npm run typecheck && npm run build`
Then smoke check: start `npm run dev` in the background, `curl -s http://localhost:3000 | grep -c "Chat dictation demo"` prints 1 or more, then stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx src/features/dictation/README.md
git commit -m "docs(dictation): document preferences, sentence skip and the mini-player; mount it in the demo"
```
