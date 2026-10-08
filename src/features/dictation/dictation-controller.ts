import type { SpeechEngine, Unsubscribe, VoiceInfo } from "./engines/types";
import {
  extractWords,
  sentenceRange,
  wordIndexAtOffset,
  wordIndexAtPoint,
  type ExtractOptions,
  type ExtractedText,
} from "./extract-words";
import { createHighlighter, type Highlighter } from "./highlighter";
import { getPreferences, setPreferences, subscribePreferences } from "./preferences";

export type DictationStatus = "idle" | "loading" | "playing" | "paused";

export interface DictationSnapshot {
  status: DictationStatus;
  rate: number;
  voiceId: string | undefined;
  /** Index into the extracted words, or -1 when nothing is highlighted. */
  currentWordIndex: number;
  /** Auto-scroll keeps the current word in view. Turned off when the user scrolls away. */
  following: boolean;
  error: string | null;
}

export interface DictationControllerOptions {
  getContainer: () => HTMLElement | null;
  getEngine: () => SpeechEngine | null;
  extractOptions?: ExtractOptions;
  createHighlighter?: () => Highlighter;
  /** Restart from the current word if the engine is silent this long while playing. */
  watchdogMs?: number;
}

let activeController: DictationController | null = null;
const activeListeners = new Set<() => void>();

function setActiveController(controller: DictationController | null): void {
  if (activeController === controller) return;
  activeController = controller;
  activeListeners.forEach((listener) => listener());
}

/** The message currently being read (playing, paused or loading), if any. */
export function getActiveDictation(): DictationController | null {
  return activeController;
}

export function subscribeActiveDictation(listener: () => void): Unsubscribe {
  activeListeners.add(listener);
  return () => {
    activeListeners.delete(listener);
  };
}

/** Stops whichever message is currently being read aloud. */
export function stopActiveDictation(): void {
  activeController?.stop();
}

/** Playback state for one message. Only one controller plays at a time app-wide. */
export class DictationController {
  private snapshot: DictationSnapshot;
  private readonly options: DictationControllerOptions;
  private readonly listeners = new Set<() => void>();
  private extracted: ExtractedText | null = null;
  private highlighter: Highlighter | null = null;
  private engine: SpeechEngine | null = null;
  private engineUnsubs: Unsubscribe[] = [];
  private baseOffset = 0;
  private startToken = 0;
  private pausedByCancel = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private stalledAt = -1;
  private currentSentence = -1;
  private preferencesUnsub: Unsubscribe | null = null;
  private preferenceRestart: Promise<void> = Promise.resolve();
  private toolbarElement: HTMLElement | null = null;
  private readonly toolbarListeners = new Set<() => void>();

  constructor(options: DictationControllerOptions) {
    this.options = options;
    const { rate, voiceId } = getPreferences();
    this.snapshot = {
      status: "idle",
      rate,
      voiceId,
      currentWordIndex: -1,
      following: true,
      error: null,
    };
  }

  subscribe = (listener: () => void): Unsubscribe => {
    this.watchPreferences();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): DictationSnapshot => this.snapshot;

  /** The message's toolbar; the mini-player shows itself when it is off-screen. */
  setToolbarElement(element: HTMLElement | null): void {
    if (element === this.toolbarElement) return;
    this.toolbarElement = element;
    this.toolbarListeners.forEach((listener) => listener());
  }

  getToolbarElement = (): HTMLElement | null => this.toolbarElement;

  /** Notifies when the toolbar element is registered, replaced or removed. */
  subscribeToolbarElement = (listener: () => void): Unsubscribe => {
    this.toolbarListeners.add(listener);
    return () => {
      this.toolbarListeners.delete(listener);
    };
  };

  async play(): Promise<void> {
    const { status, currentWordIndex } = this.snapshot;
    if (status === "playing" || status === "loading") return;
    if (status === "paused") return this.resume();
    this.update({ following: true });
    return this.startFrom(Math.max(0, currentWordIndex));
  }

  pause(): void {
    if (this.snapshot.status !== "playing") return;
    this.engine?.pause();
    this.clearWatchdog();
    this.update({ status: "paused" });
  }

  async resume(): Promise<void> {
    if (this.snapshot.status !== "paused") return;
    if (this.pausedByCancel) return this.startFrom(this.snapshot.currentWordIndex);
    this.engine?.resume();
    this.update({ status: "playing" });
    this.armWatchdog();
  }

