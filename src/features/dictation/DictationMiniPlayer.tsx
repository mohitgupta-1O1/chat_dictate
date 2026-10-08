"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { RATES } from "./constants";
import { getActiveDictation, subscribeActiveDictation, type DictationController } from "./dictation-controller";
import { toolbarKeyAction } from "./toolbar-keys";

export interface DictationMiniPlayerProps {
  className?: string;
}

const noActiveDictation = () => null;
const noToolbar = () => null;

// Remounts the pill per message so one message's visibility never carries over to the next.
const controllerIds = new WeakMap<DictationController, number>();
let nextControllerId = 0;
function controllerKey(controller: DictationController): number {
  let id = controllerIds.get(controller);
  if (id === undefined) {
    id = ++nextControllerId;
    controllerIds.set(controller, id);
  }
  return id;
}

/**
 * Floating controls for the message being read, shown while its own toolbar is off-screen.
 * Mount once, e.g. in the root layout.
 */
export function DictationMiniPlayer({ className }: DictationMiniPlayerProps) {
  const controller = useSyncExternalStore(subscribeActiveDictation, getActiveDictation, noActiveDictation);
  return controller ? (
    <MiniPlayer key={controllerKey(controller)} controller={controller} className={className} />
  ) : null;
}

function MiniPlayer({ controller, className }: { controller: DictationController; className?: string }) {
  const { status, rate, following } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );
  const toolbar = useSyncExternalStore(controller.subscribeToolbarElement, controller.getToolbarElement, noToolbar);
  const toolbarVisible = useToolbarVisible(toolbar);
  const visible = status !== "idle" && !toolbarVisible;
  const ref = useRef<HTMLDivElement>(null);

  // Hand focus back to the message toolbar instead of losing it when the pill goes away.
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    const focusToolbar = () => controller.getToolbarElement()?.querySelector("button")?.focus();
    if (!visible) {
      // React restores the pre-commit focus after cleanups run, so move it again once hidden.
      if (hadFocus.current) focusToolbar();
      hadFocus.current = false;
      return;
    }
    const pill = ref.current;
    return () => {
      hadFocus.current = pill?.contains(document.activeElement) ?? false;
      if (hadFocus.current) focusToolbar(); // unmounting: no later effect will
    };
  }, [visible, controller]);

  if (status === "idle") return null;

  const loading = status === "loading";
  const nextRate = RATES[(RATES.indexOf(rate as (typeof RATES)[number]) + 1) % RATES.length];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = toolbarKeyAction(event);
    // ⏮ ⏭ are disabled while the voice loads.
    if (!action || (action !== "stop" && loading)) return;
    event.preventDefault();
    if (action === "stop") controller.stop();
    else void controller.skipSentence(action === "next" ? 1 : -1);
  };

  return (
    <div
      ref={ref}
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
function useToolbarVisible(element: HTMLElement | null): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return visible;
}
