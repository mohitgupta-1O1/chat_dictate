export type Unsubscribe = () => void;

export interface VoiceInfo {
  id: string;
  name: string;
  lang: string;
}

export interface SpeakOptions {
  rate: number;
  voiceId?: string;
}

/**
 * A text-to-speech backend. `speak()` replaces anything currently speaking;
 * boundary indexes are offsets into the `text` passed to the latest `speak()`.
 */
export interface SpeechEngine {
  speak(text: string, options: SpeakOptions): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  onBoundary(cb: (charIndex: number) => void): Unsubscribe;
  onEnd(cb: () => void): Unsubscribe;
  onError(cb: (error: Error) => void): Unsubscribe;
  listVoices(): Promise<VoiceInfo[]>;
}
