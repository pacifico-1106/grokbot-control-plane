/**
 * P0-A Setup Deep Links
 * Short-lived signed URLs for Slack/LINE that land on Staffpass hosted flows.
 * 
 * Locked rules (2026-09-22):
 * - Chat surfaces only the link + nextStepJa (no secrets)
 * - Prefer signed/expiring tokens; fail-closed on expiry; tenant-scoped
 * - Real input/OAuth on Staffpass or IdP hosted pages
 * 
 * Sales line: 「窓口は Slack／LINE、鍵と記録は会社の社員証（Staffpass）」
 */

import { createHash, randomBytes, createHmac } from "node:crypto";

export type SetupLinkKind =
  | "org_kickoff"
  | "employee_connector_oauth"
  | "slack_authorize"
  | "workspace_bot_install"
  | "approval_inbox_setup"
  | "line_oauth_setup"
  | "slack_bot_token_setup";

export type SetupLinkConfig = {
  kind: SetupLinkKind;
  orgId: string;
  employeeId?: string;
  expiresInSeconds?: number;
  metadata?: Record<string, unknown>;
};

export type MintedSetupLink = {
  ok: true;
  url: string;
  token: string;
  expiresAt: string;
  kind: SetupLinkKind;
  nextStepJa: string;
};

export type RedeemResult = {
  ok: true;
  kind: SetupLinkKind;
  orgId: string;
  employeeId?: string;
  metadata?: Record<string, unknown>;
} | {
  ok: false;
  code: "expired" | "invalid" | "tampered";
  messageJa: string;
};

const DEFAULT_EXPIRY_SECONDS = 3600;
const MAX_EXPIRY_SECONDS = 86400;

const SIGNING_SECRET = process.env.SETUP_LINK_SIGNING_SECRET || "staffpass-setup-link-dev-secret";

const NEXTSTEP_JA: Record<SetupLinkKind, string> = {
  org_kickoff: "リンクを開いて Staffpass でテナントの初期設定を完了してください。",
  employee_connector_oauth: "リンクを開いてコネクタ OAuth 認証を完了してください。ダッシュボードで接続状況を確認できます。",
  slack_authorize: "リンクを開いて Slack アカウントを Staffpass に連携してください。本人投稿（postingAs=user）に必要です。",
  workspace_bot_install: "リンクを開いて Slack ワークスペースに Staffpass Bot をインストールしてください。",
  approval_inbox_setup: "リンクを開いて承認インボックスの設定を完了してください。",
  line_oauth_setup: "リンクを開いて LINE Messaging API チャネルを設定してください。Webhook URL の登録が必要です。",
  slack_bot_token_setup: "リンクを開いて Slack Bot Token を設定してください。チャットにトークンを貼らないでください。",
};

const KIND_PATHS: Record<SetupLinkKind, string> = {
  org_kickoff: "/app/getting-started",
  employee_connector_oauth: "/app/employees/[employeeId]/connector",
  slack_authorize: "/api/slack/oauth/start",
  workspace_bot_install: "/api/slack/bot-install/start",
  approval_inbox_setup: "/app/settings/notifications",
  line_oauth_setup: "/app/settings/notifications/line",
  slack_bot_token_setup: "/app/settings/conversation-adapters",
};

function getBaseUrl(): string {
  return process.env.STAFFPASS_PUBLIC_ORIGIN || process.env.NEXT_PUBLIC_BASE_URL || "https://staffpass.sealith.com";
}

function signPayload(payload: string): string {
  return createHmac("sha256", SIGNING_SECRET).update(payload).digest("hex");
}

