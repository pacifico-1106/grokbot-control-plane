import { describe, expect, test } from "bun:test";
import type { OrgMember } from "@/lib/types";
import {
  managerOptionLabel,
  membersEligibleAsManager,
} from "./manager-candidates";

function member(
  id: string,
  status: OrgMember["status"],
  displayName = id,
  email = `${id}@example.com`
): OrgMember {
  return {
    id,
    orgId: "org_test",
    email,
    displayName,
    role: "member",
    status,
  };
}

describe("membersEligibleAsManager", () => {
  test("includes active and invited, excludes disabled", () => {
    const active = member("mem_active", "active", "山田 太郎", "owner@example.com");
    const invited = member("mem_invited", "invited", "佐藤 花子", "sato@example.com");
    const disabled = member("mem_disabled", "disabled", "無効", "off@example.com");
    const eligible = membersEligibleAsManager([active, invited, disabled]);
    expect(eligible.map((m) => m.id)).toEqual(["mem_active", "mem_invited"]);
    expect(eligible.some((m) => m.status === "disabled")).toBe(false);
  });
});

describe("managerOptionLabel", () => {
  test("appends 招待中 for invited members", () => {
    expect(
      managerOptionLabel(member("mem_a", "active", "山田 太郎", "owner@example.com"))
    ).toBe("山田 太郎（owner@example.com）");
    expect(
      managerOptionLabel(member("mem_i", "invited", "佐藤 花子", "sato@example.com"))
    ).toBe("佐藤 花子（sato@example.com） · 招待中");
  });
});
