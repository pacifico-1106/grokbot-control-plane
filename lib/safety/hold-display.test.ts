import { describe, expect, test } from "bun:test";
import { HOLD_DISPLAY_UNREADABLE_JA, holdDisplayMode, mergeHoldStatus, buildHoldPanelStatus } from "@/lib/safety/hold-display";

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
  test("garbage / missing state → error, not stop", () => {
    expect(holdDisplayMode({ ...none, state: "nope" as never }, "org", false)).toBe("error");
  });
});

describe("mergeHoldStatus: a stale GET none must not hide an org hold", () => {
  const heldStatus = buildHoldPanelStatus({
    enabled: true, orgEnabled: true, memberId: "mem_1",
    read: { state: "held", hold: { id: "efcfe065-566d-43af-9255-ddf2af03d5fe", kind: "stopped", startedVia: "web", startedAt: "2026-10-15T00:00:00Z", releaseRequestedBy: null, releaseApprovalId: null } },
  });
  const noneStatus = buildHoldPanelStatus({
    enabled: true, orgEnabled: true, memberId: "mem_1",
    read: { state: "none" },
  });
  test("SSR held + client none → still held (the production fail-open after #375)", () => {
    const merged = mergeHoldStatus(heldStatus, noneStatus);
    expect(merged.state).toBe("held");
    expect(merged.hold?.id).toBe("efcfe065-566d-43af-9255-ddf2af03d5fe");
  });
  test("SSR none + client held → held", () => {
    expect(mergeHoldStatus(noneStatus, heldStatus).state).toBe("held");
  });
});
