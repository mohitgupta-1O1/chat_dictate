import type { SpeakOptions, SpeechEngine, Unsubscribe, VoiceInfo } from "../engines/types";

/** A SpeechEngine driven by the test: call emitBoundary/emitEnd/emitError to simulate speech. */
export class FakeEngine implements SpeechEngine {
  calls: string[] = [];
  spoken: Array<{ text: string } & SpeakOptions> = [];
  voices: VoiceInfo[] = [];
  private readonly boundary = new Set<(charIndex: number) => void>();
  private readonly end = new Set<() => void>();
  private readonly error = new Set<(error: Error) => void>();

  speak(text: string, options: SpeakOptions): void {
    this.calls.push("speak");
    this.spoken.push({ text, ...options });
  }
  pause(): void {
    this.calls.push("pause");
  }
  resume(): void {
    this.calls.push("resume");
  }
  cancel(): void {
    this.calls.push("cancel");
  }
  onBoundary(cb: (charIndex: number) => void): Unsubscribe {
    this.boundary.add(cb);
    return () => {
      this.boundary.delete(cb);
    };
  }
  onEnd(cb: () => void): Unsubscribe {
    this.end.add(cb);
    return () => {
      this.end.delete(cb);
    };
  }
  onError(cb: (error: Error) => void): Unsubscribe {
    this.error.add(cb);
    return () => {
      this.error.delete(cb);
    };
  }
  listVoices(): Promise<VoiceInfo[]> {
    return Promise.resolve(this.voices);
  }

  get lastSpoken() {
    return this.spoken.at(-1);
  }
  get listenerCount() {
    return this.boundary.size;
  }
  emitBoundary(charIndex: number) {
    this.boundary.forEach((cb) => cb(charIndex));
  }
  emitEnd() {
    this.end.forEach((cb) => cb());
  }
  emitError(error: Error) {
    this.error.forEach((cb) => cb(error));
  }
}
