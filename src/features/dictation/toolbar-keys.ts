export type ToolbarKeyAction = "stop" | "previous" | "next";

export interface ToolbarKeyEvent {
  key: string;
  target: EventTarget | null;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

// Arrow keys move the caret or change the selected voice here.
const ARROW_CONTROLS = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** Keyboard shortcuts shared by the message toolbar and the mini-player. */
export function toolbarKeyAction(event: ToolbarKeyEvent): ToolbarKeyAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "Escape") return "stop";
  if (event.target instanceof Element && event.target.closest(ARROW_CONTROLS)) return null;
  if (event.key === "ArrowLeft") return "previous";
  if (event.key === "ArrowRight") return "next";
  return null;
}
