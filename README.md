# Chat Dictation — read AI chat responses aloud, word by word

A drop-in feature for AI chat apps that **reads a response aloud and highlights each word as it is
spoken**, so long answers are easier to follow. It works with any markdown renderer because it reads
the rendered page, and it ships with a demo app that renders responses through both
**react-markdown** (GFM + KaTeX) and **Markdoc**.

Built with Next.js 16, React 19 and TypeScript. The browser's built-in voices are used by default,
so there is no API key and no server cost.

## Features

- **Read aloud** any assistant response with one click.
- **Live highlighting:** the current word is highlighted, with a fainter highlight on the current
  sentence.
- **Speeds:** 0.5x, 1x, 1.5x and 2x. Changing speed mid-sentence continues from the current word.
- **Remembers your speed and voice** across messages and page reloads.
- **Pause / Resume / Stop**, and **skip by sentence** with ⏮ / ⏭.
- **Click any word** to start reading from there. Double-clicking to select text, or clicking a
  link, doesn't start speech.
- **Auto-scroll** keeps the spoken word in view. Scroll away yourself and it stops following, and
  **"↓ Back to current word"** brings you back.
- **Floating mini-player:** compact controls appear when the message being read scrolls out of view.
- **Only one message plays at a time**, and Dictate stays disabled while a response is still
  streaming.
- **Smart reading:** code blocks are read as "code block", maths as "equation", and citations are
  skipped.
- **Accessible:** labelled controls, status announcements for screen readers, keyboard shortcuts,
  and reduced-motion support.
- **Pluggable voice engine:** browser Web Speech today, with a clean interface for adding a cloud
  voice (Azure, ElevenLabs, …) later without UI changes.

## Quick start

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Open http://localhost:3000 and press **▶ Dictate** under any response.

Tips for the demo:
- The third message streams in, and its Dictate button enables when streaming finishes.
- Use the voice picker to compare voices. Local voices (e.g. Samantha on macOS) give exact word
  sync. Chrome's online "Google" voices don't report word positions, so their highlighting is
  estimated.

## Keyboard shortcuts

These work while focus is in a toolbar or the mini-player:

| Key | Action |
|---|---|
| Space / Enter | Activate the focused button (e.g. Pause / Resume) |
| ← / → | Previous / next sentence |
| Esc | Stop reading |

Arrow keys are left alone inside the voice picker and other inputs, and when a modifier key is held.

## Using it in your own app

The feature lives in [`src/features/dictation/`](src/features/dictation/) and depends only on React
and browser APIs. Copy that folder into your project and follow its
[integration guide](src/features/dictation/README.md). In short:

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
        <Markdown>{content}</Markdown>
      </div>
      <DictationToolbar dictation={dictation} />
    </>
  );
}
```

Then import `@/features/dictation/dictation.css` once, and mount `<DictationMiniPlayer />` once in
your layout. The integration guide covers what gets read or skipped, options, CSS variables
(including dark mode), and how to plug in a cloud voice.

## How it works

1. **Extract:** after a response renders, the text nodes are walked to build a word and sentence
   index (character offsets plus DOM ranges). Code, maths and citations are replaced or skipped.
   The page is only read, never modified.
2. **Speak:** the text is sent to a `SpeechEngine` in short, sentence-sized chunks, which avoids
   Chrome's ~15-second cutoff.
3. **Track:** the engine reports which word it's on. Voices that report nothing get estimated
   timing.
4. **Highlight:** the word and sentence are painted with the
   [CSS Custom Highlight API](https://developer.mozilla.org/docs/Web/API/CSS_Custom_Highlight_API),
   which doesn't touch React's DOM. Older browsers get an overlay fallback.

## Browser support

| Browser | Status |
|---|---|
| Chrome / Edge 105+ | Supported |
| Safari 17.2+ | Supported |
| Firefox 140+ | Supported |
| Older browsers | Speech works; highlighting uses an overlay fallback |

Voice quality and word-sync accuracy depend on the voices installed on the device.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the demo at http://localhost:3000 |
| `npm run build` / `npm start` | Production build / serve it |
| `npm test` | Run the test suite (Vitest + Testing Library) |
| `npm run typecheck` | TypeScript check |

## Project structure

```
src/
  app/                    Next.js demo shell (layout, page, styles)
  demo/                   Mock chat: messages, react-markdown + Markdoc renderers
  features/dictation/     The reusable feature (copy this into your app)
    engines/              SpeechEngine interface + Web Speech implementation
    extract-words.ts      DOM → words + sentences
    highlighter.ts        Word/sentence highlighting + auto-scroll
    dictation-controller.ts  Playback state machine
    preferences.ts        Remembered speed/voice
    use-dictation.ts      React hook
    DictationToolbar.tsx  Per-message controls
    DictationMiniPlayer.tsx  Floating controls
    __tests__/            Unit and component tests
docs/superpowers/         Design specs and implementation plans
```

## Roadmap

- Cloud voice engine (natural voices with exact word timings)
- Hands-free mode: auto-read new responses
- Better reading of tables and simple equations
- Mobile (iOS Safari / Android Chrome) testing and fixes
