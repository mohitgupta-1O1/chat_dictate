import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationMiniPlayer } from "../DictationMiniPlayer";
import { DictationController, stopActiveDictation } from "../dictation-controller";
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

// "One two. Three four." — sentence 2 starts at word 2
function setup({ withToolbar = true } = {}) {
  const container = document.createElement("div");
  container.innerHTML = "<p>One two. Three four.</p>";
  document.body.appendChild(container);
  const engine = new FakeEngine();
  const controller = new DictationController({
    getContainer: () => container,
    getEngine: () => engine,
    createHighlighter: noopHighlighter,
  });
  if (withToolbar) controller.setToolbarElement(document.createElement("div"));
  render(<DictationMiniPlayer />);
  return { engine, controller };
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
});
