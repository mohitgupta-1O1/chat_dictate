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

4. Mount `<DictationMiniPlayer />` once (e.g. in `app/layout.tsx` or your chat page). It appears while a message is being read and that message's toolbar is off-screen. Lift it above a chat input with `--dictation-mini-offset` (default `1rem`).

The ref must wrap only the message body. Any content change inside it stops playback (the words
are re-read on the next play), and everything inside it is read aloud. If dynamic UI has to live
inside the ref'd element (copy buttons, hover cards, timestamps, or the toolbar itself), mark it
`data-dictation="skip"` (the toolbar already does) or exclude it via `extractOptions.skip`; changes
inside `[data-dictation="skip"]` don't stop playback.

## What gets read

| Content | Behaviour |
|---|---|
| `pre` (code blocks) | Spoken as "code block" |
| `.katex`, `.katex-display` | Spoken as "equation" |
| `script`, `style`, `template`, `[data-citation]`, `sup.citation`, `[aria-hidden="true"]`, `[hidden]`, `.sr-only`, `.visually-hidden`, `[data-dictation="skip"]` | Skipped |
| Everything else | Read as rendered; headings, list items and table rows end with a pause |

If your citation component renders differently, pass your own selectors:

```tsx
import { DEFAULT_SKIP, useDictation } from "@/features/dictation";

useDictation(ref, { extractOptions: { skip: `${DEFAULT_SKIP}, .my-citation` } });
```

## Speed and voice are remembered

Saved per browser in `localStorage` (`dictation:preferences`), shared by every message; invalid or
blocked storage falls back to 1x and the default voice. Use `getPreferences`, `setPreferences`,
`subscribePreferences` exports for custom UI.

## Sentences

The current sentence gets a faint highlight (`::highlight(dictation-sentence)`, colour
`--dictation-sentence-bg`). ⏮ restarts the current sentence, or goes to the previous one when you
are within its first words. ⏭ goes to the next. Paused stays paused. Keyboard ← / → (Esc stops)
work in the toolbar and mini-player.

## Options

| Option | Default | Meaning |
|---|---|---|
| `isComplete` | `true` | Keep the toolbar disabled while the response streams. Switching it to `false` also stops any speech |
| `engine` | browser Web Speech | Any `SpeechEngine` implementation |
| `extractOptions` | see above | `{ replace, skip }`. Read once on mount |
| `autoScroll` | `true` | Keep the spoken word visible (see below). Read once on mount |
| `clickToSeek` | `true` | Clicking a word starts reading from it (after a short delay, so double-clicking still selects a word) |

### Auto-scroll and "Back to current word"

While a message is read aloud the page follows the highlighted word. As soon as the user scrolls
(mouse wheel or trackpad, touch, PageUp/PageDown/Home/End/arrow keys/Space outside form controls
and the toolbar, or dragging a scrollbar) following turns off; speech and highlighting continue.
The toolbar then shows "↓ Back to current word", which turns following on again and scrolls the
word into view. Following also turns on again when reading starts or the user clicks a word, but
not on speed/voice changes or pause/resume. With `autoScroll: false` nothing scrolls and the
button never appears.

The hook result exposes this as `following` (boolean), `followCurrentWord()`, and `toolbarRef`
(attach to the toolbar root so the mini-player knows when it is off-screen), for custom toolbars.

### Customise colours

Customise colours with `--dictation-highlight-bg`, `--dictation-highlight-fg` (text colour of the
highlighted word), `--dictation-accent`, `--dictation-sentence-bg` (sentence highlight), 
`--dictation-mini-bg`, `--dictation-mini-fg` (mini-player background and text), and 
`--dictation-mini-offset` (mini-player distance from bottom, default `1rem`). The defaults follow 
`prefers-color-scheme`; if your app switches themes with a class, override them there 
(`:root.dark` outranks the defaults whatever the stylesheet order; set the light values on 
`:root:not(.dark)` too if the OS can be dark while your app is light):

```css
:root.dark,
.dark {
  --dictation-highlight-bg: #854d0e;
  --dictation-highlight-fg: #fef3c7;
  --dictation-accent: #60a5fa;
  --dictation-sentence-bg: #3f2d0a;
  --dictation-mini-bg: #f9fafb;
  --dictation-mini-fg: #111827;
}
```

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
