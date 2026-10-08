import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DictationController,
  getActiveDictation,
  stopActiveDictation,
  subscribeActiveDictation,
} from "../dictation-controller";
import type { VoiceInfo } from "../engines/types";
import type { Highlighter } from "../highlighter";
import { getPreferences, resetPreferencesForTests } from "../preferences";
import { FakeEngine } from "./fake-engine";

class FakeHighlighter implements Highlighter {
  shown: (Range | null)[] = [];
  scrolls: boolean[] = [];
  forced: Range[] = [];
  cleared = 0;
  sentences: (Range | null)[] = [];
  showSentence(range: Range | null) {
    this.sentences.push(range);
  }
  show(range: Range | null, options?: { scroll?: boolean }) {
    this.shown.push(range);
    this.scrolls.push(options?.scroll ?? true);
  }
  scrollIntoView(range: Range) {
    this.forced.push(range);
  }
  clear() {
    this.cleared++;
  }
  dispose() {
    this.clear();
  }
  get lastText() {
    return this.shown.at(-1)?.toString();
  }
}

// "one two three four." — words start at 0, 4, 8, 14
function setup(html = "<p>one two three four</p>", engine = new FakeEngine(), watchdogMs = 10_000) {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const highlighter = new FakeHighlighter();
  const controller = new DictationController({
    getContainer: () => container,
    getEngine: () => engine,
    createHighlighter: () => highlighter,
    watchdogMs,
  });
  return { container, engine, highlighter, controller, state: () => controller.getSnapshot() };
}

afterEach(() => {
  stopActiveDictation();
  vi.useRealTimers();
  document.body.innerHTML = "";
  localStorage.clear();
  resetPreferencesForTests();
});

