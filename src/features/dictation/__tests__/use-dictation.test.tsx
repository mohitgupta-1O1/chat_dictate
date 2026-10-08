import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
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
    it("starts reading from the clicked word", async () => {
      const engine = new FakeEngine();
      render(<Message html="<p>hello brave world</p>" engine={engine} />);
      const p = content().querySelector("p")!;
      mockCaret(p.firstChild!, 7);
      await act(async () => {
        fireEvent.click(p);
      });
      expect(engine.lastSpoken?.text).toBe("brave world.");
    });

    it("ignores clicks that end a text selection", async () => {
      const engine = new FakeEngine();
      render(<Message html="<p>hello brave world</p>" engine={engine} />);
      const p = content().querySelector("p")!;
      window.getSelection()!.selectAllChildren(p);
      mockCaret(p.firstChild!, 7);
      await act(async () => {
        fireEvent.click(p);
      });
      expect(engine.spoken).toHaveLength(0);
    });

    it("ignores clicks on links", async () => {
      const engine = new FakeEngine();
      render(<Message html='<p>go <a href="#x">here</a> now</p>' engine={engine} />);
      const link = content().querySelector("a")!;
      mockCaret(link.firstChild!, 1);
      await act(async () => {
        fireEvent.click(link);
      });
      expect(engine.spoken).toHaveLength(0);
    });

    it("ignores clicks while the response is incomplete", async () => {
      const engine = new FakeEngine();
      render(<Message html="<p>hello brave world</p>" engine={engine} isComplete={false} />);
      const p = content().querySelector("p")!;
      mockCaret(p.firstChild!, 7);
      await act(async () => {
        fireEvent.click(p);
      });
      expect(engine.spoken).toHaveLength(0);
    });
  });
});
