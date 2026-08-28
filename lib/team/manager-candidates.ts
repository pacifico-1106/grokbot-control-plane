import type { OrgMember } from "@/lib/types";

const ELIGIBLE_MANAGER_STATUSES = new Set<OrgMember["status"]>([
  "active",
  "invited",
]);

/** Members who can be selected as 上長. Invited seats are valid destinations; disabled are not. */
export function membersEligibleAsManager(members: OrgMember[]): OrgMember[] {
  return members.filter((member) => ELIGIBLE_MANAGER_STATUSES.has(member.status));
}

export function managerOptionLabel(member: OrgMember): string {
  const base = `${member.displayName}（${member.email}）`;
  return member.status === "invited" ? `${base} · 招待中` : base;
}
