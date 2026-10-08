import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationMiniPlayer } from "../DictationMiniPlayer";
import { DictationController, stopActiveDictation } from "../dictation-controller";
import type { VoiceInfo } from "../engines/types";
import type { Highlighter } from "../highlighter";
import { resetPreferencesForTests } from "../preferences";
import { FakeEngine } from "./fake-engine";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed: Element[] = [];
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
  trigger(isIntersecting: boolean) {
    act(() => {
      this.callback(
        [{ isIntersecting, target: this.observed[0] } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    });
  }
}

const noopHighlighter = (): Highlighter => ({
  show() {},
  showSentence() {},
  scrollIntoView() {},
  clear() {},
  dispose() {},
});

function createController(engine = new FakeEngine()) {
  const container = document.createElement("div");
  container.innerHTML = "<p>One two. Three four.</p>";
  document.body.appendChild(container);
  return new DictationController({
    getContainer: () => container,
    getEngine: () => engine,
    createHighlighter: noopHighlighter,
  });
}

// "One two. Three four." — sentence 2 starts at word 2
function setup({ withToolbar = true } = {}) {
  const engine = new FakeEngine();
  const controller = createController(engine);
  if (withToolbar) controller.setToolbarElement(document.createElement("div"));
  render(<DictationMiniPlayer />);
  return { engine, controller };
}

/** A registered toolbar in the document with a focusable button. */
function attachToolbar(controller: DictationController) {
  const toolbar = document.createElement("div");
  const button = document.createElement("button");
  toolbar.appendChild(button);
  document.body.appendChild(toolbar);
  controller.setToolbarElement(toolbar);
  return button;
}

const pill = () => screen.queryByRole("toolbar", { name: "Reading controls" });
const lastObserver = () => FakeIntersectionObserver.instances.at(-1)!;

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  stopActiveDictation();
  vi.unstubAllGlobals();
  localStorage.clear();
  resetPreferencesForTests();
  document.body.innerHTML = "";
});

describe("DictationMiniPlayer", () => {
  it("renders nothing while nothing is being read", () => {
    setup();
    expect(pill()).toBeNull();
  });

  it("stays hidden while the message toolbar is on screen", async () => {
    const { controller } = setup();
    await act(() => controller.play());
    lastObserver().trigger(true);
    expect(pill()).toBeNull();
  });

  it("appears when the message toolbar scrolls out of view", async () => {
    const { controller } = setup();
    await act(() => controller.play());
    lastObserver().trigger(false);
    expect(pill()).not.toBeNull();
    lastObserver().trigger(true);
    expect(pill()).toBeNull();
  });

  it("shows whenever reading if the message has no registered toolbar", async () => {
    const { controller } = setup({ withToolbar: false });
    await act(() => controller.play());
    expect(pill()).not.toBeNull();
  });

  it("watches a toolbar registered or replaced after reading started", async () => {
    const { controller } = setup({ withToolbar: false });
    await act(() => controller.play());
    expect(pill()).not.toBeNull();
    const toolbar = document.createElement("div");
    act(() => controller.setToolbarElement(toolbar));
    expect(lastObserver().observed).toEqual([toolbar]);
    lastObserver().trigger(true);
    expect(pill()).toBeNull();
    const remounted = document.createElement("div");
    act(() => controller.setToolbarElement(remounted));
    expect(lastObserver().observed).toEqual([remounted]);
  });

  it("pauses, resumes, skips and stops the playing message", async () => {
    const { engine, controller } = setup();
    await act(() => controller.play());
    lastObserver().trigger(false);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(controller.getSnapshot().status).toBe("paused");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    });
    expect(controller.getSnapshot().status).toBe("playing");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next sentence" }));
    });
    expect(engine.lastSpoken?.text).toBe("Three four.");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(controller.getSnapshot().status).toBe("idle");
    expect(pill()).toBeNull();
  });

  it("cycles the speed and continues from the current word at the new speed", async () => {
    const { engine, controller } = setup();
    await act(() => controller.play());
    lastObserver().trigger(false);
    act(() => engine.emitBoundary(9));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^1x/ }));
    });
    expect(controller.getSnapshot().rate).toBe(1.5);
    await vi.waitFor(() =>
      expect(engine.lastSpoken).toEqual({ text: "Three four.", rate: 1.5, voiceId: undefined }),
    );
    expect(screen.getByRole("button", { name: /^1\.5x/ })).toBeTruthy();
  });

  it("offers Back to current word only after the user scrolled away", async () => {
    const { controller } = setup();
    await act(() => controller.play());
    lastObserver().trigger(false);
    expect(screen.queryByRole("button", { name: "Back to current word" })).toBeNull();
    act(() => controller.setFollowing(false));
    fireEvent.click(screen.getByRole("button", { name: "Back to current word" }));
    expect(controller.getSnapshot().following).toBe(true);
  });

  it("supports the same keyboard shortcuts as the toolbar", async () => {
    const { engine, controller } = setup();
    await act(() => controller.play());
    lastObserver().trigger(false);
    await act(async () => {
      fireEvent.keyDown(pill()!, { key: "ArrowRight" });
    });
    expect(engine.lastSpoken?.text).toBe("Three four.");
    act(() => {
      fireEvent.keyDown(pill()!, { key: "Escape" });
    });
    expect(controller.getSnapshot().status).toBe("idle");
  });

  it("renders nothing on the server", () => {
    expect(renderToString(<DictationMiniPlayer />)).toBe("");
  });

  it("starts hidden for a newly active message until its toolbar is known to be off-screen", async () => {
    const { engine, controller } = setup();
    await act(() => controller.play());
    lastObserver().trigger(false);
    expect(pill()).not.toBeNull();
    const other = createController(engine);
    other.setToolbarElement(document.createElement("div"));
    await act(() => other.play());
    expect(pill()).toBeNull();
    lastObserver().trigger(false);
    expect(pill()).not.toBeNull();
  });

  it("moves focus to the message toolbar when stopped from the keyboard", async () => {
    const { controller } = setup({ withToolbar: false });
    const toolbarButton = attachToolbar(controller);
    await act(() => controller.play());
    lastObserver().trigger(false);
    screen.getByRole("button", { name: "Stop" }).focus();
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    });
    expect(pill()).toBeNull();
    expect(document.activeElement).toBe(toolbarButton);
  });

  it("moves focus to the message toolbar when the pill hides", async () => {
    const { controller } = setup({ withToolbar: false });
    const toolbarButton = attachToolbar(controller);
    await act(() => controller.play());
    lastObserver().trigger(false);
    screen.getByRole("button", { name: "Pause" }).focus();
    lastObserver().trigger(true);
    expect(document.activeElement).toBe(toolbarButton);
  });

  it("ignores arrow keys while the voice is loading", async () => {
    const engine = new FakeEngine();
    let resolveVoices!: (voices: VoiceInfo[]) => void;
    engine.listVoices = () => new Promise((resolve) => (resolveVoices = resolve));
    const controller = createController(engine);
    render(<DictationMiniPlayer />);
    act(() => {
      void controller.play();
    });
    expect(controller.getSnapshot().status).toBe("loading");
    fireEvent.keyDown(pill()!, { key: "ArrowRight" });
    await act(async () => resolveVoices([]));
    expect(engine.spoken.map((s) => s.text)).toEqual(["One two. Three four."]);
  });
});
