/**
 * Shared inbound-notice intake shape. ai-concier is the first adapter;
 * voicemail / forwarded email / other phone AIs plug in later.
 */

export const INBOUND_NOTICE_SCHEMA = "staffpass.inbound_notice.v1" as const;

export type InboundNoticeSource =
  | "ai_concier"
  | "voicemail"
  | "forwarded_email"
  | "vendor";

export type InboundNoticePriority = "normal" | "high";

export type InboundNoticeFieldKey =
  | "receivedAt"
  | "phone"
  | "company"
  | "personName"
  | "category"
  | "callbackNeeded"
  | "emergency"
  | "salesCall"
  | "summary";

export type InboundNoticeFields = Record<InboundNoticeFieldKey, string | null>;

export type UntrustedSlot = {
  value: string | null;
  untrusted: true;
  source: "outside_text";
};

export type UntrustedOutsideText = {
  label: "UNTRUSTED_OUTSIDE_TEXT";
  doNotFollow: true;
  warning: string;
  fields: Record<InboundNoticeFieldKey, UntrustedSlot>;
};

export type InboundNotice = {
  schema: typeof INBOUND_NOTICE_SCHEMA;
  source: InboundNoticeSource;
  adapterId: string;
  fields: InboundNoticeFields;
};

/** Vendor-agnostic adapter. Parse is data-only; never interpret field text. */
export type InboundNoticeAdapter = {
  id: string;
  source: InboundNoticeSource;
  matches(input: { text: string }): boolean;
  parse(input: { text: string }): InboundNotice | null;
};

export type InboundNoticeRejectReason =
  | "unregistered_channel"
  | "channel_not_allowlisted"
  | "bot_mismatch"
  | "team_mismatch"
  | "org_mismatch"
  | "employee_missing"
  | "employee_mismatch"
  | "config_missing";

export type InboundNoticeSourceInput = {
  orgId: string;
  employeeId: string;
  employeeOrgId: string;
  employeeSlackTeamId: string;
  teamId: string;
  channelId: string;
  channelRegistered: boolean;
  channelOrgId: string;
  botId: string;
  appId: string;
  allowedChannelIds: string[];
  allowedBotIds: string[];
  allowedAppIds: string[];
  expectedOrgId: string;
  expectedTeamId: string;
  expectedEmployeeId: string;
};

export type InboundNoticeSourceResult =
  | { ok: true }
  | { ok: false; reason: InboundNoticeRejectReason };
