import { afterEach, describe, expect, it, vi } from "vitest";
import { getPreferences, resetPreferencesForTests, setPreferences, subscribePreferences } from "../preferences";

const KEY = "dictation:preferences";

afterEach(() => {
  localStorage.clear();
  resetPreferencesForTests();
  vi.restoreAllMocks();
});

describe("preferences", () => {
  it("defaults to 1x and the default voice", () => {
    expect(getPreferences()).toEqual({ rate: 1, voiceId: undefined });
  });

  it("loads saved values", () => {
    localStorage.setItem(KEY, JSON.stringify({ rate: 1.5, voiceId: "Samantha" }));
    expect(getPreferences()).toEqual({ rate: 1.5, voiceId: "Samantha" });
  });

  it("rejects invalid values field by field", () => {
    localStorage.setItem(KEY, JSON.stringify({ rate: 3, voiceId: "Daniel" }));
    expect(getPreferences()).toEqual({ rate: 1, voiceId: "Daniel" });
    resetPreferencesForTests();
    localStorage.setItem(KEY, JSON.stringify({ rate: 2, voiceId: 42 }));
    expect(getPreferences()).toEqual({ rate: 2, voiceId: undefined });
  });

  it("falls back to defaults for corrupt JSON", () => {
    localStorage.setItem(KEY, "{not json");
    expect(getPreferences()).toEqual({ rate: 1, voiceId: undefined });
  });

  it("falls back to defaults when storage throws on read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getPreferences()).toEqual({ rate: 1, voiceId: undefined });
  });

  it("persists changes and notifies subscribers once per change", () => {
    const listener = vi.fn();
    subscribePreferences(listener);
    setPreferences({ rate: 2 });
    setPreferences({ rate: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ rate: 2 });
    resetPreferencesForTests();
    expect(getPreferences().rate).toBe(2);
  });

  it("ignores invalid rates", () => {
    const listener = vi.fn();
    subscribePreferences(listener);
    setPreferences({ rate: 3 });
    expect(getPreferences().rate).toBe(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps working in memory when storage throws on write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const listener = vi.fn();
    subscribePreferences(listener);
    setPreferences({ voiceId: "Alex" });
    expect(getPreferences().voiceId).toBe("Alex");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePreferences(listener);
    unsubscribe();
    setPreferences({ rate: 0.5 });
    expect(listener).not.toHaveBeenCalled();
  });
});
