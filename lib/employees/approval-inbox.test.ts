import { describe, expect, test } from "bun:test";
import {
  assignedInboxLabel,
  extraApproversAllow,
  lineApproverGate,
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

  test("assignedInboxLabel falls back to org default when unset", () => {
    const def = {
      id: "chn_def",
      orgId: "org",
      provider: "telegram",
      label: "安藤の既定",
      enabled: true,
      isDefault: true,
    } as NotificationChannel;
    const other = { ...def, id: "chn_2", label: "八坂のDM", isDefault: false };
    expect(assignedInboxLabel({ approvalChannelId: null }, [def, other])).toBe("安藤の既定（既定）");
    expect(assignedInboxLabel({ approvalChannelId: "chn_2" }, [def, other])).toBe("八坂のDM");
    expect(assignedInboxLabel({ approvalChannelId: null }, [])).toBe("未設定");
  });
});

describe("lineApproverGate (G2: LINE presser ↔ approverUserIds)", () => {
  const U = "U0123456789abcdef0123456789abcdef";
  const base = { lineUserId: U, approvalEmployeeId: "emp-1", bindingMatch: false };

  test("fails closed when the presser has no LINE userId", () => {
    expect(lineApproverGate({ ...base, lineUserId: "", employee: { approverUserIds: [] } }))
      .toEqual({ allowed: false, reason: "missing_user_id" });
  });

  test("fails closed when the approval's employee cannot be loaded", () => {
    expect(lineApproverGate({ ...base, employee: null })).toEqual({ allowed: false, reason: "employee_not_found" });
    // An approval without an employee keeps the channel-level gate only.
    expect(lineApproverGate({ ...base, approvalEmployeeId: null, employee: null }).allowed).toBe(true);
  });

  test("empty list keeps today's behavior (channel allowedUserIds still applies upstream)", () => {
    expect(lineApproverGate({ ...base, employee: { approverUserIds: [] } })).toEqual({ allowed: true, via: "open" });
  });

  test("raw LINE userId must match exactly", () => {
    expect(lineApproverGate({ ...base, employee: { approverUserIds: [U] } })).toEqual({ allowed: true, via: "raw_id" });
    expect(lineApproverGate({ ...base, employee: { approverUserIds: [U.toUpperCase()] } }).allowed).toBe(false);
    expect(lineApproverGate({ ...base, employee: { approverUserIds: [U.slice(0, -1)] } }).allowed).toBe(false);
  });

  test("flag OFF: Staffpass UUIDs and prefixed entries never match (today's behavior)", () => {
    const employee = { approverUserIds: ["mem-a", `line:${U}`] };
    expect(lineApproverGate({ ...base, employee, binding: { memberId: "mem-a", memberUserId: "user-a" } }))
      .toEqual({ allowed: false, reason: "not_listed" });
  });

  test("flag ON: member/user UUID matches only through a verified binding for this channel", () => {
    const on = { ...base, bindingMatch: true };
    expect(lineApproverGate({ ...on, employee: { approverUserIds: ["mem-a"] }, binding: { memberId: "mem-a" } }))
      .toEqual({ allowed: true, via: "binding" });
    expect(lineApproverGate({ ...on, employee: { approverUserIds: ["user-a"] }, binding: { memberId: "mem-a", memberUserId: "user-a" } }))
      .toEqual({ allowed: true, via: "binding" });
    // No binding → no match, even if the UUID is listed.
    expect(lineApproverGate({ ...on, employee: { approverUserIds: ["mem-a"] }, binding: null }).allowed).toBe(false);
    // Binding to someone else → no match.
    expect(lineApproverGate({ ...on, employee: { approverUserIds: ["mem-a"] }, binding: { memberId: "mem-b" } }).allowed).toBe(false);
  });

  test("flag ON: provider-scoped entries cannot be mixed across providers", () => {
    const on = { ...base, bindingMatch: true };
    expect(lineApproverGate({ ...on, employee: { approverUserIds: [`line:${U}`] } })).toEqual({ allowed: true, via: "provider_scoped" });
    expect(lineApproverGate({ ...on, employee: { approverUserIds: [`slack:${U}`] } }).allowed).toBe(false);
    expect(lineApproverGate({ ...on, employee: { approverUserIds: [`telegram:${U}`] } }).allowed).toBe(false);
  });
});
