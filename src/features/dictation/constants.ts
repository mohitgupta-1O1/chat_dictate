export const RATES = [0.5, 1, 1.5, 2] as const;

export type DictationRate = (typeof RATES)[number];

export const DEFAULT_RATE: DictationRate = 1;

/** Name used with the CSS Custom Highlight API: `::highlight(dictation-word)`. */
export const HIGHLIGHT_NAME = "dictation-word";

/** Fainter layer under the word: `::highlight(dictation-sentence)`. */
export const SENTENCE_HIGHLIGHT_NAME = "dictation-sentence";
