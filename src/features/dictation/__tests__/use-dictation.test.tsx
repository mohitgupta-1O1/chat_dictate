import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopActiveDictation } from "../dictation-controller";
import type { SpeechEngine } from "../engines/types";
import { resetPreferencesForTests, setPreferences } from "../preferences";
import { useDictation } from "../use-dictation";
import { FakeEngine } from "./fake-engine";

function Message({
  html,
  engine,
  isComplete = true,
  autoScroll = false,
}: {
  html: string;
  engine?: SpeechEngine;
  isComplete?: boolean;
  autoScroll?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const d = useDictation(ref, { engine, isComplete, autoScroll });
  return (
    <div>
      <button type="button" onClick={d.play}>
        play
      </button>
      <button type="button" onClick={() => d.skipSentence(1)}>
        next
      </button>
      <button type="button" onClick={d.stop}>
        stop
      </button>
      <button type="button" onClick={d.followCurrentWord}>
        follow
      </button>
      <output data-testid="state">{`${d.supported}|${d.disabled}|${d.status}|${d.currentWordIndex}`}</output>
      <output data-testid="following">{String(d.following)}</output>
      <div ref={ref} data-testid="content" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// Renders the container only once there is content, like chat UIs that show a spinner first.
function LateMessage({ html, engine, isComplete }: { html?: string; engine: SpeechEngine; isComplete: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const d = useDictation(ref, { engine, isComplete, autoScroll: false });
  return (
    <div>
      <button type="button" onClick={d.play}>
        play
      </button>
      <output data-testid="state">{`${d.supported}|${d.disabled}|${d.status}|${d.currentWordIndex}`}</output>
      {html !== undefined && <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
}

const state = () => screen.getByTestId("state").textContent;
const content = () => screen.getByTestId("content");
const following = () => screen.getByTestId("following").textContent;

async function clickPlay() {
  await act(async () => {
    fireEvent.click(screen.getByText("play"));
  });
}

function mockCaret(node: Node, offset: number) {
  Object.defineProperty(document, "caretRangeFromPoint", {
    configurable: true,
    value: () => {
      const range = document.createRange();
      range.setStart(node, offset);
      return range;
    },
  });
}

// Clicks seek after a short delay so double-clicks can select words instead.
async function flushSeekDelay() {
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
}

async function click(target: Element, detail = 1) {
  await act(async () => {
    fireEvent.click(target, { detail });
  });
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  stopActiveDictation();
  delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
  window.getSelection()?.removeAllRanges();
  localStorage.clear();
  resetPreferencesForTests();
});

describe("useDictation", () => {
  it("is unsupported without an engine or speechSynthesis", () => {
    render(<Message html="<p>hi</p>" />);
    expect(state()).toBe("false|true|idle|-1");
  });

  it("renders the default speed on the server even when another speed is saved", () => {
    setPreferences({ rate: 1.5 });
    function Rate() {
      const ref = useRef<HTMLDivElement>(null);
      const d = useDictation(ref, { engine: new FakeEngine() });
      return <output>{`${d.rate}x`}</output>;
    }
    expect(renderToString(<Rate />)).toBe("<output>1x</output>");
  });

  it("reads the message aloud", async () => {
    const engine = new FakeEngine();
    render(<Message html="<p>hello brave world</p>" engine={engine} />);
    await clickPlay();
    expect(engine.lastSpoken?.text).toBe("hello brave world.");
    expect(state()).toBe("true|false|playing|0");
  });

  it("stays disabled while the response is incomplete", async () => {
    const engine = new FakeEngine();
    render(<Message html="<p>partial</p>" engine={engine} isComplete={false} />);
    await clickPlay();
    expect(state()).toBe("true|true|idle|-1");
    expect(engine.spoken).toHaveLength(0);
  });

  it("stops when the message content changes", async () => {
    const engine = new FakeEngine();
    const { rerender } = render(<Message html="<p>first version</p>" engine={engine} />);
    await clickPlay();
    rerender(<Message html="<p>second version</p>" engine={engine} />);
    await waitFor(() => expect(state()).toBe("true|false|idle|-1"));
    await clickPlay();
    expect(engine.lastSpoken?.text).toBe("second version.");
  });

  it("skips to the next sentence", async () => {
    const engine = new FakeEngine();
    render(<Message html="<p>One two. Three four.</p>" engine={engine} />);
    await clickPlay();
    await act(async () => {
      fireEvent.click(screen.getByText("next"));
    });
    expect(engine.lastSpoken?.text).toBe("Three four.");
  });

  it("keeps playing when UI marked data-dictation=skip inside the container changes", async () => {
    const engine = new FakeEngine();
    render(
      <Message html='<p>hello brave world</p><div data-dictation="skip"><span>Copy</span></div>' engine={engine} />,
    );
    await clickPlay();
    const callsAfterPlay = engine.calls.length;
    const skipped = content().querySelector('[data-dictation="skip"]')!;
    await act(async () => {
      skipped.firstElementChild!.textContent = "Copied!";
      skipped.appendChild(document.createElement("span"));
      (skipped.firstElementChild!.firstChild as Text).data = "Copied!!";
    });
    expect(state()).toBe("true|false|playing|0");
    expect(engine.calls.slice(callsAfterPlay)).not.toContain("cancel");
  });

  it("still stops when a mutation batch includes content outside skip regions", async () => {
    const engine = new FakeEngine();
    render(<Message html='<p>hello brave world</p><div data-dictation="skip">Copy</div>' engine={engine} />);
    await clickPlay();
    await act(async () => {
      content().querySelector('[data-dictation="skip"]')!.textContent = "Copied!";
      content().querySelector("p")!.textContent = "changed";
    });
    expect(state()).toBe("true|false|idle|-1");
  });

  it("reads the newest content when the container mounts late and is regenerated", async () => {
    const engine = new FakeEngine();
    const { rerender } = render(<LateMessage engine={engine} isComplete={false} />);
    rerender(<LateMessage html="<p>first answer</p>" engine={engine} isComplete={true} />);
    await clickPlay();
    expect(engine.lastSpoken?.text).toBe("first answer.");

    rerender(<LateMessage html="<p>regenerated answer</p>" engine={engine} isComplete={false} />);
    expect(state()).toBe("true|true|idle|-1");
    rerender(<LateMessage html="<p>regenerated answer</p>" engine={engine} isComplete={true} />);
    await clickPlay();
    expect(engine.lastSpoken?.text).toBe("regenerated answer.");
  });

  it("observes a container that mounts after the hook", async () => {
    const engine = new FakeEngine();
    const { rerender } = render(<LateMessage engine={engine} isComplete={false} />);
    rerender(<LateMessage html="<p>first answer</p>" engine={engine} isComplete={true} />);
    await clickPlay();
    rerender(<LateMessage html="<p>edited answer</p>" engine={engine} isComplete={true} />);
    await waitFor(() => expect(state()).toBe("true|false|idle|-1"));
  });

  it("cancels speech on unmount", async () => {
    const engine = new FakeEngine();
    const { unmount } = render(<Message html="<p>hello</p>" engine={engine} />);
    await clickPlay();
    unmount();
    expect(engine.calls.at(-1)).toBe("cancel");
  });

  it("stops on pagehide", async () => {
    const engine = new FakeEngine();
    render(<Message html="<p>hello</p>" engine={engine} />);
    await clickPlay();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(state()).toBe("true|false|idle|-1");
  });

  describe("click to seek", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    it("starts reading from the clicked word after a short delay", async () => {
      const engine = new FakeEngine();
      render(<Message html="<p>hello brave world</p>" engine={engine} />);
      const p = content().querySelector("p")!;
      mockCaret(p.firstChild!, 7);
      await click(p);
      expect(engine.spoken).toHaveLength(0);
      await flushSeekDelay();
      expect(engine.lastSpoken?.text).toBe("brave world.");
    });

    it("does not start reading on a double-click that selects a word", async () => {
      const engine = new FakeEngine();
      render(<Message html="<p>hello brave world</p>" engine={engine} />);
      const p = content().querySelector("p")!;
      mockCaret(p.firstChild!, 7);
      await click(p, 1);
      await click(p, 2);
      await flushSeekDelay();
      expect(engine.spoken).toHaveLength(0);
    });

    it("does not start reading if a selection was made before the delay ends", async () => {
      const engine = new FakeEngine();
      render(<Message html="<p>hello brave world</p>" engine={engine} />);
      const p = content().querySelector("p")!;
      mockCaret(p.firstChild!, 7);
      await click(p);
      window.getSelection()!.selectAllChildren(p);
      await flushSeekDelay();
      expect(engine.spoken).toHaveLength(0);
    });

    it("ignores clicks that end a text selection", async () => {
      const engine = new FakeEngine();
      render(<Message html="<p>hello brave world</p>" engine={engine} />);
      const p = content().querySelector("p")!;
      window.getSelection()!.selectAllChildren(p);
      mockCaret(p.firstChild!, 7);
      await click(p);
      await flushSeekDelay();
      expect(engine.spoken).toHaveLength(0);
    });

    it("ignores clicks on links", async () => {
      const engine = new FakeEngine();
      render(<Message html='<p>go <a href="#x">here</a> now</p>' engine={engine} />);
      const link = content().querySelector("a")!;
      mockCaret(link.firstChild!, 1);
      await click(link);
      await flushSeekDelay();
      expect(engine.spoken).toHaveLength(0);
    });

    it("ignores clicks while the response is incomplete", async () => {
      const engine = new FakeEngine();
      render(<Message html="<p>hello brave world</p>" engine={engine} isComplete={false} />);
      const p = content().querySelector("p")!;
      mockCaret(p.firstChild!, 7);
      await click(p);
      await flushSeekDelay();
      expect(engine.spoken).toHaveLength(0);
    });
  });

  describe("following the current word", () => {
    async function playing(autoScroll = true) {
      const engine = new FakeEngine();
      render(<Message html="<p>hello brave world</p>" engine={engine} autoScroll={autoScroll} />);
      await clickPlay();
      expect(following()).toBe("true");
      return engine;
    }

    function fire(target: EventTarget, event: Event) {
      act(() => {
        target.dispatchEvent(event);
      });
    }

    it("stops following when the user scrolls with the wheel", async () => {
      await playing();
      fire(window, new WheelEvent("wheel", { deltaY: 100 }));
      expect(following()).toBe("false");
      expect(state()).toBe("true|false|playing|0");
    });

    it("stops following on touch scrolling", async () => {
      await playing();
      fire(document.body, new Event("touchmove", { bubbles: true }));
      expect(following()).toBe("false");
    });

    it("stops following on scroll keys pressed outside controls", async () => {
      await playing();
      fire(document.body, new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
      expect(following()).toBe("false");
    });

    it("ignores scroll keys while focus is on a button, field or the toolbar", async () => {
      await playing();
      fire(screen.getByText("play"), new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      const input = document.body.appendChild(document.createElement("input"));
      fire(input, new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      const toolbar = document.body.appendChild(document.createElement("div"));
      toolbar.setAttribute("role", "toolbar");
      fire(toolbar, new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      fire(document.body, new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      expect(following()).toBe("true");
      input.remove();
      toolbar.remove();
    });

    it("stops following when the user presses a scrollbar", async () => {
      await playing();
      const scroller = document.body.appendChild(document.createElement("div"));
      Object.defineProperties(scroller, {
        clientWidth: { value: 185 },
        clientHeight: { value: 300 },
        scrollHeight: { value: 1000 },
      });
      scroller.getBoundingClientRect = () => new DOMRect(0, 0, 200, 300);
      fire(scroller, new MouseEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 50 }));
      expect(following()).toBe("true");
      fire(scroller, new MouseEvent("pointerdown", { bubbles: true, clientX: 190, clientY: 50 }));
      expect(following()).toBe("false");
      scroller.remove();
    });

    it("keeps following on scroll events alone (our own smooth scrolling fires them)", async () => {
      await playing();
      fire(window, new Event("scroll"));
      fire(document, new Event("scroll"));
      expect(following()).toBe("true");
    });

    it("follows again from the follow action", async () => {
      await playing();
      fire(window, new WheelEvent("wheel", { deltaY: 100 }));
      await act(async () => {
        fireEvent.click(screen.getByText("follow"));
      });
      expect(following()).toBe("true");
    });

    it("stops listening once reading stops", async () => {
      await playing();
      const remove = vi.spyOn(window, "removeEventListener");
      await act(async () => {
        fireEvent.click(screen.getByText("stop"));
      });
      const removed = remove.mock.calls.map(([type]) => type);
      remove.mockRestore();
      expect(removed).toEqual(expect.arrayContaining(["wheel", "touchmove", "keydown", "pointerdown"]));
      fire(window, new WheelEvent("wheel", { deltaY: 100 }));
      expect(following()).toBe("true");
    });

    it("never stops following when autoScroll is off", async () => {
      await playing(false);
      fire(window, new WheelEvent("wheel", { deltaY: 100 }));
      fire(document.body, new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
      expect(following()).toBe("true");
    });
  });
});
