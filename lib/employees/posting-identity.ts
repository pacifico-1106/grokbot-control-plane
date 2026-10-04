/**
 * Slack posting identity (employees.posting_as: "bot" | "user") — the write
 * shared by the dashboard (PATCH /api/employees/[id]/slack-identity) and the
 * admin MCP tool `employees.postingIdentity.set`.
 *
 * - Only posting_as changes: every other policy field is passed through as it
 *   is now (same call the dashboard route always made).
 * - Fail-closed: updateEmployeePolicy throws on any employees / credentials
 *   write error; callers report the failure and write no success audit.
 * - Audit metadata names both sides of the change (from / to). `postingAs`
 *   stays for readers of older dashboard rows.
 *
 * The user-token check for switching to "user" lives in the admin MCP tool
 * (lib/admin-mcp/posting-identity-tool.ts); the dashboard deliberately still
 * lets a human pick "user" before linking (SlackIdentityForm:
 * 「未連携でも選べます」; the gateway fails closed with slack_identity_unbound).
 */
import { updateEmployeePolicy } from "@/lib/data";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import type { Employee, PostingAs } from "@/lib/types";

/** Strict parse for machine callers: exactly "bot" or "user", nothing else. */
export function parsePostingAsStrict(value: unknown): PostingAs | null {
  return value === "bot" || value === "user" ? value : null;
}

export function currentPostingAs(employee: Pick<Employee, "postingAs">): PostingAs {
  return normalizePostingAs(employee.postingAs);
}

export const POSTING_AS_LABEL_JA: Record<PostingAs, string> = {
  bot: "会社のBot",
  user: "本人",
};

/** Write posting_as only (all other policy fields unchanged). Throws on write failure. */
export async function writeEmployeePostingAs(input: {
  orgId: string;
  employee: Employee;
  postingAs: PostingAs;
}): Promise<Employee | null> {
  const { orgId, employee } = input;
  return updateEmployeePolicy({
    orgId,
    employeeId: employee.id,
    scopes: employee.scopes,
    allowedPurposes: employee.allowedPurposes,
    approvalPolicy: employee.approvalPolicy,
    actionLimits: employee.actionLimits,
    postingAs: normalizePostingAs(input.postingAs),
  });
}

/** Audit metadata for a posting identity change (dashboard and admin MCP). */
export function postingAsChangeMetadata(from: PostingAs, to: PostingAs): { postingAs: PostingAs; from: PostingAs; to: PostingAs } {
  return { postingAs: to, from, to };
}
