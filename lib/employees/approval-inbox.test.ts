import { describe, expect, test } from "bun:test";
import {
  extraApproversAllow,
  inboxOptionLabel,
  normalizeApproverUserIds,
  parseApprovalChannelId,
} from "./approval-inbox";
import type { NotificationChannel } from "@/lib/types";

describe("approval inbox helpers", () => {
  test("normalizeApproverUserIds splits, trims, and de-dupes", () => {
    expect(normalizeApproverUserIds(" 111, 222 111 \n333 ")).toEqual(["111", "222", "333"]);
    expect(normalizeApproverUserIds(["  a ", "", "a"])).toEqual(["a"]);
    expect(normalizeApproverUserIds(null)).toEqual([]);
  });

  test("parseApprovalChannelId accepts org channels and treats empty as unset", () => {
    expect(parseApprovalChannelId("", ["chn_1"])).toEqual({ ok: true, id: null });
    expect(parseApprovalChannelId(null, ["chn_1"])).toEqual({ ok: true, id: null });
    expect(parseApprovalChannelId("chn_1", ["chn_1", "chn_2"])).toEqual({ ok: true, id: "chn_1" });
    expect(parseApprovalChannelId("chn_other", ["chn_1"])).toEqual({ ok: false });
  });

  test("extraApproversAllow ANDs with extra ids when set", () => {
    expect(extraApproversAllow("111", [])).toBe(true);
    expect(extraApproversAllow("111", ["111", "222"])).toBe(true);
    expect(extraApproversAllow("333", ["111", "222"])).toBe(false);
    expect(extraApproversAllow("", ["111"])).toBe(false);
  });

  test("inboxOptionLabel marks the org default", () => {
    const channel = {
      id: "chn_1",
      orgId: "org",
      provider: "telegram",
      label: "八坂のDM",
      enabled: true,
      isDefault: true,
    } as NotificationChannel;
    expect(inboxOptionLabel(channel)).toBe("八坂のDM（既定）");
  });
});
