import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationToolbar } from "../DictationToolbar";
import type { UseDictationResult } from "../use-dictation";

function fakeDictation(overrides: Partial<UseDictationResult> = {}): UseDictationResult {
  return {
    status: "idle",
    rate: 1,
    voiceId: undefined,
    currentWordIndex: -1,
    error: null,
    following: true,
    supported: true,
    disabled: false,
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    setRate: vi.fn(),
    setVoice: vi.fn(),
    seekToWord: vi.fn(),
    followCurrentWord: vi.fn(),
    skipSentence: vi.fn(),
    toolbarRef: vi.fn(),
    listVoices: vi.fn(async () => [{ id: "v1", name: "Samantha", lang: "en-US" }]),
    ...overrides,
  };
}

afterEach(cleanup);

describe("DictationToolbar", () => {
  it("renders nothing when speech is unsupported", () => {
    const { container } = render(<DictationToolbar dictation={fakeDictation({ supported: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("marks itself as skipped so dictation ignores it inside a message container", () => {
    render(<DictationToolbar dictation={fakeDictation()} />);
    expect(screen.getByRole("toolbar")).toHaveAttribute("data-dictation", "skip");
  });

  it("starts reading from the Dictate button", () => {
    const d = fakeDictation();
    render(<DictationToolbar dictation={d} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate: read this response aloud" }));
    expect(d.play).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("disables Dictate while the response is incomplete", () => {
    render(<DictationToolbar dictation={fakeDictation({ disabled: true })} />);
    expect(screen.getByRole("button", { name: "Dictate: read this response aloud" })).toBeDisabled();
  });

  it("shows Pause and Stop while playing", () => {
    const d = fakeDictation({ status: "playing" });
    render(<DictationToolbar dictation={d} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(d.pause).toHaveBeenCalled();
    expect(d.stop).toHaveBeenCalled();
    expect(screen.getByText("Reading aloud")).toBeTruthy();
  });

  it("shows Resume while paused", () => {
    const d = fakeDictation({ status: "paused" });
    render(<DictationToolbar dictation={d} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(d.resume).toHaveBeenCalled();
  });

  it("gives every button an accessible name that starts with its visible text", () => {
    for (const status of ["idle", "loading", "playing", "paused"] as const) {
      const { unmount } = render(<DictationToolbar dictation={fakeDictation({ status, following: false })} />);
      for (const button of screen.getAllByRole("button")) {
        const visible = button.textContent!.replace(/[▶❚■…↓⏮⏭]/g, "").trim();
        const name = button.getAttribute("aria-label") ?? visible;
        expect(name.startsWith(visible)).toBe(true);
      }
      unmount();
    }
  });

  it("announces Stopped when reading ends, and nothing initially", () => {
    const live = () => document.querySelector('[aria-live="polite"]')!.textContent;
    const { rerender } = render(<DictationToolbar dictation={fakeDictation()} />);
    expect(live()).toBe("");
    rerender(<DictationToolbar dictation={fakeDictation({ status: "playing" })} />);
    expect(live()).toBe("Reading aloud");
    rerender(<DictationToolbar dictation={fakeDictation({ status: "idle" })} />);
    expect(live()).toBe("Stopped");
    rerender(<DictationToolbar dictation={fakeDictation({ status: "paused" })} />);
    expect(live()).toBe("Paused");
  });

  it("offers exactly the four speeds and marks the current one", () => {
    const d = fakeDictation({ rate: 1.5 });
    render(<DictationToolbar dictation={d} />);
    const group = screen.getByRole("group", { name: "Reading speed" });
    const buttons = Array.from(group.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["0.5x", "1x", "1.5x", "2x"]);
    expect(screen.getByRole("button", { name: "1.5x" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1x" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "2x" }));
    expect(d.setRate).toHaveBeenCalledWith(2);
  });

  it("stops on Escape while active", () => {
    const d = fakeDictation({ status: "playing" });
    render(<DictationToolbar dictation={d} />);
    fireEvent.keyDown(screen.getByRole("toolbar"), { key: "Escape" });
    expect(d.stop).toHaveBeenCalled();
  });

  it("shows errors", () => {
    render(<DictationToolbar dictation={fakeDictation({ error: "boom" })} />);
    expect(screen.getByRole("alert").textContent).toBe("boom");
  });

  it("lists voices and selects one", async () => {
    const d = fakeDictation();
    render(<DictationToolbar dictation={d} showVoicePicker />);
    await screen.findByRole("option", { name: "Samantha (en-US)" });
    fireEvent.change(screen.getByRole("combobox", { name: "Voice" }), { target: { value: "v1" } });
    expect(d.setVoice).toHaveBeenCalledWith("v1");
  });

  it("offers Back to current word only while reading and not following", () => {
    const back = () => screen.queryByRole("button", { name: "Back to current word" });
    const { rerender } = render(<DictationToolbar dictation={fakeDictation({ status: "playing" })} />);
    expect(back()).toBeNull();
    rerender(<DictationToolbar dictation={fakeDictation({ status: "idle", following: false })} />);
    expect(back()).toBeNull();
    for (const status of ["loading", "playing", "paused"] as const) {
      rerender(<DictationToolbar dictation={fakeDictation({ status, following: false })} />);
      expect(back()).not.toBeNull();
    }
  });

  it("follows the current word again from the Back to current word button", () => {
    const d = fakeDictation({ status: "playing", following: false });
    render(<DictationToolbar dictation={d} />);
    fireEvent.click(screen.getByRole("button", { name: "Back to current word" }));
    expect(d.followCurrentWord).toHaveBeenCalled();
  });
  it("shows sentence skip buttons only while active", () => {
    render(<DictationToolbar dictation={fakeDictation()} />);
    expect(screen.queryByRole("button", { name: "Previous sentence" })).toBeNull();
    cleanup();
    const d = fakeDictation({ status: "playing" });
    render(<DictationToolbar dictation={d} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous sentence" }));
    fireEvent.click(screen.getByRole("button", { name: "Next sentence" }));
    expect(d.skipSentence).toHaveBeenNthCalledWith(1, -1);
    expect(d.skipSentence).toHaveBeenNthCalledWith(2, 1);
  });

  it("disables sentence skip while the voice loads", () => {
    render(<DictationToolbar dictation={fakeDictation({ status: "loading" })} />);
    expect(screen.getByRole("button", { name: "Next sentence" })).toBeDisabled();
  });

  it("skips with the arrow keys while active", () => {
    const d = fakeDictation({ status: "paused" });
    render(<DictationToolbar dictation={d} />);
    fireEvent.keyDown(screen.getByRole("toolbar"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("toolbar"), { key: "ArrowLeft" });
    expect(d.skipSentence).toHaveBeenNthCalledWith(1, 1);
    expect(d.skipSentence).toHaveBeenNthCalledWith(2, -1);
  });

  it("leaves arrow keys to the voice picker", async () => {
    const d = fakeDictation({ status: "playing" });
    render(<DictationToolbar dictation={d} showVoicePicker />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Voice" }), { key: "ArrowRight" });
    expect(d.skipSentence).not.toHaveBeenCalled();
    await screen.findByRole("option", { name: "Samantha (en-US)" });
  });
  it("registers its root element for the mini-player", () => {
    const d = fakeDictation();
    render(<DictationToolbar dictation={d} />);
    expect(d.toolbarRef).toHaveBeenCalledWith(screen.getByRole("toolbar"));
  });
});
