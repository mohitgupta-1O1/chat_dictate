import { DEFAULT_RATE } from "./constants";
import type { SpeechEngine, Unsubscribe, VoiceInfo } from "./engines/types";
import {
  extractWords,
  wordIndexAtOffset,
  wordIndexAtPoint,
  type ExtractOptions,
  type ExtractedText,
} from "./extract-words";
import { createHighlighter, type Highlighter } from "./highlighter";

export type DictationStatus = "idle" | "loading" | "playing" | "paused";

export interface DictationSnapshot {
  status: DictationStatus;
  rate: number;
  voiceId: string | undefined;
  /** Index into the extracted words, or -1 when nothing is highlighted. */
  currentWordIndex: number;
  error: string | null;
}

export interface DictationControllerOptions {
  getContainer: () => HTMLElement | null;
  getEngine: () => SpeechEngine | null;
  extractOptions?: ExtractOptions;
  createHighlighter?: () => Highlighter;
  /** Restart from the current word if the engine is silent this long while playing. */
  watchdogMs?: number;
  initialRate?: number;
}

let activeController: DictationController | null = null;

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

  constructor(options: DictationControllerOptions) {
    this.options = options;
    this.snapshot = {
      status: "idle",
      rate: options.initialRate ?? DEFAULT_RATE,
      voiceId: undefined,
      currentWordIndex: -1,
      error: null,
    };
  }

  subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): DictationSnapshot => this.snapshot;

  async play(): Promise<void> {
    const { status, currentWordIndex } = this.snapshot;
    if (status === "playing" || status === "loading") return;
    if (status === "paused") return this.resume();
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
    this.update({ status: "idle", currentWordIndex: -1, error: null });
  }

  async setRate(rate: number): Promise<void> {
    this.update({ rate });
    return this.restartIfActive();
  }

  async setVoice(voiceId: string | undefined): Promise<void> {
    this.update({ voiceId });
    return this.restartIfActive();
  }

  async seekToWord(index: number): Promise<void> {
    return this.startFrom(index);
  }

  async seekToPoint(node: Node, offset: number): Promise<void> {
    const extracted = this.ensureExtracted();
    if (!extracted) return;
    const index = wordIndexAtPoint(extracted.words, node, offset);
    if (index >= 0) return this.startFrom(index);
  }

  /** Call when the message content changed: stops playback and forgets cached words. */
  invalidate(): void {
    this.extracted = null;
    if (this.snapshot.status !== "idle") this.stop();
  }

  /** Stops and releases resources. The controller stays usable (StrictMode remounts). */
  dispose(): void {
    this.stop();
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

  private async startFrom(requestedIndex: number, fromWatchdog = false): Promise<void> {
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
      activeController = this;
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
    if (activeController === this) activeController = null;
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
    const word = this.extracted?.words[index];
    if (!word) return;
    this.highlighter ??= (this.options.createHighlighter ?? createHighlighter)();
    this.highlighter.show(word.range);
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
