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
| `script`, `style`, `template`, `[data-citation]`, `sup.citation`, `[aria-hidden="true"]`, `[data-dictation="skip"]` | Skipped |
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
| `clickToSeek` | `true` | Clicking a word starts reading from it (after a short delay, so double-clicking still selects a word) |

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
