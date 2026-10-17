function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type InboundNoticeConfig = {
  orgId: string;
  employeeId: string;
  slackTeamId: string;
  channelIds: string[];
  botIds: string[];
  appIds: string[];
};

/** Prototype routing: designated employee + allowlists from env. Missing any required id → null. */
export function readInboundNoticeConfig(
  env: NodeJS.ProcessEnv = process.env
): InboundNoticeConfig | null {
  const orgId = (env.INBOUND_CALL_NOTICE_ORG_ID ?? "").trim();
  const employeeId = (env.INBOUND_CALL_NOTICE_EMPLOYEE_ID ?? "").trim();
  const slackTeamId = (env.INBOUND_CALL_NOTICE_SLACK_TEAM_ID ?? "").trim();
  const channelIds = csv(env.INBOUND_CALL_NOTICE_SLACK_CHANNEL_IDS);
  const botIds = csv(env.INBOUND_CALL_NOTICE_SLACK_BOT_IDS);
  const appIds = csv(env.INBOUND_CALL_NOTICE_SLACK_APP_IDS);
  if (!orgId || !employeeId || !slackTeamId || channelIds.length === 0) return null;
  if (botIds.length === 0 && appIds.length === 0) return null;
  return { orgId, employeeId, slackTeamId, channelIds, botIds, appIds };
}
