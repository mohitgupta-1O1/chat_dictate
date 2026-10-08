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
