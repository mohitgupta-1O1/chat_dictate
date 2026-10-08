# Chat Dictation (Read-Aloud with Word Highlighting) — Design

Date: 2026-10-09
Status: Draft — awaiting review

## 1. Goal

Add a "Dictate" control to each AI chat response that reads the response aloud at a
selectable speed and highlights each word as it is spoken. Build it as a standalone,
drop-in module, proven in a demo app, then copy it into the main project.

### Target environment (main project)
- Next.js 16, React 19, TypeScript.
- Two markdown renderers, both must be supported:
  - Agent Mode: `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex`
    (`src/components/agent/agent-markdown.tsx`).
  - Regular chat / documents: `@markdoc/markdoc` with custom citation, code block and
    table components (`src/components/markdown/markdown.tsx`).

### Success criteria
- Clicking Dictate on a response speaks it and the currently-spoken word is visibly
  highlighted, in sync, at every speed.
- Works unchanged on content rendered by either renderer.
- Integration into a message = one hook + one toolbar component + a ref on the
  message container.

### Out of scope
- The chatbot / LLM itself (demo uses static mock messages).
- Cloud TTS implementation (only the interface seam is built now).

## 2. Requirements

| # | Requirement |
|---|---|
| R1 | Dictate button on each completed assistant message |
| R2 | Speed options: 0.5x, 1x, 1.5x, 2x (default 1x) |
| R3 | Pause / Resume |
| R4 | Stop (ends playback, clears highlight) |
| R5 | Click any word to start/jump playback from that word |
| R6 | Auto-scroll keeps the highlighted word visible |
| R7 | Speed change mid-playback continues from the current word |
| R8 | Only one message plays at a time app-wide |
| R9 | Highlight the current word in sync with speech |
| R10 | Engine abstraction: browser Web Speech now, cloud TTS pluggable later |

## 3. Approach

**DOM text-walk + CSS Custom Highlight API (renderer-agnostic).**
After a message renders, walk its text nodes, build a word index (each word = global
char offset + DOM `Range`), speak the concatenated text, and map engine boundary
offsets back to words. Highlight via `CSS.highlights` — no DOM mutation, so React
reconciliation and both markdown renderers are untouched.

Rejected: per-renderer word-wrapping plugins (two plugins to maintain, thousands of
spans, KaTeX breakage); speaking markdown source and mapping to DOM (fragile).

Browser support for the Highlight API: Chrome/Edge 105+, Safari 17.2+, Firefox 140+.
A fallback overlay is used where unsupported.

## 4. Module layout

All code in `src/features/dictation/` (self-contained, copyable):

| File | Responsibility | Depends on |
|---|---|---|
| `extract-words.ts` | Walk container DOM; skip/replace excluded elements; return `{ text, words: { start, end, range }[] }` | DOM only |
| `engines/types.ts` | `SpeechEngine` interface | — |
| `engines/web-speech-engine.ts` | Web Speech implementation (sentence chunking, boundary relay, estimated-timing fallback) | `speechSynthesis` |
| `highlighter.ts` | Apply/clear highlight for a `Range`; overlay fallback; scroll into view | DOM |
| `dictation-controller.ts` | Framework-agnostic state machine; app-wide single-active-player registry | engine, highlighter |
| `use-dictation.ts` | React hook wrapping the controller | controller |
| `DictationToolbar.tsx` | UI: Dictate / Pause / Resume / Stop, speed selector | hook |
| `dictation.css` | `::highlight(dictation-word)` style, toolbar styles | — |

### Integration shape
```tsx
const ref = useRef<HTMLDivElement>(null);
const dictation = useDictation(ref, { isComplete });
<DictationToolbar dictation={dictation} />
<div ref={ref}><AgentMarkdown … /></div>
```

## 5. Engine interface

```ts
type Unsubscribe = () => void;

interface VoiceInfo { id: string; name: string; lang: string }

interface SpeechEngine {
  speak(text: string, opts: { rate: number; voiceId?: string }): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  onBoundary(cb: (charIndex: number) => void): Unsubscribe; // offset into `text`
  onEnd(cb: () => void): Unsubscribe;
  onError(cb: (err: Error) => void): Unsubscribe;
  listVoices(): Promise<VoiceInfo[]>;
}
```

- The controller always calls `speak()` with the text **from the current word onward**
  and adds that base offset to every boundary index. Seek and speed change are both
  implemented as `cancel()` + `speak()` from a word index, so every engine behaves the same.
- Future cloud engine: Next.js route handler returns audio + word timings; engine plays
  via `<audio>`, emits boundaries from a timeupdate/rAF loop, and may use
  `playbackRate` internally. No UI or controller changes.

### Web Speech engine specifics
- **Chunking:** split text into sentences (fallback: ~200-char chunks at whitespace)
  and queue one `SpeechSynthesisUtterance` per chunk, to avoid Chrome's ~15s cutoff.
  Chunk-local `charIndex` is translated to an offset in the full `text`.
- **Voice loading:** `listVoices()` awaits `voiceschanged` if `getVoices()` is empty
  (with a timeout).
- **Default voice:** a `localService` voice matching `document.documentElement.lang`
  (falls back to `navigator.language`), since local voices reliably emit word boundaries.
