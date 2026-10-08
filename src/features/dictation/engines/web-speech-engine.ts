import type { SpeakOptions, SpeechEngine, Unsubscribe, VoiceInfo } from "./types";

export interface TextChunk {
  text: string;
  /** Offset of the chunk in the full text. */
  offset: number;
}

export interface WordTiming {
  charIndex: number;
  atMs: number;
}

export interface WebSpeechEngineOptions {
  synth?: SpeechSynthesis;
  Utterance?: typeof SpeechSynthesisUtterance;
  /** Language used to pick a default voice. Defaults to <html lang> or navigator.language. */
  lang?: string;
  /** Start estimating word timing if a chunk produces no boundary event within this time. */
  boundaryTimeoutMs?: number;
  voicesTimeoutMs?: number;
  maxChunkLength?: number;
}

const MS_PER_CHAR = 65;
const PUNCTUATION_PAUSE_MS = 250;

/**
 * Splits text at sentence ends (and, for long sentences, at spaces) so each
 * utterance stays short — Chrome silently stops utterances after ~15 seconds.
 */
export function splitIntoChunks(text: string, maxLength = 200): TextChunk[] {
  const chunks: TextChunk[] = [];
  const add = (start: number, end: number) => {
    const slice = text.slice(start, end);
    if (/\S/.test(slice)) chunks.push({ text: slice, offset: start });
  };
  const push = (start: number, end: number) => {
    while (end - start > maxLength) {
      const space = text.lastIndexOf(" ", start + maxLength - 1);
      const cut = space > start ? space + 1 : start + maxLength;
      add(start, cut);
      start = cut;
    }
    add(start, end);
  };

  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isEllipsis = ch === "." && text[i - 1] === ".";
    if ((ch === "." || ch === "!" || ch === "?") && !isEllipsis && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      let end = i + 1;
      while (end < text.length && /\s/.test(text[end])) end++;
      push(start, end);
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) push(start, text.length);
  return chunks;
}

/** Rough per-word start times, used when a voice does not report word boundaries. */
export function estimateWordTimings(text: string, rate: number): WordTiming[] {
  const timings: WordTiming[] = [];
  let at = 0;
  for (const match of text.matchAll(/\S+/g)) {
    const word = match[0];
    timings.push({ charIndex: match.index ?? 0, atMs: at });
    at += ((word.length + 1) * MS_PER_CHAR + (/[.,;:!?]$/.test(word) ? PUNCTUATION_PAUSE_MS : 0)) / rate;
  }
  return timings;
}

const normaliseLang = (lang: string) => lang.toLowerCase().replace("_", "-");

/** Prefers local voices: they report word boundaries reliably, remote ones often do not. */
export function pickDefaultVoice(voices: readonly SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  const wanted = normaliseLang(lang);
  const base = wanted.split("-")[0];
  const exact = (v: SpeechSynthesisVoice) => normaliseLang(v.lang) === wanted;
  const sameBase = (v: SpeechSynthesisVoice) => normaliseLang(v.lang).split("-")[0] === base;
  return (
    voices.find((v) => v.localService && v.default && sameBase(v)) ??
    voices.find((v) => v.localService && exact(v)) ??
    voices.find((v) => v.localService && sameBase(v)) ??
    voices.find((v) => v.default && sameBase(v)) ??
    voices.find(sameBase) ??
    null
  );
}

export function isWebSpeechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.SpeechSynthesisUtterance === "function"
  );
}

let sharedEngine: WebSpeechEngine | null = null;

/** The app-wide browser engine, or null during SSR / in unsupported browsers. */
export function getWebSpeechEngine(): WebSpeechEngine | null {
  if (!isWebSpeechSupported()) return null;
  sharedEngine ??= new WebSpeechEngine();
  return sharedEngine;
}

function defaultLang(): string {
  if (typeof document !== "undefined" && document.documentElement.lang) return document.documentElement.lang;
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  return "en-US";
}

/** Emits estimated boundaries on a timer; can be stopped and re-run from an elapsed time. */
class EstimatedBoundaries {
  private next = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly timings: WordTiming[];
  private readonly emit: (charIndex: number) => void;

