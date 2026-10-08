import { DEFAULT_RATE, RATES } from "./constants";
import type { Unsubscribe } from "./engines/types";

export interface DictationPreferences {
  rate: number;
  voiceId: string | undefined;
}

const STORAGE_KEY = "dictation:preferences";
const DEFAULTS: DictationPreferences = { rate: DEFAULT_RATE, voiceId: undefined };

let current: DictationPreferences | null = null;
const listeners = new Set<() => void>();

const isRate = (value: unknown): value is number => (RATES as readonly unknown[]).includes(value);

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // some browsers throw just for touching localStorage when it is blocked
  }
}

function load(): DictationPreferences {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULTS;
    const { rate, voiceId } = parsed as Record<string, unknown>;
    return {
      rate: isRate(rate) ? rate : DEFAULTS.rate,
      voiceId: typeof voiceId === "string" ? voiceId : undefined,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Saved speed and voice, shared by every message. Defaults during SSR. */
export function getPreferences(): DictationPreferences {
  if (typeof window === "undefined") return DEFAULTS;
  current ??= load();
  return current;
}

export function setPreferences(patch: Partial<DictationPreferences>): void {
  if (typeof window === "undefined") return;
  const previous = getPreferences();
  const next = { ...previous, ...patch };
  if (!isRate(next.rate)) next.rate = previous.rate;
  if (next.rate === previous.rate && next.voiceId === previous.voiceId) return;
  current = next;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: keep the change for this page only.
  }
  listeners.forEach((listener) => listener());
}

export function subscribePreferences(listener: () => void): Unsubscribe {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper: forget cached preferences and listeners, as after a page reload. */
export function resetPreferencesForTests(): void {
  current = null;
  listeners.clear();
}
