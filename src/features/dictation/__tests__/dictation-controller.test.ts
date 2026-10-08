import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationController, stopActiveDictation } from "../dictation-controller";
import type { VoiceInfo } from "../engines/types";
import type { Highlighter } from "../highlighter";
import { FakeEngine } from "./fake-engine";

class FakeHighlighter implements Highlighter {
  shown: (Range | null)[] = [];
  cleared = 0;
  show(range: Range | null) {
    this.shown.push(range);
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
});

describe("DictationController", () => {
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
});