  stop(): void {
    this.startToken++;
    this.clearWatchdog();
    this.pausedByCancel = false;
    if (activeController === this) this.engine?.cancel();
    this.release();
    this.highlighter?.clear();
    this.currentSentence = -1;
    this.update({ status: "idle", currentWordIndex: -1, following: true, error: null });
  }

  /** Saves the speed for every message; the playing one continues from its current word. */
  async setRate(rate: number): Promise<void> {
    this.watchPreferences();
    setPreferences({ rate });
    return activeController?.preferenceRestart ?? Promise.resolve();
  }

  /** Saves the voice for every message; the playing one continues from its current word. */
  async setVoice(voiceId: string | undefined): Promise<void> {
    this.watchPreferences();
    setPreferences({ voiceId });
    return activeController?.preferenceRestart ?? Promise.resolve();
  }

  async seekToWord(index: number): Promise<void> {
    this.update({ following: true });
    return this.startFrom(index);
  }

  async seekToPoint(node: Node, offset: number): Promise<void> {
    const extracted = this.ensureExtracted();
    if (!extracted) return;
    const index = wordIndexAtPoint(extracted.words, node, offset);
    if (index < 0) return;
    this.update({ following: true });
    return this.startFrom(index);
  }

  /**
   * Moves by sentence like a music player: back restarts the current sentence unless
   * we are at its start, then it goes to the previous one. Paused stays paused.
   */
  async skipSentence(direction: -1 | 1): Promise<void> {
    const { status, currentWordIndex } = this.snapshot;
    const extracted = this.extracted;
    if (status === "idle" || !extracted || currentWordIndex < 0) return;
    const { words, sentences } = extracted;
    const current = words[currentWordIndex].sentence;
    let target: number;
    if (direction === 1) {
      if (current >= sentences.length - 1) return;
      target = current + 1;
    } else {
      target = currentWordIndex - sentences[current].startWord > 2 ? current : Math.max(0, current - 1);
    }
    const index = sentences[target].startWord;
    if (status === "paused") {
      this.engine?.cancel();
      this.pausedByCancel = true;
      this.setWord(index);
      return;
    }
    return this.startFrom(index);
  }

  /** Turn auto-scroll to the current word on or off without affecting speech. */
  setFollowing(on: boolean): void {
    this.update({ following: on });
  }

  /** Turns following back on and scrolls the current word into view now. */
  followCurrentWord(): void {
    this.update({ following: true });
    const range = this.extracted?.words[this.snapshot.currentWordIndex]?.range;
    if (range && this.snapshot.status !== "idle") this.highlighter?.scrollIntoView(range);
  }

  /** Call when the message content changed: stops playback and forgets cached words. */
  invalidate(): void {
    this.extracted = null;
    this.currentSentence = -1;
    if (this.snapshot.status !== "idle") this.stop();
  }

  /** Stops and releases resources. The controller stays usable (StrictMode remounts). */
  dispose(): void {
    this.stop();
    this.preferencesUnsub?.();
    this.preferencesUnsub = null;
    this.highlighter?.dispose();
    this.highlighter = null;
    this.extracted = null;
  }

  listVoices(): Promise<VoiceInfo[]> {
    return this.options.getEngine()?.listVoices() ?? Promise.resolve([]);
  }

  private async restartIfActive(): Promise<void> {
    const { status, currentWordIndex } = this.snapshot;
    if (status === "playing") return this.startFrom(currentWordIndex);
    if (status === "paused") {
      // Engines can't change rate/voice mid-utterance; restart from this word on resume.
      this.engine?.cancel();
      this.pausedByCancel = true;
    }
    // While loading, startFrom reads the new rate/voice after its await.
  }

  /** Subscribes to saved preferences (again after dispose); never during SSR. */
  private watchPreferences(): void {
    if (this.preferencesUnsub || typeof window === "undefined") return;
    this.preferencesUnsub = subscribePreferences(this.handlePreferences);
    const { rate, voiceId } = getPreferences();
    this.update({ rate, voiceId });
  }

