/**
 * comm.delete surface support matrix. Same request / response shape on every
 * surface; a surface that cannot delete says so with a reason (not_supported).
 *
 * - Slack: chat.delete. Bot token: chat:write; user token: chat:write.
 *   A bot token deletes only messages posted by that bot; a user token deletes
 *   only messages that user can delete.
 *   Source: https://docs.slack.dev/reference/methods/chat.delete
 * - LINE: the Messaging API has no endpoint to delete / unsend a message the
 *   bot sent (only an `unsend` webhook event when a USER unsends theirs).
 *   Source: https://developers.line.biz/en/reference/messaging-api/
 * - Telegram: deleteMessage exists (only messages sent < 48 hours ago; bots can
 *   delete their outgoing messages), but Staffpass has no gateway conversation
 *   posting path for Telegram yet (Telegram is an approval-notification channel
 *   only), so there are no recorded Telegram posts to delete.
 *   Source: https://core.telegram.org/bots/api#deletemessage
 */
export type CommDeleteSurface = "slack" | "line" | "telegram";

export const COMM_DELETE_SURFACES: readonly CommDeleteSurface[] = ["slack", "line", "telegram"];

export type CommDeleteSurfaceSupport =
  | { supported: true }
  | { supported: false; reason: string; messageJa: string; source: string };

const SUPPORT: Record<CommDeleteSurface, CommDeleteSurfaceSupport> = {
  slack: { supported: true },
  line: {
    supported: false,
    reason: "provider_has_no_delete_api",
    messageJa:
      "LINE の Messaging API には、送信済みのメッセージを削除・送信取消する機能がないため削除できません（LINE 側の仕様）。",
    source: "https://developers.line.biz/en/reference/messaging-api/",
  },
  telegram: {
    supported: false,
    reason: "no_gateway_post_path",
    messageJa:
      "Telegram への会話投稿はまだ Staffpass から行っていないため（Telegram は承認通知にのみ使用）、削除できる投稿の記録がありません。投稿経路が追加されたら、Telegram の制限（送信から48時間以内）の範囲で対応します。",
    source: "https://core.telegram.org/bots/api#deletemessage",
  },
};

export function commDeleteSurfaceSupport(surface: CommDeleteSurface): CommDeleteSurfaceSupport {
  return SUPPORT[surface];
}