describe("DictationController", () => {
  it("starts with the saved speed and voice", async () => {
    localStorage.setItem("dictation:preferences", JSON.stringify({ rate: 1.5, voiceId: "Daniel" }));
    resetPreferencesForTests();
    const { engine, controller, state } = setup();
    expect(state()).toMatchObject({ rate: 1.5, voiceId: "Daniel" });
    await controller.play();
    expect(engine.lastSpoken).toMatchObject({ rate: 1.5, voiceId: "Daniel" });
  });

  it("saves speed and voice changes", async () => {
    const { controller } = setup();
    await controller.setRate(2);
    await controller.setVoice("Alex");
    expect(getPreferences()).toEqual({ rate: 2, voiceId: "Alex" });
  });

  it("shares a speed change with every message", async () => {
    const a = setup();
    const b = setup("<p>other words</p>", a.engine);
    b.controller.subscribe(() => {});
    await a.controller.setRate(0.5);
    expect(b.state().rate).toBe(0.5);
  });

  it("does not listen for preference changes until subscribed or used", async () => {
    const a = setup();
    const b = setup("<p>other words</p>", a.engine);
    await a.controller.setRate(2);
    expect(b.state().rate).toBe(1);
  });

  it("picks up a speed changed while disposed when subscribed again", async () => {
    const a = setup();
    const b = setup("<p>other words</p>", a.engine);
    b.controller.subscribe(() => {});
    b.controller.dispose();
    await a.controller.setRate(1.5);
    expect(b.state().rate).toBe(1);
    b.controller.subscribe(() => {});
    expect(b.state().rate).toBe(1.5);
  });

  it("restarts the playing message when another message changes the speed", async () => {
    const a = setup();
    const b = setup("<p>other words</p>", a.engine);
    await a.controller.play();
    a.engine.emitBoundary(8);
    await b.controller.setRate(2);
    expect(a.engine.lastSpoken).toEqual({ text: "three four.", rate: 2, voiceId: undefined });
    expect(b.state().status).toBe("idle");
  });

  it("ignores speeds outside the allowed set", async () => {
    const { controller, state } = setup();
    await controller.setRate(3);
    expect(state().rate).toBe(1);
  });

  it("plays the whole message from the first word", async () => {
    const { engine, highlighter, controller, state } = setup();
    await controller.play();
    expect(engine.lastSpoken).toEqual({ text: "one two three four.", rate: 1, voiceId: undefined });
    expect(state()).toMatchObject({ status: "playing", currentWordIndex: 0, error: null });
    expect(highlighter.lastText).toBe("one");
  });

  it("highlights the word at each boundary", async () => {
    const { engine, highlighter, controller, state } = setup();
    await controller.play();
    engine.emitBoundary(8);
    expect(state().currentWordIndex).toBe(2);
    expect(highlighter.lastText).toBe("three");
  });

  it("restarts from the current word when the speed changes", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    engine.emitBoundary(8);
    await controller.setRate(2);
    expect(engine.lastSpoken).toEqual({ text: "three four.", rate: 2, voiceId: undefined });
    engine.emitBoundary(6);
    expect(state()).toMatchObject({ currentWordIndex: 3, rate: 2 });
  });

  it("restarts from the current word when the voice changes", async () => {
    const { engine, controller } = setup();
    await controller.play();
    engine.emitBoundary(4);
    await controller.setVoice("daniel");
    expect(engine.lastSpoken).toEqual({ text: "two three four.", rate: 1, voiceId: "daniel" });
  });

  it("seeks to a word from idle", async () => {
    const { engine, controller, state } = setup();
    await controller.seekToWord(3);
    expect(engine.lastSpoken?.text).toBe("four.");
    expect(state().status).toBe("playing");
  });

  it("seeks to a caret position", async () => {
    const { container, engine, controller } = setup();
    await controller.seekToPoint(container.querySelector("p")!.firstChild!, 9);
    expect(engine.lastSpoken?.text).toBe("three four.");
  });

  it("pauses and resumes through the engine", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    controller.pause();
    expect(state().status).toBe("paused");
    expect(engine.calls.at(-1)).toBe("pause");
    await controller.resume();
    expect(state().status).toBe("playing");
    expect(engine.calls.at(-1)).toBe("resume");
    expect(engine.spoken).toHaveLength(1);
  });

  it("silences an engine that ignores pause and restarts on resume", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    engine.emitBoundary(4);
    controller.pause();
    engine.emitBoundary(8);
    expect(engine.calls.at(-1)).toBe("cancel");
    expect(state().currentWordIndex).toBe(1);
    await controller.resume();
    expect(engine.lastSpoken?.text).toBe("two three four.");
  });

  it("applies a speed change made while paused on resume", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    engine.emitBoundary(4);
    controller.pause();
    await controller.setRate(1.5);
    expect(state().status).toBe("paused");
    expect(engine.spoken).toHaveLength(1);
    await controller.resume();
    expect(engine.lastSpoken).toEqual({ text: "two three four.", rate: 1.5, voiceId: undefined });
  });

  it("returns to idle and clears the highlight at the end", async () => {
    const { engine, highlighter, controller, state } = setup();
    await controller.play();
    engine.emitEnd();
    expect(state()).toMatchObject({ status: "idle", currentWordIndex: -1 });
    expect(highlighter.cleared).toBeGreaterThan(0);
  });

  it("surfaces engine errors", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    engine.emitError(new Error("boom"));
    expect(state()).toMatchObject({ status: "idle", error: "boom" });
  });

  it("stops and unsubscribes", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    controller.stop();
    expect(engine.calls.at(-1)).toBe("cancel");
    expect(state()).toMatchObject({ status: "idle", currentWordIndex: -1 });
    expect(engine.listenerCount).toBe(0);
  });

  it("allows only one message to play at a time", async () => {
    const a = setup();
    const b = setup("<p>other words</p>", a.engine);
    await a.controller.play();
    await b.controller.play();
    expect(a.state().status).toBe("idle");
    a.engine.emitBoundary(6);
    expect(b.state().currentWordIndex).toBe(1);
    expect(a.state().currentWordIndex).toBe(-1);
    expect(a.engine.listenerCount).toBe(1);
  });

  it("stops and re-reads the DOM after invalidate", async () => {
    const { container, engine, controller, state } = setup();
    await controller.play();
    container.innerHTML = "<p>new words</p>";
    controller.invalidate();
    expect(state().status).toBe("idle");
    await controller.play();
    expect(engine.lastSpoken?.text).toBe("new words.");
  });

  it("does not speak if stopped while loading voices", async () => {
    const { engine, controller, state } = setup();
    let resolveVoices: (v: VoiceInfo[]) => void = () => {};
    engine.listVoices = () => new Promise((resolve) => (resolveVoices = resolve));
    const pending = controller.play();
    expect(state().status).toBe("loading");
    controller.stop();
    resolveVoices([]);
    await pending;
    expect(engine.spoken).toHaveLength(0);
    expect(state().status).toBe("idle");
  });

  it("ignores boundaries while loading", async () => {
    const { engine, controller, state } = setup();
    let resolveVoices: (v: VoiceInfo[]) => void = () => {};
    engine.listVoices = () => new Promise((resolve) => (resolveVoices = resolve));
    const pending = controller.play();
    engine.emitBoundary(8);
    expect(state().currentWordIndex).toBe(0);
    resolveVoices([]);
    await pending;
  });

  it("reports an error when there is nothing to read", async () => {
    const { engine, controller, state } = setup("<p>   </p>");
    await controller.play();
    expect(engine.spoken).toHaveLength(0);
    expect(state()).toMatchObject({ status: "idle", error: "There is no text to read." });
  });

  it("restarts a stalled engine once, then gives up", async () => {
    vi.useFakeTimers();
    const { engine, controller, state } = setup(undefined, undefined, 1000);
    await controller.play();
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.spoken).toHaveLength(2);
    expect(engine.lastSpoken?.text).toBe("one two three four.");
    await vi.advanceTimersByTimeAsync(1000);
    expect(state()).toMatchObject({ status: "idle", error: "Speech stopped responding." });
  });

  it("does not restart while boundaries keep arriving", async () => {
    vi.useFakeTimers();
    const { engine, controller } = setup(undefined, undefined, 1000);
    await controller.play();
    await vi.advanceTimersByTimeAsync(900);
    engine.emitBoundary(4);
    await vi.advanceTimersByTimeAsync(900);
    expect(engine.spoken).toHaveLength(1);
  });

  it("can play again after dispose (React StrictMode remounts)", async () => {
    const { engine, controller, state } = setup();
    await controller.play();
    controller.dispose();
    await controller.play();
    expect(engine.spoken).toHaveLength(2);
    expect(state().status).toBe("playing");
  });

  it("passes listVoices through to the engine", async () => {
    const { engine, controller } = setup();
    engine.voices = [{ id: "a", name: "A", lang: "en-US" }];
    expect(await controller.listVoices()).toEqual(engine.voices);
  });

  describe("following the current word", () => {
    it("follows by default", async () => {
      const { highlighter, controller, state } = setup();
      expect(state().following).toBe(true);
      await controller.play();
      expect(highlighter.scrolls).toEqual([true]);
    });

    it("stays off across boundaries, speed changes and pause/resume, and tells the highlighter not to scroll", async () => {
      const { engine, highlighter, controller, state } = setup();
      await controller.play();
      controller.setFollowing(false);
      engine.emitBoundary(4);
      await controller.setRate(2);
      engine.emitBoundary(4);
      controller.pause();
      await controller.resume();
      expect(state()).toMatchObject({ following: false, currentWordIndex: 2 });
      expect(highlighter.scrolls.slice(1)).toEqual([false, false, false]);
    });

    it("stays off when a stalled engine is restarted", async () => {
      vi.useFakeTimers();
      const { controller, state } = setup(undefined, undefined, 1000);
      await controller.play();
      controller.setFollowing(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(state()).toMatchObject({ status: "playing", following: false });
    });

    it("turns back on when seeking to a word or a caret position", async () => {
      const { container, highlighter, controller, state } = setup();
      await controller.play();
      controller.setFollowing(false);
      await controller.seekToWord(2);
      expect(state().following).toBe(true);
      expect(highlighter.scrolls.at(-1)).toBe(true);
      controller.setFollowing(false);
      await controller.seekToPoint(container.querySelector("p")!.firstChild!, 15);
      expect(state()).toMatchObject({ following: true, currentWordIndex: 3 });
    });

    it("turns back on when playback starts from idle", async () => {
      const { highlighter, controller, state } = setup();
      await controller.play();
      controller.setFollowing(false);
      controller.stop();
      await controller.play();
      expect(state().following).toBe(true);
      expect(highlighter.scrolls.at(-1)).toBe(true);
    });

    it("followCurrentWord turns following on and scrolls to the current word now", async () => {
      const { engine, highlighter, controller, state } = setup();
      await controller.play();
      engine.emitBoundary(8);
      controller.setFollowing(false);
      controller.followCurrentWord();
      expect(state().following).toBe(true);
      expect(highlighter.forced.map((range) => range.toString())).toEqual(["three"]);
    });
  });

  // "One two. Three four." — words start at 0, 4, 9, 15
  const TWO_SENTENCES = "<p>One two. Three four.</p>";

  it("highlights the current sentence and updates it only when the sentence changes", async () => {
    const { engine, highlighter, controller } = setup(TWO_SENTENCES);
    await controller.play();
    expect(highlighter.sentences.map((r) => r?.toString())).toEqual(["One two."]);
    engine.emitBoundary(4);
    expect(highlighter.sentences).toHaveLength(1);
    engine.emitBoundary(9);
    expect(highlighter.sentences.map((r) => r?.toString())).toEqual(["One two.", "Three four."]);
  });

  it("skips to the next sentence while playing", async () => {
    const { engine, controller, state } = setup(TWO_SENTENCES);
    await controller.play();
    await controller.skipSentence(1);
    expect(engine.lastSpoken?.text).toBe("Three four.");
    expect(state()).toMatchObject({ status: "playing", currentWordIndex: 2 });
  });

  it("does nothing when skipping past the last sentence", async () => {
    const { engine, controller } = setup(TWO_SENTENCES);
    await controller.seekToWord(3);
    await controller.skipSentence(1);
    expect(engine.spoken).toHaveLength(1);
  });

  it("goes to the previous sentence near the start of a sentence", async () => {
    const { engine, controller } = setup(TWO_SENTENCES);
    await controller.seekToWord(2);
    await controller.skipSentence(-1);
    expect(engine.lastSpoken?.text).toBe("One two. Three four.");
  });

  it("restarts the current sentence when well into it", async () => {
    // "One two. Three four five six seven." — sentence 1 starts at word 2
    const { engine, controller } = setup("<p>One two. Three four five six seven.</p>");
    await controller.seekToWord(5);
    await controller.skipSentence(-1);
    expect(engine.lastSpoken?.text).toBe("Three four five six seven.");
  });

  it("stays paused when skipping while paused, then resumes from the new sentence", async () => {
    const { engine, controller, state } = setup(TWO_SENTENCES);
    await controller.play();
    controller.pause();
    await controller.skipSentence(1);
    expect(state()).toMatchObject({ status: "paused", currentWordIndex: 2 });
    expect(engine.calls.at(-1)).toBe("cancel");
    expect(engine.spoken).toHaveLength(1);
    await controller.resume();
    expect(engine.lastSpoken?.text).toBe("Three four.");
  });

  it("goes back a sentence within the first 2 words, and restarts the current one from the 3rd", async () => {
    // "One two. Three four five six seven." — sentence 1 starts at word 2
    const { engine, controller } = setup("<p>One two. Three four five six seven.</p>");
    await controller.seekToWord(4); // 2 words in
    await controller.skipSentence(-1);
    expect(engine.lastSpoken?.text).toBe("One two. Three four five six seven.");
    await controller.seekToWord(5); // 3 words in
    await controller.skipSentence(-1);
    expect(engine.lastSpoken?.text).toBe("Three four five six seven.");
  });

  it("restarts the first sentence when going back from it", async () => {
    const { engine, controller, state } = setup(TWO_SENTENCES);
    await controller.seekToWord(1);
    await controller.skipSentence(-1);
    expect(engine.lastSpoken?.text).toBe("One two. Three four.");
    expect(state()).toMatchObject({ status: "playing", currentWordIndex: 0 });
  });

  it("goes back a sentence while paused and stays paused", async () => {
    const { engine, controller, state } = setup(TWO_SENTENCES);
    await controller.play();
    engine.emitBoundary(15);
    controller.pause();
    await controller.skipSentence(-1);
    expect(state()).toMatchObject({ status: "paused", currentWordIndex: 0 });
    expect(engine.calls.at(-1)).toBe("cancel");
    expect(engine.spoken).toHaveLength(1);
    await controller.resume();
    expect(engine.spoken).toHaveLength(2);
    expect(engine.lastSpoken?.text).toBe("One two. Three four.");
  });

  it("leaves following off after a skip", async () => {
    const { controller, state } = setup(TWO_SENTENCES);
    await controller.play();
    controller.setFollowing(false);
    await controller.skipSentence(1);
    expect(state().following).toBe(false);
  });

  it("ignores skips while idle", async () => {
    const { engine, controller } = setup(TWO_SENTENCES);
    await controller.skipSentence(1);
    expect(engine.spoken).toHaveLength(0);
  });

  it("clears the sentence highlight on stop and shows it again on the next play", async () => {
    const { highlighter, controller } = setup(TWO_SENTENCES);
    await controller.play();
    controller.stop();
    await controller.play();
    expect(highlighter.sentences.map((r) => r?.toString())).toEqual(["One two.", "One two."]);
  });
  it("publishes the playing controller", async () => {
    const a = setup();
    const b = setup("<p>other words</p>", a.engine);
    const listener = vi.fn();
    const unsubscribe = subscribeActiveDictation(listener);
    await a.controller.play();
    expect(getActiveDictation()).toBe(a.controller);
    await b.controller.play();
    expect(getActiveDictation()).toBe(b.controller);
    b.controller.stop();
    expect(getActiveDictation()).toBeNull();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("remembers its toolbar element", () => {
    const { controller } = setup();
    const el = document.createElement("div");
    controller.setToolbarElement(el);
    expect(controller.getToolbarElement()).toBe(el);
    controller.setToolbarElement(null);
    expect(controller.getToolbarElement()).toBeNull();
  });
});
