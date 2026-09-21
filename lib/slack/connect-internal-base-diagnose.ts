/**
 * Connect internal-base setup checklist diagnostics for Admin MCP.
 * G7/Uehara Connect: external-shared channels stay `shared_external` (+ mixed),
 * internal parties resolved via parties allowlist or internalAudienceRule.
 */

import {
  getOrgChannel,
  getOrgParty,
  listOrgChannels,
  listOrgParties,
} from "@/lib/data/directory";
import { getOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import type { OrgChannel, OrgParty, OrgInternalAudienceRule } from "@/lib/types";

export type ConnectInternalBaseStep =
  | "channel_classify"
  | "parties_or_iar"
  | "employee_post_contract"
  | "connectivity_probe";

export type ConnectInternalBaseCheckItem = {
  step: ConnectInternalBaseStep;
  ok: boolean;
  summaryJa: string;
  nextStepJa: string;
  /** Admin MCP tool name for next action (null when complete) */
  nextTool: string | null;
  details?: Record<string, unknown>;
};

export type ConnectInternalBaseChecklistResult = {
  ok: boolean;
  channelId: string | null;
  channel: OrgChannel | null;
  internalAudienceRule: OrgInternalAudienceRule;
  slackUserParties: OrgParty[];
  checklist: ConnectInternalBaseCheckItem[];
  summaryJa: string;
  nextStepJa: string;
  /** IC guidance: client cannot lower, public needs assetRef */
  icGuidanceJa: string;
};

const IC_GUIDANCE_JA =
  "ICはクライアントで下げられない（raise-only）。public は information_assets + assetRef が必要。フリーテキスト送信は confidential → 承認が正解。";

function checkChannelClassify(
  channel: OrgChannel | null,
  channelId: string | null
): ConnectInternalBaseCheckItem {
  if (!channelId) {
    return {
      step: "channel_classify",
      ok: false,
      summaryJa: "channelId が指定されていません",
      nextStepJa: "診断対象の Slack Connect チャネル ID を指定してください",
      nextTool: null,
    };
  }

  if (!channel) {
    return {
      step: "channel_classify",
      ok: false,
      summaryJa: `チャネル ${channelId} は未分類です`,
      nextStepJa: `channels.classify で externalId=${channelId}, classification=shared_external, mixed=true を設定してください`,
      nextTool: "channels.classify",
      details: {
        externalId: channelId,
        suggestedClassification: "shared_external",
        suggestedMixed: true,
      },
    };
  }

  if (channel.classification !== "shared_external") {
    return {
      step: "channel_classify",
      ok: false,
      summaryJa: `チャネル ${channelId} の分類が shared_external ではありません (現在: ${channel.classification})`,
      nextStepJa: `channels.classify で classification=shared_external, mixed=true に更新してください。Connect は internal に再分類できません。`,
      nextTool: "channels.classify",
      details: {
        currentClassification: channel.classification,
        currentMixed: channel.mixed,
        suggestedClassification: "shared_external",
        suggestedMixed: true,
      },
    };
  }

  if (!channel.mixed) {
    return {
      step: "channel_classify",
      ok: false,
      summaryJa: `チャネル ${channelId} の mixed フラグが false です`,
      nextStepJa: `channels.classify で mixed=true を設定してください。Connect / 混在ch は相手台帳必須です。`,
      nextTool: "channels.classify",
      details: {
        currentMixed: channel.mixed,
        suggestedMixed: true,
      },
    };
  }

  return {
    step: "channel_classify",
    ok: true,
    summaryJa: `チャネル ${channelId} は shared_external + mixed=true（Connect 設定完了）`,
    nextStepJa: "チャネル分類は完了しています",
    nextTool: null,
    details: {
      classification: channel.classification,
      mixed: channel.mixed,
    },
  };
}

function checkPartiesOrIar(
  slackUserParties: OrgParty[],
  internalAudienceRule: OrgInternalAudienceRule,
  channelId: string | null
): ConnectInternalBaseCheckItem {
  const hasSlackUserParty = slackUserParties.some(
    (party) => party.kind === "slack_user" && party.audience === "internal"
  );
  const hasIarSlackTeam =
    internalAudienceRule.autoSlackTeamInternal &&
    internalAudienceRule.slackTeamIds.length > 0;
  const hasIarEmailDomain = internalAudienceRule.emailDomains.length > 0;

  if (!hasSlackUserParty && !hasIarSlackTeam && !hasIarEmailDomain) {
    return {
      step: "parties_or_iar",
      ok: false,
      summaryJa: "内部判定ルールが未設定です（parties も IAR も空）",
      nextStepJa:
        "parties.upsert で speaker（発話者）の slack_user を内部登録するか、internalAudienceRule.patch で slackTeamIds + autoSlackTeamInternal=true を設定してください",
      nextTool: "parties.upsert",
      details: {
        slackUserPartiesCount: slackUserParties.length,
        iarSlackTeamIds: internalAudienceRule.slackTeamIds,
        iarAutoSlackTeamInternal: internalAudienceRule.autoSlackTeamInternal,
        iarEmailDomains: internalAudienceRule.emailDomains,
        alternativeTool: "internalAudienceRule.patch",
      },
    };
  }

  const methods: string[] = [];
  if (hasSlackUserParty) {
    const internalCount = slackUserParties.filter(
      (p) => p.kind === "slack_user" && p.audience === "internal"
    ).length;
    methods.push(`slack_user parties (${internalCount}件)`);
  }
  if (hasIarSlackTeam) {
    methods.push(
      `IAR slackTeamIds (${internalAudienceRule.slackTeamIds.join(", ")})`
    );
  }
  if (hasIarEmailDomain) {
    methods.push(
      `IAR emailDomains (${internalAudienceRule.emailDomains.join(", ")})`
    );
  }

  return {
    step: "parties_or_iar",
    ok: true,
    summaryJa: `内部判定ルール設定済み: ${methods.join(" + ")}`,
    nextStepJa:
      "内部判定ルールは設定済みです。追加の speaker を登録する場合は parties.upsert を使用してください。",
    nextTool: null,
    details: {
      methods,
      slackUserPartiesCount: slackUserParties.length,
      iarSlackTeamIds: internalAudienceRule.slackTeamIds,
      iarAutoSlackTeamInternal: internalAudienceRule.autoSlackTeamInternal,
      iarEmailDomains: internalAudienceRule.emailDomains,
    },
  };
}

function checkEmployeePostContract(channelId: string | null): ConnectInternalBaseCheckItem {
  const doc = [
    "【社員 post 契約（社員 MCP comm.reply 呼び出し時）】",
    "- slackChannelId / args.channel = wake.channel（イベントのチャネル ID）",
    "- WHO = wake.user / speakerId（社員証バインド ID ではなく、発話者の Slack user_id）",
    "- thread_ts = wake.ts（メンションのスレッド ts）",
  ].join("\n");

  return {
    step: "employee_post_contract",
    ok: true,
    summaryJa: "社員 post 契約（ドキュメント参照用）",
    nextStepJa: doc,
    nextTool: null,
    details: {
      contract: {
        slackChannelIdSource: "wake.channel",
        whoSource: "wake.user / speakerId",
        threadTsSource: "wake.ts",
      },
      channelId,
    },
  };
}

function checkConnectivityProbe(): ConnectInternalBaseCheckItem {
  return {
    step: "connectivity_probe",
    ok: true,
    summaryJa: "接続性プローブ（既存ツール参照）",
    nextStepJa:
      "社員 MCP の staffpass_whoami / staffpass_health、または管理 MCP の setup.slackStatus で接続性を確認してください",
    nextTool: "setup.slackStatus",
    details: {
      employeeMcpTools: ["staffpass_whoami", "staffpass_health"],
      adminMcpTools: ["setup.slackStatus"],
    },
  };
}

export async function diagnoseConnectInternalBase(
  orgId: string,
  channelId: string | null
): Promise<ConnectInternalBaseChecklistResult> {
  const normalizedChannelId = channelId?.trim() || null;

  const channel = normalizedChannelId
    ? await getOrgChannel(orgId, "slack", normalizedChannelId)
    : null;

  const internalAudienceRule = await getOrgInternalAudienceRule(orgId);

  const allParties = await listOrgParties(orgId);
  const slackUserParties = allParties.filter((p) => p.kind === "slack_user");

  const checklist: ConnectInternalBaseCheckItem[] = [
    checkChannelClassify(channel, normalizedChannelId),
    checkPartiesOrIar(slackUserParties, internalAudienceRule, normalizedChannelId),
    checkEmployeePostContract(normalizedChannelId),
    checkConnectivityProbe(),
  ];

  const incomplete = checklist.filter((item) => !item.ok);
  const allOk = incomplete.length === 0;

  let summaryJa: string;
  let nextStepJa: string;

  if (!normalizedChannelId) {
    summaryJa = "Connect internal-base チェックリスト: channelId が未指定です";
    nextStepJa =
      "診断対象の Slack Connect チャネル ID（C で始まる ID）を channelId 引数に渡してください";
  } else if (allOk) {
    summaryJa = `Connect internal-base チェックリスト: ${normalizedChannelId} は設定完了`;
    nextStepJa =
      "設定は完了しています。社員 MCP から comm.reply でテスト送信を行ってください。";
  } else {
    const firstIncomplete = incomplete[0];
    summaryJa = `Connect internal-base チェックリスト: ${incomplete.length}件の未完了ステップ`;
    nextStepJa = firstIncomplete.nextStepJa;
  }

  return {
    ok: allOk && Boolean(normalizedChannelId),
    channelId: normalizedChannelId,
    channel,
    internalAudienceRule,
    slackUserParties,
    checklist,
    summaryJa,
    nextStepJa,
    icGuidanceJa: IC_GUIDANCE_JA,
  };
}

export type ChannelInternalBaseReadiness = {
  channelId: string;
  classified: boolean;
  isSharedExternal: boolean;
  isMixed: boolean;
  hasPartiesOrIar: boolean;
  partiesHint: string | null;
  readyForConnect: boolean;
  summaryJa: string;
  nextStepJa: string;
  icGuidanceJa: string;
};

export async function diagnoseChannelInternalBaseReadiness(
  orgId: string,
  channelId: string
): Promise<ChannelInternalBaseReadiness> {
  const normalizedId = channelId.trim();
  const channel = await getOrgChannel(orgId, "slack", normalizedId);
  const internalAudienceRule = await getOrgInternalAudienceRule(orgId);
  const allParties = await listOrgParties(orgId);
  const slackUserParties = allParties.filter(
    (p) => p.kind === "slack_user" && p.audience === "internal"
  );

  const classified = Boolean(channel);
  const isSharedExternal = channel?.classification === "shared_external";
  const isMixed = channel?.mixed === true;

  const hasIarSlackTeam =
    internalAudienceRule.autoSlackTeamInternal &&
    internalAudienceRule.slackTeamIds.length > 0;
  const hasIarEmailDomain = internalAudienceRule.emailDomains.length > 0;
  const hasSlackUserParty = slackUserParties.length > 0;
  const hasPartiesOrIar = hasSlackUserParty || hasIarSlackTeam || hasIarEmailDomain;

  let partiesHint: string | null = null;
  if (!hasPartiesOrIar) {
    partiesHint =
      "内部 slack_user parties がありません。parties.upsert で speaker を登録するか、internalAudienceRule.patch を設定してください。";
  } else if (!hasSlackUserParty && hasIarSlackTeam) {
    partiesHint = `IAR で slackTeamIds=${internalAudienceRule.slackTeamIds.join(",")} 設定済み。個別 parties は未登録。`;
  }

  const readyForConnect = classified && isSharedExternal && isMixed && hasPartiesOrIar;

  let summaryJa: string;
  let nextStepJa: string;

  if (readyForConnect) {
    summaryJa = `${normalizedId}: Connect internal-base 準備完了`;
    nextStepJa = "設定完了。comm.reply でテスト送信可能です。";
  } else {
    const issues: string[] = [];
    if (!classified) issues.push("未分類");
    else if (!isSharedExternal) issues.push(`分類が shared_external ではない (${channel?.classification})`);
    if (!isMixed) issues.push("mixed=false");
    if (!hasPartiesOrIar) issues.push("parties/IAR 未設定");
    summaryJa = `${normalizedId}: ${issues.join(" / ")}`;
    if (!classified || !isSharedExternal || !isMixed) {
      nextStepJa = `channels.classify で externalId=${normalizedId}, classification=shared_external, mixed=true を設定`;
    } else {
      nextStepJa =
        "parties.upsert で speaker を内部登録、または internalAudienceRule.patch を設定";
    }
  }

  return {
    channelId: normalizedId,
    classified,
    isSharedExternal,
    isMixed,
    hasPartiesOrIar,
    partiesHint,
    readyForConnect,
    summaryJa,
    nextStepJa,
    icGuidanceJa: IC_GUIDANCE_JA,
  };
}
