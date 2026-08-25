import { describe, expect, test } from "bun:test";
import { isTokyo307PilotEmail } from "./notification-channels";

describe("global Telegram fallback pilot", () => {
  test("allows only the Tokyo307 pilot account", () => {
    expect(isTokyo307PilotEmail("info@tokyo307inc.com")).toBe(true);
    expect(isTokyo307PilotEmail(" INFO@TOKYO307INC.COM ")).toBe(true);
    expect(isTokyo307PilotEmail("owner@tokyo307inc.com")).toBe(false);
    expect(isTokyo307PilotEmail("info@another-tenant.com")).toBe(false);
  });
});
