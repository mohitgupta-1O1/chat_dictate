export type ToolbarKeyAction = "stop" | "previous" | "next";

/** Keyboard shortcuts shared by the message toolbar and the mini-player. */
export function toolbarKeyAction(event: { key: string; target: EventTarget | null }): ToolbarKeyAction | null {
  if (event.key === "Escape") return "stop";
  // Arrow keys change the selected voice inside the picker.
  if (event.target instanceof HTMLSelectElement) return null;
  if (event.key === "ArrowLeft") return "previous";
  if (event.key === "ArrowRight") return "next";
  return null;
}
