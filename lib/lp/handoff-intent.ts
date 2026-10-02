/**
 * Deterministic handoff handling for the LP chat.
 *
 * Prod smoke 2026-10-02 20:04 JST: for 「担当の方と話したいです」 gpt-4o-mini wrote a
 * text "要約案 … この要約でよろしければ、承認をお願い致します。" instead of calling
 * handoff_offer, so no handoff card appeared and the visitor hit a dead end.
 * The server therefore (a) detects an explicit request for a human and forces the
 * handoff_offer tool, (b) guarantees a handoff card (or, with LP_HANDOFF_ENABLED OFF,
 * a contact-form card) and (c) never lets a fake in-chat approval request through.
 */
import type { HistoryMessage } from "@/lib/lp/chat-prompt";

const HUMAN = "(?:担当(?:者|の方|の人|さん|者様)?|営業(?:担当|の方|の人|さん)?|人間|スタッフ|オペレーター|社員の方|専門家|有人|人)";
const TALK = "(?:話|はな|相談|連絡|電話|つな|繋)";

/** Explicit asks for a person, a call back, a quote or a contact. */
const STRONG_PATTERNS: RegExp[] = [new RegExp(`${HUMAN}(?:の方)?(?:と|に|へ|から|で)?.{0,6}${TALK}`, "u")];

const CONTACT_REQUEST =
  /(?:電話|見積(?:も|書)?り?|お?問い?合わ?せ|連絡|折り?返し|打ち合わせ|面談|商談|デモ)(?:を|が|は|で)?(?:ほしい|欲しい|したい|して(?:ほしい|欲しい|ください|下さい|いただ|もら)|ください|下さい|お願い|頂け|いただけ|できます|可能|もらえ|希望)/u;

/** Phrases that describe delegating a task ("電話対応を任せたい") rather than asking for a human. */
const TASK_CONTEXT = /(?:任せ|まかせ|自動化|代行|業務|対応を|作成を|AI社員に|AIに)/u;

export function detectHandoffIntent(text: string): boolean {
  const t = text.normalize("NFKC").replace(/\s+/g, "");
  if (!t) return false;
  if (STRONG_PATTERNS.some((re) => re.test(t))) {
    // "経理担当の業務を任せたい" is a task description, not a request for a person.
    if (TASK_CONTEXT.test(t) && !/(?:話|はな|相談|連絡|電話|つな|繋)(?:し|い)?た?い|(?:話|はな)せ|つないで|繋いで/u.test(t)) return false;
    return true;
  }
  if (CONTACT_REQUEST.test(t) && !TASK_CONTEXT.test(t)) return true;
  return false;
}

/** Model text that imitates the handoff UI (summary + approval request) in plain chat. */
const FAKE_HANDOFF_TEXT = /(?:要約案|共有する(?:内容|要約)|この(?:要約|内容)でよろしければ|承認(?:を)?お願い|ご承認|承認してください|承認いただ|担当者に(?:お?伝え|共有)します)/u;

export function looksLikeFakeHandoffText(reply: string): boolean {
  return FAKE_HANDOFF_TEXT.test(reply.normalize("NFKC"));
}

export const HANDOFF_CARD_REPLY =
  "担当者に共有する内容をまとめました。下のカードの「内容を確認して相談を依頼する」から、内容と連絡先を確認してお申し込みください。確定するまで担当者には共有されません。";

export const HANDOFF_OFF_REPLY =
  "担当者とのご相談は、下の「相談フォームを開く」からお申し込みください。担当者から折り返しご連絡します。";

export const HANDOFF_REASON = "担当者との相談を希望";

/** Server-built summary from the visitor's own messages (used when the model did not call handoff_offer). */
export function buildServerHandoffCard(history: HistoryMessage[], text: string) {
  const userLines = [...history.filter((m) => m.role === "user").map((m) => m.content), text]
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-6);
  let summary = "AI相談窓口でのご質問・ご要望:\n";
  for (const line of userLines) {
    const next = `- ${line.slice(0, 300)}\n`;
    if (summary.length + next.length > 1900) break;
    summary += next;
  }
  summary += "（次の画面で編集できます）";
  return {
    type: "handoff_preview" as const,
    reason: HANDOFF_REASON,
    summaryDraft: summary,
    destination: "async_consultation",
    confirmationRequired: true,
    note: "引継ぎを確定するには画面で確認が必要です。",
  };
}

export function contactLinkCard() {
  return { type: "contact_link" as const, note: "相談フォームから担当者にご連絡いただけます。" };
}
