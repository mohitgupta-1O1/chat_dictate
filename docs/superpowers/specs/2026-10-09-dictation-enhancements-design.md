# Dictation Enhancements — Design

Date: 2026-10-09
Status: Draft — awaiting review
Builds on: `docs/superpowers/specs/2026-10-09-chat-dictation-design.md` (all its constraints still apply)

## 1. Goal

Four improvements to the existing `src/features/dictation/` module:

1. **Remember speed and voice** across messages and page reloads.
2. **Skip back / forward by sentence** (⏮ ⏭ buttons, ← → keys).
3. **Floating mini-player** when the playing message's toolbar is scrolled out of view.
4. **Sentence highlight**: a faint background on the current sentence under the word highlight.

### Success criteria
- Setting 1.5x on any message makes every message (including after reload) use 1.5x.
- ⏮/⏭ move reading by sentence with music-player semantics (below), playing or paused.
- While a message is being read and its toolbar is off-screen, a bottom-centre pill offers
  play/pause, ⏮ ⏭, speed, "Back to current word" and stop.
- The current sentence is visibly (faintly) highlighted together with the current word.
- Integration stays optional: without `<DictationMiniPlayer />` nothing changes besides 1, 2, 4.

### Out of scope
- Live cross-tab syncing of preferences (picked up on next load only).
- Server/account-backed preferences.

## 2. Preferences (`preferences.ts`, new)

- Module-level external store: `{ rate: number; voiceId: string | undefined }`.
- API: `getPreferences()`, `setPreferences(patch)`, `subscribePreferences(listener): Unsubscribe`.
- Persisted to `localStorage` key `dictation:preferences` as JSON.
- Loaded lazily on first `getPreferences()` in the browser; SSR / missing or throwing storage
  → defaults (`rate: 1`, `voiceId: undefined`) without errors; write failures are ignored.
- Validation on load: `rate` must be one of `RATES`, `voiceId` must be a string; anything else
  falls back to the default for that field.
- A saved `voiceId` not available on this device is passed through; the engine already falls back
  to the default voice. The saved value is not cleared.

### Controller integration
- `DictationController` reads rate/voiceId from preferences (snapshot `rate`/`voiceId` mirror the
  store); `setRate`/`setVoice` write to the store.
- All controllers subscribe to the store, so a change anywhere updates every toolbar; the playing
  controller restarts from the current word (existing `restartIfActive` behaviour).
- `initialRate` option is removed (superseded by preferences) — no external users yet.

## 3. Sentences

### Extraction (`extract-words.ts`)
- `ExtractedText` gains `sentences: Sentence[]`, `Sentence = { startWord: number; endWord: number }`
  (inclusive word indexes), and each `Word` gains `sentence: number`.
- A sentence ends after a word ending in `.`, `!` or `?` (optionally followed by closing quotes /
  brackets `"')]`), and at every hard break (sentence blocks: p, li, h1–h6, tr, blockquote, pre, …).
  Decimals like `3.14` never end a sentence (the dot is inside the word).
- A replacement phrase ("code block", "equation" when block-level) is its own sentence; an inline
  "equation" stays inside its sentence.

### Highlight (`highlighter.ts`)
- Second highlight name `dictation-sentence` (constant `SENTENCE_HIGHLIGHT_NAME`), registered with
  lower priority than `dictation-word`.
- `Highlighter` gains `showSentence(range: Range | null)`; the controller passes a Range from the
  first to the last ranged word of the current sentence (null if the sentence has no ranged word).
- Overlay fallback: draws sentence boxes with class `dictation-overlay-sentence` beneath word boxes.
- Updated only when the sentence index changes (not every word).

