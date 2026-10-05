/**
 * Approval-card text for channels.classify / parties.upsert (PR-B, always on —
 * independent of P1_CONFIG_CHANGE_REQUEST_ENABLED). The approver sees the
 * before → after change and the channel's sharing state (Slack Connect /
 * private / guests / external members). Ids, classifications and counts only:
 * never a token, never a message body. Kept ≤ 400 chars (the Slack card cuts
 * the summary there).
 */
import { getOrgChannel, getOrgParty } from "@/lib/data/directory";
import {
  describeSharingJa,
  surfaceLabel,
  type ChannelFacts,
  type ChannelsClassifyArgs,
  type ClassificationSuggestion,
  type PartiesUpsertArgs,
} from "@/lib/channel-classify/core";
import { collectSlackChannelFacts, inspectSlackUserFacts } from "@/lib/channel-classify/facts";

export const CARD_SUMMARY_MAX = 400;

export type CardRequester = "admin_agent" | "system";

function leadJa(requester: CardRequester): string {
  return requester === "system" ? "【自動提案・未反映】参加チャネルの分類" : "管理エージェントからの変更依頼";
}

function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length <= CARD_SUMMARY_MAX ? text : `${chars.slice(0, CARD_SUMMARY_MAX - 1).join("")}…`;
}

function classLabel(classification: string, mixed: boolean): string {
  return mixed || classification === "shared_external" ? `${classification}（混在）` : classification;
}

/** The card is built in the request path: Slack facts get a hard time budget (else "確認できません"). */
export const CARD_FACTS_BUDGET_MS = 5_000;
async function withinCardBudget<T>(work: Promise<T | null>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CARD_FACTS_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function buildChannelClassifyCardSummaryJa(
  orgId: string,
  value: Pick<ChannelsClassifyArgs, "surface" | "externalId" | "classification" | "mixed">,
  opts: { requester: CardRequester; facts?: ChannelFacts | null; suggestion?: ClassificationSuggestion } = { requester: "admin_agent" }
): Promise<string> {
  const current = await getOrgChannel(orgId, value.surface, value.externalId).catch(() => null);
  const before = current ? classLabel(current.classification, current.mixed) : "未登録（社外扱い）";
  const after = classLabel(value.classification, value.mixed);
  let facts = opts.facts ?? null;
  if (!facts && value.surface === "slack") facts = await withinCardBudget(collectSlackChannelFacts(orgId, value.externalId));
  const sharing = facts ? describeSharingJa(facts) : "共有状態: 確認できません";
  const warnings: string[] = [];
  if (value.classification === "internal" && facts && (facts.isExtShared || (facts.guestMembers ?? 0) > 0 || (facts.externalMembers ?? 0) > 0)) {
    warnings.push("⚠️ 社外共有・ゲストがいるのに internal です");
  }
  if (value.classification === "internal" && current && (current.mixed || current.classification === "shared_external")) {
    warnings.push("⚠️ 社外共有として登録済みのため internal にはできません（反映時に失敗）");
  }
  if (value.classification === "shared_external" && !current) {
    warnings.push("shared_external にすると後で internal に戻せません。社内専用なら却下してください");
  }
  if (opts.suggestion?.basis === "unverified") warnings.push("メンバーを確認できないため安全側（社外）で提案しています");
  const where = `${surfaceLabel(value.surface)} ${value.externalId}`;
  return clip(`${leadJa(opts.requester)}: ${where} の分類 ${before} → ${after}。${sharing}。${warnings.join("。")}${warnings.length ? "。" : ""}反映しますか？`);
}

export async function buildPartyUpsertCardSummaryJa(
  orgId: string,
  value: PartiesUpsertArgs,
  opts: { requester: CardRequester } = { requester: "admin_agent" }
): Promise<string> {
  const current = await getOrgParty(orgId, value.kind, value.identifier).catch(() => null);
  const before = current ? current.audience : "未登録（社外扱い）";
  let sharing = "";
  if (value.kind === "slack_channel") {
    const facts = await withinCardBudget(collectSlackChannelFacts(orgId, value.identifier));
    sharing = facts ? describeSharingJa(facts) : "共有状態: 確認できません";
  } else if (value.kind === "slack_user") {
    const user = await inspectSlackUserFacts(orgId, value.identifier);
    sharing = user
      ? `ゲスト: ${user.guest ? "はい" : "いいえ"} / 社外ワークスペース: ${user.external === null ? "不明" : user.external ? "はい" : "いいえ"}`
      : "Slack 上の所属: 確認できません";
  }
  const warning =
    value.audience === "internal" && /ゲスト: はい|社外ワークスペース: はい|Slack Connect（社外共有）: あり/.test(sharing)
      ? "⚠️ 社外・ゲストの可能性がある相手を internal にします。"
      : "";
  const head = opts.requester === "system" ? "【自動提案・未反映】混在チャネルの相手台帳" : "管理エージェントからの変更依頼";
  return clip(
    `${head}: 相手台帳 ${value.kind} ${value.identifier} を ${before} → ${value.audience}。${sharing ? `${sharing}。` : ""}${warning}反映しますか？`
  );
}
// TDD stub (replaced in the implementation commit).
export function setCardBudgetMsForTests(_ms: number | null): void {}