  constructor(timings: WordTiming[], emit: (charIndex: number) => void) {
    this.timings = timings;
    this.emit = emit;
  }

  run(elapsedMs: number): void {
    this.stop();
    let due = -1;
    while (this.next < this.timings.length && this.timings[this.next].atMs <= elapsedMs) {
      due = this.next;
      this.next++;
    }
    if (due >= 0) this.emit(this.timings[due].charIndex);
    for (let i = this.next; i < this.timings.length; i++) {
      const timing = this.timings[i];
      this.timers.push(
        setTimeout(() => {
          this.next = i + 1;
          this.emit(timing.charIndex);
        }, timing.atMs - elapsedMs),
      );
    }
  }

  stop(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
}

interface ActiveChunk {
  chunk: TextChunk;
  rate: number;
  gotBoundary: boolean;
  estimate: EstimatedBoundaries | null;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  /** Speaking time accumulated before the last resume. */
  activeMs: number;
  resumedAt: number;
}

export class WebSpeechEngine implements SpeechEngine {
  private readonly synth: SpeechSynthesis;
  private readonly Utterance: typeof SpeechSynthesisUtterance;
  private readonly lang: string | undefined;
  private readonly boundaryTimeoutMs: number;
  private readonly voicesTimeoutMs: number;
  private readonly maxChunkLength: number;
  private readonly boundaryListeners = new Set<(charIndex: number) => void>();
  private readonly endListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly noBoundaryVoices = new Set<string>();
  private session = 0;
  // Kept referenced: Chrome drops events of utterances that get garbage collected.
  private utterances: SpeechSynthesisUtterance[] = [];
  private current: ActiveChunk | null = null;
  private paused = false;
  private voiceKey = "default";
  private voices: SpeechSynthesisVoice[] = [];
  private voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;

  constructor(options: WebSpeechEngineOptions = {}) {
    this.synth = options.synth ?? window.speechSynthesis;
    this.Utterance = options.Utterance ?? window.SpeechSynthesisUtterance;
    this.lang = options.lang;
    this.boundaryTimeoutMs = options.boundaryTimeoutMs ?? 600;
    this.voicesTimeoutMs = options.voicesTimeoutMs ?? 1500;
    this.maxChunkLength = options.maxChunkLength ?? 200;
  }

  speak(text: string, { rate, voiceId }: SpeakOptions): void {
    this.cancel();
    const session = this.session;
    const live = () => session === this.session;
    const chunks = splitIntoChunks(text, this.maxChunkLength);
    if (chunks.length === 0) {
      queueMicrotask(() => {
        if (live()) this.endListeners.forEach((cb) => cb());
      });
      return;
    }

    const voice = this.findVoice(voiceId);
    this.voiceKey = voice?.voiceURI ?? "default";
    this.utterances = chunks.map((chunk, index) => {
      const utterance = new this.Utterance(chunk.text);
      utterance.rate = rate;
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.onstart = () => {
        if (live()) this.startChunk(chunk, rate);
      };
      utterance.onboundary = (event) => {
        if (live() && event.name !== "sentence") this.handleRealBoundary(chunk, event.charIndex);
      };
      utterance.onend = () => {
        if (!live()) return;
        this.finishChunk();
        if (index === chunks.length - 1) {
          this.utterances = [];
          this.endListeners.forEach((cb) => cb());
        }
      };
      utterance.onerror = (event) => {
        if (!live() || event.error === "canceled" || event.error === "interrupted") return;
        this.cancel();
        const error = new Error(`Speech synthesis failed: ${event.error}`);
        this.errorListeners.forEach((cb) => cb(error));
      };
      return utterance;
    });
    this.utterances.forEach((utterance) => this.synth.speak(utterance));
  }

  pause(): void {
    if (this.paused) return;
    this.synth.pause();
    const active = this.current;
    if (active) {
      active.activeMs += Date.now() - active.resumedAt;
      if (active.fallbackTimer) clearTimeout(active.fallbackTimer);
      active.fallbackTimer = null;
      active.estimate?.stop();
    }
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.synth.resume();
    const active = this.current;
    if (!active) return;
    active.resumedAt = Date.now();
    if (active.estimate) active.estimate.run(active.activeMs);
    else if (!active.gotBoundary) this.armFallback(active, Math.max(0, this.boundaryTimeoutMs - active.activeMs));
  }

