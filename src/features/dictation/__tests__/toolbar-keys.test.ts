import { describe, expect, it } from "vitest";
import { toolbarKeyAction } from "../toolbar-keys";

const NO_MODIFIERS = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

function press(key: string, target: EventTarget | null = document.createElement("button"), modifiers = {}) {
  return toolbarKeyAction({ key, target, ...NO_MODIFIERS, ...modifiers });
}

describe("toolbarKeyAction", () => {
  it("maps Escape and the left/right arrows", () => {
    expect(press("Escape")).toBe("stop");
    expect(press("ArrowLeft")).toBe("previous");
    expect(press("ArrowRight")).toBe("next");
    expect(press("a")).toBeNull();
  });

  it("ignores keys pressed with a modifier", () => {
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
      expect(press("ArrowRight", undefined, { [modifier]: true })).toBeNull();
      expect(press("Escape", undefined, { [modifier]: true })).toBeNull();
    }
  });

  it("leaves arrow keys to text fields and the voice picker, but still stops on Escape", () => {
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const inside = document.createElement("span");
    editable.appendChild(inside);
    for (const target of [
      document.createElement("select"),
      document.createElement("input"),
      document.createElement("textarea"),
      editable,
      inside,
    ]) {
      expect(press("ArrowLeft", target)).toBeNull();
      expect(press("ArrowRight", target)).toBeNull();
      expect(press("Escape", target)).toBe("stop");
    }
  });
});
