/**
 * 木村 2026-10-09 22:41 (#297): the employee MCP must NOT see the tenant's
 * sensitive-topic keywords (an AI could phrase around them and dodge the topic
 * gate). It only learns broad categories, mapped here from the tenant's list.
 *
 * Mapping: a keyword belongs to a category when it contains one of that
 * category's hint stems (case-insensitive substring). Keywords that match no
 * hint add 「その他の機密事項」. If NOTHING maps, the answer is the generic set
 * (categoriesSource "generic") so the shape never hints at how unusual the
 * list is. Output is always a subset of the fixed category names below — the
 * keywords themselves are never returned.
 */
export const SENSITIVE_TOPIC_CATEGORIES = ["金銭", "人事", "契約", "法務", "個人情報", "経営", "その他の機密事項"] as const;
export type SensitiveTopicCategory = (typeof SENSITIVE_TOPIC_CATEGORIES)[number];

const OTHER: SensitiveTopicCategory = "その他の機密事項";
export const GENERIC_SENSITIVE_TOPIC_CATEGORIES: SensitiveTopicCategory[] = ["金銭", "人事", "契約", OTHER];

const HINTS: Array<[SensitiveTopicCategory, string[]]> = [
  ["金銭", ["支払", "金額", "請求", "振込", "送金", "入金", "出金", "価格", "値段", "予算", "売上", "費用", "料金", "見積", "口座", "invoice", "payment", "price"]],
  ["人事", ["人事", "給与", "給料", "賞与", "採用", "解雇", "退職", "評価", "異動", "懲戒", "昇給", "年収", "面接"]],
  ["契約", ["契約", "合意", "nda", "秘密保持", "発注", "受注", "取引条件", "覚書"]],
  ["法務", ["訴訟", "法務", "弁護士", "紛争", "係争", "違反"]],
  ["個人情報", ["個人情報", "住所", "電話番号", "マイナンバー", "生年月日"]],
  ["経営", ["買収", "m&a", "決算", "株価", "資金調達", "上場", "合併", "経営"]],
];

export type SensitiveTopicCategorization = {
  categories: SensitiveTopicCategory[];
  categoriesSource: "mapped" | "generic" | "none";
};

export function categorizeSensitiveTopics(topics: unknown): SensitiveTopicCategorization {
  const words = Array.isArray(topics)
    ? topics.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim().toLowerCase())
    : [];
  if (words.length === 0) return { categories: [], categoriesSource: "none" };
  const found = new Set<SensitiveTopicCategory>();
  let unmapped = false;
  for (const word of words) {
    let hit = false;
    for (const [category, hints] of HINTS) {
      if (hints.some((h) => word.includes(h))) {
        found.add(category);
        hit = true;
      }
    }
    if (!hit) unmapped = true;
  }
  if (found.size === 0) return { categories: [...GENERIC_SENSITIVE_TOPIC_CATEGORIES], categoriesSource: "generic" };
  if (unmapped) found.add(OTHER);
  return { categories: SENSITIVE_TOPIC_CATEGORIES.filter((c) => found.has(c)), categoriesSource: "mapped" };
}

/**
 * Categories for keywords that actually MATCHED (topic-gate hit), for anything returned to the AI.
 * Same mapping as categorizeSensitiveTopics; a hit that maps to no category is その他の機密事項
 * (not the generic set, which would name categories that did not match). Never returns keywords.
 */
export function categorizeMatchedTopics(matched: unknown): SensitiveTopicCategory[] {
  const result = categorizeSensitiveTopics(matched);
  if (result.categoriesSource === "none") return [];
  if (result.categoriesSource === "generic") return [OTHER];
  return result.categories;
}