### Skipping (controller)
- `skipSentence(direction: -1 | 1)`:
  - `-1`: if the current word is more than 2 words past its sentence start → go to the start of the
    current sentence; otherwise → start of the previous sentence (or the first sentence's start).
  - `+1`: start of the next sentence; on the last sentence → no-op.
  - Playing / loading → continue reading from the new word (`startFrom`).
  - Paused → move the highlight, stay paused; resume reads from the new word
    (cancel engine, `pausedByCancel = true`).
  - Idle → no-op.
- Skipping does not change auto-scroll "following" state.

## 4. Toolbar and keys

- `DictationToolbar` gains ⏮ ("Previous sentence") and ⏭ ("Next sentence") buttons, shown while
  active (not idle), disabled while loading.
- ← / → in the toolbar (keydown on the toolbar root, not when focus is in the voice `<select>`)
  call `skipSentence(-1 / 1)` while active.
- Accessible names start with the visible text where visible text exists; icon-only buttons use
  `aria-label` ("Previous sentence", "Next sentence").

## 5. Mini-player (`DictationMiniPlayer.tsx`, new)

- Mounted once by the app (e.g. in the root layout). Renders nothing unless a message is active.
- The controller module exposes the active controller through an external store:
  `subscribeActiveDictation(listener)`, `getActiveDictation(): DictationController | null`
  (changes when a controller acquires/releases the lock).
- Visibility: shown while the active message is not idle AND its toolbar element is not
  intersecting the viewport. Each toolbar registers its root element with its controller
  (`controller.setToolbarElement(el | null)`); the mini-player observes that element with an
  `IntersectionObserver`. If no toolbar element is registered, the pill shows whenever active.
- Contents (compact pill, ~320px, fixed bottom-centre):
  play/pause, ⏮, ⏭, speed button cycling 0.5 → 1 → 1.5 → 2 → 0.5 (shows e.g. "1.5x"),
  "↓ Back to current word" (only when not following), ✕ stop.
- `role="toolbar"`, `aria-label="Reading controls"`, `data-dictation="skip"`; ← → and Esc behave as
  in the message toolbar.
- Slides in/out (transform/opacity); `prefers-reduced-motion` disables the animation.
- CSS variable `--dictation-mini-offset` (default `1rem`) sets distance from the bottom so apps can
  lift it above a chat input.
- `"use client"`; SSR renders nothing.

## 6. Public API additions

- Exports: `DictationMiniPlayer`, `getPreferences`, `setPreferences`, `subscribePreferences`,
  `SENTENCE_HIGHLIGHT_NAME`.
- `UseDictationResult` gains `skipSentence(direction: -1 | 1): void`.

## 7. Edge cases

- Storage unavailable / corrupt → defaults, no exceptions.
- Active message unmounts → lock released → pill hides.
- Message content changes mid-playback → existing invalidate/stop; pill hides.
- Sentence with only replacement words → no sentence highlight, word highlight cleared (existing).
- Empty sentences never produced.

## 8. Testing (Vitest + jsdom)

- `preferences`: defaults; load valid; reject invalid rate/voiceId; storage getItem/setItem throwing;
  subscribe/notify; persistence round-trip.
- `extract-words`: sentence boundaries (punctuation, closing quotes, decimals, ellipsis, hard
  breaks, lists, headings, table rows, code-block phrase as own sentence, inline equation inside
  sentence); `word.sentence` consistent with `sentences`; renderer test asserts sentences on
  react-markdown and Markdoc output.
- `highlighter`: sentence layer registered under `dictation-sentence` with lower priority; null
  clears; overlay sentence boxes.
- `controller`: preferences drive rate/voice and persist; rate change in one controller reflects in
  another's snapshot; skip rules (−1 restart vs previous, +1 next, last no-op, idle no-op, paused
  stays paused and resume reads from new word); sentence highlight updates only on sentence change;
  active-dictation store notifies on acquire/release.
- `toolbar`: ⏮ ⏭ visibility/disabled/clicks; ← → keys.
- `mini-player`: hidden when idle; hidden when toolbar intersecting; shown when not intersecting
  (mock IntersectionObserver); controls call the right actions; speed cycles; back-to-word only when
  not following; hides when active controller releases.
- Manual (user): real-browser feel of sentence highlight, skipping, and the pill.
