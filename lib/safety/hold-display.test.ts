import { describe, expect, test } from "bun:test";
import { HOLD_DISPLAY_UNREADABLE_JA, holdDisplayMode } from "@/lib/safety/hold-display";

const held = { enabled: true, orgEnabled: true, state: "held" as const, hold: { id: "h1" } };
const none = { enabled: true, orgEnabled: true, state: "none" as const, hold: null };
const unknown = { enabled: true, orgEnabled: true, state: "unknown" as const, hold: null };

describe("holdDisplayMode (fail-closed: unreadable never shows stop)", () => {
  test("org held → held (解除を申請), not stop", () => {
    expect(holdDisplayMode(held, "org", false)).toBe("held");
  });
  test("org none → stop", () => {
    expect(holdDisplayMode(none, "org", false)).toBe("stop");
  });
  test("unknown → error, not stop", () => {
    expect(holdDisplayMode(unknown, "org", false)).toBe("error");
    expect(holdDisplayMode(unknown, "employee", false)).toBe("error");
  });
  test("fetch failed → error, not stop (even with a stale none)", () => {
    expect(holdDisplayMode(none, "org", true)).toBe("error");
    expect(holdDisplayMode(null, "org", true)).toBe("error");
  });
  test("held but hold id missing → error, not stop", () => {
    expect(holdDisplayMode({ ...held, hold: null }, "org", false)).toBe("error");
    expect(holdDisplayMode({ ...held, hold: { id: "" } }, "org", false)).toBe("error");
  });
  test("flags off → hidden", () => {
    expect(holdDisplayMode({ ...none, enabled: false }, "org", false)).toBe("hidden");
    expect(holdDisplayMode({ ...none, orgEnabled: false }, "org", false)).toBe("hidden");
    expect(holdDisplayMode({ ...none, orgEnabled: false }, "employee", false)).toBe("stop");
  });
  test("loading", () => {
    expect(holdDisplayMode(null, "org", false)).toBe("loading");
  });
  test("unreadable copy is Japanese and does not mention the stop button as the action to take", () => {
    expect(HOLD_DISPLAY_UNREADABLE_JA).toMatch(/停止状態を確認できません/);
    expect(HOLD_DISPLAY_UNREADABLE_JA).toMatch(/停止ボタンは出していません/);
  });
});
