import type { HumanCapability, HumanJobRole, OrgMember } from "@/lib/types";

export const JOB_ROLE_PRESETS: Array<{
  key: HumanJobRole;
  label: string;
  hint: string;
}> = [
  { key: "owner", label: "経営", hint: "オーナー／社長" },
  { key: "sales", label: "営業", hint: "顧客・見積・承認" },
  { key: "accounting", label: "経理", hint: "予算・監査・承認" },
  { key: "admin_affairs", label: "総務", hint: "メンバー・雇い" },
  { key: "legal", label: "法務", hint: "監査・承認" },
  { key: "ops_ai", label: "AI推進／運用", hint: "運用フルセット寄り" },
  { key: "custom", label: "カスタム", hint: "自由ラベル" },
];

export const CAPABILITY_DEFS: Array<{
  key: HumanCapability;
  label: string;
  group: string;
}> = [
  { key: "view_dashboard", label: "ダッシュボード閲覧", group: "閲覧" },
  { key: "view_employees", label: "AI社員一覧・詳細", group: "閲覧" },
  { key: "view_audit", label: "監査ログ閲覧", group: "閲覧" },
  { key: "approve_actions", label: "承認キュー", group: "操作" },
  { key: "manage_spend_limits", label: "予算上限の管理", group: "操作" },
  { key: "hire_issue_credentials", label: "雇う／社員証発行", group: "操作" },
  { key: "manage_team", label: "メンバー追加・編集", group: "管理" },
  { key: "manage_billing", label: "請求・契約", group: "管理" },
];

export const VIEW_ONLY_CAPABILITIES: HumanCapability[] = [
  "view_dashboard",
  "view_employees",
  "view_audit",
];

export const JOB_ROLE_CAPABILITY_PACKS: Record<HumanJobRole, HumanCapability[]> = {
  owner: [
    "view_dashboard",
    "view_employees",
    "view_audit",
    "approve_actions",
    "manage_spend_limits",
    "hire_issue_credentials",
    "manage_team",
    "manage_billing",
  ],
  sales: ["view_dashboard", "view_employees", "approve_actions"],
  accounting: [
    "view_dashboard",
    "view_audit",
    "manage_spend_limits",
    "approve_actions",
  ],
  admin_affairs: [
    "view_dashboard",
    "view_employees",
    "manage_team",
    "hire_issue_credentials",
  ],
  legal: ["view_dashboard", "view_audit", "approve_actions"],
  ops_ai: [
    "view_dashboard",
    "view_employees",
    "view_audit",
    "approve_actions",
    "manage_spend_limits",
    "hire_issue_credentials",
    "manage_team",
  ],
  custom: ["view_dashboard"],
};

export function jobRoleLabel(role: HumanJobRole, customLabel?: string | null): string {
  if (role === "custom" && customLabel?.trim()) return customLabel.trim();
  return JOB_ROLE_PRESETS.find((p) => p.key === role)?.label ?? role;
}

export function capabilityLabel(cap: HumanCapability): string {
  return CAPABILITY_DEFS.find((c) => c.key === cap)?.label ?? cap;
}

export function capabilitiesForJobRole(role: HumanJobRole): HumanCapability[] {
  return [...JOB_ROLE_CAPABILITY_PACKS[role]];
}

export function hasCapability(
  member: Pick<OrgMember, "capabilities"> | null | undefined,
  cap: HumanCapability
): boolean {
  return (member?.capabilities ?? []).includes(cap);
}

export function missingCapabilityMessage(cap: HumanCapability): string {
  return `権限がありません（デモ）: ${capabilityLabel(cap)} が必要です。チーム画面で職務・権限を確認してください。`;
}
