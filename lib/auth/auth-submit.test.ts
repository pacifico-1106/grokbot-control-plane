/**
 * Shared auth submit lock: disable the button and reject a second click
 * while a request is in flight.
 */
import { describe, expect, test } from "bun:test";
import { authSubmitView, beginAuthSubmit, endAuthSubmit } from "./auth-submit";

describe("authSubmitView", () => {
  test("idle: button enabled with the idle label", () => {
    expect(authSubmitView(false, "再設定メールを送信", "送信中…")).toEqual({
      disabled: false,
      label: "再設定メールを送信",
      ariaBusy: false,
    });
  });

  test("busy: button disabled and labeled as sending", () => {
    expect(authSubmitView(true, "再設定メールを送信", "送信中…")).toEqual({
      disabled: true,
      label: "送信中…",
      ariaBusy: true,
    });
  });
});

describe("beginAuthSubmit", () => {
  test("first call takes the lock; a second call is rejected (no double submit)", () => {
    const lock = { current: false };
    expect(beginAuthSubmit(lock)).toBe(true);
    expect(lock.current).toBe(true);
    expect(beginAuthSubmit(lock)).toBe(false);
    endAuthSubmit(lock);
    expect(lock.current).toBe(false);
    expect(beginAuthSubmit(lock)).toBe(true);
  });
});