function verifySignature(payload: string, signature: string): boolean {
  const expected = signPayload(payload);
  if (signature.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}

export function mintSetupLink(config: SetupLinkConfig): MintedSetupLink {
  const expiresInSeconds = Math.min(
    config.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS,
    MAX_EXPIRY_SECONDS
  );
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const nonce = randomBytes(12).toString("hex");

  const payload = JSON.stringify({
    kind: config.kind,
    orgId: config.orgId,
    employeeId: config.employeeId,
    expiresAt,
    nonce,
    metadata: config.metadata,
  });

  const payloadBase64 = Buffer.from(payload).toString("base64url");
  const signature = signPayload(payload);
  const token = `${payloadBase64}.${signature}`;

  let path = KIND_PATHS[config.kind];
  if (config.employeeId && path.includes("[employeeId]")) {
    path = path.replace("[employeeId]", config.employeeId);
  }

  const url = `${getBaseUrl()}${path}?setup_token=${encodeURIComponent(token)}`;

  return {
    ok: true,
    url,
    token,
    expiresAt,
    kind: config.kind,
    nextStepJa: NEXTSTEP_JA[config.kind],
  };
}

export function redeemSetupLink(token: string): RedeemResult {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return {
      ok: false,
      code: "invalid",
      messageJa: "無効なセットアップリンクです。新しいリンクを取得してください。",
    };
  }

  const [payloadBase64, signature] = parts;
  let payload: string;
  try {
    payload = Buffer.from(payloadBase64, "base64url").toString("utf-8");
  } catch {
    return {
      ok: false,
      code: "invalid",
      messageJa: "無効なセットアップリンクです。新しいリンクを取得してください。",
    };
  }

  if (!verifySignature(payload, signature)) {
    return {
      ok: false,
      code: "tampered",
      messageJa: "セットアップリンクが改ざんされています。新しいリンクを取得してください。",
    };
  }

  let data: {
    kind: SetupLinkKind;
    orgId: string;
    employeeId?: string;
    expiresAt: string;
    metadata?: Record<string, unknown>;
  };
  try {
    data = JSON.parse(payload);
  } catch {
    return {
      ok: false,
      code: "invalid",
      messageJa: "無効なセットアップリンクです。新しいリンクを取得してください。",
    };
  }

  if (new Date(data.expiresAt).getTime() < Date.now()) {
    return {
      ok: false,
      code: "expired",
      messageJa: "セットアップリンクの有効期限が切れました。Admin MCP から新しいリンクを取得してください。",
    };
  }

  return {
    ok: true,
    kind: data.kind,
    orgId: data.orgId,
    employeeId: data.employeeId,
    metadata: data.metadata,
  };
}

export function buildSetupLinkResponse(link: MintedSetupLink): {
  setupUrl: string;
  expiresAt: string;
  nextStepJa: string;
} {
  return {
    setupUrl: link.url,
    expiresAt: link.expiresAt,
    nextStepJa: link.nextStepJa,
  };
}

export function getSetupLinkNextStepJa(kind: SetupLinkKind): string {
  return NEXTSTEP_JA[kind];
}

export type SetupLinkGuidance = {
  kind: SetupLinkKind;
  descriptionJa: string;
  nextStepJa: string;
  setupUrl?: string;
  expiresAt?: string;
};

export function buildSetupGuidance(
  kind: SetupLinkKind,
  options?: { mintLink?: boolean; orgId?: string; employeeId?: string }
): SetupLinkGuidance {
  const descriptions: Record<SetupLinkKind, string> = {
    org_kickoff: "テナントの初期設定",
    employee_connector_oauth: "AI社員のコネクタ OAuth 認証",
    slack_authorize: "Slack 本人連携（User Token 取得）",
    workspace_bot_install: "Slack ワークスペースへの Bot インストール",
    approval_inbox_setup: "承認インボックスの設定",
    line_oauth_setup: "LINE Messaging API チャネルの設定",
    slack_bot_token_setup: "Slack Bot Token の設定",
  };

  const guidance: SetupLinkGuidance = {
    kind,
    descriptionJa: descriptions[kind],
    nextStepJa: NEXTSTEP_JA[kind],
  };

  if (options?.mintLink && options.orgId) {
    const link = mintSetupLink({
      kind,
      orgId: options.orgId,
      employeeId: options.employeeId,
    });
    guidance.setupUrl = link.url;
    guidance.expiresAt = link.expiresAt;
  }

  return guidance;
}