- **Estimated-timing fallback:** if no `boundary` event arrives within ~600 ms of a
  chunk's `start`, emit synthetic boundaries for that chunk using a per-word duration
  derived from word length and rate.

## 6. Controller behaviour

States: `idle | loading | playing | paused`.

| Action | Effect |
|---|---|
| `play()` | Extract words (if not cached), acquire global lock (stops any other active controller), speak from word 0 (or current word if paused-by-restart) |
| `pause()` | `engine.pause()`; state `paused`. If the engine does not honour pause (detected by continued boundaries), fall back to `cancel()` and remember word index |
| `resume()` | `engine.resume()`, or re-speak from remembered word index |
| `stop()` | `cancel()`, clear highlight, reset index to 0, state `idle`, release lock |
| `setRate(r)` | Store rate; if playing, `cancel()` + speak from current word at new rate |
| `seekToWord(i)` | Set index; if playing/paused/idle, speak from word `i` (click-to-seek also starts playback) |

Boundary handling: map global char offset → word index by binary search over word
starts; highlight that word's `Range`; scroll into view if outside viewport
(`block: "nearest"`, smooth).

Click-to-seek: on click inside the container, resolve the caret via
`document.caretPositionFromPoint` (fallback `caretRangeFromPoint`), map
(node, offset) → word index. Ignored for clicks on links, buttons, and excluded regions.

## 7. Text extraction rules

- Walk text nodes inside the container in document order.
- **Excluded elements** (configurable selector list):
  - `pre`, `code` blocks (block-level code) → spoken as "code block", no highlight.
  - `.katex`, `.katex-display` → spoken as "equation", no highlight.
  - Citation markers (selector configurable; default `[data-citation], sup.citation`) → skipped silently.
  - `[aria-hidden="true"]`, `script`, `style`, and elements with `data-dictation="skip"` → skipped.
- Inline `code` is read normally.
- Block boundaries (`p`, `li`, `h1–h6`, `td`, `th`, `tr`, `br`, `div`) insert a separator
  (". " for headings/list items/rows without terminal punctuation, otherwise " ") so
  speech pauses naturally and words do not merge across blocks.
- Words = maximal runs of non-whitespace within a text node. Each word records
  `start`/`end` in the spoken text and a `Range` over its DOM characters.
- Replacement phrases ("code block", "equation") occupy text offsets but map to no
  `Range` — the highlighter clears while they are spoken.

## 8. Edge cases

- **Streaming:** Dictate disabled until `isComplete` is true.
- **Content changes during playback:** a `MutationObserver` on the container stops
  playback and invalidates the word cache.
- **Unmount / route change:** cancel speech, clear highlight, release lock.
  Also `pagehide` → cancel (Chrome otherwise keeps speaking).
- **Background tab:** speech continues; a watchdog restarts from the last word if no
  boundary/end event occurs for an extended period while `playing`.
- **SSR:** engine is created lazily in the browser; if `speechSynthesis` is unavailable
  the toolbar does not render.
- **Engine error:** state → `idle`, highlight cleared, error surfaced via hook
  (`error` field) — toolbar shows a brief message.
- **Highlight API unsupported:** fallback draws absolutely-positioned overlay boxes from
  `range.getClientRects()` inside the container.

## 9. UI / accessibility

- Toolbar: `Dictate` (▶) button → becomes `Pause` / `Resume`; `Stop` (■) visible while
  active; speed segmented control `0.5x | 1x | 1.5x | 2x`.
- Optional voice picker (demo only by default; prop to enable).
- `aria-label`s on all buttons; `aria-pressed` on the active speed; an `aria-live="polite"`
  region announces state changes ("Reading", "Paused", "Stopped").
- Keyboard: Space toggles pause/resume, Esc stops — only while focus is in the toolbar.
- Highlight style: `::highlight(dictation-word)` with a soft yellow background,
  respecting dark mode via a CSS variable.

## 10. Demo app

Minimal Next.js 16 / React 19 / TypeScript app (App Router) at the repo root:
- One page with mock assistant messages rendered through **both** `react-markdown`
  (+ `remark-gfm`, `remark-math`, `rehype-katex`) and `@markdoc/markdoc`.
- Content covers: paragraphs, headings, lists, a table, a code block, inline code,
  KaTeX math, citations, and one long message for auto-scroll.
- Voice picker enabled.

## 11. Testing

**Automated (Vitest + jsdom):**
- `extract-words`: fixtures rendered from both renderers (plain text, lists, table,
  code block, KaTeX, citations, nested inline formatting, odd whitespace). Assert word
  list, spoken text, and offset ↔ range consistency.
- `dictation-controller`: fake `SpeechEngine` driven by the test. Covers state
  transitions; speed change mid-word restarts from that word with correct base offset;
  seek; single-active-player lock; error → idle.
- `web-speech-engine`: mocked `speechSynthesis` / `SpeechSynthesisUtterance`. Covers
  sentence chunking, chunk → global offset mapping, async voice loading,
  estimated-timing fallback.
- `highlighter`: asserts `CSS.highlights` usage; overlay fallback when absent.

**Manual (in the demo, Chrome / Safari / Edge on macOS):** highlight sync at each speed,
click-to-seek, auto-scroll on the long message, switching messages stops the previous
one, navigating away stops speech.

**Not automated:** actual audio output and audio-to-highlight sync (jsdom cannot play audio).
