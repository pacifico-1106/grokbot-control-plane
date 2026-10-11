/**
 * サービスの表記（2026-10-03 八坂決定）。
 *
 * Grok Bot 以外のエージェントサービスにも対応するため、Grok Bot 専用に読める旧表記から
 * 「AIエージェントの社員証」に変更した。画面・メール・ドキュメントの表記はこれに揃える。
 * 法務ページの本文は条文として読めるよう文字列をそのまま書いている（lib/brand.test.ts で一致を確認）。
 */
export const SERVICE_LABEL = "Staffpass（AIエージェントの社員証）";

/** 英語の表記（package.json / MCP server-card など）。 */
export const SERVICE_LABEL_EN = "Staffpass — ID badges for AI agents";
