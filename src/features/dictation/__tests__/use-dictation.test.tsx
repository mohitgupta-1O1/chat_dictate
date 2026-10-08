import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopActiveDictation } from "../dictation-controller";
import type { SpeechEngine } from "../engines/types";
import { useDictation } from "../use-dictation";
import { FakeEngine } from "./fake-engine";

function Message({ html, engine, isComplete = true }: { html: string; engine?: SpeechEngine; isComplete?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const d = useDictation(ref, { engine, isComplete, autoScroll: false });
  return (
    <div>
      <button type="button" onClick={d.play}>
        play
      </button>
      <output data-testid="state">{`${d.supported}|${d.disabled}|${d.status}|${d.currentWordIndex}`}</output>
      <div ref={ref} data-testid="content" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

const state = () => screen.getByTestId("state").textContent;
const content = () => screen.getByTestId("content");

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
});

describe("useDictation", () => {
  it("is unsupported without an engine or speechSynthesis", () => {
    render(<Message html="<p>hi</p>" />);
    expect(state()).toBe("false|true|idle|-1");
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
});
