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
    /** Parsed recipient count for To field */
    toCount: number;
    /** Parsed recipient count for CC field */
    ccCount: number;
    /** Parsed recipient count for BCC field */
    bccCount: number;
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

  // Check for OTHER secrets (not from the auth link's apiKey).
  // The aws_secret_key pattern can match the apiKey parameter (40 chars alphanumeric),
  // so we ignore aws_secret_key suspected when auth links are present.
  if (input.secretDetection.ok && input.secretDetection.suspected && input.secretDetection.suspected.length > 0) {
    const otherSecrets = input.secretDetection.suspected.filter(
      (s) => s.pattern !== "aws_secret_key"
    );
    if (otherSecrets.length > 0) {
      return blocked("other_secret_detected");
    }
  }

  if (input.isChannelPost) {
    return blocked("channel_post");
  }

  // L: Check CC/BCC FIRST before audience - malformed CC/BCC should return
  // has_cc_or_bcc rather than external_recipient caused by invalid addresses
  if (input.recipients.ccCount > 0 || input.recipients.bccCount > 0) {
    return blocked("has_cc_or_bcc");
  }

  if (input.audience.destinationMissing) {
    return blocked("audience_unknown");
  }

  if (input.audience.effectiveAudience !== "internal") {
    return blocked("external_recipient");
  }

  if (input.recipients.toCount !== 1) {
    return blocked("multiple_recipients");
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

/**
 * Mask oobCode and apiKey values in the request body for auth action link approvals.
 * 
 * SECURITY: The approval snapshot must NEVER contain oobCode or apiKey values.
 * This function replaces those values with [REDACTED] in the args.body field.
 * 
 * Note: DetectedAuthActionLink intentionally does NOT expose the actual secret values.
 * We re-extract them here from the body text to mask them.
 */
export function maskAuthActionLinkSecretsInBody<T extends { args?: Record<string, unknown> }>(
  body: T,
  links: DetectedAuthActionLink[]
): T {
  if (!body.args || typeof body.args.body !== "string" || links.length === 0) {
    return body;
  }

  let maskedBody = body.args.body;
  
  // Extract and mask oobCode and apiKey values from Firebase auth action link URLs
  // Pattern: https://*.firebaseapp.com/__/auth/action?mode=...&oobCode=VALUE&apiKey=VALUE
  const urlPattern = /https?:\/\/[A-Za-z0-9.-]+\/__\/auth\/action\?[^\s"'<>]*/gi;
  const matches = maskedBody.matchAll(urlPattern);
  
  for (const match of matches) {
    try {
      const url = new URL(match[0]);
      const oobCode = url.searchParams.get("oobCode");
      const apiKey = url.searchParams.get("apiKey");
      
      if (oobCode) {
        maskedBody = maskedBody.split(oobCode).join("[REDACTED]");
      }
      if (apiKey) {
        maskedBody = maskedBody.split(apiKey).join("[REDACTED]");
      }
    } catch {
      // Invalid URL, skip
    }
  }

  return {
    ...body,
    args: {
      ...body.args,
      body: maskedBody,
    },
  };
}
