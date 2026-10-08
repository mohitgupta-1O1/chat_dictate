"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { RATES } from "./constants";
import type { DictationStatus } from "./dictation-controller";
import type { VoiceInfo } from "./engines/types";
import { toolbarKeyAction } from "./toolbar-keys";
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
  const { status, rate, error, disabled } = dictation;
  const active = status !== "idle";

  // Announce "Stopped" when reading ends; idle alone says nothing (e.g. on first render).
  const [prevStatus, setPrevStatus] = useState(status);
  const [stopped, setStopped] = useState(false);
  if (status !== prevStatus) {
    setPrevStatus(status);
    setStopped(!active);
  }

  if (!dictation.supported) return null;

  // Accessible names start with the visible text (WCAG 2.5.3).
  const primary =
    status === "playing"
      ? { icon: "❚❚", label: "Pause", aria: undefined, onClick: dictation.pause }
      : status === "paused"
        ? { icon: "▶", label: "Resume", aria: undefined, onClick: dictation.resume }
        : status === "loading"
          ? { icon: "…", label: "Loading", aria: "Loading voice", onClick: undefined }
          : { icon: "▶", label: "Dictate", aria: "Dictate: read this response aloud", onClick: dictation.play };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = active ? toolbarKeyAction(event) : null;
    if (!action) return;
    event.preventDefault();
    if (action === "stop") dictation.stop();
    else dictation.skipSentence(action === "next" ? 1 : -1);
  };

  return (
    <div
      ref={dictation.toolbarRef}
      role="toolbar"
      aria-label="Read aloud"
      data-dictation="skip"
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
      {active && (
        <button type="button" className="dictation-btn" onClick={dictation.stop}>
          <span aria-hidden="true">■</span> Stop
        </button>
      )}
      {active && !dictation.following && (
        <button type="button" className="dictation-btn" onClick={dictation.followCurrentWord}>
          <span aria-hidden="true">↓</span> Back to current word
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
        {stopped ? "Stopped" : STATUS_TEXT[status]}
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
