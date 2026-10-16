import type {
  InboundNoticeSourceInput,
  InboundNoticeSourceResult,
} from "@/lib/inbound-notice/types";

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function allow(list: string[], value: string): boolean {
  const v = norm(value);
  if (!v) return false;
  return list.some((item) => norm(item) === v);
}

/**
 * Fail closed: registered Slack channel, expected bot or app ID, same org/team.
 * Empty allowlists do not implicit-allow.
 */
export function verifyInboundNoticeSource(
  input: InboundNoticeSourceInput
): InboundNoticeSourceResult {
  const org = norm(input.expectedOrgId);
  const team = norm(input.expectedTeamId);
  const employee = (input.expectedEmployeeId ?? "").trim();
  if (!org || !team || !employee) return { ok: false, reason: "config_missing" };

  if (!(input.employeeId || "").trim()) return { ok: false, reason: "employee_missing" };
  if ((input.employeeId || "").trim() !== employee) {
    return { ok: false, reason: "employee_mismatch" };
  }

  if (!input.channelRegistered) return { ok: false, reason: "unregistered_channel" };
  if (!allow(input.allowedChannelIds, input.channelId)) {
    return { ok: false, reason: "channel_not_allowlisted" };
  }

  if (norm(input.orgId) !== org || norm(input.employeeOrgId) !== org || norm(input.channelOrgId) !== org) {
    return { ok: false, reason: "org_mismatch" };
  }

  if (norm(input.teamId) !== team || norm(input.employeeSlackTeamId) !== team) {
    return { ok: false, reason: "team_mismatch" };
  }

  const botOk = allow(input.allowedBotIds, input.botId);
  const appOk = allow(input.allowedAppIds, input.appId);
  if (!botOk && !appOk) return { ok: false, reason: "bot_mismatch" };

  return { ok: true };
}