  cancel(): void {
    this.session++;
    this.finishChunk();
    this.utterances = [];
    this.paused = false;
    this.synth.cancel();
    // Chrome keeps the queue paused after cancel(), which would mute the next speak().
    this.synth.resume();
  }

  onBoundary(cb: (charIndex: number) => void): Unsubscribe {
    this.boundaryListeners.add(cb);
    return () => {
      this.boundaryListeners.delete(cb);
    };
  }

  onEnd(cb: () => void): Unsubscribe {
    this.endListeners.add(cb);
    return () => {
      this.endListeners.delete(cb);
    };
  }

  onError(cb: (error: Error) => void): Unsubscribe {
    this.errorListeners.add(cb);
    return () => {
      this.errorListeners.delete(cb);
    };
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const voices = await this.loadVoices();
    return voices.map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang }));
  }

  private loadVoices(): Promise<SpeechSynthesisVoice[]> {
    const ready = this.synth.getVoices();
    if (ready.length > 0) {
      this.voices = ready;
      return Promise.resolve(ready);
    }
    this.voicesPromise ??= new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.synth.removeEventListener("voiceschanged", done);
        this.voices = this.synth.getVoices();
        this.voicesPromise = null;
        resolve(this.voices);
      };
      const timer = setTimeout(done, this.voicesTimeoutMs);
      this.synth.addEventListener("voiceschanged", done);
    });
    return this.voicesPromise;
  }

  private findVoice(voiceId?: string): SpeechSynthesisVoice | null {
    const voices = this.voices.length > 0 ? this.voices : this.synth.getVoices();
    if (voiceId) {
      const match = voices.find((v) => v.voiceURI === voiceId);
      if (match) return match;
    }
    return pickDefaultVoice(voices, this.lang ?? defaultLang());
  }

  private emitBoundary(charIndex: number): void {
    this.boundaryListeners.forEach((cb) => cb(charIndex));
  }

  private startChunk(chunk: TextChunk, rate: number): void {
    this.finishChunk();
    const active: ActiveChunk = {
      chunk,
      rate,
      gotBoundary: false,
      estimate: null,
      fallbackTimer: null,
      activeMs: 0,
      resumedAt: Date.now(),
    };
    this.current = active;
    if (this.noBoundaryVoices.has(this.voiceKey)) this.startEstimate(active, 0);
    else this.armFallback(active, this.boundaryTimeoutMs);
  }

  private armFallback(active: ActiveChunk, delayMs: number): void {
    active.fallbackTimer = setTimeout(() => {
      active.fallbackTimer = null;
      if (active.gotBoundary || this.current !== active) return;
      this.noBoundaryVoices.add(this.voiceKey);
      this.startEstimate(active, active.activeMs + Date.now() - active.resumedAt);
    }, delayMs);
  }

  private startEstimate(active: ActiveChunk, elapsedMs: number): void {
    const { offset } = active.chunk;
    active.estimate = new EstimatedBoundaries(estimateWordTimings(active.chunk.text, active.rate), (charIndex) =>
      this.emitBoundary(offset + charIndex),
    );
    active.estimate.run(elapsedMs);
  }

  private handleRealBoundary(chunk: TextChunk, charIndex: number): void {
    const active = this.current;
    if (active && active.chunk === chunk) {
      active.gotBoundary = true;
      if (active.fallbackTimer) clearTimeout(active.fallbackTimer);
      active.fallbackTimer = null;
      active.estimate?.stop();
      active.estimate = null;
    }
    this.noBoundaryVoices.delete(this.voiceKey);
    this.emitBoundary(chunk.offset + charIndex);
  }

  private finishChunk(): void {
    const active = this.current;
    if (!active) return;
    if (active.fallbackTimer) clearTimeout(active.fallbackTimer);
    active.estimate?.stop();
    this.current = null;
  }
}
