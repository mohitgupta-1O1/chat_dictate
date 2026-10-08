import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebSpeechEngine,
  estimateWordTimings,
  pickDefaultVoice,
  splitIntoChunks,
  type WebSpeechEngineOptions,
} from "../engines/web-speech-engine";

class MockUtterance {
  text: string;
  rate = 1;
  lang = "";
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onboundary: ((event: { charIndex: number; name?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

class MockSynth {
  queue: MockUtterance[] = [];
  voices: SpeechSynthesisVoice[] = [];
  calls: string[] = [];
  private listeners = new Set<() => void>();
  speak(u: MockUtterance) {
    this.queue.push(u);
  }
  cancel() {
    this.calls.push("cancel");
    this.queue = [];
  }
  pause() {
    this.calls.push("pause");
  }
  resume() {
    this.calls.push("resume");
  }
  getVoices() {
    return this.voices;
  }
  addEventListener(_type: string, cb: () => void) {
    this.listeners.add(cb);
  }
  removeEventListener(_type: string, cb: () => void) {
    this.listeners.delete(cb);
  }
  fireVoicesChanged() {
    this.listeners.forEach((cb) => cb());
  }
}

function voice(partial: Partial<SpeechSynthesisVoice>): SpeechSynthesisVoice {
  return {
    voiceURI: partial.name ?? "v",
    name: "v",
    lang: "en-US",
    localService: false,
    default: false,
    ...partial,
  } as SpeechSynthesisVoice;
}

function setup(options: WebSpeechEngineOptions = {}) {
  const synth = new MockSynth();
  const engine = new WebSpeechEngine({
    synth: synth as unknown as SpeechSynthesis,
    Utterance: MockUtterance as unknown as typeof SpeechSynthesisUtterance,
    lang: "en-US",
    ...options,
  });
  const boundaries: number[] = [];
  const errors: string[] = [];
  let ends = 0;
  engine.onBoundary((i) => boundaries.push(i));
  engine.onEnd(() => ends++);
  engine.onError((e) => errors.push(e.message));
  return { synth, engine, boundaries, errors, ends: () => ends };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("splitIntoChunks", () => {
  it("splits at sentence ends and keeps offsets", () => {
    expect(splitIntoChunks("Hello there. How are you? Fine.")).toEqual([
      { text: "Hello there. ", offset: 0 },
      { text: "How are you? ", offset: 13 },
      { text: "Fine.", offset: 26 },
    ]);
  });

  it("does not split decimals or inside ellipses", () => {
    expect(splitIntoChunks("Pi is 3.14 today. Wait... what?").map((c) => c.text)).toEqual([
      "Pi is 3.14 today. ",
      "Wait... what?",
    ]);
  });

  it("splits long unpunctuated text at spaces into chunks of at most 200 chars", () => {
    const text = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(200);
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
      expect(chunk.offset === 0 || text[chunk.offset - 1] === " ").toBe(true);
    }
    expect(chunks.map((c) => c.text).join("")).toBe(text);
  });

  it("drops whitespace-only text", () => {
    expect(splitIntoChunks("   ")).toEqual([]);
  });
});

describe("estimateWordTimings", () => {
  it("spaces words by length and scales with rate", () => {
    expect(estimateWordTimings("one two", 1)).toEqual([
      { charIndex: 0, atMs: 0 },
      { charIndex: 4, atMs: 260 },
    ]);
    expect(estimateWordTimings("one two", 2)[1].atMs).toBe(130);
  });
});

describe("pickDefaultVoice", () => {
  it("prefers the local default voice for the language", () => {
    const voices = [
      voice({ name: "Google", default: true }),
      voice({ name: "Albert", localService: true }),
      voice({ name: "Samantha", localService: true, default: true }),
    ];
    expect(pickDefaultVoice(voices, "en-US")?.name).toBe("Samantha");
  });

  it("falls back to any local voice with the exact language", () => {
    const voices = [voice({ name: "Google", default: true }), voice({ name: "Alex", localService: true })];
    expect(pickDefaultVoice(voices, "en-US")?.name).toBe("Alex");
  });

  it("matches on base language and normalises underscores", () => {
    const voices = [voice({ name: "Amelie", lang: "fr-FR", localService: true }), voice({ name: "Alex", lang: "en_US", localService: true })];
    expect(pickDefaultVoice(voices, "en-GB")?.name).toBe("Alex");
  });

  it("returns null when nothing matches", () => {
    expect(pickDefaultVoice([voice({ name: "Alex" })], "ja-JP")).toBeNull();
  });
});

describe("WebSpeechEngine", () => {
  it("queues one utterance per sentence with rate and voice", () => {
    const { synth, engine } = setup();
    synth.voices = [voice({ name: "Samantha", localService: true, default: true })];
    engine.speak("One. Two.", { rate: 1.5 });
    expect(synth.queue.map((u) => u.text)).toEqual(["One. ", "Two."]);
    expect(synth.queue.every((u) => u.rate === 1.5 && u.voice?.name === "Samantha")).toBe(true);
  });

  it("uses the requested voice id", () => {
    const { synth, engine } = setup();
    synth.voices = [voice({ name: "Samantha", localService: true, default: true }), voice({ name: "Daniel", lang: "en-GB" })];
    engine.speak("Hi.", { rate: 1, voiceId: "Daniel" });
    expect(synth.queue[0].voice?.name).toBe("Daniel");
  });

  it("maps word boundaries into offsets of the full text and ignores sentence boundaries", () => {
    const { synth, engine, boundaries } = setup();
    engine.speak("One. Two three.", { rate: 1 });
    const second = synth.queue[1];
    second.onstart!();
    second.onboundary!({ charIndex: 0, name: "sentence" });
    second.onboundary!({ charIndex: 4, name: "word" });
    expect(boundaries).toEqual([9]);
  });

  it("emits end only after the last chunk", () => {
    const { synth, engine, ends } = setup();
    engine.speak("One. Two.", { rate: 1 });
    const [first, second] = synth.queue;
    first.onend!();
    expect(ends()).toBe(0);
    second.onend!();
    expect(ends()).toBe(1);
  });

  it("ignores events from a cancelled session and unpauses the synth on cancel", () => {
    const { synth, engine, boundaries, errors, ends } = setup();
    engine.speak("Hi.", { rate: 1 });
    const [u] = synth.queue;
    synth.calls = [];
    engine.cancel();
    u.onboundary!({ charIndex: 0, name: "word" });
    u.onend!();
    u.onerror!({ error: "synthesis-failed" });
    expect([boundaries, errors, ends()]).toEqual([[], [], 0]);
    expect(synth.calls).toEqual(["cancel", "resume"]);
  });

  it("reports real errors but not cancellations", () => {
    const { synth, engine, errors } = setup();
    engine.speak("Hi.", { rate: 1 });
    synth.queue[0].onerror!({ error: "interrupted" });
    synth.queue[0].onerror!({ error: "canceled" });
    expect(errors).toEqual([]);
    engine.speak("Hi.", { rate: 1 });
    synth.queue[0].onerror!({ error: "synthesis-failed" });
    expect(errors).toEqual(["Speech synthesis failed: synthesis-failed"]);
  });

  it("ends asynchronously when there is nothing to say", async () => {
    const { engine, ends } = setup();
    engine.speak("   ", { rate: 1 });
    expect(ends()).toBe(0);
    await Promise.resolve();
    expect(ends()).toBe(1);
  });

  describe("estimated timing for voices without boundary events", () => {
    // "one two three four." → word timings at 0, 260, 520, 910 ms (rate 1)
    it("starts estimating after the boundary timeout", () => {
      vi.useFakeTimers();
      const { synth, engine, boundaries } = setup();
      engine.speak("one two three four.", { rate: 1 });
      synth.queue[0].onstart!();
      vi.advanceTimersByTime(599);
      expect(boundaries).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(boundaries).toEqual([8]);
      vi.advanceTimersByTime(310);
      expect(boundaries).toEqual([8, 14]);
    });

    it("does not estimate when real boundaries arrive", () => {
      vi.useFakeTimers();
      const { synth, engine, boundaries } = setup();
      engine.speak("one two three four.", { rate: 1 });
      synth.queue[0].onstart!();
      vi.advanceTimersByTime(100);
      synth.queue[0].onboundary!({ charIndex: 0, name: "word" });
      vi.advanceTimersByTime(5000);
      expect(boundaries).toEqual([0]);
    });

    it("estimates immediately for a voice already known to lack boundaries", () => {
      vi.useFakeTimers();
      const { synth, engine, boundaries } = setup();
      engine.speak("a b.", { rate: 1 });
      synth.queue[0].onstart!();
      vi.advanceTimersByTime(600);
      engine.speak("c d.", { rate: 1 });
      boundaries.length = 0;
      synth.queue[0].onstart!();
      expect(boundaries).toEqual([0]);
    });

    it("freezes estimates while paused", () => {
      vi.useFakeTimers();
      const { synth, engine, boundaries } = setup();
      engine.speak("one two three four five.", { rate: 1 });
      synth.queue[0].onstart!();
      vi.advanceTimersByTime(600);
      expect(boundaries).toEqual([8]);
      engine.pause();
      vi.advanceTimersByTime(5000);
      expect(boundaries).toEqual([8]);
      engine.resume();
      vi.advanceTimersByTime(310);
      expect(boundaries).toEqual([8, 14]);
    });

    it("counts only speaking time toward the boundary timeout", () => {
      vi.useFakeTimers();
      const { synth, engine, boundaries } = setup();
      engine.speak("one two three four.", { rate: 1 });
      synth.queue[0].onstart!();
      vi.advanceTimersByTime(300);
      engine.pause();
      vi.advanceTimersByTime(1000);
      engine.resume();
      vi.advanceTimersByTime(299);
      expect(boundaries).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(boundaries).toEqual([8]);
    });
  });

  describe("listVoices", () => {
    it("waits for voiceschanged when voices are not loaded yet", async () => {
      const { synth, engine } = setup();
      const pending = engine.listVoices();
      synth.voices = [voice({ name: "Alex" })];
      synth.fireVoicesChanged();
      expect(await pending).toEqual([{ id: "Alex", name: "Alex", lang: "en-US" }]);
    });

    it("gives up after the timeout", async () => {
      vi.useFakeTimers();
      const { engine } = setup();
      const pending = engine.listVoices();
      vi.advanceTimersByTime(1500);
      expect(await pending).toEqual([]);
    });
  });
});
