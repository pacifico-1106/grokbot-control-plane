/**
 * P0-A Setup Deep Links
 * Short-lived signed URLs for Slack/LINE that land on Staffpass hosted flows.
 * 
 * Locked rules (2026-09-22):
 * - Chat surfaces only the link + nextStepJa (no secrets)
 * - Prefer signed/expiring tokens; fail-closed on expiry; tenant-scoped
 * - #294: the in-repo redeemer had no caller and was removed
 *   with the hard-coded dev secret. Minting needs SETUP_LINK_SIGNING_SECRET.
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

const DEFAULT_EXPIRY_SECONDS = 3600;
const MAX_EXPIRY_SECONDS = 86400;

/**
 * #294 (木村 2026-10-09 22:13): no hard-coded fallback. The secret is read at
 * mint time; missing / blank → minting is refused (a link signed with a
 * public constant would be forgeable by anyone who reads this repo).
 */
export const SETUP_LINK_SIGNING_SECRET_ENV = "SETUP_LINK_SIGNING_SECRET";

export class SetupLinkSigningSecretMissingError extends Error {
  readonly code = "setup_link_signing_secret_missing";
  constructor() {
    super("setup_link_signing_secret_missing: SETUP_LINK_SIGNING_SECRET is not set; no setup link was minted");
    this.name = "SetupLinkSigningSecretMissingError";
  }
}

function signingSecret(): string {
  const value = process.env[SETUP_LINK_SIGNING_SECRET_ENV];
  if (typeof value !== "string" || !value.trim()) throw new SetupLinkSigningSecretMissingError();
  return value;
}

const NEXTSTEP_JA: Record<SetupLinkKind, string> = {
  org_kickoff: "リンクを開いて Staffpass でテナントの初期設定を完了してください。",
  employee_connector_oauth: "リンクを開いてコネクタ OAuth 認証を完了してください。ダッシュボードで接続状況を確認できます。",
  slack_authorize:
    "Slack 本人連携は単回の再認可リンク（/api/slack/oauth/link）で行います。Admin MCP の setup.slackAuthorizeLink.issue（employeeId 指定・人の承認 1 回）で発行すると、承認アプリの DM でリンクが届きます。社員本人の Slack で開いて「許可する」を押してください。本人投稿（postingAs=user）に必要です。",
  workspace_bot_install: "リンクを開いて Slack ワークスペースに Staffpass Bot をインストールしてください。",
  approval_inbox_setup: "リンクを開いて承認インボックスの設定を完了してください。",
  line_oauth_setup: "リンクを開いて LINE Messaging API チャネルを設定してください。Webhook URL の登録が必要です。",
  slack_bot_token_setup: "リンクを開いて Slack Bot Token を設定してください。チャットにトークンを貼らないでください。",
};

const KIND_PATHS: Record<SetupLinkKind, string> = {
  org_kickoff: "/app/getting-started",
  employee_connector_oauth: "/app/employees/[employeeId]/connector",
  // Not minted here (see NOT_MINTABLE): the admin-issued single-use
  // re-authorize link (lib/slack/authorize-link.ts slackAuthorizeLinkUrl) is
  // the only URL for this kind. Never the session start route, which requires
  // hire_issue_credentials (#284).
  slack_authorize: "/api/slack/oauth/link",
  workspace_bot_install: "/api/slack/bot-install/start",
  approval_inbox_setup: "/app/settings/notifications",
  line_oauth_setup: "/app/settings/notifications/line",
  slack_bot_token_setup: "/app/settings/conversation-adapters",
};

function getBaseUrl(): string {
  return process.env.STAFFPASS_PUBLIC_ORIGIN || process.env.NEXT_PUBLIC_BASE_URL || "https://staffpass.sealith.com";
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * #284 follow-up (木村 2026-10-09): kinds whose landing route does NOT accept a
 * setup-link token. `slack_authorize` lands on /api/slack/oauth/link, which
 * reads `?t=` and accepts only a hashed, single-use token issued by
 * setup.slackAuthorizeLink.issue after one human approval
 * (lib/slack/authorize-link.ts). A stateless setup token there would always be
 * an invalid page — and minting real link tokens here would bypass that
 * approval — so this minter refuses the kind (guidance only).
 */
const NOT_MINTABLE: ReadonlySet<SetupLinkKind> = new Set<SetupLinkKind>(["slack_authorize"]);

export class SetupLinkKindNotMintableError extends Error {
  readonly code = "slack_authorize_requires_issue";
  readonly kind: SetupLinkKind;
  readonly nextStepJa: string;
  constructor(kind: SetupLinkKind) {
    super("slack_authorize_requires_issue: issue the single-use link with setup.slackAuthorizeLink.issue");
    this.name = "SetupLinkKindNotMintableError";
    this.kind = kind;
    this.nextStepJa = NEXTSTEP_JA[kind];
  }
}

export function isSetupLinkKindMintable(kind: SetupLinkKind): boolean {
  return !NOT_MINTABLE.has(kind);
}

export function mintSetupLink(config: SetupLinkConfig): MintedSetupLink {
  if (!isSetupLinkKindMintable(config.kind)) throw new SetupLinkKindNotMintableError(config.kind);
  const secret = signingSecret();
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
  const signature = signPayload(payload, secret);
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

  if (options?.mintLink && options.orgId && isSetupLinkKindMintable(kind)) {
    try {
      const link = mintSetupLink({
        kind,
        orgId: options.orgId,
        employeeId: options.employeeId,
      });
      guidance.setupUrl = link.url;
      guidance.expiresAt = link.expiresAt;
    } catch (error) {
      // No signing secret → guidance only (fail-closed: never an unsigned or fallback-signed link).
      if (!(error instanceof SetupLinkSigningSecretMissingError)) throw error;
    }
  }

  return guidance;
}
