/**
 * Slack DM-based identity verification for voter bindings.
 *
 * P0 Item 2: When binding a Slack user to an org member:
 * 1. Send a DM with a one-time code and a Block Kit confirm button
 * 2. User must either enter the code OR click the button (signed interaction)
 * 3. Verification validates team_id matches the channel's expectedTeamId
 * 4. Binding becomes active only after successful verification
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  generateVerificationCode,
  verifyVoterBinding,
  type VoterBinding,
  type VoterBindingProvider,
} from "./voter-binding";

const SLACK_API = "https://slack.com/api";
const SLACK_TIMEOUT_MS = 5_000;

export interface SendVerificationDmInput {
  botToken: string;
  slackUserId: string;
  orgId: string;
  channelKey: string;
  memberId: string;
  memberDisplayName: string;
  orgName: string;
  verificationCode: string;
}

export interface SlackDmResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

type SlackApiResponse = {
  ok?: boolean;
  error?: string;
  channel?: { id?: string };
  ts?: string;
};

export async function sendVerificationDmToSlackUser(
  input: SendVerificationDmInput
): Promise<SlackDmResult> {
  if (!input.botToken?.trim() || !input.slackUserId?.trim()) {
    return { ok: false, error: "missing_credentials" };
  }

  const openResponse = await fetch(`${SLACK_API}/conversations.open`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ users: input.slackUserId }),
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });

  const openBody = (await openResponse.json().catch(() => ({}))) as SlackApiResponse;
  if (!openBody.ok || !openBody.channel?.id) {
    return { ok: false, error: openBody.error || "dm_open_failed" };
  }

  const dmChannelId = openBody.channel.id;
  const callbackValue = buildVerificationCallbackValue({
    orgId: input.orgId,
    channelKey: input.channelKey,
    slackUserId: input.slackUserId,
    verificationCode: input.verificationCode,
  });

  const blocks = buildVerificationBlocks({
    memberDisplayName: input.memberDisplayName,
    orgName: input.orgName,
    verificationCode: input.verificationCode,
    callbackValue,
  });

  const postResponse = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: dmChannelId,
      text: `Staffpass 承認者登録の確認: 組織「${input.orgName}」へのバインディングを確認してください。`,
      blocks,
    }),
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });

  const postBody = (await postResponse.json().catch(() => ({}))) as SlackApiResponse;
  if (!postBody.ok) {
    return { ok: false, error: postBody.error || "dm_post_failed" };
  }

  return { ok: true, ts: postBody.ts, channel: dmChannelId };
}

function buildVerificationBlocks(input: {
  memberDisplayName: string;
  orgName: string;
  verificationCode: string;
  callbackValue: string;
}) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Staffpass 承認者登録の確認*\n\n組織「${escapeSlackMrkdwn(input.orgName)}」で、あなたのアカウントを承認者「${escapeSlackMrkdwn(input.memberDisplayName)}」として登録しようとしています。`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `このバインディングを承認すると、あなたは承認ワークフローでチケットを承認・却下できるようになります。\n\n*確認コード:* \`${input.verificationCode}\``,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "承認者として登録する" },
          style: "primary",
          action_id: "staffpass_verify_voter_binding",
          value: input.callbackValue,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "拒否する" },
          style: "danger",
          action_id: "staffpass_reject_voter_binding",
          value: input.callbackValue,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "この確認は15分で期限切れになります。心当たりがない場合は「拒否する」をクリックしてください。",
        },
      ],
    },
  ];
}

function escapeSlackMrkdwn(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const CALLBACK_SECRET = process.env.VOTER_BINDING_SECRET || "dev-secret";

function buildVerificationCallbackValue(input: {
  orgId: string;
  channelKey: string;
  slackUserId: string;
  verificationCode: string;
}): string {
  const payload = JSON.stringify({
    o: input.orgId,
    c: input.channelKey,
    u: input.slackUserId,
    v: input.verificationCode,
    t: Date.now(),
  });
  const sig = createHmac("sha256", CALLBACK_SECRET)
    .update(payload)
    .digest("base64url")
    .slice(0, 16);
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

export function parseVerificationCallbackValue(
  value: string
): { ok: true; orgId: string; channelKey: string; slackUserId: string; verificationCode: string } | { ok: false; reason: string } {
  const parts = value.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid_format" };

  const [payloadB64, sig] = parts;
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString();
  } catch {
    return { ok: false, reason: "decode_failed" };
  }

  const expectedSig = createHmac("sha256", CALLBACK_SECRET)
    .update(payload)
    .digest("base64url")
    .slice(0, 16);

  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature_invalid" };
  }

  try {
    const parsed = JSON.parse(payload) as { o?: string; c?: string; u?: string; v?: string; t?: number };
    if (!parsed.o || !parsed.c || !parsed.u || !parsed.v) {
      return { ok: false, reason: "missing_fields" };
    }
    return {
      ok: true,
      orgId: parsed.o,
      channelKey: parsed.c,
      slackUserId: parsed.u,
      verificationCode: parsed.v,
    };
  } catch {
    return { ok: false, reason: "parse_failed" };
  }
}

export async function handleVerificationButtonClick(input: {
  callbackValue: string;
  presserSlackUserId: string;
  presserTeamId?: string;
}): Promise<
  | { ok: true; binding: VoterBinding; messageJa: string }
  | { ok: false; reason: string; messageJa: string }
> {
  const parsed = parseVerificationCallbackValue(input.callbackValue);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      messageJa: "検証データが不正です。リンクが無効または改ざんされています。",
    };
  }

  if (parsed.slackUserId !== input.presserSlackUserId) {
    return {
      ok: false,
      reason: "user_mismatch",
      messageJa: "このボタンはあなた宛てではありません。バインディング対象のユーザーのみが確認できます。",
    };
  }

  const result = await verifyVoterBinding({
    orgId: parsed.orgId,
    provider: "slack" as VoterBindingProvider,
    channelKey: parsed.channelKey,
    externalUserId: parsed.slackUserId,
    verificationCode: parsed.verificationCode,
    teamId: input.presserTeamId,
  });

  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    binding: result.binding,
    messageJa: "承認者として正常に登録されました。承認ワークフローでチケットを処理できるようになりました。",
  };
}

export async function handleVerificationRejection(input: {
  callbackValue: string;
  presserSlackUserId: string;
}): Promise<{ ok: true; messageJa: string } | { ok: false; reason: string; messageJa: string }> {
  const parsed = parseVerificationCallbackValue(input.callbackValue);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      messageJa: "検証データが不正です。",
    };
  }

  if (parsed.slackUserId !== input.presserSlackUserId) {
    return {
      ok: false,
      reason: "user_mismatch",
      messageJa: "このボタンはあなた宛てではありません。",
    };
  }

  return {
    ok: true,
    messageJa: "バインディングリクエストを拒否しました。管理者に連絡してください。",
  };
}

export function buildVerificationSuccessBlocks(memberDisplayName: string): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ *登録完了*\n\nあなたは「${escapeSlackMrkdwn(memberDisplayName)}」として承認者に登録されました。承認ワークフローでチケットを処理できます。`,
      },
    },
  ];
}

export function buildVerificationFailureBlocks(reason: string, messageJa: string): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `❌ *登録失敗*\n\n${escapeSlackMrkdwn(messageJa)}\n\n_理由: ${escapeSlackMrkdwn(reason)}_`,
      },
    },
  ];
}

export function buildVerificationRejectedBlocks(): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "🚫 *リクエスト拒否*\n\nバインディングリクエストは拒否されました。管理者にお問い合わせください。",
      },
    },
  ];
}
