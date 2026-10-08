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
  /** Turns following back on and scrolls the current word into view. */
  followCurrentWord(): void;
  /** Jumps a sentence back (-1) or forward (1) while reading or paused. */
  skipSentence(direction: -1 | 1): void;
  listVoices(): Promise<VoiceInfo[]>;
  /** Attach to the toolbar root so the mini-player knows when it is off-screen. */
  toolbarRef: (element: HTMLElement | null) => void;
}

// Clicks on these keep their normal behaviour instead of seeking.
const INTERACTIVE =
  'a, button, input, textarea, select, summary, label, [role="button"], [contenteditable=""], [contenteditable="true"], [data-dictation="skip"]';

const SKIP_REGION = '[data-dictation="skip"]';

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

// Scroll keys pressed here operate the control instead of scrolling the page.
const KEY_CONTROLS =
  'input, textarea, select, button, [contenteditable=""], [contenteditable="true"], [role="toolbar"], [data-dictation="skip"]';

// Long enough to tell a single click from the start of a double-click.
const SEEK_DELAY_MS = 300;

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
  const [followable] = useState(autoScroll); // read once on mount, like the highlighter

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
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const observer = new MutationObserver((records) => {
      // UI marked data-dictation="skip" (e.g. our toolbar, copy buttons) may change freely.
      if (records.some((record) => !isInSkipRegion(record.target))) controller.invalidate();
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
    // isComplete: re-read ref.current, since the container may mount or be replaced while streaming.
  }, [controller, ref, isComplete]);

  useEffect(() => {
    // Content may have changed (or the container appeared) without the observer seeing it.
    controller.invalidate();
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
    let pending: ReturnType<typeof setTimeout> | null = null;
    const cancelPending = () => {
      if (pending) clearTimeout(pending);
      pending = null;
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.detail > 1) cancelPending();
    };
    const onClick = (event: MouseEvent) => {
      cancelPending();
      // Double/triple clicks select text; they must not start speech.
      if (event.detail > 1) return;
      if (event.button !== 0 || event.defaultPrevented) return;
      if (!isSelectionCollapsed()) return;
      if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
      const caret = caretFromPoint(event.clientX, event.clientY);
      if (!caret || !container.contains(caret.node)) return;
      // Wait to see whether this click becomes a double-click.
      pending = setTimeout(() => {
        pending = null;
        if (isSelectionCollapsed()) void controller.seekToPoint(caret.node, caret.offset);
      }, SEEK_DELAY_MS);
    };
    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("click", onClick);
    return () => {
      cancelPending();
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("click", onClick);
    };
  }, [controller, ref, clickToSeek, disabled]);

  const listenForUserScroll = followable && snapshot.status !== "idle";
  useEffect(() => {
    if (!listenForUserScroll) return;
    // Judge intent from input, not `scroll` events: our own smooth scrolling fires those too.
    const stopFollowing = () => controller.setFollowing(false);
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) stopFollowing(); // ctrl+wheel is pinch-zoom
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest(KEY_CONTROLS)) return;
      stopFollowing();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (isOnScrollbar(event)) stopFollowing();
    };
    const listeners = [
      ["wheel", onWheel],
      ["touchmove", stopFollowing],
      ["keydown", onKeyDown],
      ["pointerdown", onPointerDown],
    ] as const;
    const opts = { capture: true, passive: true };
    for (const [type, listener] of listeners) window.addEventListener(type, listener as EventListener, opts);
    return () => {
      for (const [type, listener] of listeners) window.removeEventListener(type, listener as EventListener, opts);
    };
  }, [controller, listenForUserScroll]);

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
      followCurrentWord: () => controller.followCurrentWord(),
      skipSentence: (direction: -1 | 1) => {
        void controller.skipSentence(direction);
      },
      listVoices: () => controller.listVoices(),
      toolbarRef: (element: HTMLElement | null) => controller.setToolbarElement(element),
    }),
    [controller, disabled],
  );

  return useMemo(() => ({ ...snapshot, supported, disabled, ...actions }), [snapshot, supported, disabled, actions]);
}

function isInSkipRegion(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(SKIP_REGION) != null;
}

/** True when the pointer went down on the scrollbar of the page or a scrollable element. */
function isOnScrollbar(event: MouseEvent): boolean {
  const target = event.target;
  const element =
    target instanceof Document ? target.documentElement : target instanceof Element ? target : null;
  if (!element) return false;
  if (element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth) return false;
  if (element === document.documentElement) {
    return event.clientX >= element.clientWidth || event.clientY >= element.clientHeight;
  }
  const rect = element.getBoundingClientRect();
  return (
    event.clientX >= rect.left + element.clientLeft + element.clientWidth ||
    event.clientY >= rect.top + element.clientTop + element.clientHeight
  );
}

function isSelectionCollapsed(): boolean {
  const selection = window.getSelection();
  return !selection || selection.isCollapsed;
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
