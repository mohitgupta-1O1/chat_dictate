export { DictationToolbar, type DictationToolbarProps } from "./DictationToolbar";
export { useDictation, type UseDictationOptions, type UseDictationResult } from "./use-dictation";
export { stopActiveDictation, type DictationSnapshot, type DictationStatus } from "./dictation-controller";
export { DEFAULT_RATE, HIGHLIGHT_NAME, RATES, type DictationRate } from "./constants";
export { DEFAULT_REPLACE, DEFAULT_SKIP, type ExtractOptions, type Replacement } from "./extract-words";
export type { SpeakOptions, SpeechEngine, Unsubscribe, VoiceInfo } from "./engines/types";
export { WebSpeechEngine } from "./engines/web-speech-engine";
export { getPreferences, setPreferences, subscribePreferences, type DictationPreferences } from "./preferences";
