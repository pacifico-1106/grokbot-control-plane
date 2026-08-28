import { describe, expect, test } from "bun:test";
import { getRuntimeMembers } from "../demo-data";
import {
  isUuid,
  listMembers,
  normalizeMemberEmail,
  resolveProductionMemberId,
  upsertMember,
} from "./members";

describe("isUuid", () => {
  test("accepts RFC uuid v4", () => {
    expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isUuid(crypto.randomUUID())).toBe(true);
  });

  test("rejects mem_ ids and empty", () => {
    expect(isUuid("mem_abc123")).toBe(false);
    expect(isUuid("mem_1")).toBe(false);
    expect(isUuid("org_demo")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe("production member id / email helpers", () => {
  test("resolveProductionMemberId mints uuid when given mem_*", () => {
    const id = resolveProductionMemberId("mem_deadbe");
    expect(isUuid(id)).toBe(true);
    expect(id.startsWith("mem_")).toBe(false);
  });

  test("resolveProductionMemberId keeps a passed uuid", () => {
    const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(resolveProductionMemberId(uuid)).toBe(uuid);
  });

  test("normalizeMemberEmail trims and lowercases", () => {
    expect(normalizeMemberEmail("  Info@Tokyo307inc.com ")).toBe(
      "info@tokyo307inc.com"
    );
  });
});

describe("demo upsertRuntime path", () => {
  test("upsertMember keeps mem_ ids on the demo path", async () => {
    const id = `mem_${crypto.randomUUID().slice(0, 8)}`;
    const saved = await upsertMember({
      id,
      orgId: "org_demo",
      email: "Invitee@Example.com",
      displayName: "招待テスト",
      role: "member",
      jobRole: "sales",
      jobLabel: null,
      capabilities: ["view_dashboard"],
      status: "invited",
    });
    expect(saved.id).toBe(id);
    expect(saved.status).toBe("invited");
    expect(getRuntimeMembers().some((m) => m.id === id)).toBe(true);
  });

  test("listMembers still returns invited rows (no active-only filter)", async () => {
    const members = await listMembers("org_demo");
    expect(members.some((m) => m.status === "invited")).toBe(true);
    expect(members.some((m) => m.id.startsWith("mem_"))).toBe(true);
  });
});
