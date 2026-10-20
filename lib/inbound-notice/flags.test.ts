import { afterEach, describe, expect, test } from "bun:test";
import { isInboundCallNoticeEnabled } from "@/lib/inbound-notice/flags";

const KEY = "INBOUND_CALL_NOTICE_ENABLED";
const saved = process.env[KEY];
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe("INBOUND_CALL_NOTICE_ENABLED (default OFF)", () => {
  test("unset → OFF", () => {
    delete process.env[KEY];
    expect(isInboundCallNoticeEnabled()).toBe(false);
  });

  test("empty / falsey values stay OFF", () => {
    for (const v of ["", "0", "false", "off", "no", "yes please"]) {
      process.env[KEY] = v;
      expect(isInboundCallNoticeEnabled()).toBe(false);
    }
  });

  test("only explicit truthy values turn it ON", () => {
    for (const v of ["true", "1", "on", "enabled", "TRUE", "On"]) {
      process.env[KEY] = v;
      expect(isInboundCallNoticeEnabled()).toBe(true);
    }
  });
});