  private readonly handlePreferences = (): void => {
    const { rate, voiceId } = getPreferences();
    if (rate === this.snapshot.rate && voiceId === this.snapshot.voiceId) return;
    this.update({ rate, voiceId });
    this.preferenceRestart = this.restartIfActive();
  };

  private async startFrom(requestedIndex: number, fromWatchdog = false): Promise<void> {
    this.watchPreferences();
    const engine = this.options.getEngine();
    const extracted = this.ensureExtracted();
    if (!engine || !extracted) return;
    if (extracted.words.length === 0) {
      this.update({ error: "There is no text to read." });
      return;
    }

    const token = ++this.startToken;
    const index = Math.min(Math.max(requestedIndex, 0), extracted.words.length - 1);
    if (!fromWatchdog) this.stalledAt = -1;
    this.acquire(engine);
    engine.cancel();
    this.clearWatchdog();
    this.pausedByCancel = false;
    this.setWord(index);
    this.update({ status: "loading", error: null });

    try {
      await engine.listVoices();
    } catch {
      // Speak with the engine's default voice.
    }
    if (token !== this.startToken) return;

    this.baseOffset = extracted.words[index].start;
    this.update({ status: "playing" });
    engine.speak(extracted.text.slice(this.baseOffset), {
      rate: this.snapshot.rate,
      voiceId: this.snapshot.voiceId,
    });
    this.armWatchdog();
  }

  private ensureExtracted(): ExtractedText | null {
    if (this.extracted) return this.extracted;
    const container = this.options.getContainer();
    if (!container) return null;
    this.extracted = extractWords(container, this.options.extractOptions);
    return this.extracted;
  }

  private acquire(engine: SpeechEngine): void {
    if (activeController !== this) {
      activeController?.stop();
      setActiveController(this);
    }
    if (this.engine !== engine) this.unsubscribeEngine();
    this.engine = engine;
    if (this.engineUnsubs.length === 0) {
      this.engineUnsubs = [
        engine.onBoundary(this.handleBoundary),
        engine.onEnd(this.handleEnd),
        engine.onError(this.handleError),
      ];
    }
  }

  private release(): void {
    this.unsubscribeEngine();
    if (activeController === this) setActiveController(null);
  }

  private unsubscribeEngine(): void {
    this.engineUnsubs.forEach((unsubscribe) => unsubscribe());
    this.engineUnsubs = [];
  }

  private readonly handleBoundary = (charIndex: number): void => {
    const extracted = this.extracted;
    if (!extracted) return;
    if (this.snapshot.status === "paused") {
      // The engine ignored pause(); silence it and restart from the paused word on resume.
      this.engine?.cancel();
      this.pausedByCancel = true;
      return;
    }
    if (this.snapshot.status !== "playing") return;
    const index = wordIndexAtOffset(extracted.words, this.baseOffset + charIndex);
    if (index >= 0 && index !== this.snapshot.currentWordIndex) {
      this.stalledAt = -1;
      this.setWord(index);
    }
    this.armWatchdog();
  };

  private readonly handleEnd = (): void => {
    if (this.snapshot.status === "paused") {
      this.pausedByCancel = true;
      return;
    }
    if (this.snapshot.status === "playing") this.stop();
  };

  private readonly handleError = (error: Error): void => {
    this.stop();
    this.update({ error: error.message });
  };

  private setWord(index: number): void {
    const extracted = this.extracted;
    const word = extracted?.words[index];
    if (!extracted || !word) return;
    this.highlighter ??= (this.options.createHighlighter ?? createHighlighter)();
    if (word.sentence !== this.currentSentence) {
      this.currentSentence = word.sentence;
      this.highlighter.showSentence(sentenceRange(extracted.words, extracted.sentences[word.sentence]));
    }
    this.highlighter.show(word.range, { scroll: this.snapshot.following });
    this.update({ currentWordIndex: index });
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.snapshot.status !== "playing") return;
      const index = this.snapshot.currentWordIndex;
      if (this.stalledAt === index) {
        this.stop();
        this.update({ error: "Speech stopped responding." });
        return;
      }
      this.stalledAt = index;
      void this.startFrom(index, true);
    }, this.options.watchdogMs ?? 10_000);
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private update(patch: Partial<DictationSnapshot>): void {
    const keys = Object.keys(patch) as (keyof DictationSnapshot)[];
    if (keys.every((key) => this.snapshot[key] === patch[key])) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
