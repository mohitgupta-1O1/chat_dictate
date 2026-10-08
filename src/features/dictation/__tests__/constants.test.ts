import { describe, expect, it } from "vitest";
import { DEFAULT_RATE, HIGHLIGHT_NAME, RATES } from "../constants";

describe("constants", () => {
  it("offers exactly the four approved speeds, defaulting to 1x", () => {
    expect(RATES).toEqual([0.5, 1, 1.5, 2]);
    expect(DEFAULT_RATE).toBe(1);
  });

  it("names the CSS highlight", () => {
    expect(HIGHLIGHT_NAME).toBe("dictation-word");
  });
});
