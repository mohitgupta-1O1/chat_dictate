"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { RATES } from "./constants";
import type { DictationStatus } from "./dictation-controller";
import type { VoiceInfo } from "./engines/types";
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
  if (!dictation.supported) return null;
  const { status, rate, error, disabled } = dictation;
  const active = status !== "idle";

  const primary =
    status === "playing"
      ? { icon: "❚❚", label: "Pause", aria: "Pause reading", onClick: dictation.pause }
      : status === "paused"
        ? { icon: "▶", label: "Resume", aria: "Resume reading", onClick: dictation.resume }
        : status === "loading"
          ? { icon: "…", label: "Loading", aria: "Loading voice", onClick: undefined }
          : { icon: "▶", label: "Dictate", aria: "Read this response aloud", onClick: dictation.play };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && active) {
      event.preventDefault();
      dictation.stop();
    }
  };

  return (
    <div
      role="toolbar"
      aria-label="Read aloud"
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
        <button type="button" className="dictation-btn" aria-label="Stop reading" onClick={dictation.stop}>
          <span aria-hidden="true">■</span> Stop
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
        {STATUS_TEXT[status]}
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
