// fail-first stub: names only, no behaviour yet.
import type { NotificationChannel } from "@/lib/types";
export const APPROVAL_APP_SCOPE_FIX_JA = "";
export function resetApprovalAppScopeNoticeForTests(): void {}
export function setApprovalAppScopeNoticeDepsForTests(_deps: {
  mail?: ((msg: { to: string[]; subject: string; text: string; html: string }) => Promise<{ ok: boolean }>) | null;
  send?: ((channel: NotificationChannel, text: string) => Promise<{ ok: boolean }>) | null;
}): void {}
