/**
 * Auth Action Link Policy (SECRET_AUTH_ACTION_LINK_ENABLED)
 * 
 * Evaluates whether a mail.send containing Firebase auth action links
 * can proceed with approval or must be blocked.
 * 
 * Requirements:
 * - Recipient: exactly 1 internal recipient (resolveAudience = internal)
 * - Email: To = 1, no CC, no BCC
 * - No other secrets in the payload (only auth_action_link is allowed)
 * - Fail-closed: any uncertainty blocks the request
 * 
 * SECURITY: oobCode and apiKey values are NEVER logged or returned in errors.
 */

import type { DetectedAuthActionLink, SecretDetectionResult } from "@/lib/security/secret-detector";
import { isSecretAuthActionLinkEnabledForOrg } from "@/lib/feature-flags";

export type AuthActionLinkPolicyResult =
  | { ok: true; action: "allow"; reason: "no_auth_links" }
  | { ok: true; action: "needs_approval"; reason: "auth_action_link_internal"; links: DetectedAuthActionLink[] }
  | { ok: false; code: "auth_action_link_blocked"; reason: AuthActionLinkBlockReason; messageJa: string };

export type AuthActionLinkBlockReason =
  | "external_recipient"
  | "multiple_recipients"
  | "has_cc_or_bcc"
  | "channel_post"
  | "audience_unknown"
  | "other_secret_detected"
  | "flag_off";

const BLOCK_MESSAGES_JA: Record<AuthActionLinkBlockReason, string> = {
  external_recipient: "認証リンクを社外に送信することはできません。",
  multiple_recipients: "認証リンクは1人の宛先にのみ送信できます。",
  has_cc_or_bcc: "認証リンクをCC/BCCで送信することはできません。",
  channel_post: "認証リンクをチャンネルに投稿することはできません。",
  audience_unknown: "宛先を判定できないため、認証リンクを送信できません。",
  other_secret_detected: "認証リンク以外の秘密情報が含まれているため、送信できません。",
  flag_off: "認証リンクの送信は現在無効になっています。",
};

export type AuthActionLinkPolicyInput = {
  orgId: string;
  secretDetection: SecretDetectionResult;
  audience: {
    effectiveAudience: "internal" | "external";
    namedRecipients: boolean;
    destinationMissing: boolean;
  };
  recipients: {
    to: string[];
    cc: string[];
    bcc: string[];
  };
  isChannelPost: boolean;
};

/**
 * Evaluate whether auth action links in a mail.send can proceed.
 * 
 * Returns:
 * - allow: no auth links, normal flow
 * - needs_approval: auth links found, conditions met for approval
 * - blocked: auth links found, conditions NOT met
 */
export function evaluateAuthActionLinkPolicy(
  input: AuthActionLinkPolicyInput
): AuthActionLinkPolicyResult {
  if (!isSecretAuthActionLinkEnabledForOrg(input.orgId)) {
    if (hasAuthActionLinks(input.secretDetection)) {
      return blocked("flag_off");
    }
    return allow("no_auth_links");
  }

  const links = input.secretDetection.ok ? input.secretDetection.authActionLinks : undefined;
  if (!links || links.length === 0) {
    return allow("no_auth_links");
  }

  if (input.secretDetection.ok && input.secretDetection.suspected && input.secretDetection.suspected.length > 0) {
    return blocked("other_secret_detected");
  }

  if (input.isChannelPost) {
    return blocked("channel_post");
  }

  if (input.audience.destinationMissing) {
    return blocked("audience_unknown");
  }

  if (input.audience.effectiveAudience !== "internal") {
    return blocked("external_recipient");
  }

  if (input.recipients.to.length !== 1) {
    return blocked("multiple_recipients");
  }

  if (input.recipients.cc.length > 0 || input.recipients.bcc.length > 0) {
    return blocked("has_cc_or_bcc");
  }

  return {
    ok: true,
    action: "needs_approval",
    reason: "auth_action_link_internal",
    links,
  };
}

function allow(reason: "no_auth_links"): AuthActionLinkPolicyResult {
  return { ok: true, action: "allow", reason };
}

function blocked(reason: AuthActionLinkBlockReason): AuthActionLinkPolicyResult {
  return {
    ok: false,
    code: "auth_action_link_blocked",
    reason,
    messageJa: BLOCK_MESSAGES_JA[reason],
  };
}

function hasAuthActionLinks(detection: SecretDetectionResult): boolean {
  return detection.ok && !!detection.authActionLinks && detection.authActionLinks.length > 0;
}

/**
 * Build approval card summary for auth action link.
 * 
 * SECURITY: oobCode and apiKey values are NEVER included.
 */
export function buildAuthActionLinkApprovalSummary(
  recipientEmail: string,
  mode: DetectedAuthActionLink["mode"]
): string {
  const modeJa = AUTH_MODE_LABEL_JA[mode];
  return `認証リンク（${modeJa}）を ${recipientEmail} さんに渡します。`;
}

const AUTH_MODE_LABEL_JA: Record<DetectedAuthActionLink["mode"], string> = {
  resetPassword: "パスワード再設定",
  verifyEmail: "メール確認",
  signIn: "サインイン",
  recoverEmail: "メール復旧",
};

/**
 * Build approval card lines for auth action link.
 * 
 * SECURITY: oobCode and apiKey are masked.
 */
export function buildAuthActionLinkArtifactLines(
  recipientEmail: string,
  links: DetectedAuthActionLink[]
): string[] {
  const lines: string[] = [];
  lines.push(`宛先: ${recipientEmail}`);
  lines.push(`認証リンク: ${links.length}件`);
  for (const link of links) {
    lines.push(`  - ${AUTH_MODE_LABEL_JA[link.mode]}（oobCode: [masked], apiKey: [masked]）`);
  }
  return lines;
}
